import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { EMPTY_HARNESS_CATALOG } from "@orrery/contract";

const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeDir() {
  const d = await mkdtemp(join(tmpdir(), "orrery-pinning-"));
  dirs.push(d);
  return d;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orrery-pinrepo-"));
  dirs.push(root);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  await writeFile(join(repo, "f.txt"), "hi\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
  return repo;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function run(
  args: string[],
  env: Record<string, string | undefined>,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    if (!("ORRERY_URL" in env)) delete merged.ORRERY_URL;
    if (!("ORRERY_RUNNER_ALLOW_INSECURE_HTTP" in env))
      delete merged.ORRERY_RUNNER_ALLOW_INSECURE_HTTP;
    // Origin-pinning tests must not require a real opencode binary on PATH.
    if (
      !("ORRERY_ACP_COMMAND" in env) &&
      !args.includes("--harness") &&
      !args.includes("--acp-command")
    ) {
      merged.ORRERY_ACP_COMMAND = process.execPath;
    }
    const child = spawn(process.execPath, [mainPath, ...args], {
      env: merged,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function writeCredential(dir: string, server: string, displayName = "TestLaptop") {
  await writeFile(
    join(dir, "runner-credential.json"),
    JSON.stringify({
      server,
      hostId: "host-1",
      credential: "orr_rh_local-credential-1234567890",
      displayName,
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );
}

/** Discovery payload matching the w/p ids used by the start tests below. */
function targetsJson() {
  return {
    workspaces: [
      {
        id: "w",
        name: "W",
        slug: "w",
        kind: "shared",
        projects: [{ id: "p", key: "P", name: "P", accessLevel: "manage" }],
      },
    ],
    agents: [{ id: "agent-1", name: "Agent One" }],
    defaultAgentId: "agent-1",
  };
}

function serveTargets(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET" && req.url === "/api/runners/targets") {
    json(res, 200, targetsJson());
    return true;
  }
  return false;
}

function runnerJson(id: string, fingerprint = "a".repeat(64)) {
  const now = new Date().toISOString();
  return {
    id,
    hostId: "host-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    agentId: "agent-1",
    displayName: "TestLaptop",
    repoFingerprint: fingerprint,
    capabilities: [],
    harnessCatalog: EMPTY_HARNESS_CATALOG,
    maxConcurrency: 1,
    activeSlotCount: 0,
    lastSeenAt: now,
    disconnectedAt: null,
    revokedAt: null,
    createdAt: now,
    presence: "online",
  };
}

describe("origin pinning, transport hardening and offline status (#264)", () => {
  it("--server mismatch fails fast with zero HTTP and no secret", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen((req, res) => json(res, 500, {}));
    try {
      await writeCredential(dir, stub.url);
      const result = await run(
        [
          "start",
          "--server",
          "https://other.test/",
          "--workspace",
          "w",
          "--project",
          "p",
          "--repo",
          repo,
        ],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
        repo,
      );
      expect(result.code).toBe(1);
      expect(stub.requests).toEqual([]);
      expect(result.stderr).toContain("does not match enrolled origin");
      expect(result.stderr).not.toContain("orr_rh_");
      expect(result.stdout).not.toContain("orr_rh_");
    } finally {
      await stub.close();
    }
  });

  it("ORRERY_URL mismatch fails fast with zero HTTP", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen((req, res) => json(res, 500, {}));
    try {
      await writeCredential(dir, stub.url);
      const result = await run(
        ["start", "--workspace", "w", "--project", "p", "--repo", repo],
        { ORRERY_RUNNER_CONFIG_DIR: dir, ORRERY_URL: "https://other.test/" },
        repo,
      );
      expect(result.code).toBe(1);
      expect(stub.requests).toEqual([]);
      expect(result.stderr).toContain("ORRERY_URL");
    } finally {
      await stub.close();
    }
  });

  it("start defaults to the enrolled origin without --server", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen(async (req, res) => {
      if (serveTargets(req, res)) return;
      if (req.method === "POST" && req.url === "/api/runners/register") {
        json(res, 201, runnerJson("r-1"));
        return;
      }
      if (req.url?.endsWith("/heartbeat")) {
        json(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "x" });
    });
    try {
      await writeCredential(dir, `${stub.url}/`);
      const result = await run(
        ["start", "--workspace", "w", "--project", "p", "--repo", repo, "--heartbeat-ms", "50"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
        repo,
      );
      expect(result.code).toBe(0);
      expect(stub.requests.some((r) => r.includes("/api/runners/register"))).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("status is offline with ORRERY_URL pointing at an unreachable server", async () => {
    const dir = await makeDir();
    await writeCredential(dir, "https://enrolled.test/app/");
    const result = await run(["status"], {
      ORRERY_RUNNER_CONFIG_DIR: dir,
      ORRERY_URL: "http://127.0.0.1:1",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("https://enrolled.test/app");
    expect(result.stdout).toContain("TestLaptop");
    expect(result.stdout).toContain("host-1");
  });

  it("login without --server reuses enrollment but fails when ORRERY_URL disagrees", async () => {
    const dir = await makeDir();
    const stub = await listen((req, res) => json(res, 500, {}));
    try {
      await writeCredential(dir, stub.url);
      const bad = await run(["login"], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
        ORRERY_URL: "https://other.test/",
      });
      expect(bad.code).toBe(1);
      expect(stub.requests).toEqual([]);
      expect(bad.stderr).toContain("does not match enrolled origin");
    } finally {
      await stub.close();
    }
  });

  it("refuses redirects on credentialed requests", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen(async (req, res) => {
      if (serveTargets(req, res)) return;
      if (req.method === "POST" && req.url === "/api/runners/register") {
        res.writeHead(302, { location: "https://evil.test/" });
        res.end();
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "x" });
    });
    try {
      await writeCredential(dir, stub.url);
      const result = await run(
        ["start", "--workspace", "w", "--project", "p", "--repo", repo],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
        repo,
      );
      expect(result.code).toBe(1);
      expect(stub.requests.length).toBeGreaterThan(0);
    } finally {
      await stub.close();
    }
  });

  it("rejects non-loopback http without opt-in and warns with opt-in (zero secret)", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    await writeCredential(dir, "http://nonexistent.invalid:8080");
    const noOpt = await run(
      ["start", "--workspace", "w", "--project", "p", "--repo", repo],
      { ORRERY_RUNNER_CONFIG_DIR: dir },
      repo,
    );
    expect(noOpt.code).toBe(1);
    expect(noOpt.stderr).toContain("plain-HTTP");
    const opt = await run(
      ["start", "--workspace", "w", "--project", "p", "--repo", repo],
      { ORRERY_RUNNER_CONFIG_DIR: dir, ORRERY_RUNNER_ALLOW_INSECURE_HTTP: "1" },
      repo,
    );
    expect(opt.code).toBe(1);
    expect(opt.stderr).toContain("insecure");
    expect(opt.stderr).toContain("http://nonexistent.invalid:8080");
    expect(opt.stderr).not.toContain("orr_rh_");
  });

  it("rejects over-long explicit --name without truncation and truncates emoji defaults", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen(async (req, res) => {
      if (serveTargets(req, res)) return;
      if (req.method === "POST" && req.url === "/api/runners/register") {
        let body = "";
        req.on("data", (c) => (body += String(c)));
        req.on("end", () => {
          const parsed: unknown = JSON.parse(body);
          const displayName =
            typeof parsed === "object" &&
            parsed !== null &&
            "displayName" in parsed &&
            typeof parsed.displayName === "string"
              ? parsed.displayName
              : "x";
          json(res, 201, { ...runnerJson("r-emo"), displayName });
        });
        return;
      }
      if (req.url?.endsWith("/heartbeat")) {
        json(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "x" });
    });
    try {
      const host = `😀`.repeat(120);
      await writeCredential(dir, stub.url, host);
      const over = await run(
        ["start", "--workspace", "w", "--project", "p", "--repo", repo, "--name", "😀".repeat(121)],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
        repo,
      );
      expect(over.code).toBe(1);
      expect(stub.requests).toEqual([]);
      const ok = await run(
        ["start", "--workspace", "w", "--project", "p", "--repo", repo, "--heartbeat-ms", "50"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
        repo,
      );
      expect(ok.code).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("login rejects an over-long explicit --host-name without network calls", async () => {
    const dir = await makeDir();
    const stub = await listen((req, res) => json(res, 500, {}));
    try {
      await writeCredential(dir, stub.url);
      const result = await run(["login", "--server", stub.url, "--host-name", "😀".repeat(121)], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/120/);
      expect(stub.requests).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("work fails fast on origin mismatch (zero HTTP) and on unborn repos", async () => {
    const dir = await makeDir();
    const stub = await listen((req, res) => json(res, 500, {}));
    try {
      await writeCredential(dir, stub.url);
      const mismatch = await run(["work", "KEY-1", "--server", "https://other.test/"], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(mismatch.code).toBe(1);
      expect(mismatch.stderr).toContain("does not match enrolled origin");
      expect(stub.requests).toEqual([]);

      const unbornRoot = await mkdtemp(join(tmpdir(), "orrery-unborn-work-"));
      dirs.push(unbornRoot);
      const unborn = join(unbornRoot, "repo");
      await mkdir(unborn, { recursive: true });
      execFileSync("git", ["init", "-q", unborn]);
      const unbornRun = await run(["work", "KEY-1", "--repo", unborn], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(unbornRun.code).toBe(1);
      expect(unbornRun.stderr).toMatch(/no HEAD/);
      expect(stub.requests).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("main checkout and linked worktree start independently; failed registration releases the lock", async () => {
    const { runnerFingerprint: fp } = await import("./checkout.ts");
    const { lockPath } = await import("./lock.ts");
    const dir = await makeDir();
    const repo = await makeRepo();
    const link = join(repo, "..", "linked-ind");
    execFileSync("git", ["-C", repo, "worktree", "add", link, "-b", "linked-ind-branch"]);
    const stub = await listen(async (req, res) => {
      if (serveTargets(req, res)) return;
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/runners/register") {
          const parsed: unknown = JSON.parse(body);
          const fingerprint =
            typeof parsed === "object" && parsed !== null && "repoFingerprint" in parsed
              ? String(parsed.repoFingerprint).slice(0, 8)
              : "x";
          json(res, 201, { ...runnerJson(`runner-${fingerprint}`), id: `runner-${fingerprint}` });
          return;
        }
        if (req.url?.includes("/heartbeat")) {
          json(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
          return;
        }
        json(res, 404, { status: 404, code: "not_found", title: "x" });
      });
    });
    try {
      await writeCredential(dir, stub.url);
      const [mainRun, linkRun] = await Promise.all([
        run(
          ["start", "--workspace", "w", "--project", "p", "--repo", repo, "--heartbeat-ms", "50"],
          { ORRERY_RUNNER_CONFIG_DIR: dir },
          repo,
        ),
        run(
          ["start", "--workspace", "w", "--project", "p", "--repo", link, "--heartbeat-ms", "50"],
          { ORRERY_RUNNER_CONFIG_DIR: dir },
          link,
        ),
      ]);
      expect(mainRun.code).toBe(0);
      expect(linkRun.code).toBe(0);
      expect(stub.requests.filter((r) => r.includes("/api/runners/register"))).toHaveLength(2);

      // A failed registration must not leak the lockfile.
      const failing = await listen(async (req, res) => {
        if (serveTargets(req, res)) return;
        if (req.method === "POST" && req.url === "/api/runners/register") {
          json(res, 500, { status: 500, code: "boom", title: "Boom" });
          return;
        }
        json(res, 404, { status: 404, code: "not_found", title: "x" });
      });
      try {
        await writeCredential(dir, failing.url);
        const failed = await run(
          ["start", "--workspace", "w", "--project", "p", "--repo", repo],
          { ORRERY_RUNNER_CONFIG_DIR: dir },
          repo,
        );
        expect(failed.code).toBe(1);
        const { existsSync } = await import("node:fs");
        expect(existsSync(lockPath(fp(repo), dir))).toBe(false);
      } finally {
        await failing.close();
      }
    } finally {
      await stub.close();
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", link]);
      execFileSync("git", ["-C", repo, "worktree", "prune"]);
    }
  });

  it("credentialed spool and MCP clients refuse redirects", async () => {
    const { createStreamSpool } = await import("./spool.ts");
    const { RunnerMcpClient } = await import("./mcp-client.ts");
    const dir = await makeDir();
    const seenSpool: Array<RequestInit | undefined> = [];
    const spoolFetch = (async (_url: unknown, init?: RequestInit) => {
      seenSpool.push(init);
      return new Response(JSON.stringify({ ackedSeq: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const spool = await createStreamSpool({
      spoolDir: dir,
      dispatchAttemptId: "attempt-redirect",
      apiBaseUrl: "http://127.0.0.1:9",
      runnerId: "runner-1",
      dispatchId: "dispatch-1",
      credential: "orr_rh_test",
      fetch: spoolFetch,
      sleep: async () => {},
    });
    await spool.append({ kind: "event", summary: "hi" });
    await spool.flush();
    expect(seenSpool[0]?.redirect).toBe("error");

    const seenMcp: Array<RequestInit | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenMcp.push(init);
      return new Response("redirect", { status: 302 });
    };
    try {
      const mcp = new RunnerMcpClient({ server: "http://127.0.0.1:9", token: "orr_dt_test" });
      await expect(mcp.callTool("get_issue", { issueId: "x" })).rejects.toThrow(/302/);
      expect(seenMcp[0]?.redirect).toBe("error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("login --server to a new origin warns with previous host and revocation reminder", async () => {
    const dir = await makeDir();
    const first = await listen(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/runners/device-codes") {
        json(res, 201, {
          deviceCode: "orr_dc_test-device-code-1234567890",
          userCode: "ABCD-2345",
          verificationUri: `${first.url}/device`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/device-codes/token") {
        json(res, 200, {
          hostId: "host-1",
          credential: "orr_rh_local-credential-1234567890",
          displayName: "FirstHost",
          platform: "linux-x64",
        });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "x" });
    });
    try {
      const login1 = await run(
        ["login", "--server", first.url, "--host-name", "FirstHost", "--poll-ms", "20"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(login1.code).toBe(0);
      const second = await listen(async (req, res) => {
        if (req.method === "POST" && req.url === "/api/runners/device-codes") {
          json(res, 201, {
            deviceCode: "orr_dc_test-device-code-1234567890",
            userCode: "WXYZ-6789",
            verificationUri: `${second.url}/device`,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
          return;
        }
        if (req.method === "POST" && req.url === "/api/runners/device-codes/token") {
          json(res, 200, {
            hostId: "host-2",
            credential: "orr_rh_local-credential-0987654321",
            displayName: "SecondHost",
            platform: "linux-x64",
          });
          return;
        }
        json(res, 404, { status: 404, code: "not_found", title: "x" });
      });
      try {
        const login2 = await run(
          ["login", "--server", second.url, "--host-name", "SecondHost", "--poll-ms", "20"],
          { ORRERY_RUNNER_CONFIG_DIR: dir },
        );
        expect(login2.code).toBe(0);
        expect(login2.stdout).toContain("FirstHost");
        expect(login2.stdout).toContain(first.url);
        expect(login2.stdout).toContain("Revoke");
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("second start in the same checkout fails fast with the live PID", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const { execFileSync: execSync } = await import("node:child_process");
    const { realpathSync: realSync } = await import("node:fs");
    const { resolve: resolvePath } = await import("node:path");
    const toplevel = realSync(
      resolvePath(
        execSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
      ),
    );
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256").update(toplevel).digest("hex");
    const { acquireCheckoutLock: acquire } = await import("./lock.ts");
    const release = await acquire({
      fingerprint,
      server: "http://127.0.0.1:8080",
      repoRoot: toplevel,
      configDir: dir,
    });
    const stub = await listen((req, res) => json(res, 500, {}));
    try {
      await writeCredential(dir, stub.url);
      const result = await run(
        ["start", "--workspace", "w", "--project", "p", "--repo", repo],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
        repo,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`pid ${process.pid}`);
      expect(stub.requests).toEqual([]);
    } finally {
      await release();
      await stub.close();
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const { mkdir } = await import("node:fs/promises");
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

  it("--version prints without credential", async () => {
    const dir = await makeDir();
    const result = await run(["--version"], { ORRERY_RUNNER_CONFIG_DIR: dir });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
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

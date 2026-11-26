import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { bindingFingerprint } from "./checkout.ts";
import { readReposFile } from "./repos.ts";

const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((path) => rm(path, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orrery-binding-"));
  dirs.push(path);
  return path;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orrery-bind-repo-"));
  dirs.push(root);
  const repo = join(root, "repo");
  await import("node:fs/promises").then((fs) => fs.mkdir(repo, { recursive: true }));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  await writeFile(join(repo, "f.txt"), "hi\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
  return repo;
}

const targetsPayload = {
  workspaces: [
    {
      id: "ws-acme",
      name: "Acme",
      slug: "acme",
      kind: "shared",
      projects: [
        { id: "proj-one", key: "ONE", name: "One", accessLevel: "manage" },
        { id: "proj-two", key: "TWO", name: "Two", accessLevel: "manage" },
      ],
    },
    {
      id: "ws-other",
      name: "Other",
      slug: "other",
      kind: "shared",
      projects: [{ id: "proj-three", key: "THREE", name: "Three", accessLevel: "manage" }],
    },
  ],
  agents: [
    { id: "agent-ada", name: "Ada" },
    { id: "agent-bo", name: "Bo" },
  ],
  defaultAgentId: "agent-ada",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function bodyOf(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(text === "" ? {} : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

interface StubOptions {
  targetsStatus?: number;
  register?: { status: number; code: string; title: string } | "echo";
}

interface Stub {
  url: string;
  requests: string[];
  registerBodies: unknown[];
  close(): Promise<void>;
}

async function listen(options: StubOptions = {}): Promise<Stub> {
  const requests: string[] = [];
  const registerBodies: unknown[] = [];
  const mode = options.register ?? "echo";
  const targetsStatus = options.targetsStatus ?? 200;
  const server = createServer((req, res) => {
    void (async () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url === "/api/runners/targets") {
        if (targetsStatus === 200) json(res, 200, targetsPayload);
        else json(res, 409, { status: 409, code: "targets_too_large", title: "Too many targets" });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/register") {
        const body = z
          .object({
            workspaceId: z.string(),
            projectId: z.string(),
            agentId: z.string().optional(),
            repoFingerprint: z.string(),
          })
          .parse(await bodyOf(req));
        registerBodies.push(body);
        if (mode === "echo") {
          const now = new Date().toISOString();
          json(res, 201, {
            id: "runner-1",
            hostId: "host-1",
            workspaceId: body.workspaceId,
            projectId: body.projectId,
            agentId: body.agentId ?? "agent-ada",
            displayName: "TestLaptop",
            repoFingerprint: body.repoFingerprint,
            capabilities: [],
            harnessCatalog: { harnesses: [], probedAt: now },
            maxConcurrency: 1,
            activeSlotCount: 0,
            lastSeenAt: now,
            disconnectedAt: null,
            revokedAt: null,
            createdAt: now,
            presence: "online",
          });
          return;
        }
        json(res, mode.status, { status: mode.status, code: mode.code, title: mode.title });
        return;
      }
      if (req.url?.endsWith("/heartbeat")) {
        json(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
        return;
      }
      json(res, 404, { status: 404, code: "not_found", title: "Not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    registerBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function run(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    if (!("ORRERY_URL" in env)) delete merged.ORRERY_URL;
    if (!("ORRERY_RUNNER_ALLOW_INSECURE_HTTP" in env)) {
      delete merged.ORRERY_RUNNER_ALLOW_INSECURE_HTTP;
    }
    const child = spawn(process.execPath, [mainPath, ...args], {
      env: merged,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function writeCredential(dir: string, server: string, hostId = "host-1") {
  await writeFile(
    join(dir, "runner-credential.json"),
    JSON.stringify({
      server,
      hostId,
      credential: "orr_rh_local-credential-1234567890",
      displayName: "TestLaptop",
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );
  // A hermetic local harness so startup validation never depends on PATH.
  await writeFile(
    join(dir, "harnesses.json"),
    JSON.stringify({
      harnesses: [{ id: "node", displayName: "Node", command: process.execPath, args: [] }],
    }),
  );
}

async function writeReposBinding(
  dir: string,
  server: string,
  repo: string,
  entry: Record<string, unknown>,
) {
  await writeFile(
    join(dir, "repos.json"),
    JSON.stringify({
      version: 1,
      bindings: [
        {
          server,
          bindingFingerprint: bindingFingerprint(repo),
          workspaceId: "ws-acme",
          projectId: "proj-one",
          agentId: "agent-ada",
          hostId: "host-1",
          workspaceName: "Acme",
          projectKey: "ONE",
          agentName: "Ada",
          updatedAt: new Date(0).toISOString(),
          ...entry,
        },
      ],
    }),
  );
}

const readRepos = (dir: string) => readFile(join(dir, "repos.json"), "utf8");

describe("zero-flag start and remembered bindings (#267)", () => {
  it("reuses a saved binding with zero targets fetch and leaves the file untouched", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      await writeReposBinding(dir, stub.url, repo, {});
      const before = await readRepos(dir);
      const result = await run(["start", "--repo", repo, "--heartbeat-ms", "50"], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(result.code).toBe(0);
      expect(stub.requests.some((item) => item.includes("/api/runners/targets"))).toBe(false);
      expect(stub.registerBodies).toHaveLength(1);
      expect(stub.registerBodies[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-one",
        agentId: "agent-ada",
      });
      expect(await readRepos(dir)).toBe(before);
    } finally {
      await stub.close();
    }
  });

  it("fails fast in non-TTY with exact flag and init examples", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      const result = await run(["start", "--repo", repo], { ORRERY_RUNNER_CONFIG_DIR: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--workspace");
      expect(result.stderr).toContain("--project");
      expect(result.stderr).toContain("init");
    } finally {
      await stub.close();
    }
  });

  it("explicit flags override for one run without rewriting the binding", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      await writeReposBinding(dir, stub.url, repo, {});
      const before = await readRepos(dir);
      const result = await run(
        ["start", "--repo", repo, "--project", "TWO", "--heartbeat-ms", "50"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(stub.registerBodies[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-two",
      });
      expect(result.stdout).toContain("left unchanged");
      expect(await readRepos(dir)).toBe(before);
    } finally {
      await stub.close();
    }
  });

  it("refuses a lone --project outside the bound workspace instead of switching", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      await writeReposBinding(dir, stub.url, repo, {});
      const before = await readRepos(dir);
      const result = await run(["start", "--repo", repo, "--project", "THREE"], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("in workspace 'Acme'");
      expect(result.stderr).toContain("--reconfigure");
      expect(stub.registerBodies).toHaveLength(0);
      expect(await readRepos(dir)).toBe(before);
    } finally {
      await stub.close();
    }
  });

  it("checks a lone --workspace against the bound project symmetrically", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      await writeReposBinding(dir, stub.url, repo, {});
      const result = await run(["start", "--repo", repo, "--workspace", "Other"], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not in workspace 'Other'");
      expect(stub.registerBodies).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it.each([
    {
      code: "workspace_not_found",
      status: 404,
      fragments: ["no longer accessible", "left unchanged"],
    },
    { code: "project_not_found", status: 404, fragments: ["Trash", "30 days", "left unchanged"] },
    { code: "agent_not_found", status: 404, fragments: ["no longer available", "left unchanged"] },
    { code: "no_default_agent", status: 409, fragments: ["no agent to run as", "left unchanged"] },
    { code: "invalid_credential", status: 401, fragments: ["login", "left unchanged"] },
  ])(
    "maps stale registration $code without deleting the binding",
    async ({ code, status, fragments }) => {
      const dir = await makeDir();
      const repo = await makeRepo();
      const stub = await listen({ register: { status, code, title: code } });
      try {
        await writeCredential(dir, stub.url);
        await writeReposBinding(dir, stub.url, repo, {});
        const before = await readRepos(dir);
        // Name resolution still runs against targets; the failure comes from register.
        const result = await run(["start", "--repo", repo], { ORRERY_RUNNER_CONFIG_DIR: dir });
        expect(result.code).toBe(1);
        for (const fragment of fragments) expect(result.stderr).toContain(fragment);
        expect(await readRepos(dir)).toBe(before);
      } finally {
        await stub.close();
      }
    },
  );

  it("--reconfigure saves only after registration succeeds", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const failing = await listen({
      register: { status: 500, code: "boom", title: "Boom" },
    });
    try {
      await writeCredential(dir, failing.url);
      await writeReposBinding(dir, failing.url, repo, {});
      const before = await readRepos(dir);
      const failed = await run(
        ["start", "--repo", repo, "--workspace", "Acme", "--project", "TWO", "--reconfigure"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(failed.code).toBe(1);
      expect(await readRepos(dir)).toBe(before);
    } finally {
      await failing.close();
    }
    const succeeding = await listen();
    try {
      await writeCredential(dir, succeeding.url);
      // Point the saved binding at the new stub's origin.
      await writeReposBinding(dir, succeeding.url, repo, {});
      const updated = await run(
        [
          "start",
          "--repo",
          repo,
          "--workspace",
          "Acme",
          "--project",
          "TWO",
          "--reconfigure",
          "--heartbeat-ms",
          "50",
        ],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(updated.code).toBe(0);
      expect(updated.stdout).toContain("Saved checkout binding");
      expect(succeeding.registerBodies[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-two",
      });
      const saved = await readReposFile(dir);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.projectId).toBe("proj-two");
    } finally {
      await succeeding.close();
    }
  });

  it("tolerates a changed hostId after re-enrollment with a brief notice", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url, "host-2");
      await writeReposBinding(dir, stub.url, repo, {});
      const before = await readRepos(dir);
      const result = await run(["start", "--repo", repo, "--heartbeat-ms", "50"], {
        ORRERY_RUNNER_CONFIG_DIR: dir,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("different Runner host enrollment");
      expect(stub.registerBodies).toHaveLength(1);
      expect(await readRepos(dir)).toBe(before);
    } finally {
      await stub.close();
    }
  });

  it("fails fast on malformed repos.json naming the path", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      await writeFile(join(dir, "repos.json"), "{not json");
      const result = await run(["start", "--repo", repo], { ORRERY_RUNNER_CONFIG_DIR: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(join(dir, "repos.json"));
      expect(stub.registerBodies).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("rejects duplicate binding entries naming the path", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      const entry = {
        server: stub.url,
        bindingFingerprint: bindingFingerprint(repo),
        workspaceId: "ws-acme",
        projectId: "proj-one",
        updatedAt: new Date().toISOString(),
      };
      await writeFile(
        join(dir, "repos.json"),
        JSON.stringify({ version: 1, bindings: [entry, entry] }),
      );
      const result = await run(["start", "--repo", repo], { ORRERY_RUNNER_CONFIG_DIR: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Duplicate binding entries");
      expect(stub.registerBodies).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it("skips targets for explicit UUIDs on capped accounts", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen({ targetsStatus: 409 });
    const ws = "11111111-1111-1111-1111-111111111111";
    const pr = "22222222-2222-2222-2222-222222222222";
    try {
      await writeCredential(dir, stub.url);
      const result = await run(
        ["start", "--repo", repo, "--workspace", ws, "--project", pr, "--heartbeat-ms", "50"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(stub.requests.some((item) => item.includes("/api/runners/targets"))).toBe(false);
      expect(stub.registerBodies[0]).toMatchObject({ workspaceId: ws, projectId: pr });
    } finally {
      await stub.close();
    }
  });

  it("init saves a binding through the real CLI without registering", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    try {
      await writeCredential(dir, stub.url);
      const result = await run(
        ["init", "--repo", repo, "--workspace", "Acme", "--project", "ONE", "--agent", "Ada"],
        { ORRERY_RUNNER_CONFIG_DIR: dir },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Saved binding");
      expect(result.stdout).toContain("orrery-runner start");
      expect(stub.registerBodies).toHaveLength(0);
      expect((await stat(join(dir, "repos.json"))).mode & 0o777).toBe(0o600);
      const saved = await readReposFile(dir);
      expect(saved[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-one",
        agentId: "agent-ada",
      });
    } finally {
      await stub.close();
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { bindingFingerprint } from "./checkout.ts";
import { readReposFile, saveBinding } from "./repos.ts";
import { start } from "./start.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orrery-start-"));
  dirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orrery-start-repo-"));
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

function runnerEcho(body: {
  workspaceId: string;
  projectId: string;
  agentId?: string;
  displayName: string;
  repoFingerprint: string;
}) {
  const now = new Date().toISOString();
  return {
    id: "runner-1",
    hostId: "host-1",
    workspaceId: body.workspaceId,
    projectId: body.projectId,
    agentId: body.agentId ?? "agent-ada",
    displayName: body.displayName,
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
  };
}

interface Stub {
  url: string;
  requests: string[];
  registerBodies: Array<{
    workspaceId: string;
    projectId: string;
    agentId?: string;
    displayName: string;
  }>;
  autoClaimBodies: unknown[];
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const registerBody = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  agentId: z.string().optional(),
  displayName: z.string().optional(),
  repoFingerprint: z.string().optional(),
});

async function listen(options: { commandStatus?: number } = {}): Promise<Stub> {
  const requests: string[] = [];
  const registerBodies: Stub["registerBodies"] = [];
  const autoClaimBodies: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requests.push(`${req.method} ${req.url}`);
      const text = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += String(chunk)));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      const body = text === "" ? {} : (JSON.parse(text) as unknown);
      if (req.method === "GET" && req.url === "/api/runners/targets") {
        send(res, 200, targetsPayload);
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/register") {
        const parsed = registerBody.parse(body);
        registerBodies.push({
          workspaceId: parsed.workspaceId,
          projectId: parsed.projectId,
          ...(parsed.agentId === undefined ? {} : { agentId: parsed.agentId }),
          displayName: parsed.displayName ?? "",
        });
        send(
          res,
          201,
          runnerEcho({
            workspaceId: parsed.workspaceId,
            projectId: parsed.projectId,
            ...(parsed.agentId === undefined ? {} : { agentId: parsed.agentId }),
            displayName: parsed.displayName ?? "",
            repoFingerprint: parsed.repoFingerprint ?? "",
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-1/reconnect") {
        send(res, 200, { resolutions: [] });
        return;
      }
      if (req.method === "POST" && req.url === "/api/runners/runner-1/auto-claim") {
        autoClaimBodies.push(body);
        send(res, 200, { dispatch: null });
        return;
      }
      if (req.url?.endsWith("/heartbeat")) {
        send(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
        return;
      }
      if (req.url?.includes("/commands")) {
        // A 401 here aborts local operation immediately, so tests that must
        // reach another loop first can soften the command poll instead.
        const status = options.commandStatus ?? 401;
        send(res, status, { status, code: "invalid_credential", title: "Revoked" });
        return;
      }
      if (req.method === "PUT" && req.url === "/api/runners/runner-1/catalog") {
        send(
          res,
          200,
          runnerEcho({
            workspaceId: "ws",
            projectId: "p",
            displayName: "d",
            repoFingerprint: "f".repeat(64),
          }),
        );
        return;
      }
      send(res, 404, { status: 404, code: "not_found", title: "x" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    registerBodies,
    autoClaimBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

let savedRunnerConfigDir: string | undefined;
let savedOrreryUrl: string | undefined;

function isolateEnv(dir: string) {
  savedRunnerConfigDir = process.env.ORRERY_RUNNER_CONFIG_DIR;
  savedOrreryUrl = process.env.ORRERY_URL;
  process.env.ORRERY_RUNNER_CONFIG_DIR = dir;
  delete process.env.ORRERY_URL;
}

function restoreEnv() {
  if (savedRunnerConfigDir === undefined) delete process.env.ORRERY_RUNNER_CONFIG_DIR;
  else process.env.ORRERY_RUNNER_CONFIG_DIR = savedRunnerConfigDir;
  if (savedOrreryUrl === undefined) delete process.env.ORRERY_URL;
  else process.env.ORRERY_URL = savedOrreryUrl;
}

async function writeCredential(dir: string, server: string) {
  await writeFile(
    join(dir, "runner-credential.json"),
    JSON.stringify({
      server,
      hostId: "host-1",
      credential: "orr_rh_local-credential-1234567890",
      displayName: "TestLaptop",
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );
}

describe("start() target resolution end to end (#267)", () => {
  it("unbound human-readable flags register without writing repos.json", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    const lines: string[] = [];
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await start({
        server: stub.url,
        workspaceId: "Acme",
        projectId: "TWO",
        repoPath: repo,
        heartbeatMs: 50,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: (line) => lines.push(line),
        isTTY: false,
      });
      expect(stub.registerBodies).toHaveLength(1);
      expect(stub.registerBodies[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-two",
        agentId: "agent-ada",
        displayName: "TestLaptop · repo",
      });
      await expect(stat(join(dir, "repos.json"))).rejects.toThrow(/ENOENT/);
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("unbound picker with several agents saves a 0600 binding and registers the pick", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    const lines: string[] = [];
    const seen: string[] = [];
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await start({
        server: stub.url,
        repoPath: repo,
        heartbeatMs: 50,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: (line) => lines.push(line),
        isTTY: true,
        choose: async (title, options) => {
          seen.push(`${title} ${options.map((option) => option.label).join("|")}`);
          if (title === "Select a workspace:") return options[0]!.value;
          if (title.startsWith("Select a project")) {
            return options.find((option) => option.label.includes("One"))!.value;
          }
          return options.find((option) => option.label === "Bo")!.value;
        },
      });
      const agentPrompt = seen.find((entry) => entry.startsWith("Select an agent:"));
      expect(agentPrompt).toContain("Ada (default)");
      expect(stub.registerBodies[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-one",
        agentId: "agent-bo",
        displayName: "TestLaptop · repo",
      });
      expect((await stat(join(dir, "repos.json"))).mode & 0o777).toBe(0o600);
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-one",
        agentId: "agent-bo",
        workspaceName: "Acme",
        projectKey: "ONE",
        agentName: "Bo",
      });
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("bare --reconfigure in a bound checkout runs the picker and updates the binding", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await saveBinding(
        {
          server: stub.url,
          bindingFingerprint: bindingFingerprint(repo),
          workspaceId: "ws-acme",
          projectId: "proj-one",
          agentId: "agent-ada",
          hostId: "host-1",
          workspaceName: "Acme",
          projectKey: "ONE",
          agentName: "Ada",
          updatedAt: new Date(0).toISOString(),
        },
        dir,
      );
      let prompts = 0;
      await start({
        server: stub.url,
        repoPath: repo,
        heartbeatMs: 50,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: () => {},
        isTTY: true,
        reconfigure: true,
        choose: async (title, options) => {
          prompts += 1;
          if (title === "Select a workspace:") {
            return options.find((option) => option.label.includes("Other"))!.value;
          }
          if (title === "Select an agent:") {
            return options.find((option) => option.label.includes("Bo"))!.value;
          }
          return options[0]!.value;
        },
      });
      expect(prompts).toBeGreaterThan(0);
      expect(stub.registerBodies[0]).toMatchObject({
        workspaceId: "ws-other",
        projectId: "proj-three",
      });
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        workspaceId: "ws-other",
        projectId: "proj-three",
        agentId: "agent-bo",
      });
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("--reconfigure with explicit flags carries no stale labels", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await saveBinding(
        {
          server: stub.url,
          bindingFingerprint: bindingFingerprint(repo),
          workspaceId: "ws-acme",
          projectId: "proj-one",
          agentId: "agent-ada",
          hostId: "host-1",
          workspaceName: "Stale",
          projectKey: "STALE",
          agentName: "Stale",
          updatedAt: new Date(0).toISOString(),
        },
        dir,
      );
      await start({
        server: stub.url,
        workspaceId: "Other",
        projectId: "THREE",
        repoPath: repo,
        heartbeatMs: 50,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: () => {},
        isTTY: false,
        reconfigure: true,
      });
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        workspaceId: "ws-other",
        projectId: "proj-three",
        workspaceName: "Other",
        projectKey: "THREE",
      });
      const text = await readFile(join(dir, "repos.json"), "utf8");
      expect(text).not.toContain("Stale");
      expect(text).not.toContain("STALE");
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("an explicit --agent is preserved through the picker", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    const seen: string[] = [];
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await start({
        server: stub.url,
        agentId: "Bo",
        repoPath: repo,
        heartbeatMs: 50,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: () => {},
        isTTY: true,
        choose: async (title, options) => {
          seen.push(title);
          if (title === "Select a workspace:") return options[0]!.value;
          return options.find((option) => option.label.includes("Two"))!.value;
        },
      });
      expect(seen).not.toContain("Select an agent:");
      expect(stub.registerBodies[0]).toMatchObject({ agentId: "agent-bo" });
      const bindings = await readReposFile(dir);
      expect(bindings[0]).toMatchObject({ agentId: "agent-bo", agentName: "Bo" });
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("non-TTY unbound --workspace uuid fails before any targets call", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await expect(
        start({
          server: stub.url,
          workspaceId: "11111111-1111-1111-1111-111111111111",
          repoPath: repo,
          harnessDefinitions: [],
          write: () => {},
          isTTY: false,
        }),
      ).rejects.toThrow(/non-interactive/);
      expect(stub.requests.some((item) => item.includes("/api/runners/targets"))).toBe(false);
      expect(stub.registerBodies).toHaveLength(0);
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("forwards autoClaimLabels and omits the gate when unset (#280)", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen({ commandStatus: 404 });
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await start({
        server: stub.url,
        workspaceId: "Acme",
        projectId: "ONE",
        repoPath: repo,
        heartbeatMs: 400,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: () => {},
        isTTY: false,
        autoClaim: true,
        autoClaimLabels: ["Frontend", "urgent"],
        autoClaimPollMs: 20,
      });
      expect(stub.autoClaimBodies[0]).toMatchObject({
        filter: "assignedToMe",
        labels: ["Frontend", "urgent"],
      });

      stub.autoClaimBodies.length = 0;
      await start({
        server: stub.url,
        workspaceId: "Acme",
        projectId: "ONE",
        repoPath: repo,
        heartbeatMs: 400,
        commandWaitMs: 50,
        harnessDefinitions: [],
        write: () => {},
        isTTY: false,
        autoClaim: true,
        autoClaimPollMs: 20,
      });
      expect(stub.autoClaimBodies[0]).toMatchObject({ filter: "assignedToMe" });
      expect(stub.autoClaimBodies[0]).not.toHaveProperty("labels");
    } finally {
      restoreEnv();
      await stub.close();
    }
  });
});

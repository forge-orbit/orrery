import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { init } from "./init.ts";
import { bindingFingerprint } from "./checkout.ts";
import { readReposFile } from "./repos.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orrery-init-"));
  dirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orrery-init-repo-"));
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
  ],
  agents: [{ id: "agent-ada", name: "Ada" }],
  defaultAgentId: "agent-ada",
};

interface StubControl {
  url: string;
  requests: string[];
  registers: number;
  targetsHits: number;
  targetsStatus: number;
  close(): Promise<void>;
}

async function listen(targetsStatus = 200): Promise<StubControl> {
  const requests: string[] = [];
  let registers = 0;
  let targetsHits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/api/runners/targets") {
      targetsHits += 1;
      if (targetsStatus === 200) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(targetsPayload));
      } else {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ status: 409, code: "targets_too_large", title: "Too many targets" }),
        );
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/runners/register") {
      registers += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: 500, code: "boom", title: "must not register" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: 404, code: "not_found", title: "x" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get registers() {
      return registers;
    },
    get targetsHits() {
      return targetsHits;
    },
    targetsStatus,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
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

describe("orrery-runner init (#267)", () => {
  it("saves a flag-driven binding and exits without registering", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    const lines: string[] = [];
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await init({
        server: stub.url,
        workspace: "Acme",
        project: "ONE",
        agentId: "Ada",
        repoPath: repo,
        write: (line) => lines.push(line),
        isTTY: false,
      });
      expect(stub.registers).toBe(0);
      expect(lines.join("\n")).toContain("Saved binding");
      expect(lines.join("\n")).toContain("orrery-runner start");
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        workspaceId: "ws-acme",
        projectId: "proj-one",
        agentId: "agent-ada",
        hostId: "host-1",
        workspaceName: "Acme",
        projectKey: "ONE",
        agentName: "Ada",
      });
      expect(bindings[0]?.bindingFingerprint).toBe(bindingFingerprint(repo));
      expect((await stat(join(dir, "repos.json"))).mode & 0o777).toBe(0o600);
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("skips targets for fully explicit UUIDs so capped accounts can bind", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen(409);
    isolateEnv(dir);
    const ws = "11111111-1111-1111-1111-111111111111";
    const pr = "22222222-2222-2222-2222-222222222222";
    const ag = "33333333-3333-3333-3333-333333333333";
    try {
      await writeCredential(dir, stub.url);
      await init({
        server: stub.url,
        workspace: ws,
        project: pr,
        agentId: ag,
        repoPath: repo,
        write: () => {},
        isTTY: false,
      });
      expect(stub.targetsHits).toBe(0);
      expect(stub.registers).toBe(0);
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ workspaceId: ws, projectId: pr, agentId: ag });
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("directs capped accounts with human-readable flags to explicit UUIDs", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen(409);
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await expect(
        init({
          server: stub.url,
          workspace: "Acme",
          project: "ONE",
          repoPath: repo,
          write: () => {},
          isTTY: false,
        }),
      ).rejects.toThrow(/explicit UUIDs/);
      expect(await readReposFile(dir)).toEqual([]);
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("resolves via the injected picker in a TTY", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    const lines: string[] = [];
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      await init({
        server: stub.url,
        repoPath: repo,
        write: (line) => lines.push(line),
        isTTY: true,
        choose: async (title, options) => {
          if (title === "Select a workspace:") return options[0]!.value;
          return (options.find((option) => option.label.includes("Two")) ?? options[0]!).value;
        },
      });
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ workspaceId: "ws-acme", projectId: "proj-two" });
      expect(lines.join("\n")).toContain("Saved binding");
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("fails fast outside git without network calls", async () => {
    const dir = await makeDir();
    const stub = await listen();
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      const nonGit = await mkdtemp(join(tmpdir(), "orrery-init-nongit-"));
      dirs.push(nonGit);
      await expect(
        init({ server: stub.url, repoPath: nonGit, write: () => {}, isTTY: false }),
      ).rejects.toThrow(/not inside a git work tree/);
      expect(stub.requests).toEqual([]);
    } finally {
      restoreEnv();
      await stub.close();
    }
  });

  it("overwrites a previous binding for the checkout", async () => {
    const dir = await makeDir();
    const repo = await makeRepo();
    const stub = await listen();
    isolateEnv(dir);
    try {
      await writeCredential(dir, stub.url);
      const run = (project: string) =>
        init({
          server: stub.url,
          workspace: "Acme",
          project,
          repoPath: repo,
          write: () => {},
          isTTY: false,
        });
      await run("ONE");
      await run("TWO");
      const bindings = await readReposFile(dir);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]?.projectId).toBe("proj-two");
    } finally {
      restoreEnv();
      await stub.close();
    }
  });
});

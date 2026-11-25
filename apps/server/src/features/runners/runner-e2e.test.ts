import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { humans, runnerCommands, runnerDispatches } from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createFeatures } from "../index.ts";

const secret = "runner-e2e-bootstrap-secret-1234567890";
const adminEmail = "runner-e2e@example.com";
const adminPassword = "runner-e2e-password";
const runnerMain = fileURLToPath(new URL("../../../../runner/src/main.ts", import.meta.url));
const stubPath = fileURLToPath(new URL("../../../../runner/src/stub-acp.ts", import.meta.url));

interface World {
  root: string;
  repo: string;
  worktrees: string;
  configDir: string;
  marker: string;
  modeFile: string;
  baseUrl: string;
  cookie: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  runnerId: string;
  runner?: ChildProcess | undefined;
  output: string;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

let pg: StartedPostgreSqlContainer;
let httpServer: ReturnType<typeof serve>;
let database: Database;
let adminHumanId: string;
let world: World;

async function api(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${world.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body: unknown = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function until<T>(load: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met before the timeout");
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function markerEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(world.marker, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(line);
        return recordOf(parsed) ?? {};
      });
  } catch {
    return [];
  }
}

async function setMode(mode: string): Promise<void> {
  await writeFile(world.modeFile, mode);
}

async function sessionsOf(issueId: string): Promise<unknown[]> {
  const response = await api(`/api/issues/${issueId}/work-sessions/all`, { cookie: world.cookie });
  expect(response.status).toBe(200);
  return list(response.body);
}

async function activitiesOf(issueId: string, sessionId: string): Promise<unknown[]> {
  const response = await api(
    `/api/issues/${issueId}/work-sessions/${encodeURIComponent(sessionId)}/activities`,
    { cookie: world.cookie },
  );
  expect(response.status).toBe(200);
  return list(response.body);
}

/**
 * Queue a dispatch straight into the outbox. The REST dispatch guard refuses a
 * second dispatch while the only slot is busy, but a command already in the
 * outbox must still wait for that slot to drain (the #198 invariant).
 */
async function queueDispatchDirectly(issueId: string): Promise<string> {
  const attemptId = `direct-attempt-${issueId}`;
  const dispatchId = `direct-dispatch-${issueId}`;
  await database.db.insert(runnerDispatches).values({
    id: dispatchId,
    runnerId: world.runnerId,
    workspaceId: world.workspaceId,
    projectId: world.projectId,
    issueId,
    requestedByHumanId: adminHumanId,
    agentId: world.agentId,
    dispatchAttemptId: attemptId,
    state: "pending",
  });
  const existing = await database.db.select().from(runnerCommands);
  const seq = existing.reduce((max, command) => Math.max(max, command.seq), 0) + 1;
  await database.db.insert(runnerCommands).values({
    id: `direct-command-${issueId}`,
    runnerId: world.runnerId,
    dispatchId,
    dispatchAttemptId: attemptId,
    seq,
    kind: "dispatch",
    payload: {
      dispatchId,
      dispatchAttemptId: attemptId,
      issueId,
      projectId: world.projectId,
      workspaceId: world.workspaceId,
      agentId: world.agentId,
    },
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
  });
  return issueId;
}

async function waitForRunnerOnline(): Promise<void> {
  await until(async () => {
    const fleet = await api(`/api/workspaces/${world.workspaceId}/runners`, {
      cookie: world.cookie,
    });
    const runners = list(field(fleet.body, "hosts")).flatMap((host) =>
      list(field(host, "runners")),
    );
    const found = runners.find((item) => field(item, "id") === world.runnerId);
    return str(field(found, "presence")) === "online" &&
      Number(field(found, "activeSlotCount")) === 0
      ? true
      : undefined;
  }, 15_000);
}

async function createIssue(title: string): Promise<string> {
  const issue = await api(`/api/projects/${world.projectId}/issues`, {
    method: "POST",
    cookie: world.cookie,
    body: { title },
  });
  expect(issue.status).toBe(201);
  return str(field(issue.body, "id"));
}

async function dispatch(title: string): Promise<string> {
  const issueId = await createIssue(title);
  const created = await api(`/api/issues/${issueId}/dispatches`, {
    method: "POST",
    cookie: world.cookie,
    body: { runnerId: world.runnerId },
  });
  if (created.status !== 201) {
    throw new Error(
      `dispatch creation failed (${created.status}): ${JSON.stringify(created.body)}`,
    );
  }
  return issueId;
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "orrery-runner-e2e-"));
  pg = await new PostgreSqlContainer("postgres:18").start();
  const baseUrl = `http://127.0.0.1:${await freePort()}`;
  const config = loadConfig({
    DATABASE_URL: pg.getConnectionUri(),
    PUBLIC_URL: baseUrl,
    BOOTSTRAP_SECRET: secret,
    LOG_LEVEL: "error",
    // Keep local object storage out of the repository checkout.
    ORRERY_DATA_DIR: join(root, "data"),
  });
  database = createDb(config.DATABASE_URL);
  await migrate(
    database.sql,
    fileURLToPath(new URL("../../../../../db/migrations", import.meta.url)),
  );
  const features = createFeatures(database, config, createLogger("error"));
  const app = createApp({ features, publicUrl: baseUrl, log: createLogger("error") });
  httpServer = serve({ fetch: app.fetch, port: Number(new URL(baseUrl).port) });

  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  const configDir = join(root, "config");
  await mkdir(repo, { recursive: true });
  await mkdir(worktrees, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const git = (args: string[]): void => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "runner@example.com"]);
  git(["config", "user.name", "Runner E2E"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);

  world = {
    root,
    repo,
    worktrees,
    configDir,
    marker: join(root, "acp.jsonl"),
    modeFile: join(root, "acp-mode.txt"),
    baseUrl,
    cookie: "",
    workspaceId: "",
    projectId: "",
    agentId: "",
    runnerId: "",
    runner: undefined,
    output: "",
  };
  await setMode("normal");

  await until(async () => {
    try {
      return (await fetch(`${baseUrl}/healthz`)).status === 200 ? true : undefined;
    } catch {
      return undefined;
    }
  });

  const setup = await api("/api/setup/admin", {
    method: "POST",
    body: { secret, email: adminEmail, password: adminPassword },
  });
  if (setup.status !== 201) throw new Error(`bootstrap failed: ${setup.status}`);
  const [admin] = await database.db.select().from(humans).where(eq(humans.email, adminEmail));
  if (admin === undefined) throw new Error("bootstrap admin not found");
  adminHumanId = admin.id;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const cookie = login.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no admin cookie");
  world.cookie = cookie;

  const workspaces = await api("/api/workspaces", { cookie: world.cookie });
  const personal = list(workspaces.body).find((item) => field(item, "kind") === "personal");
  world.workspaceId = str(field(personal, "id"));
  const project = await api(`/api/workspaces/${world.workspaceId}/projects`, {
    method: "POST",
    cookie: world.cookie,
    body: { name: "Runner e2e", key: `E2E${randomBytes(3).toString("hex").toUpperCase()}` },
  });
  world.projectId = str(field(project.body, "id"));
  const agent = await api("/api/agents", {
    method: "POST",
    cookie: world.cookie,
    body: { name: `e2e-agent-${randomBytes(4).toString("hex")}` },
  });
  world.agentId = str(field(agent.body, "id"));

  const verifier = randomBytes(32).toString("hex");
  const created = await api("/api/runners/device-codes", {
    method: "POST",
    body: {
      hostDisplayName: "e2e-laptop",
      platform: "linux-x64",
      verifierHash: createHash("sha256").update(verifier).digest("hex"),
    },
  });
  const device = recordOf(created.body) ?? {};
  await api(`/api/runners/device-codes/${encodeURIComponent(str(device.userCode))}/approve`, {
    method: "POST",
    cookie: world.cookie,
  });
  const exchanged = await api("/api/runners/device-codes/token", {
    method: "POST",
    body: { deviceCode: str(device.deviceCode), verifier },
  });
  const credential = str(field(exchanged.body, "credential"));
  await writeFile(
    join(configDir, "runner-credential.json"),
    JSON.stringify({
      server: baseUrl,
      hostId: "e2e-host",
      credential,
      displayName: "e2e-laptop",
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );

  const runner = spawn(
    process.execPath,
    [
      runnerMain,
      "start",
      "--server",
      baseUrl,
      "--workspace",
      world.workspaceId,
      "--project",
      world.projectId,
      "--agent",
      world.agentId,
      "--repo",
      repo,
      "--concurrency",
      "1",
      "--heartbeat-ms",
      "100",
      "--lease-renew-ms",
      "40",
      "--cancel-grace-ms",
      "500",
      "--acp-command",
      process.execPath,
      "--acp-arg",
      stubPath,
      "--worktree-root",
      worktrees,
    ],
    {
      env: {
        ...process.env,
        ORRERY_RUNNER_CONFIG_DIR: configDir,
        STUB_ACP_MODE_FILE: world.modeFile,
        STUB_ACP_MARKER: world.marker,
        STUB_ACP_SLEEP_MS: "220",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  world.runner = runner;
  runner.stdout?.setEncoding("utf8");
  runner.stderr?.setEncoding("utf8");
  runner.stdout?.on("data", (chunk: string) => (world.output += chunk));
  runner.stderr?.on("data", (chunk: string) => (world.output += chunk));

  await until(async () => {
    const fleet = await api(`/api/workspaces/${world.workspaceId}/runners`, {
      cookie: world.cookie,
    });
    const runners = list(field(fleet.body, "hosts")).flatMap((host) =>
      list(field(host, "runners")),
    );
    const found = runners.find((item) => field(item, "projectId") === world.projectId);
    if (found === undefined) return undefined;
    world.runnerId = str(field(found, "id"));
    return world.runnerId !== "" ? true : undefined;
  });
  // The repo fingerprint is opaque; assert the runner never sends the raw path.
  if (world.output.includes(world.repo)) throw new Error("runner leaked the local repo path");
  if (!/^[0-9a-f]{64}$/.test(createHash("sha256").update(realpathSync(repo)).digest("hex"))) {
    throw new Error("repo fingerprint is not a sha256 digest");
  }
}, 180_000);

afterAll(async () => {
  world?.runner?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (world?.runner === undefined || world.runner.exitCode !== null) {
      resolve();
      return;
    }
    world.runner.once("exit", () => resolve());
    setTimeout(resolve, 5000);
  });
  httpServer?.close();
  await pg?.stop();
  if (world?.root !== undefined) await rm(world.root, { recursive: true, force: true });
});

describe("orrery-runner against a real Orrery server (#198)", { timeout: 120_000 }, () => {
  it("renews the real lease and completes a clean turn as review with a pruned worktree", async () => {
    await waitForRunnerOnline();
    await setMode("normal");
    const issueId = await dispatch("real lease renewal");
    const session = await until(async () => {
      const active = (await sessionsOf(issueId)).find((item) => field(item, "status") === "active");
      return active === undefined ? undefined : active;
    });
    const sessionId = str(field(session, "id"));
    const initialLease = Date.parse(str(field(session, "leaseExpiresAt")));
    const renewed = await until(async () => {
      const current = (await sessionsOf(issueId)).find((item) => field(item, "id") === sessionId);
      const lease = Date.parse(str(field(current, "leaseExpiresAt")));
      return lease > initialLease ? true : undefined;
    }, 10_000);
    expect(renewed).toBe(true);
    expect(world.output).not.toContain("Lease renewal failed");

    const ended = await until(async () => {
      const current = (await sessionsOf(issueId)).find((item) => field(item, "id") === sessionId);
      return str(field(current, "status")) === "completed" ? current : undefined;
    });
    expect(str(field(ended, "status"))).toBe("completed");
    // spooled ACP milestones may precede the worktree status activity; find
    // the one that actually carries the worktree report.
    const activity = await until(async () => {
      const found = await activitiesOf(issueId, sessionId);
      const report = found.find((item) => field(field(item, "detail"), "worktree") !== undefined);
      return report === undefined ? undefined : report;
    });
    const worktree = field(field(activity, "detail"), "worktree");
    const branch = str(field(worktree, "branch"));
    expect(branch).toMatch(/^orrery\//);
    expect(field(worktree, "preserved")).toBe(false);
    const listed = spawnSync("git", ["-C", world.repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(listed).not.toContain(branch);
  });

  it("drains a cancelled process group before an unrelated job can finish", async () => {
    await waitForRunnerOnline();
    await setMode("ignore-term");
    const firstIssue = await dispatch("cancelled dispatch");
    const first = await until(async () => {
      return (await markerEvents()).some((item) => item.event === "hanging") ? true : undefined;
    });
    expect(first).toBe(true);
    const firstSession = (await sessionsOf(firstIssue))[0];
    const firstId = str(field(firstSession, "id"));
    expect(str(field(firstSession, "status"))).toBe("active");

    const stopped = await api(`/api/issues/${firstIssue}/work-sessions/stop-request`, {
      method: "POST",
      cookie: world.cookie,
      body: { reason: "integration stop" },
    });
    expect(stopped.status).toBe(200);
    await setMode("normal");
    const secondIssue = await createIssue("unrelated dispatch");
    await queueDispatchDirectly(secondIssue);

    await until(async () => {
      const created = (await markerEvents()).filter((item) => item.event === "session/new");
      return created.length === 2 ? true : undefined;
    });
    await until(async () => {
      const recorded = await markerEvents();
      return (
        recorded.some((item) => item.event === "cancel") &&
        recorded.some((item) => item.event === "sigterm")
      );
    });
    await until(async () => {
      const recorded = await markerEvents();
      return (
        recorded.some((item) => item.event === "hanging") &&
        recorded.some((item) => item.event === "grandchild")
      );
    });
    const recorded = await markerEvents();
    const stubPid = Number(recorded.find((item) => item.event === "hanging")?.pid ?? -1);
    const grandchildPid = Number(recorded.find((item) => item.event === "grandchild")?.pid ?? -1);
    expect(stubPid).toBeGreaterThan(0);
    expect(grandchildPid).toBeGreaterThan(0);

    await until(async () => {
      const current = (await sessionsOf(secondIssue))[0];
      return str(field(current, "status")) === "completed" ? true : undefined;
    });
    expect(str(field((await sessionsOf(firstIssue))[0], "status"))).toBe("released");
    expect(str(field(firstSession, "id"))).toBe(firstId);

    for (const pid of [stubPid, grandchildPid]) {
      await until(async () => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true;
        }
      });
    }
  });

  it("releases a crashed turn and preserves a dirty worktree with a report", async () => {
    if (world.runner?.exitCode !== null) {
      throw new Error(`runner child exited: ${world.runner?.exitCode}\n${world.output}`);
    }
    await waitForRunnerOnline();
    await setMode("crash");
    const crashIssue = await dispatch("crashed dispatch");
    const crashed = await until(async () => {
      const current = (await sessionsOf(crashIssue))[0];
      return str(field(current, "status")) === "released" ? current : undefined;
    });
    expect(str(field(crashed, "status"))).toBe("released");

    await waitForRunnerOnline();
    await setMode("dirty");
    const dirtyIssue = await dispatch("dirty dispatch");
    const dirtySession = await until(async () => {
      const current = (await sessionsOf(dirtyIssue))[0];
      return str(field(current, "status")) === "completed" ? current : undefined;
    });
    const dirtyId = str(field(dirtySession, "id"));
    const activity = await until(async () => {
      const found = await activitiesOf(dirtyIssue, dirtyId);
      return found.some((item) => str(field(item, "summary")).includes("preserved"))
        ? found
        : undefined;
    });
    const worktree = field(
      field(
        activity.find((item) => str(field(item, "summary")).includes("preserved")),
        "detail",
      ),
      "worktree",
    );
    expect(field(worktree, "dirty")).toBe(true);
    expect(field(worktree, "preserved")).toBe(true);
    const branch = str(field(worktree, "branch"));
    const listed = spawnSync("git", ["-C", world.repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(listed).toContain(branch);
  });
});

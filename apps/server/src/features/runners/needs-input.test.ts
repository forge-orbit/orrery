import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues, questions, runnerCommands } from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createFeatures } from "../index.ts";
import { createInboxService } from "../inbox/index.ts";
import { enqueueCommandForIssue } from "./outbox.ts";

const secret = "needs-input-e2e-bootstrap-secret-1234567890";
const adminEmail = "needs-input-e2e@example.com";
const adminPassword = "needs-input-e2e-password";
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
let features: ReturnType<typeof createFeatures>;
let world: World;

async function api(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${world.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function until<T>(load: () => Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
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
      .map((line) => recordOf(JSON.parse(line)) ?? {});
  } catch {
    return [];
  }
}

async function setMode(mode: string): Promise<void> {
  await writeFile(world.modeFile, mode);
}

async function setFallbackPolicy(policy: "require_human" | "fallback_allowed"): Promise<void> {
  const response = await api(`/api/projects/${world.projectId}/fallback-policy`, {
    method: "PATCH",
    cookie: world.cookie,
    body: { fallbackPolicy: policy },
  });
  if (response.status !== 200) throw new Error(`fallback policy change failed: ${response.status}`);
}

/** Drive the real deadline sweep in one transaction, like the background tick. */
async function sweepDeadline(issueId: string): Promise<void> {
  const inbox = createInboxService({
    db: database.db,
    projectAccessCeiling: async (_tx, _workspaceId, _humanId, ids) =>
      new Map(ids.map((id) => [id, "manage" as const])),
    projectAccessAtLeast: (actual, required) => {
      const order = ["read", "contribute", "manage"];
      return order.indexOf(actual) >= order.indexOf(required);
    },
    deliver: async () => {},
    log: createLogger("error"),
    onRunnerCommand: enqueueCommandForIssue,
  });
  await database.db.transaction(async (tx) => {
    // Real callers (ask/answer/stop) hold the issue lock before evaluating a
    // deadline; mirror that order so a racing lease renewal cannot AB-BA.
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .for("update");
    await inbox.evaluateDeadline(tx, issueId);
  });
}

async function waitForIdleRunner(): Promise<void> {
  await until(async () => {
    const response = await api(`/api/workspaces/${world.workspaceId}/runners`, {
      cookie: world.cookie,
    });
    const found = list(field(response.body, "hosts"))
      .flatMap((host) => list(field(host, "runners")))
      .find((item) => str(field(item, "id")) === world.runnerId);
    return Number(field(found, "activeSlotCount")) === 0 ? true : undefined;
  });
}

async function dispatch(title: string): Promise<string> {
  const created = await api(`/api/projects/${world.projectId}/issues`, {
    method: "POST",
    cookie: world.cookie,
    body: { title },
  });
  if (created.status !== 201) throw new Error(`issue creation failed: ${created.status}`);
  const issueId = str(field(created.body, "id"));
  const dispatched = await api(`/api/issues/${issueId}/dispatches`, {
    method: "POST",
    cookie: world.cookie,
    body: { runnerId: world.runnerId },
  });
  if (dispatched.status !== 201) throw new Error(`dispatch failed: ${dispatched.status}`);
  return issueId;
}

async function questionFor(issueId: string): Promise<Record<string, unknown>> {
  return await until(async () => {
    const response = await api(`/api/issues/${issueId}/questions`, { cookie: world.cookie });
    const found = list(response.body).find((item) => field(item, "status") === "open");
    return found === undefined ? undefined : recordOf(found);
  });
}

async function sessionFor(issueId: string): Promise<Record<string, unknown>> {
  return await until(async () => {
    const response = await api(`/api/issues/${issueId}/work-sessions/all`, {
      cookie: world.cookie,
    });
    const found = list(response.body).find((item) => field(item, "status") === "active");
    return found === undefined ? undefined : recordOf(found);
  });
}

async function sessionsFor(issueId: string): Promise<unknown[]> {
  const response = await api(`/api/issues/${issueId}/work-sessions/all`, { cookie: world.cookie });
  expect(response.status).toBe(200);
  return list(response.body);
}

async function settledSession(issueId: string): Promise<Record<string, unknown>> {
  return await until(async () => {
    const response = await api(`/api/issues/${issueId}/work-sessions/all`, {
      cookie: world.cookie,
    });
    const found = list(response.body).find((item) => str(field(item, "status")) !== "active");
    return found === undefined ? undefined : recordOf(found);
  });
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "orrery-needs-input-e2e-"));
  pg = await new PostgreSqlContainer("postgres:18").start();
  const baseUrl = `http://127.0.0.1:${await freePort()}`;
  const config = loadConfig({
    DATABASE_URL: pg.getConnectionUri(),
    PUBLIC_URL: baseUrl,
    BOOTSTRAP_SECRET: secret,
    LOG_LEVEL: "error",
    ORRERY_DATA_DIR: join(root, "data"),
  });
  database = createDb(config.DATABASE_URL);
  await migrate(
    database.sql,
    fileURLToPath(new URL("../../../../../db/migrations", import.meta.url)),
  );
  features = createFeatures(database, config, createLogger("error"));
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
  git(["config", "user.name", "Needs Input E2E"]);
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
    output: "",
  };
  await setMode("normal");
  await until(async () => ((await fetch(`${baseUrl}/healthz`)).status === 200 ? true : undefined));

  const setup = await api("/api/setup/admin", {
    method: "POST",
    body: { secret, email: adminEmail, password: adminPassword },
  });
  if (setup.status !== 201) throw new Error(`bootstrap failed: ${setup.status}`);
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
    body: { name: "Needs input e2e" },
  });
  world.projectId = str(field(project.body, "id"));
  const agent = await api("/api/agents", {
    method: "POST",
    cookie: world.cookie,
    body: { name: `needs-input-agent-${randomBytes(4).toString("hex")}` },
  });
  world.agentId = str(field(agent.body, "id"));

  const verifier = randomBytes(32).toString("hex");
  const device = await api("/api/runners/device-codes", {
    method: "POST",
    body: {
      hostDisplayName: "needs-input-laptop",
      platform: "linux-x64",
      verifierHash: createHash("sha256").update(verifier).digest("hex"),
    },
  });
  const issued = recordOf(device.body) ?? {};
  await api(`/api/runners/device-codes/${encodeURIComponent(str(issued.userCode))}/approve`, {
    method: "POST",
    cookie: world.cookie,
  });
  const exchanged = await api("/api/runners/device-codes/token", {
    method: "POST",
    body: { deviceCode: str(issued.deviceCode), verifier },
  });
  await writeFile(
    join(configDir, "runner-credential.json"),
    JSON.stringify({
      server: baseUrl,
      hostId: "needs-input-host",
      credential: str(field(exchanged.body, "credential")),
      displayName: "needs-input-laptop",
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );

  world.runner = spawn(
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
      "300",
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
        STUB_ACP_SLEEP_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  world.runner.stdout?.setEncoding("utf8");
  world.runner.stderr?.setEncoding("utf8");
  world.runner.stdout?.on("data", (chunk: string) => (world.output += chunk));
  world.runner.stderr?.on("data", (chunk: string) => (world.output += chunk));

  const fleet = await until(async () => {
    const response = await api(`/api/workspaces/${world.workspaceId}/runners`, {
      cookie: world.cookie,
    });
    const found = list(field(response.body, "hosts"))
      .flatMap((host) => list(field(host, "runners")))
      .find((item) => field(item, "projectId") === world.projectId);
    return found === undefined ? undefined : str(field(found, "id"));
  });
  world.runnerId = fleet;
}, 180_000);

afterAll(async () => {
  world?.runner?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (world?.runner === undefined || world.runner.exitCode !== null) return resolve();
    world.runner.once("exit", () => resolve());
    setTimeout(resolve, 5000);
  });
  httpServer?.close();
  for (const feature of features ?? []) await feature.stop?.();
  await database?.sql.end();
  await pg?.stop();
  if (world?.root !== undefined) await rm(world.root, { recursive: true, force: true });
});

describe(
  "Needs Input round-trip against real Postgres, HTTP, Runner and stub ACP (#201)",
  { timeout: 120_000 },
  () => {
    it("parks on ask_for_input, resumes in the same worktree on a human answer and hands off as review", async () => {
      await waitForIdleRunner();
      await setMode("needs-input");
      const issueId = await dispatch("human answer resumes parked ACP");
      const question = await questionFor(issueId);
      const questionId = str(question.id);
      expect(str(question.issueId)).toBe(issueId);
      const session = await sessionFor(issueId);
      const sessionId = str(session.id);
      const leaseAtPark = Date.parse(str(session.leaseExpiresAt));
      const renewed = await until(async () => {
        const stillParked = await sessionFor(issueId);
        return Date.parse(str(stillParked.leaseExpiresAt)) > leaseAtPark ? true : undefined;
      }, 8000);
      expect(renewed).toBe(true);

      const answered = await api(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
        method: "POST",
        cookie: world.cookie,
        body: { answer: "Use the additive migration" },
      });
      expect(answered.status).toBe(200);
      const settled = await settledSession(issueId);
      expect(str(field(settled, "status"))).toBe("completed");
      const recorded = (await markerEvents()).filter((item) => item.event === "prompt");
      const prompts = recorded.filter((item) => typeof item.turn === "number");
      expect(prompts).toHaveLength(2);
      expect(str(prompts[0]?.cwd)).toBe(str(prompts[1]?.cwd));
      expect(str(prompts[1]?.text)).toContain("Use the additive migration");

      const commands = await database.db.select().from(runnerCommands);
      const resolved = commands.find(
        (row) => row.kind === "input_resolved" && row.payload.issueId === issueId,
      );
      expect(resolved?.payload).toMatchObject({
        issueId,
        questionId,
        resolution: "answered",
        answer: "Use the additive migration",
      });
      expect(str(field(settled, "id"))).toBe(sessionId);
    });

    it("resolves a deadline as fallback_used, enqueues input_resolved in-tx and resumes as review", async () => {
      await waitForIdleRunner();
      await setMode("needs-input");
      await setFallbackPolicy("fallback_allowed");
      const markerBefore = (await markerEvents()).length;
      const outputBefore = world.output.length;
      const issueId = await dispatch("fallback resumes parked ACP");
      const question = await questionFor(issueId);
      const questionId = str(question.id);
      await sessionFor(issueId);
      // Wait for the runner to finish turn 1 and enter the parked state before
      // expiring the deadline so the sweep cannot race ahead of parking.
      await until(
        async () =>
          world.output.slice(outputBefore).includes(`Question ${questionId} is open; parked`)
            ? true
            : undefined,
        8000,
      );

      // The deadline is one hour in production; move only this question past it.
      await database.db
        .update(questions)
        .set({
          createdAt: sql`statement_timestamp() - interval '2 hours'`,
          responseDeadlineAt: sql`statement_timestamp() - interval '1 hour'`,
        })
        .where(eq(questions.id, questionId));
      // The same transaction resolves the question as fallback_used and enqueues
      // the wake command, exactly as the background deadline tick does.
      await sweepDeadline(issueId);
      const settled = await settledSession(issueId);
      expect(str(field(settled, "status"))).toBe("completed");
      const commands = await database.db.select().from(runnerCommands);
      const resolved = commands.find(
        (row) => row.kind === "input_resolved" && row.payload.issueId === issueId,
      );
      expect(resolved?.payload).toMatchObject({
        questionId,
        resolution: "fallback_used",
        answer: "Use the additive migration",
      });
      const followUp = (await markerEvents())
        .slice(markerBefore)
        .find((item) => item.event === "prompt" && item.turn === 2);
      expect(str(followUp?.text)).toContain("deadline passed");
    });

    it("require_human deadline pauses, releases the claim, cancels the Runner and preserves the worktree", async () => {
      await waitForIdleRunner();
      await setFallbackPolicy("require_human");
      await setMode("needs-input");
      const outputBefore = world.output.length;
      const issueId = await dispatch("require human deadline pauses");
      const question = await questionFor(issueId);
      const questionId = str(question.id);
      const session = await sessionFor(issueId);
      const sessionId = str(session.id);

      await database.db
        .update(questions)
        .set({
          createdAt: sql`statement_timestamp() - interval '2 hours'`,
          responseDeadlineAt: sql`statement_timestamp() - interval '1 hour'`,
        })
        .where(eq(questions.id, questionId));
      await sweepDeadline(issueId);

      const paused = await until(async () => {
        const response = await api(`/api/issues/${issueId}/questions`, { cookie: world.cookie });
        const found = list(response.body).find((item) => str(field(item, "id")) === questionId);
        return str(field(found, "status")) === "paused" ? found : undefined;
      });
      expect(paused).toBeDefined();
      const ended = await until(async () => {
        const response = await api(`/api/issues/${issueId}/work-sessions/all`, {
          cookie: world.cookie,
        });
        const found = list(response.body).find((item) => str(field(item, "id")) === sessionId);
        return str(field(found, "status")) !== "active" ? found : undefined;
      });
      expect(["released", "expired"]).toContain(str(field(ended, "status")));

      const commands = await database.db.select().from(runnerCommands);
      const cancel = commands.find(
        (row) => row.kind === "cancel" && row.payload.issueId === issueId,
      );
      expect(cancel?.payload).toMatchObject({ reason: "question_paused" });
      const preserved = await until(async () =>
        world.output.slice(outputBefore).includes("question deadline paused") ? true : undefined,
      );
      expect(preserved).toBe(true);
      expect(world.output.slice(outputBefore)).not.toContain("Stopped work session as review.");
      const worktreeList = spawnSync("git", ["-C", world.repo, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      }).stdout;
      expect(worktreeList).toContain("orrery/");
    });

    it("answering a paused question clears Needs input so a fresh dispatch resumes as review", async () => {
      await waitForIdleRunner();
      await setFallbackPolicy("require_human");
      await setMode("needs-input");
      const issueId = await dispatch("pause then re-dispatch");
      const question = await questionFor(issueId);
      const questionId = str(question.id);
      await sessionFor(issueId);
      await database.db
        .update(questions)
        .set({
          createdAt: sql`statement_timestamp() - interval '2 hours'`,
          responseDeadlineAt: sql`statement_timestamp() - interval '1 hour'`,
        })
        .where(eq(questions.id, questionId));
      await sweepDeadline(issueId);
      await until(async () => {
        const response = await api(`/api/issues/${issueId}/questions`, { cookie: world.cookie });
        const found = list(response.body).find((item) => str(field(item, "id")) === questionId);
        return str(field(found, "status")) === "paused" ? true : undefined;
      });
      await waitForIdleRunner();

      const previousIds = new Set(
        (await sessionsFor(issueId)).map((item) => str(field(item, "id"))),
      );
      await setMode("normal");
      const answered = await api(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
        method: "POST",
        cookie: world.cookie,
        body: { answer: "Resume with the additive migration" },
      });
      expect(answered.status).toBe(200);
      const created = await api(`/api/issues/${issueId}/dispatches`, {
        method: "POST",
        cookie: world.cookie,
        body: { runnerId: world.runnerId },
      });
      expect(created.status).toBe(201);
      const resumed = await until(async () => {
        const session = (await sessionsFor(issueId)).find(
          (item) =>
            !previousIds.has(str(field(item, "id"))) && str(field(item, "status")) !== "active",
        );
        return session === undefined ? undefined : session;
      });
      expect(str(field(resumed, "status"))).toBe("completed");
      expect(previousIds.has(str(field(resumed, "id")))).toBe(false);
    });
  },
);

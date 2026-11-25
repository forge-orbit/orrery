import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  humans,
  issues,
  projectAccessGrants,
  projects,
  runnerDispatches,
  runners,
  workSessions,
  workspaceMemberships,
} from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createFeatures } from "../index.ts";

const secret = "runner-auto-claim-bootstrap-secret-123456789";
const adminEmail = "runner-auto-claim@example.com";
const adminPassword = "runner-auto-claim-password";
const runnerMain = fileURLToPath(new URL("../../../../runner/src/main.ts", import.meta.url));
const stubPath = fileURLToPath(new URL("../../../../runner/src/stub-acp.ts", import.meta.url));

interface World {
  root: string;
  repo: string;
  worktrees: string;
  configDir: string;
  baseUrl: string;
  cookie: string;
  credential: string;
  workspaceA: string;
  workspaceB: string;
  projectA: string;
  projectB: string;
  keyA: string;
  agentId: string;
  otherAgentId: string;
  humanId: string;
  testRunnerId: string;
  privateWorkspaceId: string;
  readOnlyIssueId: string;
}

let pg: StartedPostgreSqlContainer;
let httpServer: ReturnType<typeof serve>;
let database: Database;
let world: World;
let baseUrl = "";
const children: ChildProcess[] = [];

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

async function api(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
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

async function until<T>(load: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met before the timeout");
}

interface IssueOptions {
  projectId?: string;
  agentId?: string | null;
  status?: string;
  blockedBy?: string;
  trashed?: boolean;
}

async function makeIssue(
  title: string,
  options: IssueOptions = {},
): Promise<{ id: string; number: number; identifier: string }> {
  const created = await api(`/api/projects/${options.projectId ?? world.projectA}/issues`, {
    method: "POST",
    cookie: world.cookie,
    body: {
      title,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.agentId === undefined
        ? {}
        : { assignee: options.agentId === null ? null : { type: "agent", id: options.agentId } }),
    },
  });
  if (created.status !== 201)
    throw new Error(`create issue failed: ${JSON.stringify(created.body)}`);
  const id = str(field(created.body, "id"));
  const number = Number(field(created.body, "number"));
  if (options.blockedBy !== undefined) {
    const blocked = await api(`/api/issues/${id}/blocked-by`, {
      method: "POST",
      cookie: world.cookie,
      body: { blockedByIssueId: options.blockedBy },
    });
    if (blocked.status !== 201)
      throw new Error(`blocked-by failed: ${JSON.stringify(blocked.body)}`);
  }
  if (options.trashed === true) {
    const trashed = await api(`/api/issues/${id}`, { method: "DELETE", cookie: world.cookie });
    if (trashed.status < 200 || trashed.status >= 300) {
      throw new Error(`trash failed: ${JSON.stringify(trashed.body)}`);
    }
  }
  return {
    id,
    number,
    identifier: str(field(created.body, "identifier")),
  };
}

async function sessionsOf(issueId: string): Promise<unknown[]> {
  const response = await api(`/api/issues/${issueId}/work-sessions/all`, { cookie: world.cookie });
  return list(response.body);
}

async function dispatchesOf(issueId: string): Promise<unknown[]> {
  const response = await api(`/api/issues/${issueId}/dispatches`, { cookie: world.cookie });
  return list(field(response.body, "dispatches"));
}

async function streamOf(runnerId: string, dispatchId: string): Promise<unknown[]> {
  const response = await api(
    `/api/runners/${runnerId}/dispatches/${dispatchId}/stream?afterSeq=0`,
    { cookie: world.cookie },
  );
  if (response.status !== 200)
    throw new Error(`stream read failed: ${JSON.stringify(response.body)}`);
  return list(field(response.body, "chunks"));
}

async function registerHostRunner(maxConcurrency: number): Promise<string> {
  const response = await api("/api/runners/register", {
    method: "POST",
    token: world.credential,
    body: {
      workspaceId: world.workspaceA,
      projectId: world.projectA,
      agentId: world.agentId,
      repoFingerprint: createHash("sha256").update(randomBytes(32)).digest("hex"),
      capabilities: [],
      maxConcurrency,
      ephemeral: false,
    },
  });
  if (response.status !== 201) throw new Error(`register failed: ${JSON.stringify(response.body)}`);
  return str(field(response.body, "id"));
}

function spawnCli(
  args: string[],
  env: Record<string, string> = {},
): { child: ChildProcess; output: () => string; done: Promise<number | null> } {
  const child = spawn(process.execPath, [runnerMain, ...args], {
    env: {
      ...process.env,
      ORRERY_RUNNER_CONFIG_DIR: world.configDir,
      STUB_ACP_MARKER: join(world.root, `stub-${randomBytes(4).toString("hex")}.jsonl`),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (output += chunk));
  child.stderr?.on("data", (chunk: string) => (output += chunk));
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  return { child, output: () => output, done };
}

let worldRoot = "";
const acpArgs = (): string[] => [
  "--acp-command",
  process.execPath,
  "--acp-arg",
  stubPath,
  "--worktree-root",
  worldRoot,
];

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "orrery-auto-claim-"));
  worldRoot = join(root, "worktrees");
  pg = await new PostgreSqlContainer("postgres:18").start();
  baseUrl = `http://127.0.0.1:${await freePort()}`;
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
  const features = createFeatures(database, config, createLogger("error"));
  const app = createApp({ features, publicUrl: baseUrl, log: createLogger("error") });
  httpServer = serve({ fetch: app.fetch, port: Number(new URL(baseUrl).port) });

  const repo = join(root, "repo");
  const configDir = join(root, "config");
  await mkdir(repo, { recursive: true });
  await mkdir(worldRoot, { recursive: true });
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

  await until(async () => ((await fetch(`${baseUrl}/healthz`)).status === 200 ? true : undefined));
  const setup = await api("/api/setup/admin", {
    method: "POST",
    body: { secret, email: adminEmail, password: adminPassword },
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);
  const [admin] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, adminEmail))
    .limit(1);
  if (admin === undefined) throw new Error("bootstrap admin not found");
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

  world = {
    root,
    repo,
    worktrees: worldRoot,
    configDir,
    baseUrl,
    cookie,
    credential: "",
    workspaceA: "",
    workspaceB: "",
    projectA: "",
    projectB: "",
    keyA: `AC${randomBytes(3).toString("hex").toUpperCase()}`,
    agentId: "",
    otherAgentId: "",
    humanId: admin.id,
    testRunnerId: "",
    privateWorkspaceId: "",
    readOnlyIssueId: "",
  };

  const workspaceList = await api("/api/workspaces", { cookie });
  world.workspaceA = str(
    field(
      list(workspaceList.body).find((item) => field(item, "kind") === "personal"),
      "id",
    ),
  );
  const shared = await api("/api/workspaces", {
    method: "POST",
    cookie,
    body: { name: "Auto claim shared" },
  });
  if (shared.status !== 201) throw new Error(`shared failed: ${JSON.stringify(shared.body)}`);
  world.workspaceB = str(field(shared.body, "id"));
  const projectA = await api(`/api/workspaces/${world.workspaceA}/projects`, {
    method: "POST",
    cookie,
    body: { name: "Auto claim A", key: world.keyA },
  });
  if (projectA.status !== 201) throw new Error(`projectA failed: ${JSON.stringify(projectA.body)}`);
  world.projectA = str(field(projectA.body, "id"));
  const projectB = await api(`/api/workspaces/${world.workspaceB}/projects`, {
    method: "POST",
    cookie,
    body: { name: "Auto claim B", key: world.keyA },
  });
  if (projectB.status !== 201) throw new Error(`projectB failed: ${JSON.stringify(projectB.body)}`);
  world.projectB = str(field(projectB.body, "id"));
  const agent = await api("/api/agents", {
    method: "POST",
    cookie,
    body: { name: `auto-agent-${randomBytes(4).toString("hex")}` },
  });
  if (agent.status !== 201) throw new Error(`agent failed: ${JSON.stringify(agent.body)}`);
  world.agentId = str(field(agent.body, "id"));
  const other = await api("/api/agents", {
    method: "POST",
    cookie,
    body: { name: `other-agent-${randomBytes(4).toString("hex")}` },
  });
  if (other.status !== 201) throw new Error(`other failed: ${JSON.stringify(other.body)}`);
  world.otherAgentId = str(field(other.body, "id"));
  // An Agent is only assignable in a workspace where it holds a live key.
  const issueKey = async (agentId: string, workspaceId: string, projectId: string) => {
    const key = await api("/api/agents/keys", {
      method: "POST",
      cookie,
      body: {
        agentId,
        workspaceId,
        validity: "90",
        projects: [{ projectId, level: "contribute" as const }],
      },
    });
    if (key.status !== 201) throw new Error(`agent key failed: ${JSON.stringify(key.body)}`);
  };
  await issueKey(world.agentId, world.workspaceA, world.projectA);
  await issueKey(world.otherAgentId, world.workspaceA, world.projectA);
  await issueKey(world.agentId, world.workspaceB, world.projectB);

  // A foreign workspace plus a workspace the host may enter but where its
  // project grant is Read-only: both must look exactly like "no such issue".
  const outsiderId = `outsider-${randomUUID()}`;
  await database.db.insert(humans).values({
    id: outsiderId,
    email: "outsider-auto@example.com",
    handle: "outsider-auto",
    displayName: "Outsider",
    passwordHash: "not-used-in-this-test",
  });
  // The API creates each shared workspace together with an owner membership,
  // satisfying the DB-time "at least one owner" constraint trigger.
  const privateWorkspace = await api("/api/workspaces", {
    method: "POST",
    cookie,
    body: { name: "Foreign workspace" },
  });
  if (privateWorkspace.status !== 201)
    throw new Error(`workspace failed: ${JSON.stringify(privateWorkspace.body)}`);
  world.privateWorkspaceId = str(field(privateWorkspace.body, "id"));
  const readWorkspace = await api("/api/workspaces", {
    method: "POST",
    cookie,
    body: { name: "Read-only workspace" },
  });
  if (readWorkspace.status !== 201)
    throw new Error(`workspace failed: ${JSON.stringify(readWorkspace.body)}`);
  const readWorkspaceId = str(field(readWorkspace.body, "id"));
  await database.db.insert(workspaceMemberships).values([
    {
      id: `owner-membership-${randomUUID()}`,
      workspaceId: world.privateWorkspaceId,
      humanId: outsiderId,
      isOwner: true,
    },
    {
      id: `owner-membership-${randomUUID()}`,
      workspaceId: readWorkspaceId,
      humanId: outsiderId,
      isOwner: true,
    },
  ]);
  // The host owner no longer belongs to the foreign workspace, and is a plain
  // member (not an implicit owner) of the read-only one.
  await database.db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, world.privateWorkspaceId),
        eq(workspaceMemberships.humanId, admin.id),
      ),
    );
  await database.db
    .update(workspaceMemberships)
    .set({ isOwner: false })
    .where(
      and(
        eq(workspaceMemberships.workspaceId, readWorkspaceId),
        eq(workspaceMemberships.humanId, admin.id),
      ),
    );
  const readProjectId = `read-project-${randomUUID()}`;
  await database.db.insert(projects).values({
    id: readProjectId,
    workspaceId: readWorkspaceId,
    name: "Read-only project",
    key: `RD${randomBytes(3).toString("hex").toUpperCase()}`,
    createdByHumanId: outsiderId,
  });
  await database.db.insert(projectAccessGrants).values({
    id: `grant-${randomUUID()}`,
    projectId: readProjectId,
    humanId: admin.id,
    level: "read",
    grantedByHumanId: outsiderId,
  });
  world.readOnlyIssueId = `read-issue-${randomUUID()}`;
  await database.db.insert(issues).values({
    id: world.readOnlyIssueId,
    projectId: readProjectId,
    number: 1,
    title: "Not resolvable without Contribute",
    status: "todo",
    sortOrder: 65535,
    createdByHumanId: outsiderId,
    updatedByHumanId: outsiderId,
  });

  const verifier = randomBytes(32).toString("hex");
  const created = await api("/api/runners/device-codes", {
    method: "POST",
    body: {
      hostDisplayName: "auto-laptop",
      platform: "linux-x64",
      verifierHash: createHash("sha256").update(verifier).digest("hex"),
    },
  });
  const device = recordOf(created.body) ?? {};
  await api(`/api/runners/device-codes/${encodeURIComponent(str(device.userCode))}/approve`, {
    method: "POST",
    cookie,
  });
  const exchanged = await api("/api/runners/device-codes/token", {
    method: "POST",
    body: { deviceCode: str(device.deviceCode), verifier },
  });
  if (exchanged.status !== 200)
    throw new Error(`exchanged failed: ${JSON.stringify(exchanged.body)}`);
  world.credential = str(field(exchanged.body, "credential"));
  await writeFile(
    join(configDir, "runner-credential.json"),
    JSON.stringify({
      server: baseUrl,
      hostId: "auto-host",
      credential: world.credential,
      displayName: "auto-laptop",
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );
  world.testRunnerId = await registerHostRunner(2);
}, 180_000);

afterAll(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  httpServer?.close();
  await pg?.stop();
  if (world?.root !== undefined) await rm(world.root, { recursive: true, force: true });
});

describe("Runner --auto-claim and one-shot work (#202)", { timeout: 180_000 }, () => {
  it("start --auto-claim defaults to assignedToMe and streams through the Studio", async () => {
    const blocker = await makeIssue("unassigned blocker");
    const assigned = await makeIssue("assigned to default agent", { agentId: world.agentId });
    const unassigned = await makeIssue("unassigned human issue");
    const other = await makeIssue("assigned to another agent", { agentId: world.otherAgentId });
    const blocked = await makeIssue("blocked assigned issue", {
      agentId: world.agentId,
      blockedBy: blocker.id,
    });
    const done = await makeIssue("done assigned issue", { agentId: world.agentId, status: "done" });
    const trashed = await makeIssue("trashed assigned issue", {
      agentId: world.agentId,
      trashed: true,
    });
    const uncertain = await makeIssue("uncertain assigned issue", { agentId: world.agentId });
    // Reach a real uncertain attempt through the accepted-Dispatch path, then
    // mark it uncertain exactly as a missed heartbeat would.
    const createdDispatch = await api(`/api/runners/${world.testRunnerId}/dispatches`, {
      method: "POST",
      token: world.credential,
      body: { issueId: uncertain.id },
    });
    if (createdDispatch.status !== 201) {
      throw new Error(`uncertain setup failed: ${JSON.stringify(createdDispatch.body)}`);
    }
    const uncertainDispatchId = str(field(createdDispatch.body, "id"));
    const accepted = await api(
      `/api/runners/${world.testRunnerId}/dispatches/${uncertainDispatchId}/accept`,
      { method: "POST", token: world.credential },
    );
    if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
    await database.db
      .update(runnerDispatches)
      .set({ state: "uncertain" })
      .where(eq(runnerDispatches.id, uncertainDispatchId));

    const started = spawnCli([
      "start",
      "--server",
      world.baseUrl,
      "--workspace",
      world.workspaceA,
      "--project",
      world.projectA,
      "--agent",
      world.agentId,
      "--repo",
      world.repo,
      "--concurrency",
      "1",
      "--heartbeat-ms",
      "100",
      "--auto-claim",
      "--auto-claim-poll-ms",
      "100",
      "--lease-renew-ms",
      "60",
      "--cancel-grace-ms",
      "500",
      ...acpArgs(),
    ]);
    try {
      const session = await until(async () => {
        const current = (await sessionsOf(assigned.id)).find(
          (item) => field(item, "status") === "completed",
        );
        return current === undefined ? undefined : current;
      }, 30_000);
      expect(field(session, "issueId")).toBe(assigned.id);
      for (const issue of [unassigned, other, blocked, done, trashed]) {
        expect(await sessionsOf(issue.id)).toHaveLength(0);
        expect(await dispatchesOf(issue.id)).toHaveLength(0);
      }
      // The uncertain attempt keeps its single pre-existing Dispatch/session.
      expect(await dispatchesOf(uncertain.id)).toHaveLength(1);
      const dispatch = (await dispatchesOf(assigned.id))[0];
      expect(recordOf(dispatch)).toBeDefined();
      const chunks = await streamOf(str(field(dispatch, "runnerId")), str(field(dispatch, "id")));
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((chunk) => field(chunk, "kind") === "event")).toBe(true);
    } finally {
      started.child.kill("SIGTERM");
      await Promise.race([started.done, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    }
  });

  it("auto-claim filters unassigned/all and refuses work when slots are full", async () => {
    // A dedicated project keeps the filter assertions exact, independent of
    // issues left behind by the CLI auto-claim test.
    const key = `FL${randomBytes(3).toString("hex").toUpperCase()}`;
    const project = await api(`/api/workspaces/${world.workspaceA}/projects`, {
      method: "POST",
      cookie: world.cookie,
      body: { name: "Filter project", key },
    });
    if (project.status !== 201) throw new Error(`project failed: ${JSON.stringify(project.body)}`);
    const projectId = str(field(project.body, "id"));
    const runnerId = await api("/api/runners/register", {
      method: "POST",
      token: world.credential,
      body: {
        workspaceId: world.workspaceA,
        projectId,
        agentId: world.agentId,
        repoFingerprint: createHash("sha256").update(randomBytes(32)).digest("hex"),
        capabilities: [],
        maxConcurrency: 2,
        ephemeral: false,
      },
    });
    if (runnerId.status !== 201)
      throw new Error(`register failed: ${JSON.stringify(runnerId.body)}`);
    const testRunner = str(field(runnerId.body, "id"));
    const unassigned = await makeIssue("filter unassigned", { projectId });
    const assigned = await makeIssue("filter assigned", { projectId, agentId: world.agentId });

    const claim = (filter: string) =>
      api(`/api/runners/${testRunner}/auto-claim`, {
        method: "POST",
        token: world.credential,
        body: { filter },
      });

    const first = await claim("unassigned");
    expect(first.status).toBe(200);
    expect(str(field(field(first.body, "dispatch"), "issueId"))).toBe(unassigned.id);

    const second = await claim("all");
    expect(second.status).toBe(200);
    expect(str(field(field(second.body, "dispatch"), "issueId"))).toBe(assigned.id);

    // Two pending attempts already occupy maxConcurrency=2; a third is refused.
    const full = await claim("all");
    expect(full.status).toBe(200);
    expect(field(full.body, "dispatch")).toBeNull();

    await api(`/api/runners/${testRunner}/heartbeat`, {
      method: "POST",
      token: world.credential,
      body: { activeSlotCount: 2 },
    });
    const heartbeatFull = await claim("unassigned");
    expect(heartbeatFull.status).toBe(200);
    expect(field(heartbeatFull.body, "dispatch")).toBeNull();
  });

  it("resolves issues by ID, URL and KEY and disambiguates ambiguous keys", async () => {
    const target = await makeIssue("resolve me");
    const ambiguous = await makeIssue("ambiguous", { projectId: world.projectB });

    const byId = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: target.id },
    });
    expect(byId.status).toBe(200);
    expect(str(field(byId.body, "issueId"))).toBe(target.id);

    const byUrl = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: `${world.baseUrl}/issues/${target.id}` },
    });
    expect(byUrl.status).toBe(200);
    expect(str(field(byUrl.body, "issueId"))).toBe(target.id);

    const key = `${world.keyA}-${ambiguous.number}`;
    const ambiguousResult = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: key },
    });
    expect(ambiguousResult.status).toBe(409);
    expect(str(field(ambiguousResult.body, "code"))).toBe("issue_ambiguous");
    expect(str(field(ambiguousResult.body, "detail"))).toContain(world.workspaceA);
    expect(str(field(ambiguousResult.body, "detail"))).toContain(world.workspaceB);

    const chosen = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: key, workspace: world.workspaceB },
    });
    expect(chosen.status).toBe(200);
    expect(str(field(chosen.body, "issueId"))).toBe(ambiguous.id);
  });

  it("one-shot work completes by ID, flushes streams and tears down the Runner", async () => {
    const issue = await makeIssue("one-shot by id", { agentId: world.agentId });
    const result = spawnCli([
      "work",
      issue.id,
      "--server",
      world.baseUrl,
      "--repo",
      world.repo,
      "--lease-renew-ms",
      "60",
      "--cancel-grace-ms",
      "500",
      ...acpArgs(),
    ]);
    const code = await Promise.race([
      result.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(code).toBe(0);

    const session = (await sessionsOf(issue.id))[0];
    expect(str(field(session, "status"))).toBe("completed");
    const dispatch = (await dispatchesOf(issue.id))[0];
    expect(recordOf(dispatch)).toBeDefined();
    expect(
      (await streamOf(str(field(dispatch, "runnerId")), str(field(dispatch, "id")))).length,
    ).toBeGreaterThan(0);
    const runnerRow = await database.db
      .select({ revokedAt: runners.revokedAt })
      .from(runners)
      .where(eq(runners.id, str(field(dispatch, "runnerId"))))
      .limit(1);
    expect(runnerRow[0]?.revokedAt).not.toBeNull();
  });

  it("one-shot work resolves URLs and disambiguated keys, and fails cleanly on ambiguity", async () => {
    const byUrlIssue = await makeIssue("one-shot by url", { agentId: world.agentId });
    const urlRun = spawnCli([
      "work",
      `${world.baseUrl}/issues/${byUrlIssue.id}`,
      "--server",
      world.baseUrl,
      "--repo",
      world.repo,
      ...acpArgs(),
    ]);
    const urlCode = await Promise.race([
      urlRun.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(urlCode).toBe(0);
    expect(str(field((await sessionsOf(byUrlIssue.id))[0], "status"))).toBe("completed");

    const ambiguous = await makeIssue("one-shot ambiguous", {
      projectId: world.projectB,
      agentId: world.agentId,
    });
    const key = `${world.keyA}-${ambiguous.number}`;
    const ambiguousRun = spawnCli([
      "work",
      key,
      "--server",
      world.baseUrl,
      "--repo",
      world.repo,
      ...acpArgs(),
    ]);
    const ambiguousCode = await Promise.race([
      ambiguousRun.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(ambiguousCode).not.toBe(0);
    expect(ambiguousRun.output()).toContain("Matches 2 workspaces");
    expect(ambiguousRun.output()).toContain(world.workspaceA);
    expect(ambiguousRun.output()).toContain(world.workspaceB);

    const chosenRun = spawnCli([
      "work",
      key,
      "--workspace",
      world.workspaceB,
      "--server",
      world.baseUrl,
      "--repo",
      world.repo,
      ...acpArgs(),
    ]);
    const chosenCode = await Promise.race([
      chosenRun.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(chosenCode).toBe(0);
    expect(str(field((await sessionsOf(ambiguous.id))[0], "status"))).toBe("completed");
  });

  it("one-shot work exits non-zero on an ACP crash and still tears down", async () => {
    const issue = await makeIssue("one-shot crash", { agentId: world.agentId });
    const result = spawnCli(
      [
        "work",
        issue.id,
        "--server",
        world.baseUrl,
        "--repo",
        world.repo,
        "--cancel-grace-ms",
        "500",
        ...acpArgs(),
      ],
      { STUB_ACP_MODE: "crash" },
    );
    const code = await Promise.race([
      result.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(code).not.toBe(0);
    expect(str(field((await sessionsOf(issue.id))[0], "status"))).toBe("released");
    expect(result.output()).toContain("marked offline");
  });

  it("racing auto-claim calls create only one Dispatch for the same issue", async () => {
    const key = `RC${randomBytes(3).toString("hex").toUpperCase()}`;
    const project = await api(`/api/workspaces/${world.workspaceA}/projects`, {
      method: "POST",
      cookie: world.cookie,
      body: { name: "Race project", key },
    });
    if (project.status !== 201) throw new Error(`project failed: ${JSON.stringify(project.body)}`);
    const projectId = str(field(project.body, "id"));
    const runner = await api("/api/runners/register", {
      method: "POST",
      token: world.credential,
      body: {
        workspaceId: world.workspaceA,
        projectId,
        agentId: world.agentId,
        repoFingerprint: createHash("sha256").update(randomBytes(32)).digest("hex"),
        capabilities: [],
        maxConcurrency: 4,
        ephemeral: false,
      },
    });
    if (runner.status !== 201) throw new Error(`register failed: ${JSON.stringify(runner.body)}`);
    const runnerId = str(field(runner.body, "id"));
    const issue = await makeIssue("race candidate", { projectId, agentId: world.agentId });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api(`/api/runners/${runnerId}/auto-claim`, {
          method: "POST",
          token: world.credential,
          body: { filter: "assignedToMe" },
        }),
      ),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.filter((result) => field(result.body, "dispatch") !== null)).toHaveLength(1);
    const rows = await database.db
      .select({ id: runnerDispatches.id })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.issueId, issue.id));
    expect(rows).toHaveLength(1);
  });

  it("excludes needs_input issues from auto-claim", async () => {
    const key = `NI${randomBytes(3).toString("hex").toUpperCase()}`;
    const project = await api(`/api/workspaces/${world.workspaceA}/projects`, {
      method: "POST",
      cookie: world.cookie,
      body: { name: "Needs input project", key },
    });
    if (project.status !== 201) throw new Error(`project failed: ${JSON.stringify(project.body)}`);
    const projectId = str(field(project.body, "id"));
    const runner = await api("/api/runners/register", {
      method: "POST",
      token: world.credential,
      body: {
        workspaceId: world.workspaceA,
        projectId,
        agentId: world.agentId,
        repoFingerprint: createHash("sha256").update(randomBytes(32)).digest("hex"),
        capabilities: [],
        maxConcurrency: 1,
        ephemeral: false,
      },
    });
    if (runner.status !== 201) throw new Error(`register failed: ${JSON.stringify(runner.body)}`);
    const runnerId = str(field(runner.body, "id"));
    const issue = await makeIssue("needs input", { projectId, agentId: world.agentId });
    await database.db.update(issues).set({ needsInput: true }).where(eq(issues.id, issue.id));

    const claimed = await api(`/api/runners/${runnerId}/auto-claim`, {
      method: "POST",
      token: world.credential,
      body: { filter: "assignedToMe" },
    });
    expect(claimed.status).toBe(200);
    expect(field(claimed.body, "dispatch")).toBeNull();
  });

  it("resolves foreign/read-only projects uniformly and rejects int4 overflow keys", async () => {
    const readOnly = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: world.readOnlyIssueId },
    });
    expect(readOnly.status).toBe(404);
    expect(str(field(readOnly.body, "code"))).toBe("issue_not_found");

    const foreign = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: world.readOnlyIssueId, workspace: world.privateWorkspaceId },
    });
    expect(foreign.status).toBe(404);
    expect(str(field(foreign.body, "code"))).toBe("workspace_not_found");

    const overflow = await api("/api/runners/issue-resolve", {
      method: "POST",
      token: world.credential,
      body: { target: `${world.keyA}-99999999999` },
    });
    expect(overflow.status).toBe(404);
    expect(str(field(overflow.body, "code"))).toBe("issue_not_found");
  });

  it("flushes owner-only stderr chunks before stop_session rolls up the stream", async () => {
    const issue = await makeIssue("owner-only stderr", { agentId: world.agentId });
    const result = spawnCli(
      [
        "work",
        issue.id,
        "--server",
        world.baseUrl,
        "--repo",
        world.repo,
        "--cancel-grace-ms",
        "500",
        ...acpArgs(),
      ],
      { STUB_ACP_MODE: "stderr" },
    );
    const code = await Promise.race([
      result.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(code).toBe(0);

    const dispatch = (await dispatchesOf(issue.id))[0];
    const sessionId = str(field(dispatch, "workSessionId"));
    const sessionRow = await database.db
      .select({ streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, sessionId))
      .limit(1);
    expect(sessionRow[0]?.streamObjectId).not.toBeNull();

    const chunks = await streamOf(str(field(dispatch, "runnerId")), str(field(dispatch, "id")));
    const raw = chunks.find((chunk) => field(chunk, "kind") === "raw_output");
    expect(raw).toBeDefined();
    expect(field(raw, "visibility")).toBe("owner_only");
    expect(JSON.stringify(field(raw, "data"))).toContain("stub diagnostic");
  });

  it("SIGTERM on one-shot work revokes the Runner and settles its Dispatch", async () => {
    const issue = await makeIssue("one-shot sigterm", { agentId: world.agentId });
    const result = spawnCli(
      [
        "work",
        issue.id,
        "--server",
        world.baseUrl,
        "--repo",
        world.repo,
        "--cancel-grace-ms",
        "500",
        ...acpArgs(),
      ],
      { STUB_ACP_MODE: "hang" },
    );
    await until(async () => ((await sessionsOf(issue.id)).length === 1 ? true : undefined), 20_000);
    result.child.kill("SIGTERM");
    const code = await Promise.race([
      result.done,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(-99), 30_000)),
    ]);
    expect(code).not.toBe(0);

    const dispatchRow = await database.db
      .select({
        id: runnerDispatches.id,
        runnerId: runnerDispatches.runnerId,
        state: runnerDispatches.state,
      })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.issueId, issue.id))
      .orderBy(runnerDispatches.createdAt)
      .limit(1);
    expect(dispatchRow[0]?.state).toBe("ended");
    const runnerRow = await database.db
      .select({ revokedAt: runners.revokedAt })
      .from(runners)
      .where(eq(runners.id, dispatchRow[0]?.runnerId ?? ""))
      .limit(1);
    expect(runnerRow[0]?.revokedAt).not.toBeNull();
  });
});

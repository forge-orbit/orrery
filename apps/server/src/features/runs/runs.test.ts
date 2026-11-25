import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  CreateAgentKeyResponse,
  Problem,
  type RunDetail,
  type RunReportInput,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  humans,
  issues,
  projects,
  runModelChanges,
  runs as runRows,
  workspaceMemberships,
  workspaces,
  workSessions,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import type { AgentAuthenticator } from "../agents/index.ts";
import { createAgentsFeature } from "../agents/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createRunsFeature, type RunsService } from "./index.ts";
import { RUN_STALE_AFTER_SECONDS } from "./state-machine.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "runs-admin@example.com";
const ADMIN_PASSWORD = "runs-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let runsService: RunsService;
let agentAuthenticator: AgentAuthenticator;
let adminCookie: string;
let adminHumanId: string;
let workspaceId: string;
let agentId: string;
let secret: string;

const postJson = (path: string, body: unknown, cookie?: string, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getJson = (path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : {});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

const bearerRequest = (token: string) =>
  new Request("http://orrery.test/api/runs/hook", {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  });

const report = async (input: RunReportInput, token = secret) =>
  runsService.report(await agentAuthenticator(bearerRequest(token)), input);

function adminAccount() {
  return {
    humanId: adminHumanId,
    email: ADMIN_EMAIL,
    isSystemAdministrator: false,
    emailVerifiedAt: new Date(),
  };
}

function listedRuns(workspace = workspaceId): Promise<RunDetail[]> {
  return runsService.listWorkspaceRuns(adminAccount(), workspace);
}

function staleAt(): Date {
  return new Date(Date.now() - (RUN_STALE_AFTER_SECONDS + 5 * 60) * 1000);
}

async function backdateRun(runId: string, at: Date): Promise<void> {
  await database.db
    .update(runRows)
    .set({ createdAt: at, updatedAt: at, lastHeartbeatAt: at })
    .where(eq(runRows.id, runId));
}

async function addLiveWorkSession(runId: string, leaseSeconds = 300): Promise<void> {
  const projectId = randomUUID();
  const issueId = randomUUID();
  await database.db.insert(projects).values({
    id: projectId,
    workspaceId,
    name: "Run staleness",
    key: `RUN${randomUUID().slice(0, 6).toUpperCase()}`,
    createdByHumanId: adminHumanId,
  });
  await database.db.insert(issues).values({
    id: issueId,
    projectId,
    number: 1,
    title: "Leased work",
    status: "todo",
    sortOrder: 1,
    createdByHumanId: adminHumanId,
    updatedByHumanId: adminHumanId,
  });
  await database.db.insert(workSessions).values({
    id: randomUUID(),
    agentId,
    runId,
    workspaceId,
    issueId,
    leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
  });
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  let authenticator: AgentAuthenticator | undefined;
  const lateAuth: AgentAuthenticator = (request) => {
    if (authenticator === undefined) throw new Error("authenticator not wired");
    return authenticator(request);
  };
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: lateAuth,
    sessionGate: async () => true,
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, ws, human, ids) =>
      projectsFeature.projectAccessCeiling(tx, ws, human, ids),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  authenticator = agentsFeature.authenticator;
  agentAuthenticator = agentsFeature.authenticator;
  const runsFeature = createRunsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
  });
  app = createApp({
    features: [accounts, projectsFeature, agentsFeature, runsFeature],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
  runsService = runsFeature.service;
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspace_ownership_guards`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from instance_setup`);
    await tx.execute(sql`delete from humans`);
  });
});

async function bootstrap() {
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(setup.status).toBe(201);
  const login = await postJson("/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  adminCookie = cookie;

  const [human] = await database.db.select().from(workspaces);
  if (human?.personalOwnerHumanId === null || human?.personalOwnerHumanId === undefined) {
    throw new Error("the personal workspace was not created");
  }
  adminHumanId = human.personalOwnerHumanId;
  workspaceId = human.id;

  const created = await postJson(
    "/api/agents",
    { name: `runs-agent-${randomUUID()}` },
    adminCookie,
  );
  expect(created.status).toBe(201);
  agentId = idOf(await created.json(), "agent");
  const issued = await postJson(
    "/api/agents/keys",
    { agentId, workspaceId, validity: "90", projects: [] },
    adminCookie,
  );
  expect(issued.status).toBe(201);
  const body = CreateAgentKeyResponse.parse(await issued.json());
  secret = body.secret;
}

describe("runs service against real Postgres", () => {
  it("keeps two clients sharing one key as distinct runs and preserves a resume", async () => {
    await bootstrap();
    const a = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "session-A" },
      model: "gpt-6.2-sol",
    });
    const b = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "session-B" },
      model: "gpt-6.2-sol",
    });
    expect(a.runId).not.toBe(b.runId);
    expect(a.harness).toBe("codex");

    const resume = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "session-A" },
    });
    expect(resume.runId).toBe(a.runId);
    const byId = await report({ event: "run_heartbeat", runId: a.runId });
    expect(byId.runId).toBe(a.runId);

    const listed = await listedRuns();
    expect(listed).toHaveLength(2);
    expect(
      listed
        .map((run) => run.nativeSessionId)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["session-A", "session-B"]);
    expect(listed.every((run) => run.agentId === agentId)).toBe(true);
    expect(listed.every((run) => run.agentName.startsWith("runs-agent-"))).toBe(true);
    const [stored] = await database.db.select().from(runRows);
    expect(stored?.agentId).toBe(agentId);
  });

  it("resolves concurrent check-ins with the same key to one run", async () => {
    await bootstrap();
    const key = { harness: "claude-code", nativeSessionId: "shared-session" } as const;
    const [x, y] = await Promise.all([
      report({ event: "run_heartbeat", runKey: key }),
      report({ event: "run_heartbeat", runKey: key }),
    ]);
    expect(x.runId).toBe(y.runId);
    expect(await listedRuns()).toHaveLength(1);
  });

  it("writes one clean model-change history row for two simultaneous model reports", async () => {
    await bootstrap();
    const first = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "race-model" },
      model: "gpt-6.2-sol",
    });
    const runId = first.runId ?? "";
    await Promise.all([
      report({ event: "run_heartbeat", runId, model: "gpt-7" }),
      report({ event: "run_heartbeat", runId, model: "gpt-7" }),
    ]);
    const changes = await database.db
      .select()
      .from(runModelChanges)
      .where(eq(runModelChanges.runId, runId));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromModel: "gpt-6.2-sol", toModel: "gpt-7" });
    const listed = await listedRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.model).toBe("gpt-7");
    expect(listed[0]?.modelHistory).toHaveLength(1);
  });

  it("rejects a child runId that is a self-loop or outside the agent/workspace scope", async () => {
    await bootstrap();
    const parent = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "child-scope" },
    });
    const parentId = parent.runId ?? "";
    const childRef = { agentId: "child-a", agentType: "general-purpose" };

    await expect(
      report({ event: "child_started", runId: parentId, child: { ...childRef, runId: parentId } }),
    ).rejects.toMatchObject({ kind: "run_not_found" });

    const [foreignAgent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: adminHumanId, name: `foreign-${randomUUID()}` })
      .returning();
    if (foreignAgent === undefined) throw new Error("the foreign agent was not created");
    const [foreignRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId: foreignAgent.id,
        workspaceId,
        harness: "codex",
        nativeSessionId: "foreign-agent-run",
      })
      .returning();
    if (foreignRun === undefined) throw new Error("the foreign run was not created");
    await expect(
      report({
        event: "child_started",
        runId: parentId,
        child: { ...childRef, runId: foreignRun.id },
      }),
    ).rejects.toMatchObject({ kind: "run_not_found" });

    const otherWorkspace = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Other team" })
        .returning();
      if (created === undefined) throw new Error("the other workspace was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: adminHumanId,
        isOwner: true,
      });
      return created;
    });
    const [otherRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId,
        workspaceId: otherWorkspace.id,
        harness: "codex",
        nativeSessionId: "other-workspace-run",
      })
      .returning();
    if (otherRun === undefined) throw new Error("the other run was not created");
    await expect(
      report({
        event: "child_started",
        runId: parentId,
        child: { ...childRef, runId: otherRun.id },
      }),
    ).rejects.toMatchObject({ kind: "run_not_found" });

    const [sibling] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId,
        workspaceId,
        harness: "codex",
        nativeSessionId: "sibling-run",
      })
      .returning();
    if (sibling === undefined) throw new Error("the sibling run was not created");
    const ok = await report({
      event: "child_started",
      runId: parentId,
      child: { ...childRef, runId: sibling.id },
    });
    expect(ok.runId).toBe(parentId);
    const listed = await listedRuns();
    const children = listed.find((run) => run.id === parentId)?.children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0]?.childRunId).toBe(sibling.id);
  });

  it("links child workers to the parent run and records model changes, leaving missing values unknown", async () => {
    await bootstrap();
    const key = { harness: "codex", nativeSessionId: "parent-session" } as const;
    const first = await report({
      event: "run_started",
      runKey: key,
      model: "gpt-6.2-sol",
      harnessVersion: "0.171.0",
    });
    const child = await report({
      event: "child_started",
      runId: first.runId,
      agentId: "01a1f6bd-4995-7b01-aa8b-fc78992f5713",
      agentType: "default",
    });
    expect(child.runId).toBe(first.runId);
    await report({
      event: "child_ended",
      runId: first.runId,
      agentId: "01a1f6bd-4995-7b01-aa8b-fc78992f5713",
      agentType: "default",
    });
    const changed = await report({ event: "run_heartbeat", runId: first.runId, model: "gpt-7" });
    expect(changed.model).toBe("gpt-7");

    await report({ event: "run_heartbeat", runId: first.runId, model: "gpt-7" });
    const unknown = await report({ event: "run_heartbeat", runId: first.runId });
    expect(unknown.model).toBe("gpt-7");

    const bare = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "bare" },
    });
    const noIdentity = await report({ event: "run_heartbeat", model: "orphan" });
    expect(noIdentity.runId).toBeNull();

    const listed = await listedRuns();
    expect(listed).toHaveLength(2);
    const parent = listed.find((run) => run.id === first.runId);
    expect(parent?.harnessVersion).toBe("0.171.0");
    expect(parent?.model).toBe("gpt-7");
    expect(parent?.modelHistory).toHaveLength(1);
    expect(parent?.modelHistory[0]).toMatchObject({ fromModel: "gpt-6.2-sol", toModel: "gpt-7" });
    expect(parent?.children).toHaveLength(1);
    expect(parent?.children[0]).toMatchObject({
      agentId: "01a1f6bd-4995-7b01-aa8b-fc78992f5713",
      agentType: "default",
      status: "ended",
      model: null,
    });
    const bareRun = listed.find((run) => run.id === bare.runId);
    expect(bareRun?.model).toBeNull();
    expect(bareRun?.harnessVersion).toBeNull();
  });

  it("refuses a revoked key, a run outside the key's workspace, and a human outside the workspace", async () => {
    await bootstrap();
    const own = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "own-session" },
    });

    const outsider = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Other" })
        .returning();
      if (created === undefined) throw new Error("the other workspace was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: adminHumanId,
        isOwner: true,
      });
      return created;
    });
    const [foreignAgent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: adminHumanId, name: `foreign-${randomUUID()}` })
      .returning();
    if (foreignAgent === undefined) throw new Error("the foreign agent was not created");
    const [foreignRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId: foreignAgent.id,
        workspaceId: outsider.id,
        harness: "codex",
        nativeSessionId: "foreign-session",
      })
      .returning();
    if (foreignRun === undefined) throw new Error("the foreign run was not created");
    await expect(report({ event: "run_heartbeat", runId: foreignRun.id })).rejects.toMatchObject({
      kind: "run_not_found",
    });

    const [foreignHuman] = await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email: `outsider-${randomUUID()}@example.com`,
        passwordHash: "scrypt$anything",
      })
      .returning();
    if (foreignHuman === undefined) throw new Error("the foreign human was not created");
    const foreignWorkspace = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Foreign team" })
        .returning();
      if (created === undefined) throw new Error("the foreign workspace was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: foreignHuman.id,
        isOwner: true,
      });
      return created;
    });
    await expect(
      runsService.listWorkspaceRuns(adminAccount(), foreignWorkspace.id),
    ).rejects.toMatchObject({
      kind: "workspace_not_found",
    });
    const restDenied = await getJson(`/api/workspaces/${foreignWorkspace.id}/runs`, adminCookie);
    expect(restDenied.status).toBe(404);

    const revoke = await app.request(`/api/agents/keys/${(await agentKeyId()).id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(revoke.status).toBe(204);
    await expect(report({ event: "run_heartbeat", runId: own.runId ?? "" })).rejects.toMatchObject({
      kind: "key_revoked",
    });
  });

  it("expires a stale run with no live work session and ends its active children", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "stale-with-child" },
    });
    const runId = created.runId ?? "";
    await report({
      event: "child_started",
      runId,
      agentId: "stale-child",
      agentType: "default",
    });
    const stale = staleAt();
    await backdateRun(runId, stale);

    const listed = await listedRuns();
    const run = listed.find((entry) => entry.id === runId);
    expect(run).toMatchObject({ status: "ended", endedReason: "stale" });
    expect(run?.endedAt).toBe(stale.toISOString());
    expect(run?.children).toHaveLength(1);
    expect(run?.children[0]?.status).toBe("ended");
    expect(run?.children[0]?.endedAt).not.toBeNull();
    expect(new Date(run?.children[0]?.endedAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(run?.children[0]?.startedAt ?? 0).getTime(),
    );

    const [stored] = await database.db.select().from(runRows).where(eq(runRows.id, runId));
    expect(stored).toMatchObject({ status: "ended", endedReason: "stale" });
    expect(stored?.endedAt?.toISOString()).toBe(stale.toISOString());
  });

  it("keeps a stale heartbeat active while a work session lease is live, then expires it", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "stale-with-lease" },
    });
    const runId = created.runId ?? "";
    await addLiveWorkSession(runId);
    await backdateRun(runId, staleAt());

    const live = await listedRuns();
    expect(live.find((entry) => entry.id === runId)).toMatchObject({
      status: "active",
      endedReason: null,
      endedAt: null,
    });

    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(workSessions.runId, runId));
    const expired = await listedRuns();
    expect(expired.find((entry) => entry.id === runId)).toMatchObject({
      status: "ended",
      endedReason: "stale",
    });
  });

  it("does not expire a run whose heartbeat is recent even when it started long ago", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "recent-heartbeat" },
    });
    const runId = created.runId ?? "";
    await database.db
      .update(runRows)
      .set({ createdAt: staleAt(), updatedAt: staleAt(), lastHeartbeatAt: staleAt() })
      .where(eq(runRows.id, runId));
    await report({ event: "run_heartbeat", runId });

    const listed = await listedRuns();
    expect(listed.find((entry) => entry.id === runId)).toMatchObject({
      status: "active",
      endedReason: null,
      endedAt: null,
    });
  });

  it("resumes a stale-expired run on a heartbeat and clears the expiry", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "stale-resume-heartbeat" },
    });
    const runId = created.runId ?? "";
    await backdateRun(runId, staleAt());

    const expired = (await listedRuns()).find((entry) => entry.id === runId);
    expect(expired).toMatchObject({ status: "ended", endedReason: "stale" });

    const resumed = await report({ event: "run_heartbeat", runId });
    expect(resumed.runId).toBe(runId);
    const active = (await listedRuns()).find((entry) => entry.id === runId);
    expect(active).toMatchObject({ status: "active", endedReason: null, endedAt: null });
    expect(active?.lastHeartbeatAt).not.toBeNull();
    expect(new Date(active?.lastHeartbeatAt ?? 0).getTime()).toBeGreaterThan(
      new Date(expired?.endedAt ?? 0).getTime(),
    );

    const [stored] = await database.db.select().from(runRows).where(eq(runRows.id, runId));
    expect(stored).toMatchObject({ status: "active", endedReason: null, endedAt: null });
  });

  it("does not let a heartbeat undo an explicit run_ended, but a fresh start resumes it", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "reported-end" },
    });
    const runId = created.runId ?? "";
    await report({ event: "run_ended", runId });

    const ended = (await listedRuns()).find((entry) => entry.id === runId);
    expect(ended).toMatchObject({ status: "ended", endedReason: "reported" });

    await report({ event: "run_heartbeat", runId });
    const stillEnded = (await listedRuns()).find((entry) => entry.id === runId);
    expect(stillEnded).toMatchObject({
      status: "ended",
      endedReason: "reported",
      endedAt: ended?.endedAt,
    });

    await report({ event: "run_started", runId });
    const resumed = (await listedRuns()).find((entry) => entry.id === runId);
    expect(resumed).toMatchObject({ status: "active", endedReason: null, endedAt: null });
  });

  it("marks a stale-expired run reported when run_ended arrives afterwards", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "stale-then-ended" },
    });
    const runId = created.runId ?? "";
    const stale = staleAt();
    await backdateRun(runId, stale);
    expect((await listedRuns()).find((entry) => entry.id === runId)).toMatchObject({
      status: "ended",
      endedReason: "stale",
    });

    await report({ event: "run_ended", runId });
    const ended = (await listedRuns()).find((entry) => entry.id === runId);
    expect(ended).toMatchObject({ status: "ended", endedReason: "reported" });
    expect(new Date(ended?.endedAt ?? 0).getTime()).toBeGreaterThan(stale.getTime());

    await report({ event: "run_heartbeat", runId });
    expect((await listedRuns()).find((entry) => entry.id === runId)).toMatchObject({
      status: "ended",
      endedReason: "reported",
    });
  });

  it("sweeps stale runs without waiting for a workspace read and is idempotent", async () => {
    await bootstrap();
    const created = await report({
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "sweep-only" },
    });
    const runId = created.runId ?? "";
    await backdateRun(runId, staleAt());

    expect(await runsService.expireStaleRuns()).toBe(1);
    expect(await runsService.expireStaleRuns()).toBe(0);

    const [stored] = await database.db.select().from(runRows).where(eq(runRows.id, runId));
    expect(stored).toMatchObject({ status: "ended", endedReason: "stale" });
  });

  it("uses createdAt as the last-seen time for a run that never sent a heartbeat", async () => {
    await bootstrap();
    const runId = randomUUID();
    const createdAt = staleAt();
    await database.db.insert(runRows).values({
      id: runId,
      agentId,
      workspaceId,
      harness: "runner",
      nativeSessionId: "runner-no-heartbeat",
      createdAt,
      updatedAt: createdAt,
    });

    const run = (await listedRuns()).find((entry) => entry.id === runId);
    expect(run).toMatchObject({ status: "ended", endedReason: "stale" });
    expect(run?.endedAt).toBe(createdAt.toISOString());
    expect(run?.lastHeartbeatAt).toBeNull();
  });
});

async function agentKeyId() {
  const res = await getJson(
    "/api/agents/keys?workspaceId=" + encodeURIComponent(workspaceId),
    adminCookie,
  );
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  const keys = field(body, "keys");
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("no key was found");
  return { id: idOf(keys[0], "key") };
}

describe("run REST reporting", () => {
  it("accepts a v1 hook event with a bearer key and exposes runs to a human session", async () => {
    await bootstrap();
    const res = await postJson(
      "/api/runs/hook",
      {
        schema: "orrery.run.hook.v1",
        event: "run_started",
        runKey: { harness: "codex", nativeSessionId: "rest-session" },
        model: "gpt-6.2-sol",
        at: new Date().toISOString(),
      },
      undefined,
      secret,
    );
    expect(res.status).toBe(200);
    const accepted: unknown = await res.json();
    expect(typeof field(accepted, "runId")).toBe("string");
    expect(field(accepted, "model")).toBe("gpt-6.2-sol");

    const listed = await getJson(`/api/workspaces/${workspaceId}/runs`, adminCookie);
    expect(listed.status).toBe(200);
    const body: unknown = await listed.json();
    const runs = field(body, "runs");
    expect(Array.isArray(runs) && runs.length === 1).toBe(true);

    const unauthenticated = await postJson("/api/runs/hook", {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "codex", nativeSessionId: "no-key" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(Problem.parse(await unauthenticated.json()).code).toBe("not_signed_in");
  });
});

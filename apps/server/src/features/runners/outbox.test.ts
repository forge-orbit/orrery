import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AckCommandsResponse,
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
  HostCredentialResponse,
  Issue,
  Problem,
  Runner,
  RunnerCommandsResponse,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  browserSessions,
  humans,
  issues,
  projectAccessGrants,
  projects,
  questions,
  runnerCommands,
  runnerDispatches,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createFeatures } from "../index.ts";

const SECRET = "outbox-test-bootstrap-secret-123456";
const ADMIN_EMAIL = "outbox-admin@example.com";
const ADMIN_PASSWORD = "outbox-admin-password";
const PUBLIC_URL = "http://orrery.test";
const fingerprint = tokenHash("/home/secret/outbox-repo");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let features: ReturnType<typeof createFeatures>;
let adminCookie: string;
let adminHumanId: string;
let workspaceId: string;
let projectId: string;
let defaultAgentId: string;

function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

const request = (
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    cookie?: string;
    token?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

async function login(email: string, password: string): Promise<string> {
  const res = await request("/api/auth/login", { method: "POST", body: { email, password } });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("session cookie was not set");
  return cookie;
}

async function insertHuman(email = `human-${randomUUID()}@example.com`) {
  return one(
    await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email,
        passwordHash: "scrypt$anything",
        emailVerifiedAt: sql`statement_timestamp()`,
      })
      .returning(),
  );
}

async function browserCookie(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`statement_timestamp() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

async function insertAgent(humanId: string) {
  return one(
    await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId, name: `agent-${randomUUID()}` })
      .returning(),
  );
}

async function grantProjectAccess(
  humanId: string,
  level: "read" | "contribute" | "manage" = "contribute",
) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner: false,
  });
  await database.db.insert(projectAccessGrants).values({
    id: randomUUID(),
    projectId,
    humanId,
    level,
    grantedByHumanId: adminHumanId,
  });
}

async function enrollHost(cookie: string, name = "outbox-laptop") {
  const verifier = randomBytes(32).toString("hex");
  const created = await request("/api/runners/device-codes", {
    method: "POST",
    body: { hostDisplayName: name, platform: "linux-x64", verifierHash: tokenHash(verifier) },
  });
  expect(created.status).toBe(201);
  const device = DeviceCodeResponse.parse(await created.json());
  expect(
    (
      await request(`/api/runners/device-codes/${device.userCode}/approve`, {
        method: "POST",
        cookie,
      })
    ).status,
  ).toBe(200);
  const exchanged = await request("/api/runners/device-codes/token", {
    method: "POST",
    body: { deviceCode: device.deviceCode, verifier },
  });
  expect(exchanged.status).toBe(200);
  return HostCredentialResponse.parse(await exchanged.json());
}

async function registerRunner(credential: string, agent = defaultAgentId) {
  const res = await request("/api/runners/register", {
    method: "POST",
    body: { workspaceId, projectId, agentId: agent, repoFingerprint: fingerprint },
    token: credential,
  });
  expect(res.status).toBe(201);
  return Runner.parse(await res.json());
}

async function createIssue(title: string) {
  const res = await request(`/api/projects/${projectId}/issues`, {
    method: "POST",
    body: { title },
    cookie: adminCookie,
  });
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

function createDispatch(issueId: string, runnerId: string, cookie: string) {
  return request(`/api/issues/${issueId}/dispatches`, {
    method: "POST",
    body: { runnerId },
    cookie,
  });
}

function acceptDispatch(runner: Runner, dispatchId: string, credential: string) {
  return request(`/api/runners/${runner.id}/dispatches/${dispatchId}/accept`, {
    method: "POST",
    token: credential,
  });
}

function pollCommands(runnerId: string, credential: string, afterSeq: number, waitMs = 0) {
  return request(`/api/runners/${runnerId}/commands?afterSeq=${afterSeq}&waitMs=${waitMs}`, {
    token: credential,
  });
}

function ackCommands(runnerId: string, credential: string, upToSeq: number) {
  return request(`/api/runners/${runnerId}/commands/ack`, {
    method: "POST",
    token: credential,
    body: { upToSeq },
  });
}

async function commandRows(runnerId: string) {
  return database.db
    .select()
    .from(runnerCommands)
    .where(eq(runnerCommands.runnerId, runnerId))
    .orderBy(runnerCommands.seq);
}

const commandsOf = async (res: Response) => RunnerCommandsResponse.parse(await res.json()).commands;

async function insertQuestion(input: {
  issueId: string;
  runId: string;
  sessionId: string;
  pastDeadline?: boolean;
}) {
  const [row] = await database.db
    .insert(questions)
    .values({
      id: randomUUID(),
      issueId: input.issueId,
      projectId,
      workspaceId,
      agentId: defaultAgentId,
      runId: input.runId,
      sessionId: input.sessionId,
      question: "Which approach?",
      proposedFallback: "Use the proposed fallback",
      responseDeadlineAt: input.pastDeadline
        ? sql`statement_timestamp() - interval '1 hour'`
        : sql`statement_timestamp() + interval '1 hour'`,
      createdAt: input.pastDeadline
        ? sql`statement_timestamp() - interval '2 hours'`
        : sql`statement_timestamp()`,
    })
    .returning();
  return row!;
}

function evaluateDeadlineFor(issueId: string) {
  // The inbox feature exposes the deadline seam used by the expiry sweeper.
  const inbox = features.find((feature) => feature.name === "inbox");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- feature seam
  const service = inbox as unknown as {
    service: {
      evaluateDeadline(
        tx: Parameters<Parameters<typeof database.db.transaction>[0]>[0],
        issueId: string,
      ): Promise<void>;
    };
  };
  return database.db.transaction((tx) => service.service.evaluateDeadline(tx, issueId));
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  const config = loadConfig({
    DATABASE_URL: pg.getConnectionUri(),
    PUBLIC_URL,
    BOOTSTRAP_SECRET: SECRET,
    LOG_LEVEL: "error",
  });
  database = createDb(config.DATABASE_URL);
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
  features = createFeatures(database, config, createLogger("error"));
  app = createApp({ features, publicUrl: PUBLIC_URL, log: createLogger("error") });

  const setup = await request("/api/setup/admin", {
    method: "POST",
    body: { secret: SECRET, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (setup.status !== 201) throw new Error(`bootstrap failed with ${setup.status}`);
  const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
  adminHumanId = admin!.id;
}, 120_000);

beforeEach(async () => {
  adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  await database.db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ id: randomUUID(), kind: "shared", name: "Outbox workspace" })
      .returning();
    workspaceId = workspace!.id;
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: adminHumanId,
      isOwner: true,
    });
  });
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name: "Outbox repo",
      key: `O${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      createdByHumanId: adminHumanId,
    })
    .returning();
  projectId = project!.id;
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: adminHumanId, name: `outbox-agent-${randomUUID()}` })
    .returning();
  defaultAgentId = agent!.id;
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    for (const table of [
      "runner_commands",
      "dispatch_tokens",
      "runner_dispatches",
      "notifications",
      "work_session_activities",
      "questions",
      "project_activity",
      "project_access_events",
      "workspace_events",
      "account_recovery_events",
      "agent_key_events",
      "project_transfer_authorizations",
      "work_sessions",
      "runs",
      "runners",
      "runner_device_codes",
      "runner_device_code_attempts",
      "runner_hosts",
      "issues",
      "project_access_grants",
      "projects",
      "workspace_memberships",
      "browser_sessions",
      "agents",
    ]) {
      await tx.execute(sql.raw(`delete from ${table}`));
    }
    if (workspaceId !== undefined) {
      await tx.execute(sql`delete from workspaces where id = ${workspaceId}`);
    }
    await tx.execute(sql`delete from humans where id <> ${adminHumanId}`);
  });
});

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

describe("transactional runner command outbox (#197)", () => {
  it("enqueues a dispatch command atomically with createDispatch and replays it from afterSeq", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("atomic dispatch command");

    const created = await createDispatch(issue.id, runner.id, adminCookie);
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());

    const rows = await commandRows(runner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "dispatch",
      seq: 1,
      dispatchId: dispatch.id,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      runnerId: runner.id,
      ackedAt: null,
    });
    expect(rows[0]!.payload).toMatchObject({
      dispatchId: dispatch.id,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      issueId: issue.id,
      projectId,
      workspaceId,
      agentId: defaultAgentId,
    });
    const [bridge] = await database.db
      .select({ lastDownSeq: runnerDispatches.lastDownSeq })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(bridge!.lastDownSeq).toBe(1);

    const polled = await pollCommands(runner.id, host.credential, 0);
    expect(polled.status).toBe(200);
    const body = await commandsOf(polled);
    expect(body).toMatchObject([{ seq: 1, kind: "dispatch" }]);
  });

  it("rolls back the outbox row when the dispatch write fails", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("not claimable");
    await database.db
      .update(issues)
      .set({ assigneeType: "human", assigneeId: adminHumanId })
      .where(eq(issues.id, issue.id));

    const rejected = await createDispatch(issue.id, runner.id, adminCookie);
    expect(rejected.status).toBe(409);
    expect(await commandRows(runner.id)).toHaveLength(0);
  });

  it("allocates monotonic sequences for concurrent dispatches to one runner", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const firstIssue = await createIssue("concurrent one");
    const secondIssue = await createIssue("concurrent two");

    const created = await Promise.all([
      createDispatch(firstIssue.id, runner.id, adminCookie),
      createDispatch(secondIssue.id, runner.id, adminCookie),
    ]);
    expect(created.map((res) => res.status)).toEqual([201, 201]);
    expect((await commandRows(runner.id)).map((row) => row.seq)).toEqual([1, 2]);
  });

  it("long-polls and wakes when a command is enqueued after the poll begins", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const started = Date.now();
    const pending = pollCommands(runner.id, host.credential, 0, 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const issue = await createIssue("wakeup");
    expect((await createDispatch(issue.id, runner.id, adminCookie)).status).toBe(201);

    const res = await pending;
    expect(res.status).toBe(200);
    expect((await commandsOf(res)).map((row) => row.kind)).toEqual(["dispatch"]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("replays only unread commands from afterSeq and acks implicitly and explicitly", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const first = await createDispatch((await createIssue("first")).id, runner.id, adminCookie);
    const second = await createDispatch((await createIssue("second")).id, runner.id, adminCookie);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const page = await commandsOf(await pollCommands(runner.id, host.credential, 0));
    expect(page.map((row) => row.seq)).toEqual([1, 2]);
    expect(new Set(page.map((row) => row.commandId)).size).toBe(2);

    // Reconnect with the cursor: only the unread command is replayed, and
    // advancing afterSeq implicitly acknowledges everything at or below it.
    const replay = await commandsOf(await pollCommands(runner.id, host.credential, 1));
    expect(replay.map((row) => row.seq)).toEqual([2]);
    const acked = await commandRows(runner.id);
    expect(acked[0]!.ackedAt).not.toBeNull();
    expect(acked[1]!.ackedAt).toBeNull();

    const explicit = await ackCommands(runner.id, host.credential, 2);
    expect(explicit.status).toBe(200);
    expect(AckCommandsResponse.parse(await explicit.json())).toMatchObject({ ackedSeq: 2 });
    expect((await commandRows(runner.id)).every((row) => row.ackedAt !== null)).toBe(true);

    const empty = await commandsOf(await pollCommands(runner.id, host.credential, 2));
    expect(empty).toEqual([]);
  });

  it("ignores commands whose expiry has passed in database time", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    await createDispatch((await createIssue("expiring")).id, runner.id, adminCookie);
    await database.db
      .update(runnerCommands)
      .set({
        createdAt: sql`statement_timestamp() - interval '2 hours'`,
        expiresAt: sql`statement_timestamp() - interval '1 hour'`,
      })
      .where(eq(runnerCommands.runnerId, runner.id));

    const polled = await pollCommands(runner.id, host.credential, 0);
    expect(polled.status).toBe(200);
    expect(await commandsOf(polled)).toEqual([]);
  });

  it("accepts a redelivered dispatch command idempotently", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("duplicate accept");
    const created = await createDispatch(issue.id, runner.id, adminCookie);
    const dispatch = Dispatch.parse(await created.json());

    const first = await acceptDispatch(runner, dispatch.id, host.credential);
    expect(first.status).toBe(200);
    const acceptance = DispatchAcceptance.parse(await first.json());
    const second = await acceptDispatch(runner, dispatch.id, host.credential);
    expect(second.status).toBe(200);
    const repeated = DispatchAcceptance.parse(await second.json());
    expect(repeated.dispatch.id).toBe(acceptance.dispatch.id);
    expect(repeated.session.id).toBe(acceptance.session.id);
    expect(repeated.run.id).toBe(acceptance.run.id);

    const sessions = await database.db
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    expect(sessions).toHaveLength(1);
  });

  it("lets a teammate with Contribute access request a stop and enqueues one cancel", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("teammate stop");
    const created = await createDispatch(issue.id, runner.id, adminCookie);
    const dispatch = Dispatch.parse(await created.json());
    expect((await acceptDispatch(runner, dispatch.id, host.credential)).status).toBe(200);

    const teammate = await insertHuman();
    await grantProjectAccess(teammate.id, "contribute");
    const teammateCookie = await browserCookie(teammate.id);
    const stop = await request(`/api/issues/${issue.id}/work-sessions/stop-request`, {
      method: "POST",
      cookie: teammateCookie,
      body: { reason: "emergency brake" },
    });
    expect(stop.status).toBe(200);
    const repeatedStop = await request(`/api/issues/${issue.id}/work-sessions/stop-request`, {
      method: "POST",
      cookie: teammateCookie,
      body: { reason: "again" },
    });
    expect(repeatedStop.status).toBe(200);

    const rows = await commandRows(runner.id);
    const cancels = rows.filter((row) => row.kind === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.dispatchAttemptId).toBe(dispatch.dispatchAttemptId);
    expect(cancels[0]!.payload).toMatchObject({ issueId: issue.id, reason: "emergency brake" });

    const polled = await pollCommands(runner.id, host.credential, 0);
    expect(polled.status).toBe(200);
    expect((await commandsOf(polled)).map((row) => row.kind)).toEqual(["dispatch", "cancel"]);
  });

  it("rejects a reader's stop request without enqueuing a cancel", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("reader stop");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, adminCookie)).json(),
    );
    expect((await acceptDispatch(runner, dispatch.id, host.credential)).status).toBe(200);

    const reader = await insertHuman();
    await grantProjectAccess(reader.id, "read");
    const readerCookie = await browserCookie(reader.id);
    await expectProblem(
      await request(`/api/issues/${issue.id}/work-sessions/stop-request`, {
        method: "POST",
        cookie: readerCookie,
        body: {},
      }),
      403,
      "insufficient_access",
    );
    expect((await commandRows(runner.id)).filter((row) => row.kind === "cancel")).toHaveLength(0);
  });

  it("cancels active dispatches when the Runner host is revoked", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("host revoke");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, adminCookie)).json(),
    );
    expect((await acceptDispatch(runner, dispatch.id, host.credential)).status).toBe(200);

    const revoked = await request(`/api/runner-hosts/${host.hostId}/revoke`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(revoked.status).toBe(200);

    const rows = await commandRows(runner.id);
    const cancels = rows.filter((row) => row.kind === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.payload).toMatchObject({ reason: "host_revoked" });
    const [bridge] = await database.db
      .select({ state: runnerDispatches.state })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(bridge!.state).toBe("ended");

    // A revoked runner drains ONLY the final cancel; the older dispatch command
    // is never leaked, and once the cancel is consumed every poll is a 401
    // stop-all-slots signal. The explicit ack obeys the same rule.
    const draining = await pollCommands(runner.id, host.credential, 0);
    expect(draining.status).toBe(200);
    expect((await commandsOf(draining)).map((row) => row.kind)).toEqual(["cancel"]);

    // Explicit ack is allowed while a final cancel is still unacknowledged.
    expect((await ackCommands(runner.id, host.credential, 2)).status).toBe(200);
    await expectProblem(await ackCommands(runner.id, host.credential, 3), 401, "runner_revoked");
    await expectProblem(await pollCommands(runner.id, host.credential, 2), 401, "runner_revoked");
  });

  it("cancels active dispatches when a human is deactivated", async () => {
    const owner = await insertHuman(`owner-${randomUUID()}@example.com`);
    await grantProjectAccess(owner.id, "contribute");
    const ownerCookie = await browserCookie(owner.id);
    const ownerAgent = await insertAgent(owner.id);
    const host = await enrollHost(ownerCookie, "owner-laptop");
    const runner = await registerRunner(host.credential, ownerAgent.id);
    const issue = await createIssue("owner deactivation");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, ownerCookie)).json(),
    );
    expect((await acceptDispatch(runner, dispatch.id, host.credential)).status).toBe(200);

    const deactivated = await request(`/api/admin/accounts/${owner.id}/deactivate`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(deactivated.status).toBe(200);

    const rows = await commandRows(runner.id);
    expect(rows.filter((row) => row.kind === "cancel")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "cancel")?.payload).toMatchObject({
      reason: "human_deactivated",
    });
    const [bridge] = await database.db
      .select({ state: runnerDispatches.state })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(bridge!.state).toBe("ended");
  });

  it("cancels active dispatches when a workspace member is removed", async () => {
    const member = await insertHuman(`member-${randomUUID()}@example.com`);
    await grantProjectAccess(member.id, "contribute");
    const memberCookie = await browserCookie(member.id);
    const memberAgent = await insertAgent(member.id);
    const host = await enrollHost(memberCookie, "member-laptop");
    const runner = await registerRunner(host.credential, memberAgent.id);
    const issue = await createIssue("member removal");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, memberCookie)).json(),
    );
    expect((await acceptDispatch(runner, dispatch.id, host.credential)).status).toBe(200);

    const removed = await request(`/api/workspaces/${workspaceId}/members/${member.id}`, {
      method: "DELETE",
      cookie: adminCookie,
    });
    expect(removed.status).toBe(204);

    const rows = await commandRows(runner.id);
    expect(rows.filter((row) => row.kind === "cancel")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "cancel")?.payload).toMatchObject({
      reason: "member_removed",
    });
    const [bridge] = await database.db
      .select({ state: runnerDispatches.state })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(bridge!.state).toBe("ended");
  });

  it("re-verifies host, runner and project access on every poll", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    expect((await pollCommands(runner.id, "orr_rh_invalid", 0)).status).toBe(401);
    await expectProblem(
      await pollCommands(runner.id, "orr_rh_invalid", 0),
      401,
      "invalid_credential",
    );
    expect((await pollCommands(randomUUID(), host.credential, 0)).status).toBe(404);
    expect((await pollCommands(runner.id, host.credential, -1)).status).toBe(400);
  });

  it("returns 401 and leaks no commands after project access is lost", async () => {
    const owner = await insertHuman(`no-access-${randomUUID()}@example.com`);
    await grantProjectAccess(owner.id, "contribute");
    const ownerCookie = await browserCookie(owner.id);
    const ownerAgent = await insertAgent(owner.id);
    const host = await enrollHost(ownerCookie, "no-access-laptop");
    const runner = await registerRunner(host.credential, ownerAgent.id);
    const issue = await createIssue("lost access");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, ownerCookie)).json(),
    );
    expect((await acceptDispatch(runner, dispatch.id, host.credential)).status).toBe(200);
    expect(
      (await commandsOf(await pollCommands(runner.id, host.credential, 0))).length,
    ).toBeGreaterThan(0);

    // Losing the project grant (without revoking the host) drops the read
    // ceiling; the outbox must not reveal the dispatch/input_resolved commands.
    await database.db
      .delete(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.projectId, projectId),
          eq(projectAccessGrants.humanId, owner.id),
        ),
      );
    await expectProblem(await pollCommands(runner.id, host.credential, 0), 401, "runner_revoked");
    await expectProblem(await ackCommands(runner.id, host.credential, 99), 401, "runner_revoked");
  });

  it("refuses an idempotent accept when the reused session lease lapsed", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("expired lease accept");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, adminCookie)).json(),
    );
    const acceptance = DispatchAcceptance.parse(
      await (await acceptDispatch(runner, dispatch.id, host.credential)).json(),
    );
    await database.db
      .update(workSessions)
      .set({
        leaseExpiresAt: sql`statement_timestamp() - interval '1 second'`,
        status: "active",
      })
      .where(eq(workSessions.id, acceptance.session.id));

    const repeated = await acceptDispatch(runner, dispatch.id, host.credential);
    expect(repeated.status).toBe(409);
    expect(Problem.parse(await repeated.json()).code).toBe("issue_not_dispatchable");
  });

  it("fans out one shared listener to concurrent long-polls", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const started = Date.now();
    const polls = [
      Promise.resolve(pollCommands(runner.id, host.credential, 0, 5000)),
      Promise.resolve(pollCommands(runner.id, host.credential, 0, 5000)),
    ];
    await new Promise((resolve) => setTimeout(resolve, 200));
    await createDispatch((await createIssue("shared listener")).id, runner.id, adminCookie);

    const results = await Promise.all(polls);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    for (const res of results) {
      expect((await commandsOf(res)).map((row) => row.kind)).toEqual(["dispatch"]);
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("streams commands as SSE when the runner asks for text/event-stream", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    await createDispatch((await createIssue("sse")).id, runner.id, adminCookie);
    const res = await request(`/api/runners/${runner.id}/commands?afterSeq=0`, {
      token: host.credential,
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("data:");
  });

  it("enqueues input_resolved when a human answers a running dispatch's question", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("answer resumes session");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, adminCookie)).json(),
    );
    const acceptance = DispatchAcceptance.parse(
      await (await acceptDispatch(runner, dispatch.id, host.credential)).json(),
    );
    const question = await insertQuestion({
      issueId: issue.id,
      runId: acceptance.run.id,
      sessionId: acceptance.session.id,
    });

    const answered = await request(`/api/questions/${question.id}/answer`, {
      method: "POST",
      cookie: adminCookie,
      body: { answer: "Use the blue branch" },
    });
    expect(answered.status).toBe(200);

    const resolved = (await commandRows(runner.id)).find((row) => row.kind === "input_resolved");
    expect(resolved?.payload).toMatchObject({
      issueId: issue.id,
      questionId: question.id,
      resolution: "answered",
      answer: "Use the blue branch",
    });
  });

  it("enqueues input_resolved when a deadline authorizes the fallback", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("fallback deadline");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, adminCookie)).json(),
    );
    const acceptance = DispatchAcceptance.parse(
      await (await acceptDispatch(runner, dispatch.id, host.credential)).json(),
    );
    await database.db
      .update(projects)
      .set({ fallbackPolicy: "fallback_allowed" })
      .where(eq(projects.id, projectId));
    const question = await insertQuestion({
      issueId: issue.id,
      runId: acceptance.run.id,
      sessionId: acceptance.session.id,
      pastDeadline: true,
    });

    await evaluateDeadlineFor(issue.id);
    const resolved = (await commandRows(runner.id)).find((row) => row.kind === "input_resolved");
    expect(resolved?.payload).toMatchObject({
      questionId: question.id,
      resolution: "fallback_used",
      answer: "Use the proposed fallback",
    });
  });

  it("enqueues cancel when a require_human deadline pauses the question", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("paused deadline");
    const dispatch = Dispatch.parse(
      await (await createDispatch(issue.id, runner.id, adminCookie)).json(),
    );
    const acceptance = DispatchAcceptance.parse(
      await (await acceptDispatch(runner, dispatch.id, host.credential)).json(),
    );
    const question = await insertQuestion({
      issueId: issue.id,
      runId: acceptance.run.id,
      sessionId: acceptance.session.id,
      pastDeadline: true,
    });

    await evaluateDeadlineFor(issue.id);
    const [stored] = await database.db
      .select({ status: questions.status })
      .from(questions)
      .where(eq(questions.id, question.id));
    expect(stored?.status).toBe("paused");
    expect(
      (await commandRows(runner.id)).find((row) => row.kind === "cancel")?.payload,
    ).toMatchObject({
      issueId: issue.id,
      reason: "question_paused",
    });
  });
});

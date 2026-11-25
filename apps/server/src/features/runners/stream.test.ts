import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
  HostCredentialResponse,
  Issue,
  IssueDispatchesResponse,
  Problem,
  Runner,
  SessionDiagnostic,
  StreamBatchResponse,
  StreamResponse,
} from "@orrery/contract";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  browserSessions,
  dispatchTokens,
  humans,
  issues,
  notifications,
  projectAccessGrants,
  projectActivity,
  projects,
  runnerCommands,
  runnerDeviceCodeAttempts,
  runnerDeviceCodes,
  runnerDispatches,
  runnerHosts,
  runners,
  runs,
  storedObjects,
  workSessionActivities,
  workSessionStreamChunks,
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
import { createLocalObjectStore, type ObjectStore } from "../../platform/storage.ts";
import type { Feature } from "../../platform/feature.ts";
import { createFeatures } from "../index.ts";
import { type SessionsFeature } from "../work-sessions/index.ts";
import { type RunnersFeature } from "./index.ts";

const SECRET = "stream-test-bootstrap-secret-123456";
const ADMIN_EMAIL = "stream-admin@example.com";
const ADMIN_PASSWORD = "stream-admin-password";
const PUBLIC_URL = "http://orrery.test";

let pg: StartedPostgreSqlContainer;
let database: Database;
let dataDir: string;
let store: ObjectStore;
let features: Feature[];
let app: Hono;
let service: RunnersFeature["service"];
let adminCookie: string;
let adminHumanId: string;
let workspaceId: string;
let projectId: string;
let agentId: string;

type Fixture = {
  host: HostCredentialResponse;
  runner: Runner;
  issue: Issue;
  dispatch: Dispatch;
  acceptance: DispatchAcceptance;
  sessionId: string;
  attemptId: string;
};
let fixture: Fixture;

function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

function isRunnersFeature(feature: Feature): feature is RunnersFeature {
  return feature.name === "runners" && "service" in feature;
}

function isSessionsFeature(feature: Feature): feature is SessionsFeature {
  return feature.name === "work-sessions" && "service" in feature;
}

function stopSessionViaRest(dispatchToken: string) {
  return request(`/api/issues/${fixture.issue.id}/work-sessions/stop`, {
    method: "POST",
    token: dispatchToken,
    body: { outcome: "completed" },
  });
}

const request = (
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
) =>
  app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
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

async function insertHuman(email: string) {
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

async function enrollHost(cookie: string) {
  const verifier = randomBytes(32).toString("hex");
  const created = await request("/api/runners/device-codes", {
    method: "POST",
    body: {
      hostDisplayName: "stream-laptop",
      platform: "linux-x64",
      verifierHash: tokenHash(verifier),
    },
  });
  expect(created.status).toBe(201);
  const device = DeviceCodeResponse.parse(await created.json());
  const approved = await request(`/api/runners/device-codes/${device.userCode}/approve`, {
    method: "POST",
    cookie,
  });
  expect(approved.status).toBe(200);
  const exchanged = await request("/api/runners/device-codes/token", {
    method: "POST",
    body: { deviceCode: device.deviceCode, verifier },
  });
  expect(exchanged.status).toBe(200);
  return HostCredentialResponse.parse(await exchanged.json());
}

async function registerRunner(credential: string) {
  const res = await request("/api/runners/register", {
    method: "POST",
    body: {
      workspaceId,
      projectId,
      agentId,
      repoFingerprint: tokenHash(`/secret/repo/${randomUUID()}`),
    },
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

async function acceptedFixture(): Promise<Fixture> {
  const host = await enrollHost(adminCookie);
  const runner = await registerRunner(host.credential);
  const issue = await createIssue(`stream-${randomUUID()}`);
  const created = await request(`/api/issues/${issue.id}/dispatches`, {
    method: "POST",
    body: { runnerId: runner.id },
    cookie: adminCookie,
  });
  expect(created.status).toBe(201);
  const dispatch = Dispatch.parse(await created.json());
  const accepted = await request(`/api/runners/${runner.id}/dispatches/${dispatch.id}/accept`, {
    method: "POST",
    token: host.credential,
  });
  expect(accepted.status).toBe(200);
  const acceptance = DispatchAcceptance.parse(await accepted.json());
  const [row] = await database.db
    .select({ workSessionId: runnerDispatches.workSessionId })
    .from(runnerDispatches)
    .where(eq(runnerDispatches.id, dispatch.id));
  if (row?.workSessionId === null || row?.workSessionId === undefined) {
    throw new Error("accepted dispatch has no work session");
  }
  return {
    host,
    runner,
    issue,
    dispatch,
    acceptance,
    sessionId: row.workSessionId,
    attemptId: dispatch.dispatchAttemptId,
  };
}

const chunk = (
  seq: number,
  summary: string,
  visibility: "project_readers" | "owner_only" = "project_readers",
) => ({
  seq,
  kind: "event" as const,
  eventType: "tool_call",
  summary,
  visibility,
  data: { seq },
});

function postBatch(
  chunks: Record<string, unknown>[],
  fromSeq: number,
  toSeq: number,
  cred = fixture.host.credential,
) {
  return request(`/api/runners/${fixture.runner.id}/dispatches/${fixture.dispatch.id}/stream`, {
    method: "POST",
    token: cred,
    body: { dispatchAttemptId: fixture.attemptId, fromSeq, toSeq, chunks },
  });
}

function getStream(afterSeq = 0, opts: { cookie?: string; token?: string } = {}) {
  return request(
    `/api/runners/${fixture.runner.id}/dispatches/${fixture.dispatch.id}/stream?afterSeq=${afterSeq}`,
    opts,
  );
}

async function hotCount(sessionId = fixture.sessionId) {
  return (
    await database.db
      .select({ seq: workSessionStreamChunks.seq })
      .from(workSessionStreamChunks)
      .where(eq(workSessionStreamChunks.workSessionId, sessionId))
  ).length;
}

async function endSession() {
  await database.db
    .update(workSessions)
    .set({ status: "completed", endedAt: sql`statement_timestamp()` })
    .where(eq(workSessions.id, fixture.sessionId));
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
  dataDir = await mkdtemp(join(tmpdir(), "orrery-stream-test-"));
  store = createLocalObjectStore(dataDir);
  features = createFeatures(database, config, createLogger("error"), store);
  app = createApp({ features, publicUrl: PUBLIC_URL, log: createLogger("error") });
  const runnersFeature = features.find(isRunnersFeature);
  if (runnersFeature === undefined) throw new Error("runners feature was not registered");
  service = runnersFeature.service;

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
      .values({ id: randomUUID(), kind: "shared", name: "Stream workspace" })
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
      name: "Stream repo",
      key: `ST${randomBytes(3).toString("hex").slice(0, 3).toUpperCase()}`,
      createdByHumanId: adminHumanId,
    })
    .returning();
  projectId = project!.id;
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: adminHumanId, name: `stream-agent-${randomUUID()}` })
    .returning();
  agentId = agent!.id;
  fixture = await acceptedFixture();
});

afterEach(async () => {
  // A DB trigger refuses TRUNCATE on workspace_memberships, so delete every row
  // in dependency order inside one transaction instead.
  await database.db.transaction(async (tx) => {
    await tx.delete(workSessionStreamChunks);
    await tx.delete(workSessionActivities);
    await tx.delete(dispatchTokens);
    await tx.delete(runnerCommands);
    await tx.delete(runnerDispatches);
    await tx.delete(workSessions);
    await tx.delete(storedObjects);
    await tx.delete(notifications);
    await tx.delete(projectActivity);
    await tx.delete(runs);
    await tx.delete(issues);
    await tx.delete(projectAccessGrants);
    await tx.delete(projects);
    await tx.delete(workspaceMemberships);
    await tx.delete(runnerDeviceCodeAttempts);
    await tx.delete(runnerDeviceCodes);
    await tx.delete(runners);
    await tx.delete(runnerHosts);
    await tx.delete(agents);
    await tx.delete(browserSessions);
    await tx.delete(workspaces);
    // The bootstrap administrator is referenced by instance_setup; keep it.
    await tx.delete(humans).where(ne(humans.id, adminHumanId));
  });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await database?.sql.end();
  await pg?.stop();
});

describe("structured stream ingestion and ObjectStore rollup (#199)", () => {
  it("acks idempotent fromSeq..toSeq replays and partial overlaps", async () => {
    const first = await postBatch([chunk(1, "one"), chunk(2, "two")], 1, 2);
    expect(first.status).toBe(200);
    expect(StreamBatchResponse.parse(await first.json())).toEqual({ ackedSeq: 2 });

    const replay = await postBatch([chunk(2, "two"), chunk(3, "three"), chunk(4, "four")], 2, 4);
    expect(StreamBatchResponse.parse(await replay.json())).toEqual({ ackedSeq: 4 });

    const gap = await postBatch([chunk(5, "five"), chunk(7, "seven")], 5, 7);
    expect(StreamBatchResponse.parse(await gap.json())).toEqual({ ackedSeq: 5 });

    const filled = await postBatch([chunk(6, "six"), chunk(7, "seven")], 6, 7);
    expect(StreamBatchResponse.parse(await filled.json())).toEqual({ ackedSeq: 7 });
    expect(await hotCount()).toBe(7);

    const stream = StreamResponse.parse(
      await (await getStream(0, { token: fixture.host.credential })).json(),
    );
    expect(stream.chunks.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(stream.nextAfterSeq).toBe(7);
  });

  it("returns RFC 9457 429 with Retry-After on DB-time backpressure", async () => {
    for (let seq = 1; seq <= 6; seq += 1) {
      const res = await postBatch([chunk(seq, `batch-${seq}`)], seq, seq);
      expect(res.status).toBe(200);
    }
    const blocked = await postBatch([chunk(7, "batch-7")], 7, 7);
    await expectProblem(blocked, 429, "stream_rate_limited");
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    await database.db
      .update(runnerDispatches)
      .set({ streamWindowStartedAt: sql`statement_timestamp() - interval '61 seconds'` })
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    const retried = await postBatch([chunk(7, "batch-7")], 7, 7);
    expect(StreamBatchResponse.parse(await retried.json())).toEqual({ ackedSeq: 7 });
  });

  it("coalesces semantic milestones into work_session_activities", async () => {
    await postBatch([chunk(1, "npm test"), { ...chunk(2, "npm test"), kind: "diagnostic" }], 1, 2);
    await postBatch([chunk(3, "npm test")], 3, 3);
    await postBatch(
      [chunk(4, "build"), { ...chunk(5, "secret"), kind: "raw_output", visibility: "owner_only" }],
      4,
      5,
    );

    const rows = await database.db
      .select({ summary: workSessionActivities.summary, kind: workSessionActivities.kind })
      .from(workSessionActivities)
      .where(eq(workSessionActivities.workSessionId, fixture.sessionId));
    const summaries = rows.map((row) => row.summary);
    expect(summaries.filter((summary) => summary === "npm test")).toHaveLength(1);
    expect(summaries).toContain("build");
    expect(summaries).not.toContain("secret");
  });

  it("filters owner_only chunks server-side on live and archived streams", async () => {
    // A system administrator who is not the Runner host owner must still be
    // filtered: the check is human identity, never an admin role.
    const teammate = await insertHuman(`teammate-${randomUUID()}@example.com`);
    await database.db
      .update(humans)
      .set({ isSystemAdministrator: true })
      .where(eq(humans.id, teammate.id));
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: teammate.id,
      isOwner: false,
    });
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId,
      humanId: teammate.id,
      level: "read",
      grantedByHumanId: adminHumanId,
    });
    const teammateCookie = await browserCookie(teammate.id);

    await postBatch(
      [
        chunk(1, "visible event"),
        {
          seq: 2,
          kind: "raw_output",
          data: { stdout: "host secret" },
        },
        {
          seq: 3,
          kind: "diagnostic",
          diagnostic: { kind: "usage_limit", version: 1, message: "rate limited" },
        },
      ],
      1,
      3,
    );

    const ownerLive = StreamResponse.parse(
      await (await getStream(0, { cookie: adminCookie })).json(),
    );
    expect(ownerLive.chunks.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(ownerLive.chunks[1]?.visibility).toBe("owner_only");
    const teammateLive = StreamResponse.parse(
      await (await getStream(0, { cookie: teammateCookie })).json(),
    );
    expect(teammateLive.chunks.map((entry) => entry.seq)).toEqual([1, 3]);
    expect(teammateLive.chunks.some((entry) => entry.visibility === "owner_only")).toBe(false);
    expect(SessionDiagnostic.parse(teammateLive.chunks[1]?.diagnostic)).toMatchObject({
      kind: "usage_limit",
      version: 1,
    });

    await endSession();
    expect(await service.rollUpStreams()).toBe(1);
    const [session] = await database.db
      .select({ streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, fixture.sessionId));
    expect(session?.streamObjectId).not.toBeNull();
    expect(await hotCount()).toBe(0);
    const [object] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.id, session!.streamObjectId!));
    expect(object).toMatchObject({ status: "active" });
    expect(object!.byteSize).toBeGreaterThan(0);
    expect((await store.get(object!.key))?.data.byteLength).toBeGreaterThan(0);

    const teammateArchived = StreamResponse.parse(
      await (await getStream(0, { cookie: teammateCookie })).json(),
    );
    expect(teammateArchived.rolledUp).toBe(true);
    expect(teammateArchived.chunks.map((entry) => entry.seq)).toEqual([1, 3]);
    const ownerArchived = StreamResponse.parse(
      await (await getStream(0, { token: fixture.host.credential })).json(),
    );
    expect(ownerArchived.chunks.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("marks missed-heartbeat dispatches uncertain with a diagnostic and no auto-cancel", async () => {
    await postBatch([chunk(1, "in flight")], 1, 1);
    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '31 seconds'` })
      .where(eq(runners.id, fixture.runner.id));

    expect(await service.markDisconnectedDispatches()).toBe(1);
    const [dispatch] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    expect(dispatch?.state).toBe("uncertain");
    expect(dispatch?.disconnectedAt).not.toBeNull();
    const [session] = await database.db
      .select({ status: workSessions.status })
      .from(workSessions)
      .where(eq(workSessions.id, fixture.sessionId));
    expect(session?.status).toBe("active");
    const cancels = await database.db
      .select()
      .from(runnerCommands)
      .where(
        and(eq(runnerCommands.dispatchId, fixture.dispatch.id), eq(runnerCommands.kind, "cancel")),
      );
    expect(cancels).toHaveLength(0);
    const activities = await database.db
      .select({ detail: workSessionActivities.detail })
      .from(workSessionActivities)
      .where(eq(workSessionActivities.workSessionId, fixture.sessionId));
    const diagnostic = activities
      .map((activity) => activity.detail?.diagnostic)
      .find((value) => value !== undefined);
    expect(SessionDiagnostic.parse(diagnostic)).toMatchObject({
      kind: "runner_disconnected",
      version: 1,
    });
    // Stream readers see the diagnostic too, without consuming a spool seq.
    const live = StreamResponse.parse(await (await getStream(0, { cookie: adminCookie })).json());
    expect(
      live.chunks.some(
        (entry) => entry.kind === "diagnostic" && entry.diagnostic?.kind === "runner_disconnected",
      ),
    ).toBe(true);
  });

  it("resumes a live attempt but never advances lastUpSeq past persisted chunks", async () => {
    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '31 seconds'` })
      .where(eq(runners.id, fixture.runner.id));
    await service.markDisconnectedDispatches();
    const res = await request(`/api/runners/${fixture.runner.id}/reconnect`, {
      method: "POST",
      token: fixture.host.credential,
      body: { activeAttempts: [{ dispatchAttemptId: fixture.attemptId, lastSeq: 5 }] },
    });
    expect(res.status).toBe(200);
    // The response reports the SERVER cursor (0), so the runner replays 1..5.
    expect(await res.json()).toMatchObject({
      resolutions: [
        { dispatchId: fixture.dispatch.id, resumed: true, lastSeq: 0, state: "active" },
      ],
    });
    const [dispatch] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    expect(dispatch).toMatchObject({ state: "active", lastUpSeq: 0, needsHumanResolution: false });
  });

  it("keeps an absent uncertain attempt uncertain and blocks a second dispatch until resolution", async () => {
    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '31 seconds'` })
      .where(eq(runners.id, fixture.runner.id));
    await service.markDisconnectedDispatches();

    const reconnect = await request(`/api/runners/${fixture.runner.id}/reconnect`, {
      method: "POST",
      token: fixture.host.credential,
      body: { activeAttempts: [] },
    });
    expect(reconnect.status).toBe(200);
    const [afterReconnect] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    expect(afterReconnect).toMatchObject({ state: "uncertain", needsHumanResolution: true });

    const second = await request(`/api/issues/${fixture.issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: fixture.runner.id },
      cookie: adminCookie,
    });
    await expectProblem(second, 409, "dispatch_uncertain");

    const resolved = await request(`/api/runners/dispatches/${fixture.dispatch.id}/resolve`, {
      method: "POST",
      body: { outcome: "released" },
      cookie: adminCookie,
    });
    expect(resolved.status).toBe(200);
    expect(Dispatch.parse(await resolved.json()).state).toBe("ended");

    const redispatch = await request(`/api/issues/${fixture.issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: fixture.runner.id },
      cookie: adminCookie,
    });
    expect(redispatch.status).toBe(201);
  });

  it("aborts a rollup whose pending blob lost a race to a late chunk", async () => {
    await postBatch([chunk(1, "before rollup")], 1, 1);
    await endSession();

    let enterPut: (() => void) | undefined;
    let leavePut: (() => void) | undefined;
    const putEntered = new Promise<void>((resolve) => {
      enterPut = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      leavePut = resolve;
    });
    const gatedStore: ObjectStore = {
      ...store,
      async put(key, data, contentType) {
        enterPut?.();
        await putReleased;
        return store.put(key, data, contentType);
      },
    };
    const gatedFeatures = createFeatures(
      database,
      loadConfig({
        DATABASE_URL: pg.getConnectionUri(),
        PUBLIC_URL,
        BOOTSTRAP_SECRET: SECRET,
        LOG_LEVEL: "error",
      }),
      createLogger("error"),
      gatedStore,
    );
    const gatedApp = createApp({
      features: gatedFeatures,
      publicUrl: PUBLIC_URL,
      log: createLogger("error"),
    });
    const gatedFeature = gatedFeatures.find(isRunnersFeature);
    if (gatedFeature === undefined) throw new Error("gated runners feature missing");

    // The blob is written outside the transaction: a late batch can land after
    // the snapshot but before the lock. The pending object must be discarded
    // and every hot chunk preserved for the next rollup.
    const rolling = gatedFeature.service.rollUpStreams();
    await putEntered;
    const lateResult = StreamBatchResponse.parse(
      await (await postBatch([chunk(2, "late batch")], 2, 2)).json(),
    );
    expect(lateResult.ackedSeq).toBe(2);
    leavePut?.();
    expect(await rolling).toBe(0); // aborted: no orphan active blob

    const [aborted] = await database.db
      .select({ streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, fixture.sessionId));
    expect(aborted?.streamObjectId).toBeNull();
    expect(await hotCount()).toBe(2);

    const replay = StreamResponse.parse(
      await (
        await gatedApp.request(
          `/api/runners/${fixture.runner.id}/dispatches/${fixture.dispatch.id}/stream?afterSeq=0`,
          { headers: { authorization: `Bearer ${fixture.host.credential}` } },
        )
      ).json(),
    );
    expect(replay.rolledUp).toBe(false);
    expect(replay.chunks.map((entry) => entry.seq)).toEqual([1, 2]);

    // The retry merges BOTH chunks into one new immutable blob and prunes hot rows.
    expect(await gatedFeature.service.rollUpStreams()).toBe(1);
    expect(await hotCount()).toBe(0);
    const mergedReplay = StreamResponse.parse(
      await (
        await gatedApp.request(
          `/api/runners/${fixture.runner.id}/dispatches/${fixture.dispatch.id}/stream?afterSeq=0`,
          { headers: { authorization: `Bearer ${fixture.host.credential}` } },
        )
      ).json(),
    );
    expect(mergedReplay).toMatchObject({ rolledUp: true, nextAfterSeq: 2 });
    expect(mergedReplay.chunks.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("skips rollup entirely for a zero-chunk session", async () => {
    await endSession();
    expect(await service.rollUpStreams()).toBe(0);
    const [session] = await database.db
      .select({ streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, fixture.sessionId));
    expect(session?.streamObjectId).toBeNull();
    const objects = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.key, `streams/${fixture.sessionId}.jsonl`));
    expect(objects).toHaveLength(0);
  });

  it("validates all eight versioned SessionDiagnostic variants", () => {
    const diagnostics = [
      { kind: "acp_not_installed", version: 1, message: "ACP binary missing", harness: "opencode" },
      { kind: "acp_spawn_failed", version: 1, message: "spawn failed", exitCode: 2 },
      { kind: "acp_crashed", version: 1, message: "crashed", signal: "SIGKILL" },
      {
        kind: "auth_expired",
        version: 1,
        message: "provider auth expired",
        remediation: "Run opencode auth login",
      },
      {
        kind: "usage_limit",
        version: 1,
        message: "rate limited",
        resetsAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        kind: "provider_overload",
        version: 1,
        message: "overloaded",
        attempt: 2,
        countdownSeconds: 30,
      },
      { kind: "permission_denied", version: 1, message: "denied", tool: "write" },
      { kind: "runner_disconnected", version: 1, message: "heartbeat lost" },
    ];
    expect(diagnostics).toHaveLength(8);
    for (const diagnostic of diagnostics) {
      expect(SessionDiagnostic.parse(diagnostic)).toMatchObject({
        kind: diagnostic.kind,
        version: 1,
      });
    }
  });

  it("stalls ackedSeq across a cross-batch sequence gap", async () => {
    const later = await postBatch([chunk(3, "three"), chunk(4, "four")], 3, 4);
    expect(StreamBatchResponse.parse(await later.json()).ackedSeq).toBe(0);
    const earlier = await postBatch([chunk(1, "one"), chunk(2, "two")], 1, 2);
    expect(StreamBatchResponse.parse(await earlier.json()).ackedSeq).toBe(2);
    const filled = await postBatch([chunk(3, "three"), chunk(4, "four")], 3, 4);
    expect(StreamBatchResponse.parse(await filled.json()).ackedSeq).toBe(4);
  });

  it("an active attempt absent on reconnect becomes uncertain", async () => {
    const res = await request(`/api/runners/${fixture.runner.id}/reconnect`, {
      method: "POST",
      token: fixture.host.credential,
      body: { activeAttempts: [] },
    });
    expect(res.status).toBe(200);
    const [dispatch] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    expect(dispatch).toMatchObject({ state: "uncertain", needsHumanResolution: true });
    const second = await request(`/api/issues/${fixture.issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: fixture.runner.id },
      cookie: adminCookie,
    });
    await expectProblem(second, 409, "dispatch_uncertain");
  });

  it("never resumes an expired claim, even when the attempt is reported", async () => {
    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: sql`statement_timestamp() - interval '1 second'` })
      .where(eq(workSessions.id, fixture.sessionId));
    const res = await request(`/api/runners/${fixture.runner.id}/reconnect`, {
      method: "POST",
      token: fixture.host.credential,
      body: { activeAttempts: [{ dispatchAttemptId: fixture.attemptId, lastSeq: 5 }] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resolutions: [
        { dispatchId: fixture.dispatch.id, resumed: false, lastSeq: 0, state: "uncertain" },
      ],
    });
    const [dispatch] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    expect(dispatch).toMatchObject({
      state: "uncertain",
      needsHumanResolution: true,
      lastUpSeq: 0,
    });
  });

  it("listIssueDispatches never settles an uncertain dispatch on lease expiry", async () => {
    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '31 seconds'` })
      .where(eq(runners.id, fixture.runner.id));
    await service.markDisconnectedDispatches();
    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: sql`statement_timestamp() - interval '1 second'` })
      .where(eq(workSessions.id, fixture.sessionId));
    const listed = await request(`/api/issues/${fixture.issue.id}/dispatches`, {
      cookie: adminCookie,
    });
    expect(listed.status).toBe(200);
    const dispatches = IssueDispatchesResponse.parse(await listed.json()).dispatches;
    expect(dispatches[0]?.state).toBe("uncertain");
    const [dispatch] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, fixture.dispatch.id));
    expect(dispatch?.state).toBe("uncertain");
  });

  it("rolls up immediately when a work session is stopped", async () => {
    await postBatch([chunk(1, "before stop")], 1, 1);
    const stopped = await stopSessionViaRest(fixture.acceptance.dispatchToken);
    expect(stopped.status).toBe(200);
    const [session] = await database.db
      .select({ status: workSessions.status, streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, fixture.sessionId));
    expect(session?.status).toBe("completed");
    expect(session?.streamObjectId).not.toBeNull();
    expect(await hotCount()).toBe(0);
  });

  it("rolls up immediately when the lease-expiry sweep ends a session", async () => {
    await postBatch([chunk(1, "before sweep")], 1, 1);
    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: sql`statement_timestamp() - interval '1 second'` })
      .where(eq(workSessions.id, fixture.sessionId));
    const sessionsFeature = features.find(isSessionsFeature);
    if (sessionsFeature === undefined) throw new Error("work-sessions feature missing");
    await sessionsFeature.service.sweep();
    const [session] = await database.db
      .select({ status: workSessions.status, streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, fixture.sessionId));
    expect(session?.status).toBe("expired");
    expect(session?.streamObjectId).not.toBeNull();
    expect(await hotCount()).toBe(0);
  });

  it("does not starve sessions beyond the first rollUp page", async () => {
    const extraIds: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const id = randomUUID();
      await database.db.insert(workSessions).values({
        id,
        agentId,
        runId: fixture.acceptance.run.id,
        workspaceId,
        issueId: fixture.issue.id,
        status: "completed",
        leaseExpiresAt: sql`statement_timestamp() + interval '5 minutes'`,
        endedAt: sql`statement_timestamp()`,
        createdAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      });
      await database.db.insert(workSessionStreamChunks).values({
        workSessionId: id,
        seq: 1,
        kind: "event",
        visibility: "project_readers",
        payload: chunk(1, `overflow-${i}`),
      });
      extraIds.push(id);
    }
    expect(await service.rollUpStreams(20)).toBe(20);
    expect(await service.rollUpStreams(20)).toBe(1);
    const rolled = await database.db
      .select({ id: workSessions.id, streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(inArray(workSessions.id, extraIds));
    expect(rolled).toHaveLength(21);
    expect(rolled.every((row) => row.streamObjectId !== null)).toBe(true);
  });

  it("does not enumerate streams or resolutions to unauthenticated/foreign callers", async () => {
    const anonymousExisting = await getStream(0);
    await expectProblem(anonymousExisting, 401, "invalid_credential");
    const anonymousMissing = await request(
      `/api/runners/${fixture.runner.id}/dispatches/${randomUUID()}/stream`,
    );
    await expectProblem(anonymousMissing, 401, "invalid_credential");

    const outsider = await insertHuman(`outsider-${randomUUID()}@example.com`);
    await database.db.insert(workspaces).values({
      id: randomUUID(),
      kind: "personal",
      name: "Foreign workspace",
      personalOwnerHumanId: outsider.id,
    });
    const outsiderCookie = await browserCookie(outsider.id);
    const foreignStream = await getStream(0, { cookie: outsiderCookie });
    expect(foreignStream.status).toBe(404);
    await expectProblem(foreignStream, 404, "dispatch_not_found");

    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '31 seconds'` })
      .where(eq(runners.id, fixture.runner.id));
    await service.markDisconnectedDispatches();
    const resolved = await request(`/api/runners/dispatches/${fixture.dispatch.id}/resolve`, {
      method: "POST",
      body: { outcome: "released" },
      cookie: outsiderCookie,
    });
    await expectProblem(resolved, 404, "dispatch_not_found");
  });

  it("guards double-start and clears background ticks on stop", async () => {
    const runnersFeature = features.find(isRunnersFeature);
    if (runnersFeature === undefined) throw new Error("runners feature missing");
    runnersFeature.startBackgroundTasks?.();
    runnersFeature.startBackgroundTasks?.();
    await expect(runnersFeature.stop?.()).resolves.toBeUndefined();
  });
});

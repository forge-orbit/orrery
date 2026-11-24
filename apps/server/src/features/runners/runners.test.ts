import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DeviceCodeResponse,
  FleetRunner,
  HostCredentialResponse,
  Problem,
  type ProjectAccessLevel,
  Runner,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  browserSessions,
  humans,
  projects,
  runnerDeviceCodeAttempts,
  runnerDeviceCodes,
  runnerHosts,
  runners,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { projectAccessAtLeast } from "../projects/index.ts";
import { createRunnersFeature, revokeWorkspaceRunnersForMember } from "./index.ts";

const PUBLIC_URL = "http://orrery.test";
/** Overrides used to simulate a human losing read access to a project. */
const accessOverrides = new Map<string, ProjectAccessLevel | null>();

const postJson = (app: Hono, path: string, body: unknown, cookie?: string, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : {});

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: "correct horse battery staple staple",
    publicUrl: PUBLIC_URL,
  });
  app = createApp({
    features: [
      accounts,
      createRunnersFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        publicUrl: PUBLIC_URL,
        projectAccessCeiling: async (_tx, _workspaceId, _humanId, projectIds) =>
          new Map(
            projectIds.map((id) => [
              id,
              accessOverrides.has(id) ? (accessOverrides.get(id) ?? null) : "contribute",
            ]),
          ),
        projectAccessAtLeast,
        claimWorkSession: async () => {
          throw new Error("claimWorkSession is not wired in this test");
        },
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: createLogger("error"),
  });
}, 120_000);

afterEach(async () => {
  accessOverrides.clear();
  await database.db.delete(runners);
  await database.db.delete(runnerDeviceCodes);
  await database.db.delete(runnerDeviceCodeAttempts);
  await database.db.delete(runnerHosts);
  await database.db.delete(browserSessions);
  await database.db.delete(agents);
  await database.db.delete(projects);
  await database.db.delete(workspaces);
  await database.db.delete(humans);
});

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

async function insertHuman() {
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email: `${randomUUID()}@example.com`,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`statement_timestamp()`,
    })
    .returning();
  if (human === undefined) throw new Error("human was not created");
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId: human.id,
    tokenHash: tokenHash(token),
    expiresAt: sql`statement_timestamp() + interval '1 hour'`,
  });
  return { human, cookie: `orrery_session=${token}` };
}

async function insertWorkspaceAndProject(humanId: string) {
  const [workspace] = await database.db
    .insert(workspaces)
    .values({
      id: randomUUID(),
      kind: "personal",
      name: "Personal",
      personalOwnerHumanId: humanId,
    })
    .returning();
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId: workspace!.id,
      name: "Repo",
      key: "REP",
      createdByHumanId: humanId,
    })
    .returning();
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId, name: `agent-${randomUUID()}` })
    .returning();
  return { workspace: workspace!, project: project!, agent: agent! };
}

async function beginDeviceCode(displayName = "rubis-laptop", platform = "linux-x64") {
  const verifier = randomBytes(32).toString("hex");
  const res = await postJson(app, "/api/runners/device-codes", {
    hostDisplayName: displayName,
    platform,
    verifierHash: tokenHash(verifier),
  });
  expect(res.status).toBe(201);
  const body = DeviceCodeResponse.parse(await res.json());
  return { verifier, ...body };
}

async function enrollHost(cookie: string, displayName = "rubis-laptop", platform = "linux-x64") {
  const device = await beginDeviceCode(displayName, platform);
  const approval = await postJson(
    app,
    `/api/runners/device-codes/${device.userCode}/approve`,
    {},
    cookie,
  );
  expect(approval.status).toBe(200);
  const exchange = await postJson(app, "/api/runners/device-codes/token", {
    deviceCode: device.deviceCode,
    verifier: device.verifier,
  });
  expect(exchange.status).toBe(200);
  const credential = HostCredentialResponse.parse(await exchange.json());
  return credential;
}

async function registerRunner(
  credential: string,
  opts: { workspaceId: string; projectId: string; repoFingerprint?: string } & Partial<{
    agentId: string;
    capabilities: string[];
    maxConcurrency: number;
    displayName: string;
  }>,
) {
  const res = await postJson(
    app,
    "/api/runners/register",
    {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      repoFingerprint: opts.repoFingerprint ?? tokenHash("/home/rubi/secret/project"),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
    },
    undefined,
    credential,
  );
  expect(res.status).toBe(201);
  return Runner.parse(await res.json());
}

describe("device-code enrollment", () => {
  it("never approves on GET and requires an authenticated POST", async () => {
    const { human, cookie } = await insertHuman();
    expect(human).toBeDefined();
    const device = await beginDeviceCode("rubis-laptop", "darwin-arm64");

    const preview = await getJson(app, `/api/runners/device-codes/${device.userCode}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      userCode: device.userCode,
      hostDisplayName: "rubis-laptop",
      platform: "darwin-arm64",
    });

    const pending = await postJson(app, "/api/runners/device-codes/token", {
      deviceCode: device.deviceCode,
      verifier: device.verifier,
    });
    await expectProblem(pending, 409, "device_code_pending");

    const anonymous = await postJson(
      app,
      `/api/runners/device-codes/${device.userCode}/approve`,
      {},
    );
    await expectProblem(anonymous, 401, "not_signed_in");

    const approved = await postJson(
      app,
      `/api/runners/device-codes/${device.userCode}/approve`,
      {},
      cookie,
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      hostDisplayName: "rubis-laptop",
      platform: "darwin-arm64",
    });

    // The GET preview must not leave a second approval possible.
    const replay = await postJson(
      app,
      `/api/runners/device-codes/${device.userCode}/approve`,
      {},
      cookie,
    );
    await expectProblem(replay, 404, "device_code_invalid");
  });

  it("limits failed user-code attempts to five per human", async () => {
    const { cookie } = await insertHuman();
    await beginDeviceCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await postJson(app, "/api/runners/device-codes/AAAA-AAAA/approve", {}, cookie);
      await expectProblem(res, 404, "device_code_invalid");
    }
    const blocked = await postJson(app, "/api/runners/device-codes/AAAA-AAAA/approve", {}, cookie);
    expect(blocked.status).toBe(429);
    await expectProblem(blocked, 429, "device_code_rate_limited");
  });

  it("binds the verifier, enforces the attempt limit, and exchanges exactly once", async () => {
    const { cookie } = await insertHuman();
    const device = await beginDeviceCode();
    await postJson(app, `/api/runners/device-codes/${device.userCode}/approve`, {}, cookie);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await postJson(app, "/api/runners/device-codes/token", {
        deviceCode: device.deviceCode,
        verifier: randomBytes(32).toString("hex"),
      });
      await expectProblem(res, 403, "invalid_verifier");
    }
    const blocked = await postJson(app, "/api/runners/device-codes/token", {
      deviceCode: device.deviceCode,
      verifier: device.verifier,
    });
    expect(blocked.status).toBe(409);
    const [storedDevice] = await database.db
      .select()
      .from(runnerDeviceCodes)
      .where(eq(runnerDeviceCodes.userCode, device.userCode));
    expect(storedDevice?.failedAttempts).toBe(5);
    await expectProblem(blocked, 409, "too_many_attempts");
  });

  it("stores only a digest of the host credential and consumes the code once", async () => {
    const { cookie, human } = await insertHuman();
    const credential = await enrollHost(cookie);
    const [host] = await database.db
      .select()
      .from(runnerHosts)
      .where(eq(runnerHosts.id, credential.hostId));
    expect(host?.humanId).toBe(human.id);
    expect(host?.credentialHash).toBe(tokenHash(credential.credential));
    const rows = await database.db.select().from(runnerHosts);
    expect(JSON.stringify(rows)).not.toContain(credential.credential);

    const [code] = await database.db.select().from(runnerDeviceCodes);
    expect(code?.usedAt).not.toBeNull();
  });

  it("expires device codes after ten minutes", async () => {
    const { cookie } = await insertHuman();
    const device = await beginDeviceCode();
    await database.db
      .update(runnerDeviceCodes)
      .set({ expiresAt: sql`statement_timestamp() - interval '1 minute'` })
      .where(eq(runnerDeviceCodes.userCode, device.userCode));
    const res = await postJson(
      app,
      `/api/runners/device-codes/${device.userCode}/approve`,
      {},
      cookie,
    );
    expect(res.status).toBe(409);
    await expectProblem(res, 409, "device_code_expired");
  });
});

describe("runner registration and live presence", () => {
  it("registers a project-bound runner with a default agent and an opaque fingerprint", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project, agent } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      capabilities: ["opencode"],
      maxConcurrency: 2,
    });
    expect(created.agentId).toBe(agent.id);
    expect(created.repoFingerprint).toBe(tokenHash("/home/rubi/secret/project"));
    expect(created.capabilities).toEqual(["opencode"]);
    expect(created.maxConcurrency).toBe(2);
    expect(created.presence).toBe("online");

    const stored = await database.db.select().from(runners);
    expect(JSON.stringify(stored)).not.toContain("/home/rubi/secret/project");
  });

  it("derives online/busy/offline from DB time, revocation and active sessions", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      maxConcurrency: 2,
    });

    const busy = await postJson(
      app,
      `/api/runners/${created.id}/heartbeat`,
      { activeSlotCount: 1 },
      undefined,
      credential.credential,
    );
    expect(busy.status).toBe(200);
    expect(Runner.parse(await busy.json()).presence).toBe("busy");

    const idle = await postJson(
      app,
      `/api/runners/${created.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      credential.credential,
    );
    expect(Runner.parse(await idle.json()).presence).toBe("online");

    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '5 minutes'` })
      .where(eq(runners.id, created.id));
    const fleet = await getJson(app, `/api/workspaces/${workspace.id}/runners`, cookie);
    expect(fleet.status).toBe(200);
    const parsed = WorkspaceRunnersFleet.parse(await fleet.json());
    expect(FleetRunner.parse(parsed.hosts[0]!.runners[0]!).presence).toBe("offline");
  });

  it("stops accepting a revoked host's heartbeat with 401", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });

    await database.db
      .update(runnerHosts)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(runnerHosts.id, credential.hostId));
    const res = await postJson(
      app,
      `/api/runners/${created.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      credential.credential,
    );
    expect(res.status).toBe(401);
    await expectProblem(res, 401, "invalid_credential");
  });

  it("rejects a bearer that is not a host credential", async () => {
    const res = await postJson(app, "/api/runners/register", {
      workspaceId: "w",
      projectId: "p",
      repoFingerprint: tokenHash("repo"),
    });
    expect(res.status).toBe(401);
    await expectProblem(res, 401, "invalid_credential");
  });
});

describe("revocation", () => {
  it("revokes a host and all its runners, for the owner only", async () => {
    const owner = await insertHuman();
    const other = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(owner.human.id);
    const credential = await enrollHost(owner.cookie);
    const first = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      repoFingerprint: tokenHash("repo-1"),
    });
    const second = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      repoFingerprint: tokenHash("repo-2"),
    });

    const denied = await postJson(
      app,
      `/api/runner-hosts/${credential.hostId}/revoke`,
      {},
      other.cookie,
    );
    await expectProblem(denied, 404, "host_not_found");

    const res = await postJson(
      app,
      `/api/runner-hosts/${credential.hostId}/revoke`,
      {},
      owner.cookie,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hostId: credential.hostId, revokedRunners: 2 });

    const rows = await database.db
      .select()
      .from(runners)
      .where(and(eq(runners.hostId, credential.hostId), isNull(runners.revokedAt)));
    expect(rows).toEqual([]);
    expect(first.id).not.toBe(second.id);
    const heartbeat = await postJson(
      app,
      `/api/runners/${first.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      credential.credential,
    );
    await expectProblem(heartbeat, 401, "invalid_credential");
  });

  it("hides revoked hosts from the fleet", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });
    await postJson(app, `/api/runner-hosts/${credential.hostId}/revoke`, {}, cookie);
    const fleet = await getJson(app, `/api/workspaces/${workspace.id}/runners`, cookie);
    expect(WorkspaceRunnersFleet.parse(await fleet.json()).hosts).toEqual([]);
  });
});

describe("#195 review regressions", () => {
  it("returns 401 runner_revoked on the next heartbeat after a member's runners are revoked", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const runner = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });

    const before = await postJson(
      app,
      `/api/runners/${runner.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      credential.credential,
    );
    expect(before.status).toBe(200);

    await database.db.transaction((tx) =>
      revokeWorkspaceRunnersForMember(tx, workspace.id, human.id),
    );
    const after = await postJson(
      app,
      `/api/runners/${runner.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      credential.credential,
    );
    expect(after.status).toBe(401);
    await expectProblem(after, 401, "runner_revoked");
  });

  it("enforces device-code expiry in database time at preview, approval and exchange", async () => {
    const { cookie } = await insertHuman();
    const device = await beginDeviceCode();
    await database.db
      .update(runnerDeviceCodes)
      .set({ expiresAt: sql`statement_timestamp() - interval '1 second'` })
      .where(eq(runnerDeviceCodes.userCode, device.userCode));

    const preview = await getJson(app, `/api/runners/device-codes/${device.userCode}`);
    expect(preview.status).toBe(404);
    await expectProblem(preview, 404, "device_code_invalid");
    const approval = await postJson(
      app,
      `/api/runners/device-codes/${device.userCode}/approve`,
      {},
      cookie,
    );
    await expectProblem(approval, 409, "device_code_expired");
    const exchange = await postJson(app, "/api/runners/device-codes/token", {
      deviceCode: device.deviceCode,
      verifier: device.verifier,
    });
    await expectProblem(exchange, 409, "device_code_expired");
  });

  it("resets an expired failed-attempt window and caps concurrent failures at five", async () => {
    const { cookie, human } = await insertHuman();
    await database.db.insert(runnerDeviceCodeAttempts).values({
      humanId: human.id,
      failedCount: 5,
      windowStartedAt: sql`statement_timestamp() - interval '11 minutes'`,
    });
    const device = await beginDeviceCode();
    const approval = await postJson(
      app,
      `/api/runners/device-codes/${device.userCode}/approve`,
      {},
      cookie,
    );
    expect(approval.status).toBe(200);
    const cleared = await database.db
      .select()
      .from(runnerDeviceCodeAttempts)
      .where(eq(runnerDeviceCodeAttempts.humanId, human.id));
    expect(cleared).toEqual([]);

    const second = await insertHuman();
    const pending: Promise<Response>[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      pending.push(
        Promise.resolve(
          postJson(app, "/api/runners/device-codes/BBBB-BBBB/approve", {}, second.cookie),
        ),
      );
    }
    const results = await Promise.all(pending);
    for (const res of results) expect([404, 429]).toContain(res.status);
    const [row] = await database.db
      .select()
      .from(runnerDeviceCodeAttempts)
      .where(eq(runnerDeviceCodeAttempts.humanId, second.human.id));
    expect(row?.failedCount).toBe(5);
  });

  it("checks workspace visibility before revealing whether a project exists", async () => {
    const owner = await insertHuman();
    const outsider = await insertHuman();
    const { project } = await insertWorkspaceAndProject(owner.human.id);
    const credential = await enrollHost(outsider.cookie);
    const res = await postJson(
      app,
      "/api/runners/register",
      {
        workspaceId: "workspace-that-does-not-exist",
        projectId: project.id,
        repoFingerprint: tokenHash("repo"),
      },
      undefined,
      credential.credential,
    );
    expect(res.status).toBe(404);
    await expectProblem(res, 404, "workspace_not_found");
  });

  it("rejects an Agent owned by another human with 404", async () => {
    const { cookie, human } = await insertHuman();
    const other = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const [foreignAgent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: other.human.id, name: "foreign-agent" })
      .returning();
    const credential = await enrollHost(cookie);
    const res = await postJson(
      app,
      "/api/runners/register",
      {
        workspaceId: workspace.id,
        projectId: project.id,
        repoFingerprint: tokenHash("repo"),
        agentId: foreignAgent!.id,
      },
      undefined,
      credential.credential,
    );
    expect(res.status).toBe(404);
    await expectProblem(res, 404, "agent_not_found");
  });

  it("keeps runners for unreadable projects out of the fleet", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });
    const before = await getJson(app, `/api/workspaces/${workspace.id}/runners`, cookie);
    expect(WorkspaceRunnersFleet.parse(await before.json()).hosts).toHaveLength(1);

    accessOverrides.set(project.id, null);
    const after = await getJson(app, `/api/workspaces/${workspace.id}/runners`, cookie);
    expect(WorkspaceRunnersFleet.parse(await after.json()).hosts).toEqual([]);
  });

  it("allows one host to run the same checkout for two projects", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const [secondProject] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId: workspace.id,
        name: "Second repo",
        key: "SEC",
        createdByHumanId: human.id,
      })
      .returning();
    const credential = await enrollHost(cookie);
    const fingerprint = tokenHash("monorepo-checkout");
    const first = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      repoFingerprint: fingerprint,
    });
    const second = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: secondProject!.id,
      repoFingerprint: fingerprint,
    });
    expect(first.id).not.toBe(second.id);
  });

  it("rejects an out-of-range slot count with 400, not a credential error", async () => {
    const { cookie, human } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const runner = await registerRunner(credential.credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      maxConcurrency: 1,
    });
    const res = await postJson(
      app,
      `/api/runners/${runner.id}/heartbeat`,
      { activeSlotCount: 3 },
      undefined,
      credential.credential,
    );
    expect(res.status).toBe(400);
    await expectProblem(res, 400, "slot_count_invalid");
  });
});

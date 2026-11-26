import { randomBytes, randomUUID } from "node:crypto";
import {
  CatalogProbeResponse,
  DeviceCodeResponse,
  type HarnessCatalog,
  HostCredentialResponse,
  type ProjectAccessLevel,
  Runner,
  RunnerCommand,
} from "@orrery/contract";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  browserSessions,
  humans,
  issues,
  projects,
  runnerCommands,
  runnerDispatches,
  runnerHosts,
  runners,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { projectAccessAtLeast } from "../projects/index.ts";
import { createRunnersFeature } from "./index.ts";

const PUBLIC_URL = "http://orrery.test";
const accessOverrides = new Map<string, ProjectAccessLevel | null>();

const catalogWithUnprobedModel = (): HarnessCatalog => ({
  probedAt: "2026-01-01T00:00:00.000Z",
  harnesses: [
    {
      id: "opencode",
      displayName: "OpenCode",
      defaultModel: "model-1",
      models: [
        {
          id: "model-1",
          reasoningDiscovery: "known",
          supportedEfforts: ["low", "high"],
        },
        { id: "model-2", reasoningDiscovery: "unknown" },
      ],
      probedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
});

const request = (app: Hono, method: string, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

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
  // The shared-workspace owner guard is a deferred constraint: all of these
  // deletes must land in one transaction so it is satisfied at commit time.
  await database.db.transaction(async (tx) => {
    for (const table of [
      "runner_commands",
      "runner_dispatches",
      "issues",
      "runners",
      "runner_device_codes",
      "runner_hosts",
      "workspace_memberships",
      "projects",
      "workspaces",
      "browser_sessions",
      "agents",
    ]) {
      await tx.execute(sql.raw(`delete from ${table}`));
    }
    await tx.execute(sql.raw("delete from humans"));
  });
});

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

async function insertHuman(cookieName = randomUUID()) {
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email: `${cookieName}@example.com`,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`statement_timestamp()`,
    })
    .returning();
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId: human!.id,
    tokenHash: tokenHash(token),
    expiresAt: sql`statement_timestamp() + interval '1 hour'`,
  });
  return { human: human!, cookie: `orrery_session=${token}` };
}

async function sharedFixture() {
  const owner = await insertHuman();
  const workspaceId = randomUUID();
  // A shared workspace must gain its owner in the same transaction as insert.
  await database.db.transaction(async (tx) => {
    await tx
      .insert(workspaces)
      .values({ id: workspaceId, kind: "shared", name: "Probe workspace" });
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: owner.human.id,
      isOwner: true,
    });
  });
  const workspace = { id: workspaceId };
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId: workspace.id,
      name: "Probe repo",
      key: "PRB",
      createdByHumanId: owner.human.id,
    })
    .returning();
  await database.db.insert(agents).values({
    id: randomUUID(),
    humanId: owner.human.id,
    name: `agent-${randomUUID()}`,
  });
  const verifier = randomBytes(32).toString("hex");
  const created = await request(
    app,
    "POST",
    "/api/runners/device-codes",
    {
      hostDisplayName: "probe-laptop",
      platform: "linux-x64",
      verifierHash: tokenHash(verifier),
    },
    owner.cookie,
  );
  expect(created.status).toBe(201);
  const device = DeviceCodeResponse.parse(await created.json());
  const approval = await request(
    app,
    "POST",
    `/api/runners/device-codes/${device.userCode}/approve`,
    {},
    owner.cookie,
  );
  expect(approval.status).toBe(200);
  const exchanged = await request(app, "POST", "/api/runners/device-codes/token", {
    deviceCode: device.deviceCode,
    verifier,
  });
  expect(exchanged.status).toBe(200);
  const credential = HostCredentialResponse.parse(await exchanged.json()).credential;
  // The register route is host-credential authenticated via Bearer, mirrored by
  // a direct header because the cookie helper above is for human sessions.
  const withBearer = await app.request("/api/runners/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({
      workspaceId: workspace.id,
      projectId: project!.id,
      repoFingerprint: tokenHash("/home/private/checkout"),
      capabilities: ["opencode"],
      harnessCatalog: catalogWithUnprobedModel(),
    }),
  });
  expect(withBearer.status).toBe(201);
  return {
    owner,
    workspace,
    project: project!,
    credential,
    runner: Runner.parse(await withBearer.json()),
  };
}

const problemCode = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "code" in value ? value.code : undefined;

const probe = (testApp: Hono, runnerId: string, body: unknown, cookie: string) =>
  request(testApp, "POST", `/api/runners/${runnerId}/catalog/probe`, body, cookie);

const checkViolation = async (insert: Promise<unknown>): Promise<void> => {
  let violation: unknown;
  try {
    await insert;
  } catch (error) {
    violation = error;
  }
  const cause: unknown =
    typeof violation === "object" && violation !== null && "cause" in violation
      ? violation.cause
      : undefined;
  expect(
    typeof cause === "object" && cause !== null && "constraint_name" in cause
      ? cause.constraint_name
      : undefined,
  ).toBe("runner_commands_dispatch_ids");
};

describe("catalog probe outbox (#242)", () => {
  it("enqueues a 30s TTL probe_model with null dispatch ids and enforces the cooldown", async () => {
    const fixture = await sharedFixture();
    const response = await probe(
      app,
      fixture.runner.id,
      {
        kind: "model",
        harness: "opencode",
        model: "model-2",
      },
      fixture.owner.cookie,
    );
    expect(response.status).toBe(200);
    const body = CatalogProbeResponse.parse(await response.json());
    expect(body).toMatchObject({ kind: "probe_model", cooldownSeconds: 30 });

    const [command] = await database.db
      .select()
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, fixture.runner.id));
    expect(command).toMatchObject({
      id: body.commandId,
      kind: "probe_model",
      dispatchId: null,
      dispatchAttemptId: null,
      payload: { harness: "opencode", model: "model-2" },
    });
    const ttlMs = command!.expiresAt.getTime() - command!.createdAt.getTime();
    expect(ttlMs).toBeGreaterThan(29_000);
    expect(ttlMs).toBeLessThan(31_000);
    expect(
      RunnerCommand.parse({
        commandId: command!.id,
        runnerId: command!.runnerId,
        seq: command!.seq,
        dispatchId: null,
        dispatchAttemptId: null,
        kind: command!.kind,
        payload: command!.payload,
        createdAt: command!.createdAt.toISOString(),
        expiresAt: command!.expiresAt.toISOString(),
      }),
    ).toMatchObject({ kind: "probe_model", dispatchId: null });

    const again = await probe(
      app,
      fixture.runner.id,
      {
        kind: "model",
        harness: "opencode",
        model: "model-2",
      },
      fixture.owner.cookie,
    );
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBe("30");

    // A different model has its own cooldown bucket; catalog refresh has its own.
    const other = await probe(
      app,
      fixture.runner.id,
      {
        kind: "model",
        harness: "opencode",
        model: "model-1",
      },
      fixture.owner.cookie,
    );
    expect(other.status).toBe(200);
    const refresh = await probe(app, fixture.runner.id, { kind: "catalog" }, fixture.owner.cookie);
    expect(refresh.status).toBe(200);
    expect(CatalogProbeResponse.parse(await refresh.json()).kind).toBe("probe_catalog");
    const rows = await database.db
      .select()
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, fixture.runner.id));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.kind === "probe_catalog")).toHaveLength(1);
    // A catalog refresh has its own single cooldown bucket per runner.
    const refreshAgain = await probe(
      app,
      fixture.runner.id,
      { kind: "catalog" },
      fixture.owner.cookie,
    );
    expect(refreshAgain.status).toBe(429);
    expect(refreshAgain.headers.get("Retry-After")).toBe("30");
  });

  it("is race-safe: concurrent probes for one model enqueue exactly one command", async () => {
    const fixture = await sharedFixture();
    const body = { kind: "model", harness: "opencode", model: "model-2" };
    const results = await Promise.all([
      probe(app, fixture.runner.id, body, fixture.owner.cookie),
      probe(app, fixture.runner.id, body, fixture.owner.cookie),
      probe(app, fixture.runner.id, body, fixture.owner.cookie),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 429)).toHaveLength(2);
    const rows = await database.db
      .select()
      .from(runnerCommands)
      .where(and(eq(runnerCommands.runnerId, fixture.runner.id)));
    expect(rows).toHaveLength(1);
  });

  it("returns 403 for a teammate and 404 for a non-member", async () => {
    const fixture = await sharedFixture();
    const teammate = await insertHuman(`teammate-${randomUUID()}`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: fixture.workspace.id,
      humanId: teammate.human.id,
      isOwner: false,
    });
    const body = { kind: "catalog" };
    const denied = await probe(app, fixture.runner.id, body, teammate.cookie);
    expect(denied.status).toBe(403);
    expect(problemCode(await denied.json())).toBe("runner_forbidden");

    const outsider = await insertHuman(`outsider-${randomUUID()}`);
    const hidden = await probe(app, fixture.runner.id, body, outsider.cookie);
    expect(hidden.status).toBe(404);
  });

  it("requires an authenticated human", async () => {
    const fixture = await sharedFixture();
    const anonymous = await request(
      app,
      "POST",
      `/api/runners/${fixture.runner.id}/catalog/probe`,
      { kind: "catalog" },
    );
    expect(anonymous.status).toBe(401);
    expect(problemCode(await anonymous.json())).toBe("not_signed_in");
  });

  it("rechecks live project and workspace access on every probe", async () => {
    const fixture = await sharedFixture();
    const allowed = await probe(app, fixture.runner.id, { kind: "catalog" }, fixture.owner.cookie);
    expect(allowed.status).toBe(200);

    // The owner had access a moment ago; losing Read must now hide the runner.
    accessOverrides.set(fixture.project.id, null);
    const noProject = await probe(
      app,
      fixture.runner.id,
      { kind: "catalog" },
      fixture.owner.cookie,
    );
    expect(noProject.status).toBe(404);
    expect(problemCode(await noProject.json())).toBe("project_not_found");
    accessOverrides.clear();

    // Suspending the workspace membership is likewise checked live. Add a
    // second owner first: a shared workspace must always keep one active owner.
    const coOwner = await insertHuman(`co-owner-${randomUUID()}`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: fixture.workspace.id,
      humanId: coOwner.human.id,
      isOwner: true,
    });
    await database.db
      .update(workspaceMemberships)
      .set({ suspendedAt: sql`statement_timestamp()` })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, fixture.workspace.id),
          eq(workspaceMemberships.humanId, fixture.owner.human.id),
        ),
      );
    const noWorkspace = await probe(
      app,
      fixture.runner.id,
      { kind: "catalog" },
      fixture.owner.cookie,
    );
    expect(noWorkspace.status).toBe(404);
    expect(problemCode(await noWorkspace.json())).toBe("workspace_not_found");
  });

  it("refuses probes for offline, revoked and host-revoked Runners", async () => {
    const fixture = await sharedFixture();
    const unavailable = async () => {
      const response = await probe(
        app,
        fixture.runner.id,
        { kind: "catalog" },
        fixture.owner.cookie,
      );
      expect(response.status).toBe(409);
      expect(problemCode(await response.json())).toBe("runner_unavailable");
    };
    // Presence is derived in Postgres from lastSeenAt (no boolean column).
    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp() - interval '1 hour'` })
      .where(eq(runners.id, fixture.runner.id));
    await unavailable();

    await database.db
      .update(runners)
      .set({ lastSeenAt: sql`statement_timestamp()`, revokedAt: sql`statement_timestamp()` })
      .where(eq(runners.id, fixture.runner.id));
    await unavailable();

    await database.db
      .update(runners)
      .set({ revokedAt: null })
      .where(eq(runners.id, fixture.runner.id));
    await database.db
      .update(runnerHosts)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(runnerHosts.id, fixture.runner.hostId));
    await unavailable();
  });

  it("enforces the dispatch-id CHECK for every command kind", async () => {
    const fixture = await sharedFixture();
    const [agent] = await database.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.humanId, fixture.owner.human.id))
      .limit(1);
    const issueId = randomUUID();
    await database.db.insert(issues).values({
      id: issueId,
      projectId: fixture.project.id,
      number: 1,
      title: "CHECK proof issue",
      status: "todo",
      sortOrder: 1,
      createdByHumanId: fixture.owner.human.id,
      updatedByHumanId: fixture.owner.human.id,
    });
    const dispatchId = randomUUID();
    await database.db.insert(runnerDispatches).values({
      id: dispatchId,
      runnerId: fixture.runner.id,
      workspaceId: fixture.workspace.id,
      projectId: fixture.project.id,
      issueId,
      requestedByHumanId: fixture.owner.human.id,
      agentId: agent!.id,
      dispatchAttemptId: `attempt-${randomUUID()}`,
    });

    let seq = 1;
    type CommandValues = {
      kind: "probe_model" | "probe_catalog" | "dispatch" | "cancel" | "input_resolved";
      dispatchId?: string | null;
      dispatchAttemptId?: string | null;
    };
    const insert = (values: CommandValues) =>
      database.db.insert(runnerCommands).values({
        id: randomUUID(),
        runnerId: fixture.runner.id,
        seq: seq++,
        payload: { harness: "opencode", model: "model-2" },
        createdAt: sql`statement_timestamp()`,
        expiresAt: sql`statement_timestamp() + interval '30 seconds'`,
        ...values,
      });

    // Both runner-level probe kinds are valid with null dispatch ids.
    await expect(insert({ kind: "probe_model" })).resolves.toBeDefined();
    await expect(insert({ kind: "probe_catalog" })).resolves.toBeDefined();
    // Every dispatch-bound kind requires both ids, and a probe may not carry them.
    for (const kind of ["dispatch", "cancel", "input_resolved"] as const) {
      await checkViolation(insert({ kind }));
    }
    await checkViolation(
      insert({ kind: "probe_model", dispatchId, dispatchAttemptId: "attempt-1" }),
    );
  });

  it("does not accept a harness absent from a published catalog", async () => {
    const fixture = await sharedFixture();
    const response = await probe(
      app,
      fixture.runner.id,
      {
        kind: "model",
        harness: "not-installed",
        model: "model-2",
      },
      fixture.owner.cookie,
    );
    expect(response.status).toBe(409);
    expect(problemCode(await response.json())).toBe("harness_unavailable");
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FleetRunner } from "@orrery/contract";
import {
  DeviceCodeResponse,
  HostCredentialResponse,
  Problem,
  type HarnessCatalog,
  type ProjectAccessLevel,
  Runner,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
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
import { createRunnersFeature } from "./index.ts";

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

const putJson = (app: Hono, path: string, body: unknown, bearer?: string) =>
  app.request(path, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

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

async function enrollHostWithCookie(displayName = "rubis-laptop") {
  const { cookie, human } = await insertHuman();
  const verifier = randomBytes(32).toString("hex");
  const created = await postJson(app, "/api/runners/device-codes", {
    hostDisplayName: displayName,
    platform: "linux-x64",
    verifierHash: tokenHash(verifier),
  });
  expect(created.status).toBe(201);
  const device = DeviceCodeResponse.parse(await created.json());
  const approved = await postJson(
    app,
    `/api/runners/device-codes/${device.userCode}/approve`,
    {},
    cookie,
  );
  expect(approved.status).toBe(200);
  const exchanged = await postJson(app, "/api/runners/device-codes/token", {
    deviceCode: device.deviceCode,
    verifier,
  });
  expect(exchanged.status).toBe(200);
  const credential = HostCredentialResponse.parse(await exchanged.json());
  return {
    credential: credential.credential,
    hostId: credential.hostId,
    humanId: human.id,
    cookie,
  };
}

async function registerRunner(
  credential: string,
  opts: {
    workspaceId: string;
    projectId: string;
    repoFingerprint?: string;
    harnessCatalog?: HarnessCatalog;
  },
) {
  const res = await postJson(
    app,
    "/api/runners/register",
    {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      repoFingerprint: opts.repoFingerprint ?? tokenHash("/home/rubi/secret/project"),
      ...(opts.harnessCatalog === undefined ? {} : { harnessCatalog: opts.harnessCatalog }),
    },
    undefined,
    credential,
  );
  expect(res.status).toBe(201);
  return Runner.parse(await res.json());
}

const catalogWith = (modelId: string, known: boolean): HarnessCatalog => ({
  harnesses: [
    {
      id: "opencode",
      displayName: "OpenCode",
      source: "preset",
      defaultModel: modelId,
      models: [
        {
          id: modelId,
          reasoningDiscovery: known ? "known" : "unknown",
          effortLevels: known ? ["low", "medium", "high"] : [],
          defaultEffort: known ? "medium" : null,
          probedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      probedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("runner harness catalog (issue #240)", () => {
  it("stores a registration's optional initial catalog and returns it on the Runner", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      harnessCatalog: catalogWith("model-a", true),
    });
    expect(runner.harnessCatalog).toEqual(catalogWith("model-a", true));
    // Persisted as JSONB, separate from capabilities.
    const [row] = await database.db.select().from(runners).where(eq(runners.id, runner.id));
    expect(row?.harnessCatalog).toEqual(catalogWith("model-a", true));
  });

  it("merges a catalog PUT without regressing a known model's efforts", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      harnessCatalog: catalogWith("model-a", true),
    });
    // A slower startup probe later reports the model "unknown" again.
    const res = await putJson(
      app,
      `/api/runners/${runner.id}/catalog`,
      catalogWith("model-a", false),
      credential,
    );
    expect(res.status).toBe(200);
    const updated = Runner.parse(await res.json());
    const model = updated.harnessCatalog?.harnesses[0]?.models.find(
      (entry) => entry.id === "model-a",
    );
    expect(model?.reasoningDiscovery).toBe("known");
    expect(model?.effortLevels).toEqual(["low", "medium", "high"]);
    // The newer harness-level fields still come through the merge.
    expect(updated.harnessCatalog?.harnesses[0]?.probedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("adds models the stored catalog never saw", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      harnessCatalog: catalogWith("model-a", true),
    });
    const res = await putJson(
      app,
      `/api/runners/${runner.id}/catalog`,
      catalogWith("model-b", true),
      credential,
    );
    const updated = Runner.parse(await res.json());
    const modelIds = updated.harnessCatalog?.harnesses[0]?.models.map((entry) => entry.id);
    expect(modelIds).toEqual(["model-a", "model-b"]);
  });

  it("keeps the catalog untouched across heartbeats", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      harnessCatalog: catalogWith("model-a", true),
    });
    const res = await postJson(
      app,
      `/api/runners/${runner.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      credential,
    );
    expect(res.status).toBe(200);
    const heartbeated = Runner.parse(await res.json());
    expect(heartbeated.harnessCatalog).toEqual(catalogWith("model-a", true));
  });

  it("shows the catalog on the workspace Runners Fleet", async () => {
    const { credential, humanId, cookie } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
      harnessCatalog: catalogWith("model-a", true),
    });
    const fleetRes = await app.request(`/api/workspaces/${workspace.id}/runners`, {
      headers: { cookie },
    });
    expect(fleetRes.status).toBe(200);
    const fleet = WorkspaceRunnersFleet.parse(await fleetRes.json());
    const fleetRunner: FleetRunner | undefined = fleet.hosts
      .flatMap((host) => host.runners)
      .find((entry) => entry.id === runner.id);
    expect(fleetRunner?.harnessCatalog).toEqual(catalogWith("model-a", true));
  });

  it("rejects a catalog PUT without or with the wrong host credential", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });
    const anonymous = await putJson(
      app,
      `/api/runners/${runner.id}/catalog`,
      catalogWith("m", true),
    );
    expect(anonymous.status).toBe(401);
    await expectProblem(anonymous, 401, "invalid_credential");
    const other = await enrollHostWithCookie("other-laptop");
    await expectProblem(
      await putJson(
        app,
        `/api/runners/${runner.id}/catalog`,
        catalogWith("m", true),
        other.credential,
      ),
      404,
      "runner_not_found",
    );
  });

  it("rejects a catalog PUT for a revoked runner", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });
    await database.db
      .update(runners)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(runners.id, runner.id));
    const res = await putJson(
      app,
      `/api/runners/${runner.id}/catalog`,
      catalogWith("m", true),
      credential,
    );
    expect(res.status).toBe(401);
    await expectProblem(res, 401, "runner_revoked");
  });

  it("validates the catalog body as a Problem", async () => {
    const { credential, humanId } = await enrollHostWithCookie();
    const { workspace, project } = await insertWorkspaceAndProject(humanId);
    const runner = await registerRunner(credential, {
      workspaceId: workspace.id,
      projectId: project.id,
    });
    const res = await putJson(
      app,
      `/api/runners/${runner.id}/catalog`,
      { harnesses: [{ id: "x" }], updatedAt: "not-a-date" },
      credential,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });
});

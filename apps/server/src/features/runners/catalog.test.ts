import { randomBytes, randomUUID } from "node:crypto";
import {
  DeviceCodeResponse,
  EMPTY_HARNESS_CATALOG,
  type HarnessCatalog,
  type HarnessCatalogEntry,
  HostCredentialResponse,
  type HarnessModel,
  mergeHarnessCatalog,
  type ProjectAccessLevel,
  Runner,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  browserSessions,
  humans,
  projects,
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
const accessOverrides = new Map<string, ProjectAccessLevel | null>();

const knownModel = (id: string): HarnessModel => ({
  id,
  label: `Model ${id}`,
  reasoningDiscovery: "known",
  supportedEfforts: ["low", "high"],
  defaultEffort: "low",
  probedAt: "2026-01-01T00:00:00.000Z",
});

const entry = (
  harnessId: string,
  models: HarnessModel[],
  probedAt = "2026-01-01T00:00:00.000Z",
): HarnessCatalogEntry => ({
  id: harnessId,
  displayName: `Harness ${harnessId}`,
  source: "preset" as const,
  defaultModel: models[0]?.id ?? "default",
  models,
  probedAt,
});

const catalog = (probedAt: string, ...harnesses: HarnessCatalogEntry[]): HarnessCatalog => ({
  harnesses,
  probedAt,
});

const request = (
  app: Hono,
  method: string,
  path: string,
  body: unknown,
  bearer?: string,
  cookie?: string,
) =>
  app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
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
  await database.db.delete(runners);
  await database.db.delete(runnerDeviceCodes);
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

async function enrollHost(cookie: string) {
  const verifier = randomBytes(32).toString("hex");
  const created = await request(
    app,
    "POST",
    "/api/runners/device-codes",
    {
      hostDisplayName: "rubis-laptop",
      platform: "linux-x64",
      verifierHash: tokenHash(verifier),
    },
    undefined,
    cookie,
  );
  expect(created.status).toBe(201);
  const device = DeviceCodeResponse.parse(await created.json());
  const approval = await request(
    app,
    "POST",
    `/api/runners/device-codes/${device.userCode}/approve`,
    {},
    undefined,
    cookie,
  );
  expect(approval.status).toBe(200);
  const exchanged = await request(app, "POST", "/api/runners/device-codes/token", {
    deviceCode: device.deviceCode,
    verifier,
  });
  expect(exchanged.status).toBe(200);
  return HostCredentialResponse.parse(await exchanged.json()).credential;
}

async function register(
  credential: string,
  workspaceId: string,
  projectId: string,
  initial?: HarnessCatalog,
) {
  const res = await request(
    app,
    "POST",
    "/api/runners/register",
    {
      workspaceId,
      projectId,
      repoFingerprint: tokenHash("/home/rubi/secret/project"),
      capabilities: ["opencode"],
      ...(initial === undefined ? {} : { harnessCatalog: initial }),
    },
    credential,
  );
  expect(res.status).toBe(201);
  return Runner.parse(await res.json());
}

describe("harness catalog merge", () => {
  it("never regresses a known model's effort levels on a stale refresh", () => {
    const stored = catalog(
      "2026-01-05T00:00:00.000Z",
      entry("opencode", [knownModel("gpt-5")], "2026-01-05T00:00:00.000Z"),
    );
    const incoming = catalog(
      "2026-01-01T00:00:00.000Z",
      entry(
        "opencode",
        [{ id: "gpt-5", reasoningDiscovery: "unknown", probedAt: "2026-01-01T00:00:00.000Z" }],
        "2026-01-01T00:00:00.000Z",
      ),
    );
    const merged = mergeHarnessCatalog(stored, incoming);
    expect(merged.harnesses[0]!.models[0]).toMatchObject({
      reasoningDiscovery: "known",
      supportedEfforts: ["low", "high"],
      defaultEffort: "low",
    });
    expect(merged.probedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(merged.harnesses[0]!.probedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("keeps genuinely new unknown models unknown", () => {
    const stored = catalog("2026-01-01T00:00:00.000Z", entry("codex", [knownModel("gpt-5")]));
    const merged = mergeHarnessCatalog(
      stored,
      catalog(
        "2026-01-02T00:00:00.000Z",
        entry("codex", [
          knownModel("gpt-5"),
          { id: "gpt-5-mini", reasoningDiscovery: "unknown", probedAt: "2026-01-01T00:00:00.000Z" },
        ]),
      ),
    );
    expect(merged.harnesses[0]!.models[1]).toEqual({
      id: "gpt-5-mini",
      reasoningDiscovery: "unknown",
      probedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("runner harness catalog API", () => {
  it("persists the initial catalog on register and preserves it on heartbeat", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const initial = catalog("2026-02-01T00:00:00.000Z", entry("opencode", [knownModel("gpt-5")]));
    const created = await register(credential, workspace.id, project.id, initial);
    expect(created.harnessCatalog).toEqual(initial);
    expect(created.capabilities).toEqual(["opencode"]);

    const beat = await request(
      app,
      "POST",
      `/api/runners/${created.id}/heartbeat`,
      { activeSlotCount: 0 },
      credential,
    );
    expect(beat.status).toBe(200);
    expect(Runner.parse(await beat.json()).harnessCatalog).toEqual(initial);

    const [stored] = await database.db.select().from(runners).where(eq(runners.id, created.id));
    expect(stored!.harnessCatalog).toEqual(initial);
    expect(stored!.capabilities).toEqual(["opencode"]);
  });

  it("keeps stored known efforts when a re-register omits or empties the catalog", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const live = catalog(
      "2026-02-01T00:00:00.000Z",
      entry("opencode", [knownModel("gpt-5")], "2026-02-01T00:00:00.000Z"),
    );
    const created = await register(credential, workspace.id, project.id, live);

    const omitted = await register(credential, workspace.id, project.id);
    expect(omitted.id).toBe(created.id);
    expect(omitted.harnessCatalog).toEqual(live);

    const emptied = await register(credential, workspace.id, project.id, EMPTY_HARNESS_CATALOG);
    expect(emptied.id).toBe(created.id);
    expect(emptied.harnessCatalog).toEqual(live);

    const [stored] = await database.db.select().from(runners).where(eq(runners.id, created.id));
    expect(stored!.harnessCatalog).toEqual(live);
  });

  it("updates the catalog under a live host credential and project access", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await register(credential, workspace.id, project.id);

    const updated = catalog(
      "2026-03-01T00:00:00.000Z",
      entry("codex", [knownModel("gpt-5-codex")]),
    );
    const res = await request(
      app,
      "PUT",
      `/api/runners/${created.id}/catalog`,
      updated,
      credential,
    );
    expect(res.status).toBe(200);
    expect(Runner.parse(await res.json()).harnessCatalog).toEqual(updated);

    const [stored] = await database.db.select().from(runners).where(eq(runners.id, created.id));
    expect(stored!.harnessCatalog).toEqual(updated);

    expect((await request(app, "PUT", `/api/runners/${created.id}/catalog`, updated)).status).toBe(
      401,
    );
    accessOverrides.set(project.id, null);
    expect(
      (await request(app, "PUT", `/api/runners/${created.id}/catalog`, updated, credential)).status,
    ).toBe(401);
  });

  it("merges known effort entries when a slower refresh publishes unknown ones", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await register(credential, workspace.id, project.id);

    const first = catalog("2026-02-01T00:00:00.000Z", entry("opencode", [knownModel("gpt-5")]));
    expect(
      (await request(app, "PUT", `/api/runners/${created.id}/catalog`, first, credential)).status,
    ).toBe(200);

    const stale = catalog(
      "2026-01-01T00:00:00.000Z",
      entry(
        "opencode",
        [{ id: "gpt-5", reasoningDiscovery: "unknown", probedAt: "2026-01-01T00:00:00.000Z" }],
        "2026-01-01T00:00:00.000Z",
      ),
    );
    const second = await request(
      app,
      "PUT",
      `/api/runners/${created.id}/catalog`,
      stale,
      credential,
    );
    expect(second.status).toBe(200);
    const merged = Runner.parse(await second.json()).harnessCatalog;
    expect(merged.harnesses[0]!.models[0]).toMatchObject({
      reasoningDiscovery: "known",
      supportedEfforts: ["low", "high"],
      defaultEffort: "low",
    });
    expect(merged.probedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("exposes each fleet runner's live catalog", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const live = catalog("2026-04-01T00:00:00.000Z", entry("hermes", [knownModel("sonnet")]));
    const created = await register(credential, workspace.id, project.id);
    await request(app, "PUT", `/api/runners/${created.id}/catalog`, live, credential);

    const fleet = await app.request(`/api/workspaces/${workspace.id}/runners`, {
      headers: { cookie },
    });
    expect(fleet.status).toBe(200);
    const parsed = WorkspaceRunnersFleet.parse(await fleet.json());
    expect(parsed.hosts[0]!.runners[0]!.harnessCatalog).toEqual(live);
  });

  it("drops harnesses no longer advertised by a live catalog update", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await register(credential, workspace.id, project.id);
    const both = catalog(
      "2026-05-01T00:00:00.000Z",
      entry("opencode", [knownModel("gpt-5")]),
      entry("codex", [knownModel("gpt-5-codex")]),
    );
    expect(
      (await request(app, "PUT", `/api/runners/${created.id}/catalog`, both, credential)).status,
    ).toBe(200);

    // A probe that no longer sees codex (it was uninstalled) publishes only
    // opencode; the stored catalog must stop advertising codex.
    const onlyOne = catalog("2026-05-02T00:00:00.000Z", entry("opencode", [knownModel("gpt-5")]));
    const res = await request(
      app,
      "PUT",
      `/api/runners/${created.id}/catalog`,
      onlyOne,
      credential,
    );
    expect(res.status).toBe(200);
    expect(Runner.parse(await res.json()).harnessCatalog?.harnesses.map((item) => item.id)).toEqual(
      ["opencode"],
    );
  });

  it("rejects an invalid catalog body as a Problem", async () => {
    const { human, cookie } = await insertHuman();
    const { workspace, project } = await insertWorkspaceAndProject(human.id);
    const credential = await enrollHost(cookie);
    const created = await register(credential, workspace.id, project.id);
    const res = await request(
      app,
      "PUT",
      `/api/runners/${created.id}/catalog`,
      {
        harnesses: [{ id: "x" }],
        probedAt: "not-a-date",
      },
      credential,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

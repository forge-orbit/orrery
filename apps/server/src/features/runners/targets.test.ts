import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  DeviceCodeResponse,
  HostCredentialResponse,
  Problem,
  Runner,
  RunnerTargetsResponse,
  type ProjectAccessLevel,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  browserSessions,
  humans,
  projects,
  runnerDeviceCodeAttempts,
  runnerDeviceCodes,
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
/** Overrides used to simulate a human holding Read, Contribute or Manage access. */
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

const getTargets = (app: Hono, opts: { cookie?: string; bearer?: string } = {}) =>
  app.request("/api/runners/targets", {
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
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
  // One transaction: the deferred shared-workspace owner guard fires at commit,
  // when both memberships and workspaces are already gone.
  await database.db.transaction(async (tx) => {
    await tx.delete(runners);
    await tx.delete(runnerDeviceCodes);
    await tx.delete(runnerDeviceCodeAttempts);
    await tx.delete(runnerHosts);
    await tx.delete(browserSessions);
    await tx.delete(agentApiKeys);
    await tx.delete(agents);
    await tx.delete(projects);
    await tx.delete(workspaceMemberships);
    await tx.delete(workspaces);
    await tx.delete(humans);
  });
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

async function insertPersonalWorkspace(humanId: string, name = "Personal") {
  const [workspace] = await database.db
    .insert(workspaces)
    .values({ id: randomUUID(), kind: "personal", name, personalOwnerHumanId: humanId })
    .returning();
  return workspace!;
}

async function insertProject(workspaceId: string, humanId: string, name: string, key: string) {
  const [project] = await database.db
    .insert(projects)
    .values({ id: randomUUID(), workspaceId, name, key, createdByHumanId: humanId })
    .returning();
  return project!;
}

async function insertAgent(humanId: string, name: string, createdAt?: Date) {
  const [agent] = await database.db
    .insert(agents)
    .values({
      id: randomUUID(),
      humanId,
      name,
      ...(createdAt === undefined ? {} : { createdAt }),
    })
    .returning();
  return agent!;
}

async function insertSharedWorkspace(
  humanId: string,
  name: string,
  opts: { suspended?: boolean } = {},
) {
  const workspaceId = randomUUID();
  // A suspended-only owner is not a valid workspace shape (the owner guard
  // requires an active owner or a deactivated former owner), so a suspended
  // test membership keeps an active co-owner alongside it.
  const ownerHumanId = opts.suspended ? (await insertHuman()).human.id : humanId;
  await database.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({ id: workspaceId, kind: "shared", name });
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: ownerHumanId,
      isOwner: true,
    });
    if (opts.suspended) {
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId,
        humanId,
        suspendedAt: sql`statement_timestamp()`,
      });
    }
  });
  const [workspace] = await database.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return workspace!;
}

async function beginDeviceCode() {
  const verifier = randomBytes(32).toString("hex");
  const res = await postJson(app, "/api/runners/device-codes", {
    hostDisplayName: "rubis-laptop",
    platform: "linux-x64",
    verifierHash: tokenHash(verifier),
  });
  expect(res.status).toBe(201);
  const body = DeviceCodeResponse.parse(await res.json());
  return { verifier, ...body };
}

async function enrollHost(cookie: string) {
  const device = await beginDeviceCode();
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
  return HostCredentialResponse.parse(await exchange.json());
}

describe("GET /api/runners/targets authentication", () => {
  it("rejects every non-host credential with 401 and never caches success", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    await insertProject(workspace.id, human.id, "Repo", "REP");
    await insertAgent(human.id, "bot");
    const credential = await enrollHost(cookie);

    await expectProblem(await getTargets(app), 401, "invalid_credential");
    // Denials are never cached either.
    expect((await getTargets(app)).headers.get("cache-control")).toBe("no-store");
    await expectProblem(await getTargets(app, { cookie }), 401, "invalid_credential");
    await expectProblem(
      await getTargets(app, { bearer: `orr_ak_${randomBytes(32).toString("base64url")}` }),
      401,
      "invalid_credential",
    );
    await expectProblem(
      await getTargets(app, { bearer: `orr_dt_${randomBytes(32).toString("base64url")}` }),
      401,
      "invalid_credential",
    );
    await expectProblem(
      await getTargets(app, { bearer: "not-a-credential" }),
      401,
      "invalid_credential",
    );

    // Even a genuinely issued Agent API key is not a host credential.
    const agent = await insertAgent(human.id, "key-bot");
    const agentSecret = `orr_ak_${randomBytes(32).toString("base64url")}`;
    await database.db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId: agent.id,
      workspaceId: workspace.id,
      createdByHumanId: human.id,
      validity: "never",
      tokenHash: tokenHash(agentSecret),
    });
    await expectProblem(await getTargets(app, { bearer: agentSecret }), 401, "invalid_credential");

    const ok = await getTargets(app, { bearer: credential.credential });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(RunnerTargetsResponse.safeParse(await ok.json()).success).toBe(true);
  });

  it("rejects a revoked host and a deactivated human with 401", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    await insertProject(workspace.id, human.id, "Repo", "REP");
    await insertAgent(human.id, "bot");
    const credential = await enrollHost(cookie);

    expect((await getTargets(app, { bearer: credential.credential })).status).toBe(200);

    await database.db
      .update(runnerHosts)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(runnerHosts.id, credential.hostId));
    await expectProblem(
      await getTargets(app, { bearer: credential.credential }),
      401,
      "invalid_credential",
    );

    const other = await insertHuman();
    const otherWorkspace = await insertPersonalWorkspace(other.human.id);
    await insertProject(otherWorkspace.id, other.human.id, "Other", "OTH");
    await insertAgent(other.human.id, "other-bot");
    const otherCredential = await enrollHost(other.cookie);
    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`statement_timestamp()` })
      .where(eq(humans.id, other.human.id));
    await expectProblem(
      await getTargets(app, { bearer: otherCredential.credential }),
      401,
      "invalid_credential",
    );
  });
});

describe("GET /api/runners/targets discovery", () => {
  it("returns the personal workspace, top-level agents and the default agent", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    const project = await insertProject(workspace.id, human.id, "Repo", "REP");
    const first = await insertAgent(human.id, "alpha-bot");
    const second = await insertAgent(human.id, "beta-bot");
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    const body = RunnerTargetsResponse.parse(await res.json());
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toEqual({
      id: workspace.id,
      name: "Personal",
      slug: "personal",
      kind: "personal",
      projects: [{ id: project.id, key: "REP", name: "Repo", accessLevel: "contribute" }],
    });
    expect(body.agents).toEqual([
      { id: first.id, name: "alpha-bot" },
      { id: second.id, name: "beta-bot" },
    ]);
    expect(body.defaultAgentId).toBe(first.id);
    expect(Object.keys(body.workspaces[0] ?? {})).not.toContain("agents");
  });

  it("includes active shared memberships, excludes suspended ones, and keeps empty workspaces", async () => {
    const { cookie, human } = await insertHuman();
    const personal = await insertPersonalWorkspace(human.id);
    const active = await insertSharedWorkspace(human.id, "Team Alpha");
    const activeProject = await insertProject(active.id, human.id, "Shared repo", "SHR");
    const suspended = await insertSharedWorkspace(human.id, "Team Suspended", { suspended: true });
    await insertProject(suspended.id, human.id, "Hidden repo", "HID");
    const readOnly = await insertSharedWorkspace(human.id, "Team Readonly");
    const readOnlyProject = await insertProject(readOnly.id, human.id, "Read repo", "RO");
    accessOverrides.set(readOnlyProject.id, "read");
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    const body = RunnerTargetsResponse.parse(await res.json());
    const byId = new Map(body.workspaces.map((entry) => [entry.id, entry]));
    // The personal workspace has no Contribute+ projects yet but is retained.
    expect(byId.get(personal.id)?.projects).toEqual([]);
    expect(byId.get(active.id)).toMatchObject({
      name: "Team Alpha",
      slug: "team-alpha",
      kind: "shared",
      projects: [
        { id: activeProject.id, key: "SHR", name: "Shared repo", accessLevel: "contribute" },
      ],
    });
    // Suspended memberships (and their projects) are invisible.
    expect(byId.has(suspended.id)).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Hidden repo");
    // A workspace with only Read access is kept with an empty project list.
    expect(byId.get(readOnly.id)?.projects).toEqual([]);
  });

  it("derives slugs identically to issue-resolve and keeps non-ASCII names selectable", async () => {
    const { cookie, human } = await insertHuman();
    const ascii = await insertSharedWorkspace(human.id, "Team Alpha");
    const nonAscii = await insertSharedWorkspace(human.id, "日本語ワークスペース");
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    const body = RunnerTargetsResponse.parse(await res.json());
    const byId = new Map(body.workspaces.map((entry) => [entry.id, entry]));
    expect(byId.get(ascii.id)?.slug).toBe("team-alpha");
    expect(byId.get(nonAscii.id)).toMatchObject({
      name: "日本語ワークスペース",
      slug: "",
      projects: [],
    });
  });

  it("excludes trashed projects and enforces the Contribute ceiling", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    const trashed = await insertProject(workspace.id, human.id, "Trashed", "DEL");
    const readable = await insertProject(workspace.id, human.id, "Readable", "RO");
    const writable = await insertProject(workspace.id, human.id, "Writable", "WR");
    const manageable = await insertProject(workspace.id, human.id, "Manageable", "MGR");
    await database.db
      .update(projects)
      .set({ deletedAt: sql`statement_timestamp()`, deletedByHumanId: human.id })
      .where(eq(projects.id, trashed.id));
    accessOverrides.set(readable.id, "read");
    accessOverrides.set(manageable.id, "manage");
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    const body = RunnerTargetsResponse.parse(await res.json());
    expect(body.workspaces).toHaveLength(1);
    const listed = [...body.workspaces[0]!.projects].toSorted((a, b) => (a.key < b.key ? -1 : 1));
    expect(listed).toEqual([
      { id: manageable.id, key: "MGR", name: "Manageable", accessLevel: "manage" },
      { id: writable.id, key: "WR", name: "Writable", accessLevel: "contribute" },
    ]);
    expect(JSON.stringify(body)).not.toContain("Trashed");
    expect(JSON.stringify(body)).not.toContain("Readable");
  });

  it("never leaks foreign agents, emails or other members", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    await insertProject(workspace.id, human.id, "Repo", "REP");
    const mine = await insertAgent(human.id, "my-bot");
    const stranger = await insertHuman();
    await insertSharedWorkspace(stranger.human.id, "Stranger team");
    await insertAgent(stranger.human.id, "stranger-bot");
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    const body = RunnerTargetsResponse.parse(await res.json());
    expect(body.agents).toEqual([{ id: mine.id, name: "my-bot" }]);
    expect(body.defaultAgentId).toBe(mine.id);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("stranger-bot");
    expect(raw).not.toContain(stranger.human.email);
  });

  it("shares deterministic default-agent ordering with registerRunner on equal timestamps", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    const project = await insertProject(workspace.id, human.id, "Repo", "REP");
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    const alpha = await insertAgent(human.id, "zeta-bot", stamp);
    const beta = await insertAgent(human.id, "alpha-bot", stamp);
    const expected = [alpha.id, beta.id].toSorted()[0]!;
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    expect(RunnerTargetsResponse.parse(await res.json()).defaultAgentId).toBe(expected);

    const registered = await postJson(
      app,
      "/api/runners/register",
      {
        workspaceId: workspace.id,
        projectId: project.id,
        repoFingerprint: tokenHash("tied-checkout"),
      },
      undefined,
      credential.credential,
    );
    expect(registered.status).toBe(201);
    expect(Runner.parse(await registered.json()).agentId).toBe(expected);
  });

  it("returns a 409 problem when agents exceed the collection bound", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    await insertProject(workspace.id, human.id, "Repo", "REP");
    await database.db.insert(agents).values(
      Array.from({ length: 201 }, (_, index) => ({
        id: randomUUID(),
        humanId: human.id,
        name: `fleet-bot-${index}`,
      })),
    );
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectProblem(res, 409, "targets_too_large");
  });

  it("returns a 409 problem when workspaces exceed the collection bound", async () => {
    const { cookie, human } = await insertHuman();
    const workspaceIds = Array.from({ length: 201 }, () => randomUUID());
    // One transaction: the deferred shared-workspace owner guard fires at
    // commit, when every membership already exists.
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values(
        workspaceIds.map((id, index) => ({
          id,
          kind: "shared" as const,
          name: `Fleet ${index}`,
        })),
      );
      await tx.insert(workspaceMemberships).values(
        workspaceIds.map((workspaceId) => ({
          id: randomUUID(),
          workspaceId,
          humanId: human.id,
          isOwner: true,
        })),
      );
    });
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectProblem(res, 409, "targets_too_large");
  });

  it("returns a 409 problem when projects exceed the collection bound", async () => {
    const { cookie, human } = await insertHuman();
    const workspace = await insertPersonalWorkspace(human.id);
    await database.db.insert(projects).values(
      Array.from({ length: 2001 }, (_, index) => ({
        id: randomUUID(),
        workspaceId: workspace.id,
        name: `Bulk repo ${index}`,
        key: `B${String(index).padStart(5, "0")}`,
        createdByHumanId: human.id,
      })),
    );
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectProblem(res, 409, "targets_too_large");
  });

  it("returns empty collections for a fresh enrollment", async () => {
    const { cookie } = await insertHuman();
    const credential = await enrollHost(cookie);

    const res = await getTargets(app, { bearer: credential.credential });
    expect(res.status).toBe(200);
    expect(RunnerTargetsResponse.parse(await res.json())).toEqual({
      workspaces: [],
      agents: [],
      defaultAgentId: null,
    });
  });
});

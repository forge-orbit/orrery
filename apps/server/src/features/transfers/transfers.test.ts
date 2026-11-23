import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentIdentity,
  CreateAgentKeyResponse,
  HistoryResponse,
  Issue,
  Problem,
  Project,
  TransferAuthorization,
  TransferPreview,
  type HistoryEvent,
} from "@orrery/contract";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  browserSessions,
  humans,
  issues as issuesTable,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projectTransferAuthorizations,
  projects,
  questions,
  runs,
  workSessions,
  workspaceEvents,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAgentsFeature, type AgentAuthenticator } from "../agents/index.ts";
import { createHistoryFeature } from "../history/index.ts";
import { createProjectsFeature, type WorkSessionGate } from "../projects/index.ts";
import { createSessionsFeature, type SessionsService } from "../work-sessions/index.ts";
import { createWorkspacesFeature } from "../workspaces/index.ts";
import { createTransfersFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "transfer-admin@example.com";
const ADMIN_PASSWORD = "transfer-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let sessionsService: SessionsService;

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

const getJson = (path: string, cookie?: string, bearer?: string) =>
  app.request(
    path,
    cookie || bearer
      ? {
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
        }
      : {},
  );

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringsOf(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    const fieldValue = field(item, key);
    return typeof fieldValue === "string" ? [fieldValue] : [];
  });
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

async function cookieFor(email: string, password: string) {
  const res = await postJson("/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie");
  return cookie;
}

async function insertHuman(email: string) {
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`now()`,
    })
    .returning();
  if (human === undefined) throw new Error("the account was not created");
  return human;
}

async function sessionFor(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`now() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

async function personalWorkspaceId(humanId: string) {
  const [workspace] = await database.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("no personal workspace");
  return workspace.id;
}

async function createSharedWorkspace(cookie: string, name: string, email: string) {
  const res = await postJson("/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  const [row] = await database.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.name, name), eq(workspaces.kind, "shared")));
  if (row === undefined) throw new Error("the destination workspace was not created");
  return { workspaceId: row.id, ownerEmail: email };
}

async function addMembership(workspaceId: string, humanId: string, canCreateProjects = false) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner: false,
    canCreateProjects,
  });
}

async function createPersonalProject(cookie: string, workspaceId: string, name: string) {
  const res = await postJson(`/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createProjectWithKey(
  cookie: string,
  workspaceId: string,
  name: string,
  key: string,
) {
  const res = await postJson(`/api/workspaces/${workspaceId}/projects`, { name, key }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(cookie: string, projectId: string, title: string) {
  const res = await postJson(`/api/projects/${projectId}/issues`, { title }, cookie);
  expect(res.status).toBe(201);
  return idOf(await res.json(), "issue");
}

async function issueKey(cookie: string, workspaceId: string, projectId: string) {
  const agentName = `transfer-agent-${randomUUID()}`;
  const agentRes = await postJson("/api/agents", { name: agentName }, cookie);
  expect(agentRes.status).toBe(201);
  const keyRes = await postJson(
    "/api/agents/keys",
    {
      agentId: idOf(await agentRes.json(), "agent"),
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
    cookie,
  );
  expect(keyRes.status).toBe(201);
  return CreateAgentKeyResponse.parse(await keyRes.json()).secret;
}

async function identityFor(secret: string) {
  const res = await getJson("/api/agents/me", undefined, secret);
  expect(res.status).toBe(200);
  return AgentIdentity.parse(await res.json());
}

async function claimIssue(secret: string, issueId: string) {
  const identity = await identityFor(secret);
  const [run] = await database.db
    .insert(runs)
    .values({
      id: randomUUID(),
      agentId: identity.agentId,
      workspaceId: identity.workspaceId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: runs.id });
  if (run === undefined) throw new Error("the run was not created");
  return sessionsService.claim({ kind: "agent", identity }, { issueId, runId: run.id });
}

async function preview(cookie: string, projectId: string, destinationWorkspaceId: string) {
  const res = await postJson(
    `/api/projects/${projectId}/transfer/preview`,
    { destinationWorkspaceId },
    cookie,
  );
  expect(res.status).toBe(200);
  return TransferPreview.parse(await res.json());
}

async function authorize(cookie: string, projectId: string, destinationWorkspaceId: string) {
  const res = await postJson(
    `/api/projects/${projectId}/transfer`,
    { destinationWorkspaceId },
    cookie,
  );
  expect(res.status).toBe(201);
  return TransferAuthorization.parse(await res.json());
}

async function receiverPreview(cookie: string, token: string) {
  const res = await postJson("/api/transfers/preview", { token }, cookie);
  expect(res.status).toBe(200);
  return TransferPreview.parse(await res.json());
}

async function accept(cookie: string, token: string) {
  return postJson("/api/transfers/accept", { token }, cookie);
}

async function complete(cookie: string, projectId: string, destinationWorkspaceId: string) {
  return postJson(
    `/api/projects/${projectId}/transfer/complete`,
    { destinationWorkspaceId },
    cookie,
  );
}

async function acceptWithKey(cookie: string, token: string, key: string) {
  return postJson("/api/transfers/accept", { token, key }, cookie);
}

async function completeWithKey(
  cookie: string,
  projectId: string,
  destinationWorkspaceId: string,
  key: string,
) {
  return postJson(
    `/api/projects/${projectId}/transfer/complete`,
    { destinationWorkspaceId, key },
    cookie,
  );
}

async function getProject(cookie: string, projectId: string) {
  const res = await getJson(`/api/projects/${projectId}`, cookie);
  expect(res.status).toBe(200);
  return Project.parse(await res.json());
}

async function waitForLockWait(queryPattern: string, minimum = 1) {
  await expect
    .poll(
      async () => {
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike ${queryPattern}
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 10_000, interval: 25 },
    )
    .toBeGreaterThanOrEqual(minimum);
}

async function holdIssueLock(issueId: string) {
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let unlock!: () => void;
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const holding = database.db.transaction(async (tx) => {
    await tx
      .select({ id: issuesTable.id })
      .from(issuesTable)
      .where(eq(issuesTable.id, issueId))
      .for("update");
    locked();
    await release;
  });
  await acquired;
  return { release: () => unlock(), holding };
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
  let gate: WorkSessionGate | undefined;
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: (tx, agentId, workspaceId, issueId) => {
      if (gate === undefined) throw new Error("session gate is not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
  });
  let liveAuthenticator: AgentAuthenticator | undefined;
  const lateAuth: AgentAuthenticator = (request) => {
    if (liveAuthenticator === undefined) throw new Error("authenticator is not wired");
    return liveAuthenticator(request);
  };
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  liveAuthenticator = agentsFeature.authenticator;
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  sessionsService = sessionsFeature.service;
  const workspacesFeature = createWorkspacesFeature({
    db: database.db,
    publicUrl: PUBLIC_URL,
    sessionReader: accounts.sessionReader,
    createInvitedHuman: accounts.createInvitedHuman,
    markEmailVerified: accounts.markEmailVerified,
    deliver: async () => {},
    log: silentLogger,
    revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
      projectsFeature.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
    revokeMemberWorkspaceKeys: async () => {},
    releaseMemberWorkSessions: (tx, workspaceId, humanId) =>
      sessionsFeature.releaseMemberWorkSessions(tx, workspaceId, humanId),
    applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
      projectsFeature.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
  });
  const transfersFeature = createTransfersFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
  });
  const historyFeature = createHistoryFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
  });
  app = createApp({
    features: [
      accounts,
      projectsFeature,
      agentsFeature,
      sessionsFeature,
      workspacesFeature,
      transfersFeature,
      historyFeature,
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
}, 120_000);

beforeEach(async () => {
  const [admin] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin !== undefined) return;
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (setup.status !== 201) throw new Error("bootstrap did not create the first administrator");
});

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from questions`);
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from project_transfer_authorizations`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);

    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspace_ownership_guards`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from invitations`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from instance_setup`);
    await tx.execute(sql`delete from instance_settings`);
    await tx.execute(sql`delete from email_verification_tokens`);
    await tx.execute(sql`delete from humans`);
  });
});

async function source() {
  const cookie = await cookieFor(ADMIN_EMAIL, ADMIN_PASSWORD);
  const [admin] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin === undefined) throw new Error("no admin");
  const workspaceId = await personalWorkspaceId(admin.id);
  const project = await createPersonalProject(cookie, workspaceId, "Personal project");
  return { cookie, humanId: admin.id, workspaceId, project };
}

const patchJson = (path: string, body: unknown, cookie: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

async function sharedSource(name: string) {
  const cookie = await cookieFor(ADMIN_EMAIL, ADMIN_PASSWORD);
  const [admin] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin === undefined) throw new Error("no admin");
  const created = await createSharedWorkspace(cookie, name, ADMIN_EMAIL);
  const project = await createPersonalProject(cookie, created.workspaceId, `${name} project`);
  return { cookie, humanId: admin.id, workspaceId: created.workspaceId, project };
}

async function setAccess(cookie: string, projectId: string, email: string, level: string) {
  const res = await patchJson(`/api/projects/${projectId}/access`, { email, level }, cookie);
  expect(res.status).toBe(200);
}

async function readHistory(cookie: string, path: string): Promise<HistoryEvent[]> {
  const res = await getJson(path, cookie);
  expect(res.status).toBe(200);
  return HistoryResponse.parse(await res.json());
}

describe("personal-to-shared project transfer against real Postgres", () => {
  it("previews destination, visibility, access changes and active work without writing", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Preview Team", ADMIN_EMAIL);
    const issueId = await createIssue(s.cookie, s.project.id, "Preview issue");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    await claimIssue(secret, issueId);

    const result = await preview(s.cookie, s.project.id, dest.workspaceId);
    expect(result).toMatchObject({
      projectId: s.project.id,
      visibilityChange: "personal_to_shared",
      source: { workspaceId: s.workspaceId, kind: "personal" },
      destination: { workspaceId: dest.workspaceId, kind: "shared" },
      revokedSourceGrants: 0,
      ready: false,
    });
    expect(result.activeWork.count).toBe(1);
    expect(result.activeWork.issues[0]).toMatchObject({ issueId, title: "Preview issue" });
    expect(result.accessChanges).toEqual([
      expect.objectContaining({ reason: "destination_owner", level: "manage" }),
    ]);
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(0);
  });

  it("blocks a claim made between authorization and acceptance, then allows it after the claim stops", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Busy Team", ADMIN_EMAIL);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);

    const issueId = await createIssue(s.cookie, s.project.id, "Claimed after authorization");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    const session = await claimIssue(secret, issueId);

    await expectProblem(await accept(s.cookie, authorization.token), 409, "active_work");
    expect((await getProject(s.cookie, s.project.id)).workspaceId).toBe(s.workspaceId);

    await sessionsService.stop(
      { kind: "agent", identity: await identityFor(secret) },
      issueId,
      "completed",
    );
    const res = await accept(s.cookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      workspaceId: dest.workspaceId,
    });
    expect(session.status).toBe("active");
  });

  it("does not let an expired claim in database time block acceptance", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Stale Team", ADMIN_EMAIL);
    const issueId = await createIssue(s.cookie, s.project.id, "Stale issue");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    await claimIssue(secret, issueId);
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 second' where issue_id = ${issueId} and status = 'active'`,
    );
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    const res = await accept(s.cookie, authorization.token);
    expect(res.status).toBe(200);
    const sessions = await database.db
      .select({ status: workSessions.status })
      .from(workSessions)
      .where(eq(workSessions.issueId, issueId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("expired");
  });

  it("completes directly when one person owns both sides", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Direct Team", ADMIN_EMAIL);
    const res = await complete(s.cookie, s.project.id, dest.workspaceId);
    expect(res.status).toBe(200);
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      id: s.project.id,
      workspaceId: dest.workspaceId,
      workspaceKind: "shared",
      accessLevel: "manage",
    });
  });

  it("supports two parties: source owner authorizes, a Create projects member accepts", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Two Party Team", ADMIN_EMAIL);
    const receiver = await insertHuman("receiver@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    expect(authorization.authorizedByHumanId).toBe(s.humanId);
    const res = await accept(receiverCookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(receiverCookie, s.project.id)).toMatchObject({
      workspaceId: dest.workspaceId,
      accessLevel: "manage",
    });

    const grants = await database.db
      .select({ humanId: projectAccessGrants.humanId, level: projectAccessGrants.level })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, s.project.id));
    expect(grants).toEqual(
      expect.arrayContaining([expect.objectContaining({ humanId: receiver.id, level: "manage" })]),
    );
  });

  it("supports two parties when the destination owner is different from the source owner", async () => {
    const s = await source();
    const destinationOwner = await insertHuman("dest-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const dest = await createSharedWorkspace(ownerCookie, "Owner Team", "dest-owner@example.com");

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    const res = await accept(ownerCookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(ownerCookie, s.project.id)).toMatchObject({ accessLevel: "manage" });
  });

  it("refuses acceptance when the project workspace changed after authorization", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Changed Team", ADMIN_EMAIL);
    const other = await createSharedWorkspace(s.cookie, "Other Team", ADMIN_EMAIL);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await database.db
      .update(projects)
      .set({ workspaceId: other.workspaceId })
      .where(eq(projects.id, s.project.id));
    await expectProblem(await accept(s.cookie, authorization.token), 409, "transfer_stale");
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("refuses acceptance when destination authority was withdrawn", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Authority Team", ADMIN_EMAIL);
    const receiver = await insertHuman("downgraded@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await database.db
      .update(workspaceMemberships)
      .set({ canCreateProjects: false })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, dest.workspaceId),
          eq(workspaceMemberships.humanId, receiver.id),
        ),
      );
    await expectProblem(
      await accept(receiverCookie, authorization.token),
      403,
      "destination_authority_required",
    );
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("refuses acceptance when the authorizing owner lost the source", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Lost Source Team", ADMIN_EMAIL);
    const successor = await insertHuman("successor@example.com");
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await database.db
      .update(workspaces)
      .set({ personalOwnerHumanId: successor.id })
      .where(eq(workspaces.id, s.workspaceId));
    await expectProblem(await accept(s.cookie, authorization.token), 409, "source_authority_lost");
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("removes the project from source keys, rebuilds Manage and preserves identity and history", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "History Team", ADMIN_EMAIL);
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    const issueId = await createIssue(s.cookie, s.project.id, "Preserved issue");
    const beforeActivity = await getJson(`/api/projects/${s.project.id}/activity`, s.cookie);
    expect(beforeActivity.status).toBe(200);
    expect(stringsOf(await beforeActivity.json(), "type")).toContain("issue_created");

    const res = await complete(s.cookie, s.project.id, dest.workspaceId);
    expect(res.status).toBe(200);

    const identity = await identityFor(secret);
    expect(identity.projects.map((grant) => grant.projectId)).not.toContain(s.project.id);
    expect(await database.db.select().from(agentApiKeyProjects)).toHaveLength(0);
    const refused = await postJson(
      `/api/projects/${s.project.id}/issues`,
      { title: "Refused" },
      undefined,
      secret,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const after = await getProject(s.cookie, s.project.id);
    expect(after).toMatchObject({
      id: s.project.id,
      name: s.project.name,
      createdBy: { humanId: s.humanId },
      workspaceId: dest.workspaceId,
    });
    const issuesRes = await getJson(`/api/projects/${s.project.id}/issues`, s.cookie);
    expect(issuesRes.status).toBe(200);
    expect(stringsOf(await issuesRes.json(), "id")).toContain(issueId);
    const afterActivity = await getJson(`/api/projects/${s.project.id}/activity`, s.cookie);
    expect(stringsOf(await afterActivity.json(), "type")).toContain("issue_created");
    expect(await database.db.select().from(projectActivity)).not.toHaveLength(0);

    const grants = await database.db
      .select({ level: projectAccessGrants.level })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, s.project.id));
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.level === "manage")).toBe(true);
    const accessEvents = await database.db
      .select({ type: projectAccessEvents.type })
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.projectId, s.project.id));
    expect(accessEvents.every((event) => event.type === "project_access_granted")).toBe(true);
    const received = await database.db
      .select({ type: workspaceEvents.type })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, dest.workspaceId));
    expect(received.map((event) => event.type)).toContain("project_transfer_received");
    const sourceEvents = await database.db
      .select({ type: workspaceEvents.type })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, s.workspaceId));
    expect(sourceEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["project_transfer_authorized", "project_transferred_out"]),
    );
  });

  it("invalidates a pending invitation offer for the project on acceptance", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Offer Team", ADMIN_EMAIL);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);

    const [invitation] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: dest.workspaceId,
        email: `offered-${randomUUID()}@example.com`,
        status: "pending",
        tokenHash: randomBytes(32).toString("base64url"),
        invitedByHumanId: s.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    if (invitation === undefined) throw new Error("the invitation was not created");
    await database.db.insert(workspaceInvitationGrants).values({
      id: randomUUID(),
      invitationId: invitation.id,
      projectId: s.project.id,
      level: "read",
    });
    expect(
      await database.db
        .select()
        .from(workspaceInvitationGrants)
        .where(eq(workspaceInvitationGrants.projectId, s.project.id)),
    ).toHaveLength(1);

    const res = await accept(s.cookie, authorization.token);
    expect(res.status).toBe(200);
    expect(
      await database.db
        .select()
        .from(workspaceInvitationGrants)
        .where(eq(workspaceInvitationGrants.projectId, s.project.id)),
    ).toHaveLength(0);
  });

  it("does not enumerate a destination the caller is not a member of", async () => {
    const s = await source();
    const destinationOwner = await insertHuman("hidden-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const dest = await createSharedWorkspace(
      ownerCookie,
      "Hidden Team",
      "hidden-owner@example.com",
    );
    const outsider = await insertHuman("outsider@example.com");
    const outsiderCookie = await sessionFor(outsider.id);

    await expectProblem(
      await postJson(
        `/api/projects/${s.project.id}/transfer/preview`,
        { destinationWorkspaceId: dest.workspaceId },
        s.cookie,
      ),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await complete(s.cookie, s.project.id, dest.workspaceId),
      404,
      "workspace_not_found",
    );

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    await expectProblem(
      await postJson("/api/transfers/preview", { token: authorization.token }, outsiderCookie),
      404,
      "transfer_invalid",
    );
    await expectProblem(await accept(outsiderCookie, authorization.token), 404, "transfer_invalid");
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("leaks no destination name or owner identities to a non-member authorizer", async () => {
    const s = await source();
    const destinationOwner = await insertHuman("private-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const dest = await createSharedWorkspace(
      ownerCookie,
      "Private Team Name",
      "private-owner@example.com",
    );

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    expect(authorization.preview).toBeNull();
    expect(JSON.stringify(authorization)).not.toContain("private-owner@example.com");
    expect(JSON.stringify(authorization)).not.toContain("Private Team Name");
  });

  it("lets a separate Create projects member preview the pending transfer before accepting", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Receiver Team", ADMIN_EMAIL);
    const receiver = await insertHuman("preview-receiver@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);
    const member = await insertHuman("plain-member@example.com");
    await addMembership(dest.workspaceId, member.id, false);
    const memberCookie = await sessionFor(member.id);

    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);
    const view = await receiverPreview(receiverCookie, authorization.token);
    expect(view).toMatchObject({
      projectId: s.project.id,
      destination: { workspaceId: dest.workspaceId },
      visibilityChange: "personal_to_shared",
    });
    expect(view.accessChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanId: s.humanId,
          reason: "destination_owner",
          level: "manage",
        }),
        expect.objectContaining({ humanId: receiver.id, reason: "receiver", level: "manage" }),
      ]),
    );
    await expectProblem(
      await postJson("/api/transfers/preview", { token: authorization.token }, memberCookie),
      403,
      "destination_authority_required",
    );
    const res = await accept(receiverCookie, authorization.token);
    expect(res.status).toBe(200);
  });

  it("keeps settled invitation offers and revokes sibling authorization tokens", async () => {
    const s = await source();
    const first = await createSharedWorkspace(s.cookie, "Destination First", ADMIN_EMAIL);
    const second = await createSharedWorkspace(s.cookie, "Destination Second", ADMIN_EMAIL);
    const firstAuth = await authorize(s.cookie, s.project.id, first.workspaceId);
    const secondAuth = await authorize(s.cookie, s.project.id, second.workspaceId);

    const [settled] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: first.workspaceId,
        email: `settled-${randomUUID()}@example.com`,
        status: "accepted",
        tokenHash: randomBytes(32).toString("base64url"),
        invitedByHumanId: s.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    const [pending] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: first.workspaceId,
        email: `pending-${randomUUID()}@example.com`,
        status: "pending",
        tokenHash: randomBytes(32).toString("base64url"),
        invitedByHumanId: s.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    if (settled === undefined || pending === undefined) throw new Error("invitations not created");
    await database.db.insert(workspaceInvitationGrants).values([
      { id: randomUUID(), invitationId: settled.id, projectId: s.project.id, level: "read" },
      { id: randomUUID(), invitationId: pending.id, projectId: s.project.id, level: "read" },
    ]);

    const res = await accept(s.cookie, firstAuth.token);
    expect(res.status).toBe(200);
    const remaining = await database.db
      .select({ invitationId: workspaceInvitationGrants.invitationId })
      .from(workspaceInvitationGrants)
      .where(eq(workspaceInvitationGrants.projectId, s.project.id));
    expect(remaining.map((row) => row.invitationId)).toEqual([settled.id]);

    const authorizations = await database.db
      .select({
        id: projectTransferAuthorizations.id,
        status: projectTransferAuthorizations.status,
      })
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.projectId, s.project.id));
    expect(authorizations.find((row) => row.id === firstAuth.authorizationId)?.status).toBe(
      "accepted",
    );
    expect(authorizations.find((row) => row.id === secondAuth.authorizationId)?.status).toBe(
      "revoked",
    );
  });

  it("moves project questions to the destination workspace so they remain visible in the inbox", async () => {
    const s = await source();
    const dest = await createSharedWorkspace(s.cookie, "Inbox Team", ADMIN_EMAIL);
    const issueId = await createIssue(s.cookie, s.project.id, "Paused question issue");
    const secret = await issueKey(s.cookie, s.workspaceId, s.project.id);
    const identity = await identityFor(secret);
    const runId = randomUUID();
    const sessionId = randomUUID();
    const questionId = randomUUID();

    await database.db.insert(runs).values({
      id: runId,
      agentId: identity.agentId,
      workspaceId: s.workspaceId,
      status: "active",
    });
    await database.db.insert(workSessions).values({
      id: sessionId,
      agentId: identity.agentId,
      runId,
      workspaceId: s.workspaceId,
      issueId,
      status: "released",
      leaseExpiresAt: sql`statement_timestamp() - interval '10 minutes'`,
      endedAt: sql`statement_timestamp() - interval '10 minutes'`,
    });
    await database.db.insert(questions).values({
      id: questionId,
      issueId,
      projectId: s.project.id,
      workspaceId: s.workspaceId,
      agentId: identity.agentId,
      runId,
      sessionId,
      question: "Which region should we deploy to?",
      proposedFallback: "us-east-1",
      status: "paused",
      responseDeadlineAt: sql`statement_timestamp() + interval '1 hour'`,
      resolvedAt: sql`statement_timestamp()`,
    });

    const res = await complete(s.cookie, s.project.id, dest.workspaceId);
    expect(res.status).toBe(200);

    const [moved] = await database.db
      .select({ workspaceId: questions.workspaceId })
      .from(questions)
      .where(eq(questions.id, questionId));
    expect(moved?.workspaceId).toBe(dest.workspaceId);
  });
});

describe("shared-to-shared project transfer against real Postgres", () => {
  it("previews a shared_to_shared move and completes it directly when one owner holds both sides", async () => {
    const sourceW1 = await sharedSource("W1 Direct");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 Direct", ADMIN_EMAIL);

    const view = await preview(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);
    expect(view).toMatchObject({
      projectId: sourceW1.project.id,
      visibilityChange: "shared_to_shared",
      source: { workspaceId: sourceW1.workspaceId, kind: "shared" },
      destination: { workspaceId: destW2.workspaceId, kind: "shared" },
      ready: true,
    });
    expect(view.accessChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanId: sourceW1.humanId, reason: "destination_owner" }),
      ]),
    );

    const res = await complete(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);
    expect(res.status).toBe(200);
    expect(await getProject(sourceW1.cookie, sourceW1.project.id)).toMatchObject({
      id: sourceW1.project.id,
      workspaceId: destW2.workspaceId,
      workspaceKind: "shared",
      accessLevel: "manage",
    });
    const outEvents = await database.db
      .select({ type: workspaceEvents.type })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, sourceW1.workspaceId));
    expect(outEvents.map((event) => event.type)).toContain("project_transferred_out");
  });

  it("authorizes a shared source; a separate Create projects member previews and accepts", async () => {
    const sourceW1 = await sharedSource("W1 Two Party");

    const destinationOwner = await insertHuman("shared-dest-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const destW2 = await createSharedWorkspace(
      ownerCookie,
      "W2 Two Party",
      "shared-dest-owner@example.com",
    );
    const receiver = await insertHuman("shared-receiver@example.com");
    await addMembership(destW2.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);
    const plain = await insertHuman("shared-plain@example.com");
    await addMembership(destW2.workspaceId, plain.id, false);
    const plainCookie = await sessionFor(plain.id);

    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);
    expect(authorization.preview).toBeNull();
    expect(authorization.authorizedByHumanId).toBe(sourceW1.humanId);

    const receiverView = await receiverPreview(receiverCookie, authorization.token);
    expect(receiverView).toMatchObject({
      projectId: sourceW1.project.id,
      visibilityChange: "shared_to_shared",
      source: { workspaceId: sourceW1.workspaceId, kind: "shared" },
      destination: { workspaceId: destW2.workspaceId },
    });
    expect(receiverView.accessChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanId: destinationOwner.id,
          reason: "destination_owner",
          level: "manage",
        }),
        expect.objectContaining({ humanId: receiver.id, reason: "receiver", level: "manage" }),
      ]),
    );
    await expectProblem(
      await postJson("/api/transfers/preview", { token: authorization.token }, plainCookie),
      403,
      "destination_authority_required",
    );

    const res = await accept(receiverCookie, authorization.token);
    expect(res.status).toBe(200);
    expect(await getProject(receiverCookie, sourceW1.project.id)).toMatchObject({
      workspaceId: destW2.workspaceId,
      accessLevel: "manage",
    });
  });

  it("refuses a transfer to the same workspace", async () => {
    const sourceW1 = await sharedSource("W1 Same");
    await expectProblem(
      await postJson(
        `/api/projects/${sourceW1.project.id}/transfer/preview`,
        { destinationWorkspaceId: sourceW1.workspaceId },
        sourceW1.cookie,
      ),
      400,
      "same_workspace",
    );
    await expectProblem(
      await postJson(
        `/api/projects/${sourceW1.project.id}/transfer`,
        { destinationWorkspaceId: sourceW1.workspaceId },
        sourceW1.cookie,
      ),
      400,
      "same_workspace",
    );
    await expectProblem(
      await complete(sourceW1.cookie, sourceW1.project.id, sourceW1.workspaceId),
      400,
      "same_workspace",
    );
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(0);
  });

  it("refuses a shared source owner who is only a member or a stranger", async () => {
    const sourceW1 = await sharedSource("W1 Guarded");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 Guarded", ADMIN_EMAIL);
    const member = await insertHuman("shared-source-member@example.com");
    await addMembership(sourceW1.workspaceId, member.id, true);
    const memberCookie = await sessionFor(member.id);
    const stranger = await insertHuman("shared-source-stranger@example.com");
    const strangerCookie = await sessionFor(stranger.id);

    for (const cookie of [memberCookie, strangerCookie]) {
      await expectProblem(
        await postJson(
          `/api/projects/${sourceW1.project.id}/transfer/preview`,
          { destinationWorkspaceId: destW2.workspaceId },
          cookie,
        ),
        404,
        "project_not_found",
      );
      await expectProblem(
        await postJson(
          `/api/projects/${sourceW1.project.id}/transfer`,
          { destinationWorkspaceId: destW2.workspaceId },
          cookie,
        ),
        404,
        "project_not_found",
      );
      await expectProblem(
        await complete(cookie, sourceW1.project.id, destW2.workspaceId),
        404,
        "project_not_found",
      );
    }
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(0);
  });

  it("revives neither an old grant nor an old source key on a W1 -> W2 -> W1 round trip", async () => {
    const sourceW1 = await sharedSource("W1 Round");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 Round", ADMIN_EMAIL);
    const member = await insertHuman("round-grant@example.com");
    await addMembership(sourceW1.workspaceId, member.id);
    await setAccess(sourceW1.cookie, sourceW1.project.id, member.email, "read");
    const issueId = await createIssue(sourceW1.cookie, sourceW1.project.id, "Round issue");
    const secret = await issueKey(sourceW1.cookie, sourceW1.workspaceId, sourceW1.project.id);

    expect((await complete(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId)).status).toBe(
      200,
    );
    expect(await database.db.select().from(agentApiKeyProjects)).toHaveLength(0);
    let grants = await database.db
      .select({ humanId: projectAccessGrants.humanId })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, sourceW1.project.id));
    expect(grants.map((g) => g.humanId)).not.toContain(member.id);

    expect(
      (await complete(sourceW1.cookie, sourceW1.project.id, sourceW1.workspaceId)).status,
    ).toBe(200);
    expect(await getProject(sourceW1.cookie, sourceW1.project.id)).toMatchObject({
      workspaceId: sourceW1.workspaceId,
    });

    expect(await database.db.select().from(agentApiKeyProjects)).toHaveLength(0);
    const identity = await identityFor(secret);
    expect(identity.projects.map((grant) => grant.projectId)).not.toContain(sourceW1.project.id);
    const refused = await postJson(
      `/api/projects/${sourceW1.project.id}/issues`,
      { title: "Refused" },
      undefined,
      secret,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    grants = await database.db
      .select({ humanId: projectAccessGrants.humanId })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, sourceW1.project.id));
    expect(grants.map((g) => g.humanId)).not.toContain(member.id);
    const issues = await getJson(`/api/projects/${sourceW1.project.id}/issues`, sourceW1.cookie);
    expect(stringsOf(await issues.json(), "id")).toContain(issueId);
  });

  it("fails acceptance with source_authority_lost when the authorizing owner is demoted", async () => {
    const sourceW1 = await sharedSource("W1 Lost Owner");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 Lost Owner", ADMIN_EMAIL);
    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);

    const successor = await insertHuman("shared-successor@example.com");
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: sourceW1.workspaceId,
      humanId: successor.id,
      isOwner: true,
    });
    await database.db
      .update(workspaceMemberships)
      .set({ isOwner: false })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, sourceW1.workspaceId),
          eq(workspaceMemberships.humanId, sourceW1.humanId),
        ),
      );

    const stranger = await insertHuman("lost-owner-stranger@example.com");
    const strangerCookie = await sessionFor(stranger.id);
    await expectProblem(await accept(strangerCookie, authorization.token), 404, "transfer_invalid");
    await expectProblem(
      await accept(sourceW1.cookie, authorization.token),
      409,
      "source_authority_lost",
    );

    const [stored] = await database.db
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, sourceW1.project.id));
    expect(stored?.workspaceId).toBe(sourceW1.workspaceId);
    expect(await database.db.select().from(projectTransferAuthorizations)).toHaveLength(1);
  });

  it("invalidates a pending invitation offer so redemption after the move grants nothing", async () => {
    const sourceW1 = await sharedSource("W1 Offer");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 Offer", ADMIN_EMAIL);
    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);
    const invitee = await insertHuman("shared-offered@example.com");
    const token = randomBytes(32).toString("base64url");
    const [invitation] = await database.db
      .insert(workspaceInvitations)
      .values({
        id: randomUUID(),
        workspaceId: sourceW1.workspaceId,
        email: invitee.email,
        status: "pending",
        tokenHash: tokenHash(token),
        invitedByHumanId: sourceW1.humanId,
        expiresAt: sql`statement_timestamp() + interval '7 days'`,
      })
      .returning();
    if (invitation === undefined) throw new Error("the invitation was not created");

    await database.db
      .update(humans)
      .set({ emailVerifiedAt: sql`now()` })
      .where(eq(humans.id, sourceW1.humanId));
    await database.db.insert(workspaceInvitationGrants).values({
      id: randomUUID(),
      invitationId: invitation.id,
      projectId: sourceW1.project.id,
      level: "read",
    });

    expect((await accept(sourceW1.cookie, authorization.token)).status).toBe(200);
    expect(
      await database.db
        .select()
        .from(workspaceInvitationGrants)
        .where(eq(workspaceInvitationGrants.projectId, sourceW1.project.id)),
    ).toHaveLength(0);

    const inviteeCookie = await sessionFor(invitee.id);
    const redeemed = await postJson(
      "/api/workspace-invitations/acceptance",
      { token },
      inviteeCookie,
    );
    expect(redeemed.status).toBe(200);
    const grants = await database.db
      .select({ humanId: projectAccessGrants.humanId })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, sourceW1.project.id));
    expect(grants.map((g) => g.humanId)).not.toContain(invitee.id);
  });

  it("keeps source access-change events in W1 and out of W2's project and workspace history", async () => {
    const sourceW1 = await sharedSource("W1 History");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 History", ADMIN_EMAIL);
    const member = await insertHuman("history-grant@example.com");
    await addMembership(sourceW1.workspaceId, member.id);
    await setAccess(sourceW1.cookie, sourceW1.project.id, member.email, "read");
    await createIssue(sourceW1.cookie, sourceW1.project.id, "Travelling issue");

    const before = await readHistory(
      sourceW1.cookie,
      `/api/projects/${sourceW1.project.id}/history`,
    );
    const sourceAccessIds = before
      .filter((event) => event.kind === "project_access")
      .map((event) => event.id);
    expect(sourceAccessIds.length).toBeGreaterThan(0);
    expect(
      before.some(
        (event) => event.kind === "project_access" && event.subject?.email === member.email,
      ),
    ).toBe(true);

    expect((await complete(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId)).status).toBe(
      200,
    );

    const after = await readHistory(
      sourceW1.cookie,
      `/api/projects/${sourceW1.project.id}/history`,
    );
    expect(after.map((event) => event.id)).not.toEqual(expect.arrayContaining(sourceAccessIds));
    expect(after.map((event) => event.type)).toContain("issue_created");
    expect(after.some((event) => event.type === "project_access_granted")).toBe(true);
    expect(after.some((event) => event.subject?.email === member.email)).toBe(false);

    const w1History = await readHistory(
      sourceW1.cookie,
      `/api/workspaces/${sourceW1.workspaceId}/history`,
    );
    expect(w1History.map((event) => event.id)).toEqual(expect.arrayContaining(sourceAccessIds));
    const w2History = await readHistory(
      sourceW1.cookie,
      `/api/workspaces/${destW2.workspaceId}/history`,
    );
    expect(w2History.map((event) => event.id)).not.toEqual(expect.arrayContaining(sourceAccessIds));
    expect(w2History.map((event) => event.type)).toContain("project_transfer_received");
    expect(w2History.some((event) => event.type === "project_access_granted")).toBe(true);

    const stored = await database.db
      .select({
        id: projectAccessEvents.id,
        workspaceId: projectAccessEvents.workspaceId,
      })
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.projectId, sourceW1.project.id));
    expect(
      stored
        .filter((row) => sourceAccessIds.includes(row.id))
        .every((row) => row.workspaceId === sourceW1.workspaceId),
    ).toBe(true);
    expect(stored.some((row) => row.workspaceId === destW2.workspaceId)).toBe(true);
  });

  it("rejects a direct transfer when the destination already uses the project key", async () => {
    const cookie = await cookieFor(ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("no admin");
    const personal = await personalWorkspaceId(admin.id);
    const sourceProject = await createProjectWithKey(
      cookie,
      personal,
      "Personal colliding",
      "COLL",
    );
    const dest = await createSharedWorkspace(cookie, "Collision Team", ADMIN_EMAIL);
    await createProjectWithKey(cookie, dest.workspaceId, "Destination colliding", "COLL");
    const issue = await createIssue(cookie, sourceProject.id, "Identifier after collision");

    await expectProblem(
      await complete(cookie, sourceProject.id, dest.workspaceId),
      409,
      "project_key_conflict",
    );

    const pending = await database.db
      .select({ id: projectTransferAuthorizations.id })
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.projectId, sourceProject.id));
    expect(pending).toHaveLength(0);
    expect(await getProject(cookie, sourceProject.id)).toMatchObject({
      workspaceId: personal,
      key: "COLL",
    });
    const issues = await getJson(`/api/projects/${sourceProject.id}/issues`, cookie);
    expect(issues.status).toBe(200);
    expect(asArray(await issues.json())[0]).toMatchObject({ id: issue, identifier: "COLL-1" });

    const resolved = await completeWithKey(cookie, sourceProject.id, dest.workspaceId, "NEWK");
    expect(resolved.status).toBe(200);
    expect(await getProject(cookie, sourceProject.id)).toMatchObject({
      workspaceId: dest.workspaceId,
      key: "NEWK",
    });
    const after = await getJson(`/api/projects/${sourceProject.id}/issues`, cookie);
    expect(asArray(await after.json())[0]).toMatchObject({ id: issue, identifier: "NEWK-1" });
  });

  it("resolves a destination key collision on two-party acceptance atomically", async () => {
    const s = await source();
    await database.db.update(projects).set({ key: "SHAR" }).where(eq(projects.id, s.project.id));
    const dest = await createSharedWorkspace(s.cookie, "Two Party Collision", ADMIN_EMAIL);
    await createProjectWithKey(s.cookie, dest.workspaceId, "Destination project", "SHAR");
    const receiver = await insertHuman("key-receiver@example.com");
    await addMembership(dest.workspaceId, receiver.id, true);
    const receiverCookie = await sessionFor(receiver.id);
    const authorization = await authorize(s.cookie, s.project.id, dest.workspaceId);

    await expectProblem(
      await accept(receiverCookie, authorization.token),
      409,
      "project_key_conflict",
    );
    const stillPending = await database.db
      .select({ status: projectTransferAuthorizations.status })
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.id, authorization.authorizationId));
    expect(stillPending[0]?.status).toBe("pending");
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      workspaceId: s.workspaceId,
      key: "SHAR",
    });

    const resolved = await acceptWithKey(receiverCookie, authorization.token, "FRESH");
    expect(resolved.status).toBe(200);
    expect(await getProject(receiverCookie, s.project.id)).toMatchObject({
      workspaceId: dest.workspaceId,
      key: "FRESH",
    });
    const reused = await acceptWithKey(receiverCookie, authorization.token, "FRESH");
    await expectProblem(reused, 404, "transfer_invalid");
  });

  it("applies a replacement key even when the source workspace already uses it", async () => {
    const cookie = await cookieFor(ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("no admin");
    const personal = await personalWorkspaceId(admin.id);
    const moved = await createProjectWithKey(cookie, personal, "Moved project", "ORR");

    await createProjectWithKey(cookie, personal, "Source neighbour", "ORR2");
    const dest = await createSharedWorkspace(cookie, "Destination with ORR", ADMIN_EMAIL);
    await createProjectWithKey(cookie, dest.workspaceId, "Destination project", "ORR");

    const res = await completeWithKey(cookie, moved.id, dest.workspaceId, "ORR2");
    expect(res.status).toBe(200);
    expect(await getProject(cookie, moved.id)).toMatchObject({
      workspaceId: dest.workspaceId,
      key: "ORR2",
    });
    const [neighbour] = await database.db
      .select({ workspaceId: projects.workspaceId, key: projects.key })
      .from(projects)
      .where(eq(projects.name, "Source neighbour"));
    expect(neighbour).toMatchObject({ workspaceId: personal, key: "ORR2" });
  });

  it("refuses a replacement key when the transferred key does not collide", async () => {
    const s = await source();
    await database.db.update(projects).set({ key: "FREE" }).where(eq(projects.id, s.project.id));
    const dest = await createSharedWorkspace(s.cookie, "No collision Team", ADMIN_EMAIL);

    await expectProblem(
      await completeWithKey(s.cookie, s.project.id, dest.workspaceId, "OTHER"),
      409,
      "project_key_immutable",
    );
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      workspaceId: s.workspaceId,
      key: "FREE",
    });

    const res = await complete(s.cookie, s.project.id, dest.workspaceId);
    expect(res.status).toBe(200);
    expect(await getProject(s.cookie, s.project.id)).toMatchObject({
      workspaceId: dest.workspaceId,
      key: "FREE",
    });
  });

  it("blocks a shared-to-shared transfer while a claim is live in database time", async () => {
    const sourceW1 = await sharedSource("W1 Busy");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "W2 Busy", ADMIN_EMAIL);
    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);
    const issueId = await createIssue(sourceW1.cookie, sourceW1.project.id, "Claimed issue");
    const secret = await issueKey(sourceW1.cookie, sourceW1.workspaceId, sourceW1.project.id);
    await claimIssue(secret, issueId);

    await expectProblem(await accept(sourceW1.cookie, authorization.token), 409, "active_work");
    expect(await getProject(sourceW1.cookie, sourceW1.project.id)).toMatchObject({
      workspaceId: sourceW1.workspaceId,
    });

    await sessionsService.stop(
      { kind: "agent", identity: await identityFor(secret) },
      issueId,
      "completed",
    );
    expect((await accept(sourceW1.cookie, authorization.token)).status).toBe(200);
    expect(await getProject(sourceW1.cookie, sourceW1.project.id)).toMatchObject({
      workspaceId: destW2.workspaceId,
    });
  });

  it("clears assignments that are invalid in the destination so its agents can claim the issues", async () => {
    const sourceW1 = await sharedSource("W1 Assignees");
    const destinationOwner = await insertHuman("assignee-dest-owner@example.com");
    const ownerCookie = await sessionFor(destinationOwner.id);
    const destW2 = await createSharedWorkspace(
      ownerCookie,
      "W2 Assignees",
      "assignee-dest-owner@example.com",
    );

    const sourceMember = await insertHuman("assignee-source@example.com");
    await addMembership(sourceW1.workspaceId, sourceMember.id);
    const destinationMember = await insertHuman("assignee-destination@example.com");
    await addMembership(sourceW1.workspaceId, destinationMember.id);
    await addMembership(destW2.workspaceId, destinationMember.id);

    const sourceHumanIssue = await createIssue(
      sourceW1.cookie,
      sourceW1.project.id,
      "Source human assignee",
    );
    const sourceAgentIssue = await createIssue(
      sourceW1.cookie,
      sourceW1.project.id,
      "Source agent assignee",
    );
    const destinationHumanIssue = await createIssue(
      sourceW1.cookie,
      sourceW1.project.id,
      "Destination human assignee",
    );

    const sourceSecret = await issueKey(sourceW1.cookie, sourceW1.workspaceId, sourceW1.project.id);
    const sourceAgent = await identityFor(sourceSecret);
    const assign = async (issueId: string, assignee: { type: "human" | "agent"; id: string }) => {
      const res = await patchJson(`/api/issues/${issueId}`, { assignee }, sourceW1.cookie);
      expect(res.status).toBe(200);
    };
    await assign(sourceHumanIssue, { type: "human", id: sourceMember.id });
    await assign(sourceAgentIssue, { type: "agent", id: sourceAgent.agentId });
    await assign(destinationHumanIssue, { type: "human", id: destinationMember.id });

    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);
    expect((await accept(ownerCookie, authorization.token)).status).toBe(200);

    const rows = await database.db
      .select({
        id: issuesTable.id,
        assigneeType: issuesTable.assigneeType,
        assigneeId: issuesTable.assigneeId,
      })
      .from(issuesTable)
      .where(inArray(issuesTable.id, [sourceHumanIssue, sourceAgentIssue, destinationHumanIssue]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(sourceHumanIssue)).toMatchObject({ assigneeType: null, assigneeId: null });
    expect(byId.get(sourceAgentIssue)).toMatchObject({ assigneeType: null, assigneeId: null });
    expect(byId.get(destinationHumanIssue)).toMatchObject({
      assigneeType: "human",
      assigneeId: destinationMember.id,
    });

    const detail = await getJson(`/api/issues/${sourceHumanIssue}`, ownerCookie);
    expect(detail.status).toBe(200);
    expect(Issue.parse(await detail.json()).assignee).toBeNull();

    const destinationSecret = await issueKey(ownerCookie, destW2.workspaceId, sourceW1.project.id);
    const session = await claimIssue(destinationSecret, sourceHumanIssue);
    expect(session.issueId).toBe(sourceHumanIssue);
  });
});

describe("issue creation racing a transfer against real Postgres", () => {
  it("refuses a create that checked access before the project moved out of the source workspace", async () => {
    const sourceW1 = await sharedSource("Race Access Source");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "Race Access Dest", ADMIN_EMAIL);
    const contributorEmail = "race-contributor@example.com";
    const contributor = await insertHuman(contributorEmail);
    await addMembership(sourceW1.workspaceId, contributor.id);
    const contributorCookie = await sessionFor(contributor.id);
    await setAccess(sourceW1.cookie, sourceW1.project.id, contributorEmail, "contribute");
    const seededIssueId = await createIssue(sourceW1.cookie, sourceW1.project.id, "Seed issue");
    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);

    // The accept locks projects before it locks issues. Holding an issue lock
    // parks it after it has taken the projects row lock but before it commits,
    // so a concurrent create must observe the transfer's committed state.
    const { release, holding } = await holdIssueLock(seededIssueId);
    try {
      const accepting = accept(sourceW1.cookie, authorization.token);
      await waitForLockWait('%from "issues"%for update%');
      const creating = postJson(
        `/api/projects/${sourceW1.project.id}/issues`,
        { title: "Racing issue" },
        contributorCookie,
      );
      await waitForLockWait('%"projects"%');

      release();
      const [acceptRes, createRes] = await Promise.all([accepting, creating, holding]);
      expect(acceptRes.status).toBe(200);
      expect(createRes.status).toBe(404);
      expect(await createRes.json()).toMatchObject({ status: 404, code: "project_not_found" });
      const remaining = await database.db
        .select({ title: issuesTable.title })
        .from(issuesTable)
        .where(eq(issuesTable.projectId, sourceW1.project.id));
      expect(remaining.map((row) => row.title)).toEqual(["Seed issue"]);
    } finally {
      release();
      await holding.catch(() => {});
    }
  });

  it("uses the transferred key for an issue created while the key is being changed", async () => {
    const sourceW1 = await sharedSource("Race Key Source");
    const destW2 = await createSharedWorkspace(sourceW1.cookie, "Race Key Dest", ADMIN_EMAIL);
    const sourceKey = sourceW1.project.key;
    await createProjectWithKey(sourceW1.cookie, destW2.workspaceId, "Key occupier", sourceKey);
    const seededIssueId = await createIssue(sourceW1.cookie, sourceW1.project.id, "Seed issue");
    const authorization = await authorize(sourceW1.cookie, sourceW1.project.id, destW2.workspaceId);

    const { release, holding } = await holdIssueLock(seededIssueId);
    try {
      const accepting = acceptWithKey(sourceW1.cookie, authorization.token, "RENAMED");
      await waitForLockWait('%from "issues"%for update%');
      const creating = postJson(
        `/api/projects/${sourceW1.project.id}/issues`,
        { title: "Racing issue" },
        sourceW1.cookie,
      );
      await waitForLockWait('%"projects"%');

      release();
      const [acceptRes, createRes] = await Promise.all([accepting, creating, holding]);
      expect(acceptRes.status).toBe(200);
      expect(createRes.status).toBe(201);
      expect(field(await createRes.json(), "identifier")).toBe("RENAMED-2");
    } finally {
      release();
      await holding.catch(() => {});
    }
  });
});

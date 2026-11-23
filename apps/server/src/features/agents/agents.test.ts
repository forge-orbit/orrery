import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AgentIdentity, CreateAgentKeyResponse, Problem, tools } from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  issueComments,
  issues,
  knowledgeEntries,
  projectActivity,
  runs as runRows,
  agentApiKeyProjects,
  agentApiKeys,
  agentKeyEvents,
  browserSessions,
  humans,
  projectAccessGrants,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  createAccountsFeature,
  accountByEmail,
  hashPassword,
  invalidateAccountSessions,
  setAccountPasswordHash,
} from "../accounts/index.ts";
import { createHistoryFeature } from "../history/index.ts";
import {
  createProjectsFeature,
  ProjectsError,
  type ProjectsErrorKind,
  type WorkSessionGate,
} from "../projects/index.ts";
import { createRecoveryFeature } from "../recovery/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { createSessionsFeature, type SessionsService } from "../work-sessions/index.ts";
import {
  createAgentsFeature,
  revokeMemberWorkspaceKeys,
  type AgentAuthenticator,
} from "./index.ts";
import { createAgentsService } from "./service.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const MEMBER_EMAIL = "member@example.com";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

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

const getJson = (app: Hono, path: string, cookie?: string, bearer?: string) =>
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

const patchJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

let pg: StartedPostgreSqlContainer;
let database: Database;

async function makeApp(): Promise<Hono> {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  });
  return createApp({
    features: [
      accounts,
      projectsFeature,
      createAgentsFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
          projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
        projectAccessAtLeast: (actual, required) =>
          ["read", "contribute", "manage"].indexOf(actual) >=
          ["read", "contribute", "manage"].indexOf(required),
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
}

async function makeProjectWorkApp() {
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
      if (gate === undefined) throw new Error("session gate not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
  });
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: async () => null,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  const app = createApp({
    features: [
      accounts,
      projectsFeature,
      sessionsFeature,
      createAgentsFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
          projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
        projectAccessAtLeast: (actual, required) =>
          ["read", "contribute", "manage"].indexOf(actual) >=
          ["read", "contribute", "manage"].indexOf(required),
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
  return { app, projects: projectsFeature.service, sessions: sessionsFeature.service };
}

async function claimIssue(
  sessions: SessionsService,
  identity: AgentIdentity,
  issueId: string,
): Promise<void> {
  const [run] = await database.db
    .insert(runRows)
    .values({
      id: randomUUID(),
      agentId: identity.agentId,
      workspaceId: identity.workspaceId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: runRows.id });
  if (run === undefined) throw new Error("the run was not created");
  await sessions.claim({ kind: "agent", identity }, { issueId, runId: run.id });
}

async function makeBearerApp() {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  let authenticator: AgentAuthenticator | undefined;
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: (request) => {
      if (authenticator === undefined) throw new Error("authenticator not wired");
      return authenticator(request);
    },
    sessionGate: async () => true,
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  authenticator = agentsFeature.authenticator;
  return {
    app: createApp({
      features: [accounts, projectsFeature, agentsFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    }),
    projects: projectsFeature.service,
  };
}

async function makeRotationApp() {
  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) =>
      ["read", "contribute", "manage"].indexOf(actual) >=
      ["read", "contribute", "manage"].indexOf(required),
  });
  let delivered: OutgoingMail | undefined;
  const app = createApp({
    features: [
      accounts,
      projectsFeature,
      agentsFeature,
      createRecoveryFeature({
        db: database.db,
        accounts: {
          accountByEmail: (email, tx) => accountByEmail(tx ?? database.db, email),
          hashPassword: (password) => hashPassword(password),
          setPasswordHash: (humanId, passwordHash, tx) =>
            setAccountPasswordHash(tx, humanId, passwordHash),
          invalidateBrowserSessions: (humanId, tx) => invalidateAccountSessions(tx, humanId),
        },
        deliver: async (mail) => {
          delivered = mail;
        },
        publicUrl: PUBLIC_URL,
        log: silentLogger,
      }),
      createHistoryFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
          projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
  return {
    app,

    resetPassword: async (email: string, password: string) => {
      const asked = await postJson(app, "/api/auth/password-reset/request", { email });
      expect(asked.status).toBe(200);
      if (delivered === undefined) throw new Error("no reset email was delivered");
      const token = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(delivered.text)?.[1];
      if (token === undefined) throw new Error("the reset email had no token");
      const confirmed = await postJson(app, "/api/auth/password-reset/confirm", {
        token,
        password,
      });
      expect(confirmed.status).toBe(200);
      delivered = undefined;
    },
  };
}

async function adminId(): Promise<string> {
  const [human] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
  if (human === undefined) throw new Error("the administrator was not created");
  return human.id;
}

async function identityFor(app: Hono, secret: string): Promise<AgentIdentity> {
  const res = await getJson(app, "/api/agents/me", undefined, secret);
  expect(res.status).toBe(200);
  return AgentIdentity.parse(await res.json());
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the operation to be rejected");
    },
    (error: unknown) => error,
  );
}

function createGate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
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

function humanActor(humanId: string, email: string) {
  return {
    kind: "human" as const,
    account: {
      humanId,
      email,
      isSystemAdministrator: false,
      emailVerifiedAt: new Date(),
    },
  };
}

function expectProjectsError(error: unknown, kind: ProjectsErrorKind) {
  expect(error).toBeInstanceOf(ProjectsError);
  expect(error).toMatchObject({ kind });
}

async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(res.status).toBe(201);
}

async function cookieFor(app: Hono, email: string, password: string) {
  const res = await postJson(app, "/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
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
  if (human === undefined) throw new Error("the human was not created");
  return human;
}

async function createSession(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`now() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

async function personalWorkspaceOf(humanId: string) {
  const [workspace] = await database.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("the personal workspace was not found");
  return workspace;
}

async function personalWorkspace(humanId: string) {
  const [workspace] = await database.db
    .insert(workspaces)
    .values({ id: randomUUID(), kind: "personal", name: "Personal", personalOwnerHumanId: humanId })
    .returning();
  if (workspace === undefined) throw new Error("the personal workspace was not created");
  return workspace;
}

async function sharedWorkspace(name: string, ownerHumanId: string) {
  return database.db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ id: randomUUID(), kind: "shared", name })
      .returning();
    if (workspace === undefined) throw new Error("the workspace was not created");
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: ownerHumanId,
      isOwner: true,
    });
    return workspace;
  });
}

async function membership(workspaceId: string, humanId: string, isOwner = false) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner,
  });
}

async function removeMembership(workspaceId: string, humanId: string) {
  await database.db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    );
}

async function project(workspaceId: string, name: string, createdByHumanId: string) {
  const [row] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name,
      key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
      createdByHumanId,
    })
    .returning();
  if (row === undefined) throw new Error("the project was not created");
  return row;
}

async function grant(projectId: string, humanId: string, level: "read" | "contribute" | "manage") {
  await database.db.insert(projectAccessGrants).values({
    id: randomUUID(),
    projectId,
    humanId,
    level,
    grantedByHumanId: humanId,
  });
}

async function setGrant(
  projectId: string,
  humanId: string,
  level: "read" | "contribute" | "manage",
) {
  await database.db
    .update(projectAccessGrants)
    .set({ level })
    .where(
      and(eq(projectAccessGrants.projectId, projectId), eq(projectAccessGrants.humanId, humanId)),
    );
}

async function removeGrant(projectId: string, humanId: string) {
  await database.db
    .delete(projectAccessGrants)
    .where(
      and(eq(projectAccessGrants.projectId, projectId), eq(projectAccessGrants.humanId, humanId)),
    );
}

async function makeAgent(app: Hono, cookie: string, name: string) {
  const res = await postJson(app, "/api/agents", { name }, cookie);
  expect(res.status).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  app: Hono,
  cookie: string,
  input: {
    agentId: string;
    workspaceId: string;
    projects: { projectId: string; level: string }[];
    validity?: string;
  },
) {
  const res = await postJson(app, "/api/agents/keys", input, cookie);
  expect(res.status).toBe(201);
  return CreateAgentKeyResponse.parse(await res.json());
}

async function rotate(
  app: Hono,
  cookie: string,
  keyId: string,
  input: {
    validity?: string;
    projects?: { projectId: string; level: string }[];
  } = {},
) {
  const res = await postJson(
    app,
    `/api/agents/keys/${encodeURIComponent(keyId)}/rotate`,
    input,
    cookie,
  );
  expect(res.status).toBe(201);
  return CreateAgentKeyResponse.parse(await res.json());
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from account_recovery_events`);
    await tx.execute(sql`delete from password_reset_tokens`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);

    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);

    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from projects`);
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

describe("workspace-scoped agent API keys", () => {
  it("refuses to issue a key for a deactivated human, even with a stale session identity", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const admin = await database.db
      .select()
      .from(humans)
      .where(eq(humans.email, ADMIN_EMAIL))
      .then((rows) => rows[0]);
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const p = await project(workspace.id, "Personal project", admin.id);
    const agentId = await makeAgent(app, adminCookie, "deactivated-bot");

    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`now()` })
      .where(eq(humans.id, admin.id));

    const service = createAgentsService({
      db: database.db,
      projectAccessCeiling: async () => new Map([[p.id, "manage" as const]]),
      projectAccessAtLeast: () => true,
    });
    await expect(
      service.issueKey(
        {
          humanId: admin.id,
          email: admin.email,
          isSystemAdministrator: admin.isSystemAdministrator,
          emailVerifiedAt: admin.emailVerifiedAt,
        },
        {
          agentId,
          workspaceId: workspace.id,
          validity: "90",
          projects: [{ projectId: p.id, level: "manage" }],
        },
      ),
    ).rejects.toMatchObject({ kind: "workspace_not_found" });
    expect(await database.db.select().from(agentApiKeys)).toHaveLength(0);
  });

  it("refuses workspace key administration to a deactivated owner, even with a stale session identity", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await sharedWorkspace("Deactivated owner team", admin.id);
    const p = await project(workspace.id, "Owned project", admin.id);
    const agentId = await makeAgent(app, adminCookie, "owner-bot");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: p.id, level: "read" }],
    });

    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`now()` })
      .where(eq(humans.id, admin.id));

    const service = createAgentsService({
      db: database.db,
      projectAccessCeiling: async () => new Map([[p.id, "manage" as const]]),
      projectAccessAtLeast: () => true,
    });
    const staleAccount = {
      humanId: admin.id,
      email: admin.email,
      isSystemAdministrator: admin.isSystemAdministrator,
      emailVerifiedAt: admin.emailVerifiedAt,
    };
    await expect(service.workspaceKeys(staleAccount, workspace.id)).rejects.toMatchObject({
      kind: "not_workspace_owner",
    });
    await expect(
      service.ownerRevokeKey(staleAccount, workspace.id, issued.key.id),
    ).rejects.toMatchObject({ kind: "not_workspace_owner" });
    const [stored] = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, issued.key.id));
    expect(stored?.revokedAt).toBeNull();
  });

  it("creates an agent, issues a 90-day key by default, and authenticates REST as that agent", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const p = await project(workspace.id, "Personal project", admin.id);

    const agentId = await makeAgent(app, adminCookie, "build-bot");
    const duplicate = await postJson(app, "/api/agents", { name: "build-bot" }, adminCookie);
    await expectProblem(duplicate, 409, "agent_name_taken");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: p.id, level: "manage" }],
    });
    expect(issued.key.validity).toBe("90");
    expect(issued.key.expiresAt).not.toBeNull();
    expect(issued.secret).toMatch(/^orr_ak_/);
    expect(issued.key.keyHint).toBe(`${issued.secret.slice(0, 19)}...`);

    const me = await getJson(app, "/api/agents/me", undefined, issued.secret);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      agentId,
      humanId: admin.id,
      keyId: issued.key.id,
      workspaceId: workspace.id,
      name: "build-bot",
      projects: [{ projectId: p.id, level: "manage" }],
    });

    const [stored] = await database.db
      .select({ tokenHash: agentApiKeys.tokenHash })
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, issued.key.id));
    expect(stored?.tokenHash).toBe(tokenHash(issued.secret));
    const list = await getJson(app, "/api/agents/keys", adminCookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain(issued.secret);

    const events = await database.db.select().from(agentKeyEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_key_created",
      keyId: issued.key.id,
      agentId,
      workspaceId: workspace.id,
      actorHumanId: admin.id,
    });
    expect(JSON.stringify(events)).not.toContain(issued.secret);
  });

  it("refuses duplicate project grants when issuing a key", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const p = await project(workspace.id, "Duplicate-grant project", admin.id);
    const agentId = await makeAgent(app, cookie, "duplicate-grant-bot");

    const res = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        projects: [
          { projectId: p.id, level: "read" },
          { projectId: p.id, level: "manage" },
        ],
      },
      cookie,
    );
    await expectProblem(res, 400, "validation_failed");
    expect(await database.db.select().from(agentApiKeys)).toEqual([]);
    expect(await database.db.select().from(agentApiKeyProjects)).toEqual([]);
  });

  it("refuses a key used in another workspace or on a project outside its scope", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const other = await sharedWorkspace("Other", admin.id);
    const p = await project(workspace.id, "In scope", admin.id);
    const outside = await project(other.id, "Out of scope", admin.id);
    const agentId = await makeAgent(app, adminCookie, "scoped-bot");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: p.id, level: "read" }],
    });

    const cross = await getJson(
      app,
      `/api/agents/me?workspaceId=${other.id}`,
      undefined,
      issued.secret,
    );
    expect(cross.status).toBe(403);
    await expectProblem(cross, 403, "key_out_of_scope");
    const out = await getJson(
      app,
      `/api/agents/me?projectId=${outside.id}`,
      undefined,
      issued.secret,
    );
    await expectProblem(out, 403, "insufficient_agent_access");

    const bad = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId: outside.id, level: "read" }],
      },
      adminCookie,
    );
    await expectProblem(bad, 400, "invalid_key_grant");
  });

  it("accepts a key just before expiry and refuses it just after, evaluated in database time", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const p = await project(workspace.id, "Timed", admin.id);
    const agentId = await makeAgent(app, adminCookie, "timed-bot");

    const secret = `orr_ak_${randomBytes(32).toString("base64url")}`;
    const [key] = await database.db
      .insert(agentApiKeys)
      .values({
        id: randomUUID(),
        agentId,
        workspaceId: workspace.id,
        createdByHumanId: admin.id,
        validity: "7",
        tokenHash: tokenHash(secret),
        expiresAt: sql`now() + interval '2 seconds'`,
      })
      .returning();
    if (key === undefined) throw new Error("the key was not created");
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: key.id,
      projectId: p.id,
      level: "read",
    });

    const before = await getJson(app, "/api/agents/me", undefined, secret);
    expect(before.status).toBe(200);

    await database.db
      .update(agentApiKeys)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(agentApiKeys.id, key.id));
    const after = await getJson(app, "/api/agents/me", undefined, secret);
    await expectProblem(after, 401, "key_expired");
  });

  it("enforces the human's level at issue and caps dynamically when it is lowered, including Never", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await sharedWorkspace("Team", admin.id);
    const member = await insertHuman(MEMBER_EMAIL);
    const memberCookie = await createSession(member.id);
    await membership(workspace.id, member.id);
    const p = await project(workspace.id, "Team project", admin.id);
    await grant(p.id, member.id, "contribute");
    const agentId = await makeAgent(app, memberCookie, "member-bot");

    const tooHigh = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        validity: "never",
        projects: [{ projectId: p.id, level: "manage" }],
      },
      memberCookie,
    );
    await expectProblem(tooHigh, 400, "invalid_key_grant");

    const issued = await issueKey(app, memberCookie, {
      agentId,
      workspaceId: workspace.id,
      validity: "never",
      projects: [{ projectId: p.id, level: "contribute" }],
    });
    expect(issued.key.validity).toBe("never");
    expect(issued.key.expiresAt).toBeNull();

    let me = await getJson(app, "/api/agents/me?projectId=" + p.id, undefined, issued.secret);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      projects: [{ projectId: p.id, projectName: "Team project", level: "contribute" }],
    });

    await setGrant(p.id, member.id, "read");
    me = await getJson(app, "/api/agents/me?projectId=" + p.id, undefined, issued.secret);
    expect(await me.json()).toMatchObject({ projects: [{ projectId: p.id, level: "read" }] });

    await removeGrant(p.id, member.id);
    const denied = await getJson(app, "/api/agents/me?projectId=" + p.id, undefined, issued.secret);
    await expectProblem(denied, 403, "insufficient_agent_access");

    await removeMembership(workspace.id, member.id);
    const removed = await getJson(
      app,
      `/api/agents/me?workspaceId=${workspace.id}`,
      undefined,
      issued.secret,
    );
    await expectProblem(removed, 401, "key_workspace_inaccessible");
  });

  it("revokes keys without secrets, and an owner's revocation is isolated to their workspace", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const team = await sharedWorkspace("Team", admin.id);
    const member = await insertHuman(MEMBER_EMAIL);
    const memberCookie = await createSession(member.id);
    await membership(team.id, member.id);
    const memberPersonal = await personalWorkspace(member.id);
    const teamProject = await project(team.id, "Team project", admin.id);
    await grant(teamProject.id, member.id, "read");
    const ownProject = await project(memberPersonal.id, "Private", member.id);

    const memberAgent = await makeAgent(app, memberCookie, "member-bot");
    const teamKey = await issueKey(app, memberCookie, {
      agentId: memberAgent,
      workspaceId: team.id,
      projects: [{ projectId: teamProject.id, level: "read" }],
    });
    const ownKey = await issueKey(app, memberCookie, {
      agentId: memberAgent,
      workspaceId: memberPersonal.id,
      projects: [{ projectId: ownProject.id, level: "manage" }],
    });

    const listed = await getJson(app, `/api/workspaces/${team.id}/agent-keys`, adminCookie);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(JSON.stringify(listedBody)).toContain(teamKey.key.id);
    expect(JSON.stringify(listedBody)).toContain(teamKey.key.agentName);
    expect(JSON.stringify(listedBody)).toContain(teamKey.key.projects[0]?.projectName ?? "");
    expect(JSON.stringify(listedBody)).not.toContain(teamKey.secret);
    expect(JSON.stringify(listedBody)).not.toContain(ownKey.secret);

    const ownerRevoke = await deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${teamKey.key.id}`,
      adminCookie,
    );
    expect(ownerRevoke.status).toBe(204);

    const repeatOwnerRevoke = await deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${teamKey.key.id}`,
      adminCookie,
    );
    expect(repeatOwnerRevoke.status).toBe(204);

    const refused = await getJson(app, "/api/agents/me", undefined, teamKey.secret);
    await expectProblem(refused, 401, "key_revoked");
    const unaffected = await getJson(app, "/api/agents/me", undefined, ownKey.secret);
    expect(unaffected.status).toBe(200);

    const elsewhere = await deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${ownKey.key.id}`,
      adminCookie,
    );
    await expectProblem(elsewhere, 404, "key_not_found");

    const ownRevoke = await deleteRequest(app, `/api/agents/keys/${ownKey.key.id}`, memberCookie);
    expect(ownRevoke.status).toBe(204);
    const repeatOwnRevoke = await deleteRequest(
      app,
      `/api/agents/keys/${ownKey.key.id}`,
      memberCookie,
    );
    expect(repeatOwnRevoke.status).toBe(204);
    await expectProblem(
      await getJson(app, "/api/agents/me", undefined, ownKey.secret),
      401,
      "key_revoked",
    );

    const events = await database.db.select().from(agentKeyEvents);
    expect(events).toHaveLength(4);
    expect(events.filter((event) => event.type === "agent_key_created")).toHaveLength(2);
    expect(events.filter((event) => event.type === "agent_key_revoked")).toHaveLength(2);
    expect(
      events.find((event) => event.keyId === teamKey.key.id && event.type === "agent_key_revoked"),
    ).toMatchObject({
      actorHumanId: admin.id,
      workspaceId: team.id,
    });
    for (const event of events) expect(JSON.stringify(event)).not.toContain(teamKey.secret);
  });

  it("records every key when a removed member has more than one workspace key", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const team = await sharedWorkspace("Batch revocation team", admin.id);
    const member = await insertHuman(MEMBER_EMAIL);
    const memberCookie = await createSession(member.id);
    await membership(team.id, member.id);
    const p = await project(team.id, "Batch project", admin.id);
    await grant(p.id, member.id, "read");
    const agentId = await makeAgent(app, memberCookie, "batch-bot");
    const first = await issueKey(app, memberCookie, {
      agentId,
      workspaceId: team.id,
      projects: [{ projectId: p.id, level: "read" }],
    });
    const second = await issueKey(app, memberCookie, {
      agentId,
      workspaceId: team.id,
      validity: "7",
      projects: [{ projectId: p.id, level: "read" }],
    });

    await database.db.transaction((tx) =>
      revokeMemberWorkspaceKeys(tx, team.id, member.id, admin.id),
    );

    const keys = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.workspaceId, team.id));
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.revokedAt !== null)).toBe(true);
    const events = await database.db
      .select()
      .from(agentKeyEvents)
      .where(eq(agentKeyEvents.type, "agent_key_revoked"));
    expect(events.map((event) => event.keyId).toSorted()).toEqual(
      [first.key.id, second.key.id].toSorted(),
    );
    expect(events.every((event) => event.actorHumanId === admin.id)).toBe(true);
  });

  it("serializes key revocation with ownership writes", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const team = await sharedWorkspace("Revocation lock team", admin.id);
    const member = await insertHuman(MEMBER_EMAIL);
    const memberCookie = await createSession(member.id);
    await membership(team.id, member.id);
    const memberPersonal = await personalWorkspace(member.id);
    const teamProject = await project(team.id, "Team lock project", admin.id);
    await grant(teamProject.id, member.id, "read");
    const ownProject = await project(memberPersonal.id, "Own lock project", member.id);
    const agentId = await makeAgent(app, memberCookie, "revocation-lock-bot");
    const teamKey = await issueKey(app, memberCookie, {
      agentId,
      workspaceId: team.id,
      projects: [{ projectId: teamProject.id, level: "read" }],
    });
    const ownKey = await issueKey(app, memberCookie, {
      agentId,
      workspaceId: memberPersonal.id,
      projects: [{ projectId: ownProject.id, level: "manage" }],
    });

    const acquired = createGate();
    const release = createGate();
    const holder = database.sql.begin(async (tx) => {
      await tx`select lock_workspace_ownership_writes()`;
      acquired.release();
      await release.opened;
    });
    await acquired.opened;

    const ownerRevoking = deleteRequest(
      app,
      `/api/workspaces/${team.id}/agent-keys/${teamKey.key.id}`,
      adminCookie,
    );
    const selfRevoking = deleteRequest(app, `/api/agents/keys/${ownKey.key.id}`, memberCookie);
    try {
      await waitForLockWait("%lock_workspace_ownership_writes%", 2);
      const keys = await database.db.select().from(agentApiKeys);
      expect(keys.filter((key) => key.revokedAt === null)).toHaveLength(2);
    } finally {
      release.release();
      await holder;
    }
    const [ownerRes, selfRes] = await Promise.all([ownerRevoking, selfRevoking]);
    expect(ownerRes.status).toBe(204);
    expect(selfRes.status).toBe(204);
    const keys = await database.db.select().from(agentApiKeys);
    expect(keys.every((key) => key.revokedAt !== null)).toBe(true);
  }, 20_000);

  it("refuses a key project grant from another workspace at the database", async () => {
    const app = await makeApp();
    await bootstrapAdmin(app);
    const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the admin was not found");
    const workspace = await personalWorkspaceOf(admin.id);
    const other = await sharedWorkspace("Other", admin.id);
    const inScope = await project(workspace.id, "In scope", admin.id);
    const outside = await project(other.id, "Out of scope", admin.id);
    const agentId = await makeAgent(app, adminCookie, "scope-bot");
    const issued = await issueKey(app, adminCookie, {
      agentId,
      workspaceId: workspace.id,
      projects: [{ projectId: inScope.id, level: "read" }],
    });

    const error = await rejection(
      database.db.insert(agentApiKeyProjects).values({
        id: randomUUID(),
        keyId: issued.key.id,
        projectId: outside.id,
        level: "read",
      }),
    );
    expect(rootCause(error)?.message ?? String(error)).toContain("agent_key_project_workspace");
    expect(
      await database.db
        .select()
        .from(agentApiKeyProjects)
        .where(eq(agentApiKeyProjects.keyId, issued.key.id)),
    ).toHaveLength(1);
  });

  describe("agent project work (issue #33)", () => {
    it("registers only project-work tools, never membership or administration", () => {
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "list_projects",
          "get_project",
          "list_issues",
          "get_issue",
          "create_issue",
          "update_issue",
          "list_comments",
          "create_comment",
          "list_activity",
          "list_knowledge",
          "get_knowledge",
          "create_knowledge",
          "update_knowledge",
        ]),
      );
      for (const name of names) {
        expect(name).not.toMatch(/member|invit|workspace|setting|access|key|admin|grant/);
      }
    });

    it("attributes a Contribute agent's writes to the agent, not its human owner", async () => {
      const { app, projects: projectsService, sessions } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const workspace = await personalWorkspaceOf(admin);
      const created = await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Agent work" },
        cookie,
      );
      expect(created.status).toBe(201);
      const projectId = idOf(await created.json(), "project");
      const agentId = await makeAgent(app, cookie, "writer-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId, level: "contribute" }],
      });
      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };

      const issue = await projectsService.createIssue(actor, projectId, {
        title: "Agent issue",
        body: "body",
      });
      expect(issue.createdBy).toMatchObject({
        agentId,
        agentName: identity.name,
        displayName: identity.name,
      });
      expect(issue.createdBy.humanId).toBeFalsy();

      await claimIssue(sessions, identity, issue.id);
      const editedIssue = await projectsService.updateIssue(actor, issue.id, {
        title: "Edited by the agent",
        body: "New **body** by the agent.",
      });
      expect(editedIssue).toMatchObject({
        title: "Edited by the agent",
        body: "New **body** by the agent.",
      });
      expect(editedIssue.updatedBy).toMatchObject({ agentId });
      const closed = await projectsService.updateIssue(actor, issue.id, { status: "done" });
      expect(closed.updatedBy).toMatchObject({ agentId });
      const reopened = await projectsService.updateIssue(actor, issue.id, { status: "todo" });
      expect(reopened).toMatchObject({ status: "todo", closedAt: null });
      expect(reopened.updatedBy).toMatchObject({ agentId });
      const comment = await projectsService.createComment(actor, issue.id, {
        body: "Agent comment",
      });
      expect(comment.author).toMatchObject({ agentId });
      const entry = await projectsService.createKnowledge(actor, projectId, {
        title: "Agent note",
      });
      expect(entry.createdBy).toMatchObject({ agentId });
      const edited = await projectsService.updateKnowledge(actor, entry.id, { body: "more" });
      expect(edited.updatedBy).toMatchObject({ agentId });

      const [issueRow] = await database.db.select().from(issues).where(eq(issues.id, issue.id));
      expect(issueRow).toMatchObject({
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
        createdByHumanId: null,
        updatedByHumanId: null,
      });
      const [commentRow] = await database.db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, comment.id));
      expect(commentRow).toMatchObject({ createdByAgentId: agentId, createdByHumanId: null });
      const [entryRow] = await database.db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, entry.id));
      expect(entryRow).toMatchObject({
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
        createdByHumanId: null,
        updatedByHumanId: null,
      });

      const activities = await database.db.select().from(projectActivity);
      expect(activities.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "issue_created",
          "issue_edited",
          "issue_closed",
          "issue_reopened",
          "issue_commented",
          "knowledge_created",
          "knowledge_edited",
        ]),
      );
      const agentEvents = activities.filter((event) => event.type !== "project_created");
      expect(agentEvents).not.toHaveLength(0);
      for (const event of agentEvents) {
        expect(event).toMatchObject({ actorAgentId: agentId, actorHumanId: null });
      }
      const feed = await projectsService.listActivity(actor, projectId);
      const agentFeed = feed.filter((event) => event.type !== "project_created");
      expect(agentFeed).not.toHaveLength(0);
      for (const event of agentFeed) expect(event.actor).toMatchObject({ agentId });
    });

    it("lets a Read key inspect but not change work, matching REST human Read denials", async () => {
      const { app, projects: projectsService } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const workspace = await sharedWorkspace("Read team", admin);
      const created = await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Read only" },
        cookie,
      );
      expect(created.status).toBe(201);
      const projectId = idOf(await created.json(), "project");
      const humanIssue = await projectsService.createIssue(
        humanActor(admin, ADMIN_EMAIL),
        projectId,
        { title: "Existing issue" },
      );

      const agentId = await makeAgent(app, cookie, "reader-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId, level: "read" }],
      });
      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };

      expect(await projectsService.listProjects(actor, workspace.id)).toHaveLength(1);
      expect((await projectsService.getProject(actor, projectId)).id).toBe(projectId);
      expect(await projectsService.listIssues(actor, projectId)).toHaveLength(1);
      expect((await projectsService.getIssue(actor, humanIssue.id)).id).toBe(humanIssue.id);
      expect(await projectsService.listComments(actor, humanIssue.id)).toEqual([]);
      expect(await projectsService.listActivity(actor, projectId)).not.toHaveLength(0);
      expect(await projectsService.listKnowledge(actor, projectId)).toEqual([]);

      const denials = await Promise.all([
        rejection(projectsService.createIssue(actor, projectId, { title: "No" })),
        rejection(projectsService.updateIssue(actor, humanIssue.id, { status: "done" })),
        rejection(projectsService.createComment(actor, humanIssue.id, { body: "No" })),
        rejection(projectsService.createKnowledge(actor, projectId, { title: "No" })),
      ]);
      for (const error of denials) expectProjectsError(error, "insufficient_project_access");

      const other = await insertHuman("rest-reader@example.com");
      const memberCookie = await createSession(other.id);
      await membership(workspace.id, other.id);
      await grant(projectId, other.id, "read");
      const restDenied = await patchJson(
        app,
        `/api/issues/${humanIssue.id}`,
        { status: "done" },
        memberCookie,
      );
      await expectProblem(restDenied, 403, "insufficient_project_access");
      const bearerOnly = await patchJson(app, `/api/issues/${humanIssue.id}`, { status: "done" });
      expect(bearerOnly.status).toBe(401);
    });

    it("refuses cross-workspace and out-of-scope project work", async () => {
      const { app, projects: projectsService } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const workspace = await personalWorkspaceOf(admin);
      const scoped = await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Scoped" },
        cookie,
      );
      const scopedId = idOf(await scoped.json(), "project");
      expect(scopedId).toBeTruthy();
      const otherWorkspace = await sharedWorkspace("Other", admin);
      const otherProject = await project(otherWorkspace.id, "Other project", admin);
      const otherIssue = await projectsService.createIssue(
        humanActor(admin, ADMIN_EMAIL),
        otherProject.id,
        { title: "Other issue" },
      );

      const agentId = await makeAgent(app, cookie, "scoped-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId: scopedId, level: "contribute" }],
      });
      const namedOther = await getJson(
        app,
        `/api/agents/me?projectId=${otherProject.id}`,
        undefined,
        key.secret,
      );
      await expectProblem(namedOther, 403, "insufficient_agent_access");
      const namedOtherWorkspace = await getJson(
        app,
        `/api/agents/me?workspaceId=${otherWorkspace.id}`,
        undefined,
        key.secret,
      );
      await expectProblem(namedOtherWorkspace, 403, "key_out_of_scope");

      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };
      expectProjectsError(
        await rejection(projectsService.getIssue(actor, otherIssue.id)),
        "issue_not_found",
      );
      expectProjectsError(
        await rejection(projectsService.createIssue(actor, otherProject.id, { title: "No" })),
        "project_not_found",
      );
    });

    it("refuses a list_projects request aimed at another workspace the owner belongs to", async () => {
      const { app, projects: projectsService } = await makeBearerApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const scopedWorkspace = await personalWorkspaceOf(admin);

      const otherWorkspace = await sharedWorkspace("Other owned team", admin);
      const created = await postJson(
        app,
        `/api/workspaces/${scopedWorkspace.id}/projects`,
        { name: "Scoped" },
        cookie,
      );
      const projectId = idOf(await created.json(), "project");
      const agentId = await makeAgent(app, cookie, "list-scoped-bot");
      const key = await issueKey(app, cookie, {
        agentId,
        workspaceId: scopedWorkspace.id,
        projects: [{ projectId, level: "read" }],
      });
      const identity = await identityFor(app, key.secret);
      const actor = { kind: "agent" as const, identity };

      expectProjectsError(
        await rejection(projectsService.listProjects(actor, otherWorkspace.id)),
        "workspace_not_found",
      );

      const rest = await getJson(
        app,
        `/api/workspaces/${otherWorkspace.id}/projects`,
        undefined,
        key.secret,
      );
      await expectProblem(rest, 404, "workspace_not_found");

      const inScope = await getJson(
        app,
        `/api/workspaces/${scopedWorkspace.id}/projects`,
        undefined,
        key.secret,
      );
      expect(inScope.status).toBe(200);
    });

    it("caps an agent by its owner's current human access and ends access on removal", async () => {
      const { app, projects: projectsService } = await makeProjectWorkApp();
      await bootstrapAdmin(app);
      const admin = await adminId();
      const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const team = await sharedWorkspace("Team", admin);
      const created = await postJson(
        app,
        `/api/workspaces/${team.id}/projects`,
        { name: "Shared work" },
        adminCookie,
      );
      expect(created.status).toBe(201);
      const projectId = idOf(await created.json(), "project");

      const member = await insertHuman(MEMBER_EMAIL);
      const memberCookie = await createSession(member.id);
      await membership(team.id, member.id);
      await grant(projectId, member.id, "contribute");
      const agentId = await makeAgent(app, memberCookie, "team-bot");
      const key = await issueKey(app, memberCookie, {
        agentId,
        workspaceId: team.id,
        projects: [{ projectId, level: "contribute" }],
      });

      let identity = await identityFor(app, key.secret);
      expect(identity.projects).toMatchObject([{ projectId, level: "contribute" }]);
      let actor = { kind: "agent" as const, identity };
      const issue = await projectsService.createIssue(actor, projectId, {
        title: "Before demotion",
      });
      expect(issue.id).toBeTruthy();

      await setGrant(projectId, member.id, "read");
      identity = await identityFor(app, key.secret);
      expect(identity.projects).toMatchObject([{ projectId, level: "read" }]);
      actor = { kind: "agent" as const, identity };
      expectProjectsError(
        await rejection(projectsService.updateIssue(actor, issue.id, { title: "After demotion" })),
        "insufficient_project_access",
      );
      expect((await projectsService.listIssues(actor, projectId)).length).toBe(1);

      await removeMembership(team.id, member.id);
      await removeGrant(projectId, member.id);
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, key.secret),
        401,
        "key_workspace_inaccessible",
      );

      await membership(team.id, member.id);
      const rejoined = await identityFor(app, key.secret);
      expect(rejoined.projects).toEqual([]);
      expectProjectsError(
        await rejection(
          projectsService.createIssue({ kind: "agent", identity: rejoined }, projectId, {
            title: "No",
          }),
        ),
        "project_not_found",
      );

      const revoked = await deleteRequest(app, `/api/agents/keys/${key.key.id}`, memberCookie);
      expect(revoked.status).toBe(204);
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, key.secret),
        401,
        "key_revoked",
      );
    });
  });

  describe("key rotation (issue #35)", () => {
    it("creates an overlapping replacement for the same agent and workspace, without re-exposing the old secret", async () => {
      const { app } = await makeRotationApp();
      await bootstrapAdmin(app);
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const workspace = await personalWorkspaceOf(admin.id);
      const p = await project(workspace.id, "Rotating project", admin.id);
      const agentId = await makeAgent(app, cookie, "rotating-bot");
      const source = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        validity: "7",
        projects: [{ projectId: p.id, level: "contribute" }],
      });

      const replacement = await rotate(app, cookie, source.key.id);
      expect(replacement.key.id).not.toBe(source.key.id);
      expect(replacement.secret).not.toBe(source.secret);
      expect(replacement.secret).toMatch(/^orr_ak_/);
      expect(replacement.key).toMatchObject({
        agentId,
        agentName: source.key.agentName,
        workspaceId: workspace.id,
        createdByHumanId: admin.id,
        validity: "7",
        replacesKeyId: source.key.id,
        revokedAt: null,
        projects: [{ projectId: p.id, projectName: "Rotating project", level: "contribute" }],
      });
      expect(replacement.key.expiresAt).not.toBeNull();
      expect(JSON.stringify(replacement)).not.toContain(source.secret);
      const listing = JSON.stringify(await (await getJson(app, "/api/agents/keys", cookie)).json());
      expect(listing).toContain(replacement.key.id);
      expect(listing).not.toContain(source.secret);
      expect(listing).not.toContain(replacement.secret);

      expect(await identityFor(app, source.secret)).toMatchObject({
        agentId,
        keyId: source.key.id,
      });
      expect(await identityFor(app, replacement.secret)).toMatchObject({
        agentId,
        keyId: replacement.key.id,
      });

      const revoked = await deleteRequest(app, `/api/agents/keys/${source.key.id}`, cookie);
      expect(revoked.status).toBe(204);
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, source.secret),
        401,
        "key_revoked",
      );
      expect(await identityFor(app, replacement.secret)).toMatchObject({
        agentId,
        keyId: replacement.key.id,
      });

      const events = await database.db.select().from(agentKeyEvents);
      expect(events).toHaveLength(3);
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["agent_key_created", "agent_key_rotated", "agent_key_revoked"]),
      );
      expect(events.find((event) => event.type === "agent_key_rotated")).toMatchObject({
        keyId: replacement.key.id,
        agentId,
        workspaceId: workspace.id,
        actorHumanId: admin.id,
      });
      for (const event of events) {
        expect(JSON.stringify(event)).not.toContain(source.secret);
        expect(JSON.stringify(event)).not.toContain(replacement.secret);
      }
    });

    it("serializes rotation with a revocation that holds the source row", async () => {
      const app = await makeApp();
      await bootstrapAdmin(app);
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const workspace = await personalWorkspaceOf(admin.id);
      const p = await project(workspace.id, "Locked rotation", admin.id);
      const agentId = await makeAgent(app, cookie, "locked-rotation-bot");
      const source = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId: p.id, level: "read" }],
      });

      const acquired = createGate();
      const release = createGate();
      const holder = database.sql.begin(async (tx) => {
        await tx`select id from agent_api_keys where id = ${source.key.id} for update`;
        acquired.release();
        await release.opened;
        await tx`
          update agent_api_keys
          set revoked_at = statement_timestamp(), revoked_by_human_id = ${admin.id}
          where id = ${source.key.id}
        `;
      });
      await acquired.opened;

      try {
        const rotating = postJson(app, `/api/agents/keys/${source.key.id}/rotate`, {}, cookie);
        await waitForLockWait('%from "agent_api_keys"%for update%');
        release.release();
        const res = await rotating;
        await holder;
        await expectProblem(res, 409, "source_key_revoked");
      } finally {
        release.release();
        await holder.catch(() => {});
      }

      const keys = await database.db.select().from(agentApiKeys);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ id: source.key.id });
      expect(keys[0]?.revokedAt).not.toBeNull();
      const events = await database.db.select().from(agentKeyEvents);
      expect(events.some((event) => event.type === "agent_key_rotated")).toBe(false);
    });

    it("keeps each key's expiry independent of the other key's deadline", async () => {
      const app = await makeApp();
      await bootstrapAdmin(app);
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const workspace = await personalWorkspaceOf(admin.id);
      const p = await project(workspace.id, "Timed rotation", admin.id);
      const agentId = await makeAgent(app, cookie, "expiry-bot");

      const source = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        validity: "7",
        projects: [{ projectId: p.id, level: "read" }],
      });
      await database.db
        .update(agentApiKeys)
        .set({ expiresAt: sql`now() + interval '2 seconds'` })
        .where(eq(agentApiKeys.id, source.key.id));
      const replacement = await rotate(app, cookie, source.key.id, { validity: "90" });
      expect(replacement.key.validity).toBe("90");
      const [fresh] = await database.db
        .select({ expiresAt: agentApiKeys.expiresAt })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, replacement.key.id));
      if (fresh?.expiresAt === undefined || fresh.expiresAt === null)
        throw new Error("the replacement was not stored with an expiry");
      const days = (fresh.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(80);
      expect(days).toBeLessThanOrEqual(91);

      await database.db
        .update(agentApiKeys)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(agentApiKeys.id, source.key.id));
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, source.secret),
        401,
        "key_expired",
      );
      expect((await getJson(app, "/api/agents/me", undefined, replacement.secret)).status).toBe(
        200,
      );

      const never = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        validity: "never",
        projects: [{ projectId: p.id, level: "read" }],
      });
      const short = await rotate(app, cookie, never.key.id, { validity: "7" });
      expect(short.key.expiresAt).not.toBeNull();
      await database.db
        .update(agentApiKeys)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(agentApiKeys.id, short.key.id));
      await expectProblem(
        await getJson(app, "/api/agents/me", undefined, short.secret),
        401,
        "key_expired",
      );
      expect((await getJson(app, "/api/agents/me", undefined, never.secret)).status).toBe(200);
    });

    it("re-caps preserved grants by current human access and validates explicit grants", async () => {
      const app = await makeApp();
      await bootstrapAdmin(app);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const team = await sharedWorkspace("Rotation team", admin.id);
      const member = await insertHuman(MEMBER_EMAIL);
      const memberCookie = await createSession(member.id);
      await membership(team.id, member.id);
      const p = await project(team.id, "Team project", admin.id);
      await grant(p.id, member.id, "contribute");
      const agentId = await makeAgent(app, memberCookie, "member-rotator");
      const source = await issueKey(app, memberCookie, {
        agentId,
        workspaceId: team.id,
        validity: "30",
        projects: [{ projectId: p.id, level: "contribute" }],
      });

      await setGrant(p.id, member.id, "read");
      const capped = await rotate(app, memberCookie, source.key.id);
      expect(capped.key.projects).toMatchObject([{ projectId: p.id, level: "read" }]);
      expect((await identityFor(app, capped.secret)).projects).toMatchObject([
        { projectId: p.id, level: "read" },
      ]);

      await expectProblem(
        await postJson(
          app,
          `/api/agents/keys/${source.key.id}/rotate`,
          { projects: [{ projectId: p.id, level: "contribute" }] },
          memberCookie,
        ),
        400,
        "invalid_key_grant",
      );
      const other = await sharedWorkspace("Other rotation team", admin.id);
      const outside = await project(other.id, "Outside", admin.id);
      await expectProblem(
        await postJson(
          app,
          `/api/agents/keys/${source.key.id}/rotate`,
          { projects: [{ projectId: outside.id, level: "read" }] },
          memberCookie,
        ),
        400,
        "invalid_key_grant",
      );
      const explicit = await rotate(app, memberCookie, source.key.id, {
        projects: [{ projectId: p.id, level: "read" }],
      });
      expect(explicit.key.projects).toMatchObject([{ projectId: p.id, level: "read" }]);

      await removeGrant(p.id, member.id);
      const none = await rotate(app, memberCookie, source.key.id);
      expect(none.key.projects).toEqual([]);
    });

    it("refuses duplicate project grants when rotating a key", async () => {
      const app = await makeApp();
      await bootstrapAdmin(app);
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const workspace = await personalWorkspaceOf(admin.id);
      const p = await project(workspace.id, "Duplicate rotation project", admin.id);
      const agentId = await makeAgent(app, cookie, "duplicate-rotation-bot");
      const source = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId: p.id, level: "read" }],
      });

      const res = await postJson(
        app,
        `/api/agents/keys/${source.key.id}/rotate`,
        {
          projects: [
            { projectId: p.id, level: "read" },
            { projectId: p.id, level: "manage" },
          ],
        },
        cookie,
      );
      await expectProblem(res, 400, "validation_failed");
      expect(await database.db.select().from(agentApiKeys)).toHaveLength(1);
      expect(await database.db.select().from(agentApiKeyProjects)).toHaveLength(1);
    });

    it("refuses a revoked, expired, foreign, or inaccessible key and mints no replacement", async () => {
      const app = await makeApp();
      await bootstrapAdmin(app);
      const adminCookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const workspace = await personalWorkspaceOf(admin.id);
      const p = await project(workspace.id, "Refusal project", admin.id);
      const agentId = await makeAgent(app, adminCookie, "refusal-bot");
      const source = await issueKey(app, adminCookie, {
        agentId,
        workspaceId: workspace.id,
        validity: "7",
        projects: [{ projectId: p.id, level: "read" }],
      });
      expect(
        (await deleteRequest(app, `/api/agents/keys/${source.key.id}`, adminCookie)).status,
      ).toBe(204);
      await expectProblem(
        await postJson(app, `/api/agents/keys/${source.key.id}/rotate`, {}, adminCookie),
        409,
        "source_key_revoked",
      );

      const expiring = await issueKey(app, adminCookie, {
        agentId,
        workspaceId: workspace.id,
        validity: "7",
        projects: [{ projectId: p.id, level: "read" }],
      });
      await database.db
        .update(agentApiKeys)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(agentApiKeys.id, expiring.key.id));
      await expectProblem(
        await postJson(app, `/api/agents/keys/${expiring.key.id}/rotate`, {}, adminCookie),
        409,
        "source_key_expired",
      );

      const team = await sharedWorkspace("Foreign rotation team", admin.id);
      const teamProject = await project(team.id, "Team", admin.id);
      const member = await insertHuman(MEMBER_EMAIL);
      const memberCookie = await createSession(member.id);
      await membership(team.id, member.id);
      await grant(teamProject.id, member.id, "read");
      const memberAgent = await makeAgent(app, memberCookie, "member-bot");
      const foreign = await issueKey(app, memberCookie, {
        agentId: memberAgent,
        workspaceId: team.id,
        projects: [{ projectId: teamProject.id, level: "read" }],
      });
      await expectProblem(
        await postJson(app, `/api/agents/keys/${foreign.key.id}/rotate`, {}, adminCookie),
        404,
        "key_not_found",
      );

      await removeMembership(team.id, member.id);
      await expectProblem(
        await postJson(app, `/api/agents/keys/${foreign.key.id}/rotate`, {}, memberCookie),
        404,
        "workspace_not_found",
      );

      expect(await database.db.select().from(agentApiKeys)).toHaveLength(3);
      const events = await database.db.select().from(agentKeyEvents);
      expect(events).toHaveLength(4);
      expect(events.some((event) => event.type === "agent_key_rotated")).toBe(false);
    });

    it("keeps both keys working through a password reset and surfaces the rotation in history", async () => {
      const { app, resetPassword } = await makeRotationApp();
      await bootstrapAdmin(app);
      const cookie = await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
      if (admin === undefined) throw new Error("the admin was not found");
      const workspace = await personalWorkspaceOf(admin.id);
      const p = await project(workspace.id, "Audit project", admin.id);

      await database.db
        .update(humans)
        .set({ emailVerifiedAt: sql`now()` })
        .where(eq(humans.id, admin.id));
      const agentId = await makeAgent(app, cookie, "reset-bot");
      const source = await issueKey(app, cookie, {
        agentId,
        workspaceId: workspace.id,
        validity: "7",
        projects: [{ projectId: p.id, level: "read" }],
      });
      const replacement = await rotate(app, cookie, source.key.id);

      await resetPassword(ADMIN_EMAIL, "a-brand-new-password");
      expect((await getJson(app, "/api/agents/keys", cookie)).status).toBe(401);
      expect(await identityFor(app, source.secret)).toMatchObject({ agentId });
      expect(await identityFor(app, replacement.secret)).toMatchObject({ agentId });
      const newCookie = await cookieFor(app, ADMIN_EMAIL, "a-brand-new-password");

      const history = await getJson(app, `/api/workspaces/${workspace.id}/history`, newCookie);
      expect(history.status).toBe(200);
      const historyBody = await history.json();
      const historyText = JSON.stringify(historyBody);
      expect(historyText).toContain("agent_key_rotated");
      expect(historyText).not.toContain(source.secret);
      expect(historyText).not.toContain(replacement.secret);
      const events = Array.isArray(historyBody) ? historyBody : [];
      expect(events.find((event) => field(event, "type") === "agent_key_rotated")).toMatchObject({
        kind: "agent_key",
        subject: { agentId, agentName: "reset-bot" },
      });
    });
  });
});

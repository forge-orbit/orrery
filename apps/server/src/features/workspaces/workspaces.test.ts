import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Agent,
  CreateAgentKeyResponse,
  InvitationSummaries,
  InvitationSummary,
  Problem,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitationPreview,
  WorkspaceMember,
  WorkspaceMembersResponse,
  WorkspacesResponse,
  type ProjectAccessLevel,
  type SmtpSettings,
} from "@orrery/contract";
import type { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAgentsFeature, revokeMemberWorkspaceKeys } from "../agents/index.ts";
import { createInvitationsFeature } from "../invitations/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createSettingsFeature } from "../settings/index.ts";
import {
  agentApiKeys,
  agentKeyEvents,
  browserSessions,
  humans,
  projectAccessGrants,
  projects,
  workspaceEvents,
  invitations,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createWorkspacesFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const INVITEE_INPUT = "  Member@Example.COM ";
const INVITEE = "member@example.com";
const SMTP: SmtpSettings = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: null,
  password: null,
  from: "orrery@example.test",
};

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const putJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const patchJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const postEmpty = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "POST", ...(cookie ? { headers: { cookie } } : {}) });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

const tokenFrom = (text: string, path = "workspace-invitation") =>
  text.match(new RegExp(`/${path}\\?token=([A-Za-z0-9_-]+)`))?.[1];

async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: EMAIL,
    password: PASSWORD,
  });
  expect(res.status).toBe(201);
}

async function cookieFor(app: Hono, email: string, password: string) {
  const res = await postJson(app, "/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  return cookie;
}

async function saveSmtp(app: Hono, cookie: string) {
  const res = await putJson(app, "/api/settings/smtp", SMTP, cookie);
  expect(res.status).toBe(200);
}

async function verifiedCookie(app: Hono, email: string) {
  const [human] = await insertHuman({ email, verified: true });
  return { human, cookie: await sessionFor(app, human.id) };
}

async function insertHuman(input: { email: string; verified: boolean }) {
  const database = currentDatabase();
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),

      email: input.email.trim().toLowerCase(),
      passwordHash: "scrypt$anything",
      ...(input.verified ? { emailVerifiedAt: sql`now()` } : {}),
    })
    .returning();
  if (human === undefined) throw new Error("the account was not created");
  return [human] as const;
}

let databaseForHelpers: Database;
const currentDatabase = () => databaseForHelpers;

async function sessionFor(app: Hono, humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await currentDatabase()
    .db.insert(browserSessions)
    .values({
      id: randomUUID(),
      humanId,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
  return `orrery_session=${token}`;
}

async function verifyHuman(humanId: string) {
  await currentDatabase()
    .db.update(humans)
    .set({ emailVerifiedAt: sql`now()` })
    .where(eq(humans.id, humanId));
}

function createGate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    opened,
    release: () => release(),
  };
}

async function waitForLockWait(pattern: string) {
  await expect
    .poll(
      async () => {
        const [row] = await currentDatabase().sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike ${`%${pattern}%`}
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThan(0);
}

async function workspaceInviteToken(
  sent: { to: string; text: string }[],
  email: string,
  name: string,
) {
  const mail = sent.find(
    (candidate) => candidate.to === email && candidate.text.includes(`"${name}"`),
  );
  const token = mail === undefined ? undefined : tokenFrom(mail.text);
  if (token === undefined) throw new Error("the workspace invitation email carried no token");
  return token;
}

async function createWorkspace(app: Hono, cookie: string, name = "Rocket Team") {
  const res = await postJson(app, "/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  return Workspace.parse(await res.json());
}

async function assertForbidden(res: Response | Promise<Response>) {
  expect((await res).status).toBe(403);
}

async function invite(
  app: Hono,
  cookie: string,
  workspaceId: string,
  email: string,
  projectGrants: { projectId: string; level: ProjectAccessLevel }[] = [],
) {
  const res = await postJson(
    app,
    `/api/workspaces/${workspaceId}/invitations`,
    { email, projectGrants },
    cookie,
  );
  expect(res.status).toBe(201);
  return WorkspaceInvitation.parse(await res.json());
}

async function createProjectDirect(workspaceId: string, humanId: string, name = "Rocket Project") {
  const id = randomUUID();
  await currentDatabase()
    .db.insert(projects)
    .values({
      id,
      workspaceId,
      name,
      key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
      createdByHumanId: humanId,
    });
  return id;
}

async function invitationList(app: Hono, cookie: string, workspaceId: string) {
  const res = await getJson(app, `/api/workspaces/${workspaceId}/invitations`, cookie);
  expect(res.status).toBe(200);
  return InvitationSummaries.parse(await res.json());
}

async function listing(app: Hono, cookie: string) {
  const res = await getJson(app, "/api/workspaces", cookie);
  expect(res.status).toBe(200);
  return WorkspacesResponse.parse(await res.json());
}

describe("workspaces", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    databaseForHelpers = database;
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  afterEach(async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from agent_key_events`);
      await tx.execute(sql`delete from agent_api_key_projects`);
      await tx.execute(sql`delete from agent_api_keys`);
      await tx.execute(sql`delete from agents`);
      await tx.execute(sql`delete from project_access_events`);
      await tx.execute(sql`delete from project_access_grants`);
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from knowledge_entries`);
      await tx.execute(sql`delete from issue_comments`);
      await tx.execute(sql`delete from issues`);
      await tx.execute(sql`delete from workspace_events`);
      await tx.execute(sql`delete from workspace_invitation_grants`);
      await tx.execute(sql`delete from workspace_invitations`);
      await tx.execute(sql`delete from projects`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from invitations`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from instance_settings`);
      await tx.execute(sql`delete from email_verification_tokens`);
      await tx.execute(sql`delete from humans`);
    });
  });

  function makeApp() {
    const sent: { to: string; subject: string; text: string }[] = [];
    let deliveryFailure: (() => Error) | undefined;
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const settings = createSettingsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      encryptionKey: undefined,
      sessionReader: accounts.sessionReader,
      markEmailVerified: accounts.markEmailVerified,
      sendMail: async (_settings, mail) => {
        sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
        if (deliveryFailure !== undefined) throw deliveryFailure();
      },
      log: silentLogger,
    });
    const invitationsFeature = createInvitationsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      emailRegistered: accounts.emailRegistered,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log: silentLogger,
    });
    const projectsFeature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async () => null,
      sessionGate: async () => true,
    });
    const workspacesFeature = createWorkspacesFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,

      revokeMemberProjectAccess: async () => {},
      revokeMemberWorkspaceKeys: async () => {},
      releaseMemberWorkSessions: async () => {},
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projectsFeature.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
      log: silentLogger,
    });
    const app = createApp({
      features: [accounts, settings, invitationsFeature, projectsFeature, workspacesFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    return {
      app,
      sent,
      failDelivery(errorFactory: () => Error) {
        deliveryFailure = errorFactory;
      },
      repairDelivery() {
        deliveryFailure = undefined;
      },
    };
  }

  async function readyApp() {
    const made = makeApp();
    await bootstrapAdmin(made.app);
    await saveSmtp(made.app, await cookieFor(made.app, EMAIL, PASSWORD));
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");
    await verifyHuman(admin.id);
    return { ...made, admin, adminCookie: await cookieFor(made.app, EMAIL, PASSWORD) };
  }

  function makeAgentsApp() {
    const sent: { to: string; subject: string; text: string }[] = [];
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const settings = createSettingsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      encryptionKey: undefined,
      sessionReader: accounts.sessionReader,
      markEmailVerified: accounts.markEmailVerified,
      sendMail: async (_settings, mail) => {
        sent.push({ to: mail.to, subject: mail.subject, text: mail.text });
      },
      log: silentLogger,
    });
    const invitationsFeature = createInvitationsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      emailRegistered: accounts.emailRegistered,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log: silentLogger,
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
    const workspacesFeature = createWorkspacesFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      revokeMemberProjectAccess: (tx, workspaceId, humanId, actorHumanId) =>
        projectsFeature.revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId),
      revokeMemberWorkspaceKeys: (tx, workspaceId, humanId, actorHumanId) =>
        revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId),
      releaseMemberWorkSessions: async () => {},
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projectsFeature.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
      log: silentLogger,
    });
    const app = createApp({
      features: [
        accounts,
        settings,
        invitationsFeature,
        projectsFeature,
        workspacesFeature,
        agentsFeature,
      ],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    return { app, sent };
  }

  async function readyAgentsApp() {
    const made = makeAgentsApp();
    await bootstrapAdmin(made.app);
    await saveSmtp(made.app, await cookieFor(made.app, EMAIL, PASSWORD));
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");
    await verifyHuman(admin.id);
    return { ...made, admin, adminCookie: await cookieFor(made.app, EMAIL, PASSWORD) };
  }

  async function directSharedWorkspace(ownerIds: readonly string[], name = "Direct Team") {
    const workspaceId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id: workspaceId, kind: "shared", name });
      for (const humanId of ownerIds) {
        await tx.insert(workspaceMemberships).values({
          id: randomUUID(),
          workspaceId,
          humanId,
          isOwner: true,
        });
      }
    });
    return workspaceId;
  }

  async function eventsFor(workspaceId: string) {
    return database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, workspaceId))
      .orderBy(workspaceEvents.createdAt, workspaceEvents.id);
  }

  it("refuses every workspace operation without a signed-in account", async () => {
    const { app } = makeApp();
    await bootstrapAdmin(app);
    const workspace = await createWorkspace(app, await cookieFor(app, EMAIL, PASSWORD));

    const attempts = [
      await getJson(app, "/api/workspaces"),
      await getJson(app, `/api/workspaces/${workspace.id}`),
      await postJson(app, "/api/workspaces", { name: "Nope" }),
      await postJson(app, `/api/workspaces/${workspace.id}/invitations`, { email: INVITEE }),
      await postJson(app, "/api/workspace-invitations/acceptance", { token: "x" }),
      await postJson(app, `/api/workspaces/${workspace.id}/owners`, { humanId: "x" }),
      await deleteRequest(app, `/api/workspaces/${workspace.id}/members/x`),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
    }
  });

  it("creates a shared workspace with the creator as owner, and records the event", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const created = await createWorkspace(app, adminCookie, "  Rocket Team  ");
    expect(created).toMatchObject({
      kind: "shared",
      name: "Rocket Team",
      isOwner: true,
    });

    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, created.id));
    expect(membership).toMatchObject({ humanId: admin.id, isOwner: true });

    const events = await eventsFor(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "workspace_created",
      actorHumanId: admin.id,
      subjectHumanId: admin.id,
    });

    const workspacesList = await listing(app, adminCookie);
    expect(workspacesList.filter((workspace) => workspace.kind === "personal")).toHaveLength(1);
    expect(workspacesList.filter((workspace) => workspace.kind === "shared")).toEqual([created]);

    const detail = await getJson(app, `/api/workspaces/${created.id}`, adminCookie);
    expect(detail.status).toBe(200);
    expect(Workspace.parse(await detail.json())).toEqual(created);

    const members = await getJson(app, `/api/workspaces/${created.id}/members`, adminCookie);
    expect(members.status).toBe(200);
    expect(WorkspaceMembersResponse.parse(await members.json())).toEqual([
      {
        humanId: admin.id,
        email: EMAIL,
        displayName: null,
        avatarUrl: null,
        isOwner: true,
        canCreateProjects: true,
        canInviteMembers: true,
        canRemoveMembers: true,
        canManageMemberPermissions: true,
      },
    ]);

    const { cookie: otherCookie } = await verifiedCookie(app, "outsider@example.com");
    expect((await listing(app, otherCookie)).map((workspace) => workspace.id)).not.toContain(
      created.id,
    );
    const hidden = await getJson(app, `/api/workspaces/${created.id}`, otherCookie);
    expect(hidden.status).toBe(404);
    expect(await problemBody(hidden)).toMatchObject({ code: "workspace_not_found" });
    const hiddenMembers = await getJson(app, `/api/workspaces/${created.id}/members`, otherCookie);
    expect(hiddenMembers.status).toBe(404);
    expect(await problemBody(hiddenMembers)).toMatchObject({ code: "workspace_not_found" });
  });

  it("requires a verified owner to invite", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);

    await database.db.update(humans).set({ emailVerifiedAt: null }).where(eq(humans.id, admin.id));
    const unverified = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      adminCookie,
    );
    expect(unverified.status).toBe(403);
    expect(await problemBody(unverified)).toMatchObject({ code: "inviter_unverified" });
    expect(await database.db.select().from(workspaceInvitations)).toHaveLength(0);

    const { cookie: outsiderCookie } = await verifiedCookie(app, "outsider@example.com");
    await verifyHuman(admin.id);
    const outsider = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      outsiderCookie,
    );
    expect(outsider.status).toBe(404);
    expect(await problemBody(outsider)).toMatchObject({ code: "workspace_not_found" });
  });

  it("lets an existing verified account accept, matching normalized emails on both sides", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, "Member@Example.COM");

    const invitation = await invite(app, adminCookie, workspace.id, "  MEMBER@example.com ");
    expect(invitation).toEqual({
      workspaceId: workspace.id,
      email: "member@example.com",
      status: "pending",
    });
    const token = await workspaceInviteToken(sent, "member@example.com", "Rocket Team");

    const forwardedPreview = await getJson(
      app,
      `/api/workspace-invitations/preview?token=${token}`,
    );
    expect(forwardedPreview.status).toBe(200);
    expect(WorkspaceInvitationPreview.parse(await forwardedPreview.json())).toEqual({
      workspaceId: workspace.id,
      workspaceName: "Rocket Team",
      email: "member@example.com",
      invitedByEmail: EMAIL,
      accountExists: true,
      grants: [
        {
          kind: "workspace_membership",
          workspaceId: workspace.id,
          role: "member",
        },
      ],
      expiresAt: expect.any(String),
    });
    const forwarded = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      adminCookie,
    );
    expect(forwarded.status).toBe(403);
    expect(await problemBody(forwarded)).toMatchObject({
      code: "invitation_recipient_mismatch",
    });
    const [stillPending] = await database.db.select().from(workspaceInvitations);
    expect(stillPending).toMatchObject({ status: "pending", acceptedAt: null });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(accepted.status).toBe(200);
    expect(Workspace.parse(await accepted.json())).toEqual({
      id: workspace.id,
      kind: "shared",
      name: "Rocket Team",
      isOwner: false,
      canCreateProjects: false,
      canInviteMembers: false,
      canRemoveMembers: false,
      canManageMemberPermissions: false,
    });
    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, member.id));
    expect(membership).toMatchObject({ workspaceId: workspace.id, isOwner: false });
    const [acceptedRow] = await database.db.select().from(workspaceInvitations);
    expect(acceptedRow).toMatchObject({ status: "accepted", email: "member@example.com" });
    expect(acceptedRow?.acceptedAt).not.toBeNull();
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "member_joined",
    ]);
    expect((await listing(app, memberCookie)).map((item) => item.id)).toContain(workspace.id);

    const reused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(reused.status).toBe(400);
    expect(await problemBody(reused)).toMatchObject({ code: "invitation_invalid" });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(2);
  });

  it("refuses an unverified matching account until its email is verified", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [unverified] = await insertHuman({ email: INVITEE, verified: false });
    const unverifiedCookie = await sessionFor(app, unverified.id);

    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      unverifiedCookie,
    );
    expect(refused.status).toBe(403);
    expect(await problemBody(refused)).toMatchObject({ code: "email_unverified" });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    await verifyHuman(unverified.id);
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      unverifiedCookie,
    );
    expect(accepted.status).toBe(200);
  });

  it("registers a new email with its account, personal workspace, membership, and verified mark in one flow", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, "  New.Member@Example.COM ");
    const token = await workspaceInviteToken(sent, "new.member@example.com", "Rocket Team");

    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${token}`);
    expect(preview.status).toBe(200);
    expect(WorkspaceInvitationPreview.parse(await preview.json())).toEqual({
      workspaceId: workspace.id,
      workspaceName: "Rocket Team",
      email: "new.member@example.com",
      invitedByEmail: EMAIL,
      accountExists: false,
      grants: [
        {
          kind: "workspace_membership",
          workspaceId: workspace.id,
          role: "member",
        },
      ],
      expiresAt: expect.any(String),
    });

    expect(await database.db.select().from(humans)).toHaveLength(1);
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    const registered = await postJson(app, "/api/workspace-invitations/registration", {
      token,
      password: "new-member-password",
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({
      email: "new.member@example.com",
      handle: "new-member",
      displayName: null,
      emailVerified: true,
      avatarUrl: null,
    });

    const [human] = await database.db
      .select()
      .from(humans)
      .where(eq(humans.email, "new.member@example.com"));
    expect(human).toMatchObject({ isSystemAdministrator: false });
    expect(human?.emailVerifiedAt).not.toBeNull();
    expect(human?.passwordHash).toMatch(/^scrypt\$/);
    expect(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, human?.id ?? "")),
    ).toHaveLength(1);
    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, human?.id ?? ""));
    expect(membership).toMatchObject({ workspaceId: workspace.id, isOwner: false });
    const [invitation] = await database.db.select().from(workspaceInvitations);
    expect(invitation).toMatchObject({ status: "accepted" });
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "member_joined",
    ]);

    const login = await postJson(app, "/api/auth/login", {
      email: "new.member@example.com",
      password: "new-member-password",
    });
    expect(login.status).toBe(200);
    const newCookie = await cookieFor(app, "new.member@example.com", "new-member-password");
    const workspacesList = await listing(app, newCookie);
    expect(workspacesList.map((item) => item.kind).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "personal",
      "shared",
    ]);

    const [other] = await insertHuman({ email: "pending@example.com", verified: false });
    await invite(app, adminCookie, workspace.id, "pending@example.com");
    const pendingToken = await workspaceInviteToken(sent, "pending@example.com", "Rocket Team");
    await verifyHuman(other.id);
    const existing = await postJson(app, "/api/workspace-invitations/registration", {
      token: pendingToken,
      password: "existing-password",
    });
    expect(existing.status).toBe(409);
    expect(await problemBody(existing)).toMatchObject({ code: "account_exists" });
    const pendingRow = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, tokenHash(pendingToken)));
    expect(pendingRow[0]).toMatchObject({ status: "pending", acceptedAt: null });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, other.id)),
    ).toHaveLength(0);
  });

  it("appoints another owner and lets any owner appoint, while non-owners are refused", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    expect(
      (await postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie))
        .status,
    ).toBe(200);

    const memberAttempt = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: member.id },
      memberCookie,
    );
    expect(memberAttempt.status).toBe(403);
    expect(await problemBody(memberAttempt)).toMatchObject({ code: "not_workspace_owner" });

    const appointed = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: member.id },
      adminCookie,
    );
    expect(appointed.status).toBe(200);
    expect(WorkspaceMember.parse(await appointed.json())).toEqual({
      humanId: member.id,
      email: INVITEE,
      displayName: null,
      avatarUrl: null,
      isOwner: true,
      canCreateProjects: true,
      canInviteMembers: true,
      canRemoveMembers: true,
      canManageMemberPermissions: true,
    });
    const [membership] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, member.id));
    expect(membership?.isOwner).toBe(true);
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "member_joined",
      "owner_appointed",
    ]);
    expect(
      (await listing(app, memberCookie)).find((item) => item.id === workspace.id)?.isOwner,
    ).toBe(true);

    const again = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: member.id },
      adminCookie,
    );
    expect(again.status).toBe(200);
    expect(
      (await eventsFor(workspace.id)).filter((event) => event.type === "owner_appointed"),
    ).toHaveLength(1);
    const missing = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: randomUUID() },
      adminCookie,
    );
    expect(missing.status).toBe(404);
    expect(await problemBody(missing)).toMatchObject({ code: "member_not_found" });
  });

  it("protects the last owner, and a shared workspace survives one of two owners leaving", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);

    const lastOwner = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${admin.id}`,
      adminCookie,
    );
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.headers.get("content-type")).toBe("application/problem+json");
    expect(await problemBody(lastOwner)).toMatchObject({ status: 409, code: "last_owner" });
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
    ]);

    const rejected = await database.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id))
      .then(
        () => {
          throw new Error("expected the last owner to be protected");
        },
        (cause: unknown) => cause,
      );
    expect(rootCause(rejected)?.message ?? String(rejected)).toContain(
      "must keep at least one owner",
    );
    expect(await database.db.select().from(workspaceMemberships)).toHaveLength(1);

    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: second.id,
      isOwner: true,
    });
    const removed = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${second.id}`,
      adminCookie,
    );
    expect(removed.status).toBe(204);
    const remaining = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ humanId: admin.id, isOwner: true });
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual([
      "workspace_created",
      "owner_removed",
    ]);
  });

  it("settles two owners removing each other with exactly one winner and one owner left", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: second.id,
      isOwner: true,
    });
    const secondCookie = await sessionFor(app, second.id);

    const [first, other] = await Promise.all([
      deleteRequest(app, `/api/workspaces/${workspace.id}/members/${second.id}`, adminCookie),
      deleteRequest(app, `/api/workspaces/${workspace.id}/members/${admin.id}`, secondCookie),
    ]);
    expect([first.status, other.status].toSorted((a, b) => a - b)).toEqual([204, 404]);

    const remaining = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.isOwner).toBe(true);
    expect(
      (await eventsFor(workspace.id)).filter((event) => event.type === "owner_removed"),
    ).toHaveLength(1);
  });

  it("answers invalid path ids with validation Problems", async () => {
    const { app, adminCookie } = await readyApp();
    const tooLong = "a".repeat(201);
    const attempts = [
      await getJson(app, `/api/workspaces/${tooLong}`, adminCookie),
      await getJson(app, `/api/workspaces/${tooLong}/members`, adminCookie),
      await deleteRequest(app, `/api/workspaces/${tooLong}/members/x`, adminCookie),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });
    }
  });

  it("refuses acceptance after the inviter loses authority, and leaves the token pending", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    const [second] = await insertHuman({ email: "replacement.owner@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: second.id,
      isOwner: true,
    });
    expect(
      (await deleteRequest(app, `/api/workspaces/${workspace.id}/members/${admin.id}`, adminCookie))
        .status,
    ).toBe(204);

    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(refused.status).toBe(403);
    expect(await problemBody(refused)).toMatchObject({ code: "inviter_not_authorized" });
    const [row] = await database.db.select().from(workspaceInvitations);
    expect(row).toMatchObject({ status: "pending", acceptedAt: null });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, member.id)),
    ).toHaveLength(0);
  });

  it("settles concurrent redemptions of one workspace token with one membership and one winner", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    const results = await Promise.all([
      postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie),
      postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie),
    ]);
    expect(results.map((res) => res.status).toSorted((a, b) => a - b)).toEqual([200, 400]);
    const memberships = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, member.id));
    expect(memberships).toHaveLength(1);
    expect(
      (await eventsFor(workspace.id)).filter((event) => event.type === "member_joined"),
    ).toHaveLength(1);
    const [row] = await database.db.select().from(workspaceInvitations);
    expect(row).toMatchObject({ status: "accepted" });
  });

  it("serializes an expired-token acceptance against its replacement", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const staleToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.workspaceId, workspace.id));

    const [accept, replacement] = await Promise.all([
      postJson(app, "/api/workspace-invitations/acceptance", { token: staleToken }, memberCookie),
      postJson(app, `/api/workspaces/${workspace.id}/invitations`, { email: INVITEE }, adminCookie),
    ]);
    expect(accept.status).toBe(400);
    expect(await problemBody(accept)).toMatchObject({ code: "invitation_invalid" });
    expect(replacement.status).toBe(201);

    const rows = await database.db.select().from(workspaceInvitations);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "expired")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id)),
    ).toHaveLength(1);
  });

  it("supersedes a failed workspace invitation in place instead of locking the email out for seven days", async () => {
    const made = await readyApp();
    const { app, sent, adminCookie } = made;
    const workspace = await createWorkspace(app, adminCookie);
    made.failDelivery(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));

    const failed = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      { email: INVITEE_INPUT },
      adminCookie,
    );
    expect(failed.status).toBe(502);
    expect(await problemBody(failed)).toMatchObject({ code: "smtp_unreachable" });
    const [row] = await database.db.select().from(workspaceInvitations);
    expect(row).toMatchObject({ status: "pending", deliveryStatus: "failed" });
    expect(row?.acceptedAt).toBeNull();
    expect((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );

    const token = tokenFrom(sent[0]?.text ?? "") ?? "";
    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${token}`);
    expect(preview.status).toBe(400);
    expect(await problemBody(preview)).toMatchObject({ code: "invitation_invalid" });

    const decline = await postJson(app, "/api/workspace-invitations/decline", { token });
    expect(decline.status).toBe(400);
    expect(await problemBody(decline)).toMatchObject({ code: "invitation_invalid" });
    const [stillPending] = await database.db.select().from(workspaceInvitations);
    expect(stillPending).toMatchObject({ status: "pending", declinedAt: null });

    made.repairDelivery();
    const replacement = await invite(app, adminCookie, workspace.id, INVITEE);
    expect(replacement.status).toBe("pending");
    const rows = await database.db.select().from(workspaceInvitations);
    expect(rows).toHaveLength(2);
    const revoked = rows.find((candidate) => candidate.status === "revoked");
    expect(revoked).toMatchObject({ id: row?.id, expiredAt: null, deliveryStatus: "failed" });
    if (revoked?.revokedAt == null) throw new Error("replacement did not record revocation");
    expect(revoked.revokedAt.getTime()).toBeLessThan(revoked.expiresAt.getTime());
    expect(rows.filter((candidate) => candidate.status === "pending")).toHaveLength(1);
  });

  it("lists every workspace invitation for an owner, with scope and delivery separate", async () => {
    const { app, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const other = randomUUID();
    await database.db.insert(workspaceInvitations).values([
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "pending@example.com",
        status: "pending",
        tokenHash: tokenHash("workspace-list-pending"),
        invitedByHumanId: admin.id,
        createdAt: sql`now() - interval '1 hour'`,
        expiresAt: sql`now() + interval '1 day'`,
        deliveryStatus: "sent",
        deliveryAttemptedAt: sql`now() - interval '1 minute'`,
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "accepted@example.com",
        status: "accepted",
        tokenHash: tokenHash("workspace-list-accepted"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 day'`,
        acceptedAt: sql`now() - interval '1 minute'`,
        deliveryStatus: "sent",
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "declined@example.com",
        status: "declined",
        tokenHash: tokenHash("workspace-list-declined"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 day'`,
        declinedAt: sql`now() - interval '1 minute'`,
        deliveryStatus: "sent",
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "expired@example.com",
        status: "expired",
        tokenHash: tokenHash("workspace-list-expired"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() - interval '1 day'`,
        expiredAt: sql`now() - interval '1 day'`,
        deliveryStatus: "sent",
      },
      {
        id: randomUUID(),
        workspaceId: workspace.id,
        email: "revoked@example.com",
        status: "revoked",
        tokenHash: tokenHash("workspace-list-revoked"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 day'`,
        revokedAt: sql`now() - interval '1 minute'`,
        deliveryStatus: "failed",
        deliveryAttemptedAt: sql`now() - interval '2 minutes'`,
      },
    ]);

    const listed = await invitationList(app, adminCookie, workspace.id);
    expect(listed).toHaveLength(5);
    const byEmail = new Map(listed.map((invitation) => [invitation.email, invitation]));
    for (const invitation of listed) {
      expect(invitation).toMatchObject({
        target: { kind: "workspace", id: workspace.id, name: "Rocket Team" },
        grants: [
          {
            kind: "workspace_membership",
            workspaceId: workspace.id,
            role: "member",
          },
        ],
        invitedBy: { humanId: admin.id, email: EMAIL },
      });
    }
    expect(byEmail.get("pending@example.com")).toMatchObject({
      status: "pending",
      delivery: { status: "sent", attemptedAt: expect.any(String) },
      acceptedAt: null,
      declinedAt: null,
      expiredAt: null,
      revokedAt: null,
    });
    expect(byEmail.get("accepted@example.com")).toMatchObject({
      status: "accepted",
      acceptedAt: expect.any(String),
    });
    expect(byEmail.get("declined@example.com")).toMatchObject({
      status: "declined",
      declinedAt: expect.any(String),
    });
    expect(byEmail.get("expired@example.com")).toMatchObject({
      status: "expired",
      expiredAt: expect.any(String),
    });
    expect(byEmail.get("revoked@example.com")).toMatchObject({
      status: "revoked",
      revokedAt: expect.any(String),
      delivery: { status: "failed", attemptedAt: expect.any(String) },
    });

    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: member.id,
      isOwner: false,
    });
    const forbidden = [
      await getJson(app, `/api/workspaces/${workspace.id}/invitations`, memberCookie),
      await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${other}/resend`,
        memberCookie,
      ),
      await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${other}/revoke`,
        memberCookie,
      ),
    ];
    for (const res of forbidden) {
      expect(res.status).toBe(403);
      expect(await problemBody(res)).toMatchObject({ code: "not_workspace_owner" });
    }
    const anonymous = await getJson(app, `/api/workspaces/${workspace.id}/invitations`);
    expect(anonymous.status).toBe(401);
  });

  it("lets the inviter revoke and the recipient decline, and both links stop working", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { human: member, cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const [pending] = await invitationList(app, adminCookie, workspace.id);
    if (pending === undefined) throw new Error("the invitation was not listed");

    const revoked = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${pending.id}/revoke`,
      adminCookie,
    );
    expect(revoked.status).toBe(200);
    expect(InvitationSummary.parse(await revoked.json())).toMatchObject({
      id: pending.id,
      status: "revoked",
      revokedAt: expect.any(String),
    });
    expect((await getJson(app, `/api/workspace-invitations/preview?token=${token}`)).status).toBe(
      400,
    );
    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(refused.status).toBe(400);
    expect(await problemBody(refused)).toMatchObject({ code: "invitation_invalid" });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, member.id)),
    ).toHaveLength(0);

    const declineEmail = "decline@example.com";
    await invite(app, adminCookie, workspace.id, declineEmail);
    const declineToken = await workspaceInviteToken(sent, declineEmail, "Rocket Team");
    const declined = await postJson(app, "/api/workspace-invitations/decline", {
      token: declineToken,
    });
    expect(declined.status).toBe(204);
    const again = await postJson(app, "/api/workspace-invitations/decline", {
      token: declineToken,
    });
    expect(again.status).toBe(400);
    expect(await problemBody(again)).toMatchObject({ code: "invitation_invalid" });
    expect(
      (await getJson(app, `/api/workspace-invitations/preview?token=${declineToken}`)).status,
    ).toBe(400);

    const history = await invitationList(app, adminCookie, workspace.id);
    expect(history.find((candidate) => candidate.id === pending.id)).toMatchObject({
      status: "revoked",
    });
    expect(history.find((candidate) => candidate.email === declineEmail)).toMatchObject({
      status: "declined",
      declinedAt: expect.any(String),
    });
  });

  it("refuses to resend an installation invitation after the recipient registered in a workspace", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const initial = await postJson(
      app,
      "/api/invitations/installation",
      { email: INVITEE },
      adminCookie,
    );
    expect(initial.status).toBe(201);
    const [old] = await database.db.select().from(invitations);
    if (old === undefined) throw new Error("installation invitation missing");
    await database.db
      .update(invitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(invitations.id, old.id));
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const registered = await postJson(app, "/api/workspace-invitations/registration", {
      token,
      password: "new-project-password",
    });
    expect(registered.status).toBe(200);
    const resend = await postEmpty(
      app,
      `/api/invitations/installation/${old.id}/resend`,
      adminCookie,
    );
    expect(resend.status).toBe(409);
    expect(await problemBody(resend)).toMatchObject({ code: "account_exists" });
    expect(await database.db.select().from(invitations)).toEqual([
      expect.objectContaining({ id: old.id, revokedAt: null }),
    ]);
    expect(sent.filter((mail) => mail.to === INVITEE)).toHaveLength(2);
  });

  it("refuses to resend an older workspace invitation after the recipient joins", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const [old] = await invitationList(app, adminCookie, workspace.id);
    if (old === undefined) throw new Error("workspace invitation missing");
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.id, old.id));
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = tokenFrom(sent.at(-1)?.text ?? "");
    const registered = await postJson(app, "/api/workspace-invitations/registration", {
      token,
      password: "new-project-password",
    });
    expect(registered.status).toBe(200);
    const resend = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${old.id}/resend`,
      adminCookie,
    );
    expect(resend.status).toBe(409);
    expect(await problemBody(resend)).toMatchObject({ code: "already_member" });
    const history = await invitationList(app, adminCookie, workspace.id);
    expect(history.map((row) => row.status)).toEqual(["accepted", "expired"]);
    expect(sent.filter((mail) => mail.to === INVITEE)).toHaveLength(2);
  });

  it("persists workspace expiry when revocation is refused", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const [old] = await invitationList(app, adminCookie, workspace.id);
    if (old === undefined) throw new Error("workspace invitation missing");
    const deadline = new Date(Date.now() - 1_000);
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: deadline })
      .where(eq(workspaceInvitations.id, old.id));
    const revoke = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${old.id}/revoke`,
      adminCookie,
    );
    expect(revoke.status).toBe(409);
    expect(await problemBody(revoke)).toMatchObject({ code: "invitation_not_pending" });
    const [row] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, old.id));
    expect(row).toMatchObject({ status: "expired", expiredAt: deadline, revokedAt: null });
  });

  it("refuses a resend from an unverified owner and keeps the original invitation valid", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [unverified] = await insertHuman({
      email: "unverified.owner@example.com",
      verified: false,
    });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: unverified.id,
      isOwner: true,
    });
    const unverifiedCookie = await sessionFor(app, unverified.id);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const [pending] = await invitationList(app, adminCookie, workspace.id);
    if (pending === undefined) throw new Error("the invitation was not listed");

    const refused = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${pending.id}/resend`,
      unverifiedCookie,
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toBe("application/problem+json");
    expect(await problemBody(refused)).toMatchObject({ code: "inviter_unverified" });

    const rows = await database.db.select().from(workspaceInvitations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pending.id,
      status: "pending",
      revokedAt: null,
      expiredAt: null,
    });
    expect(rows[0]?.expiresAt.toISOString()).toBe(pending.expiresAt);
    expect(sent).toHaveLength(1);
    expect((await getJson(app, `/api/workspace-invitations/preview?token=${token}`)).status).toBe(
      200,
    );

    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token },
      memberCookie,
    );
    expect(accepted.status).toBe(200);
    const [acceptedRow] = await database.db.select().from(workspaceInvitations);
    expect(acceptedRow).toMatchObject({ id: pending.id, status: "accepted" });
    expect(acceptedRow?.acceptedAt).not.toBeNull();
  });

  it("resends a workspace invitation: the old link dies, history stays, and the deadline is seven fresh days", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const oldToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const [oldInvitation] = await invitationList(app, adminCookie, workspace.id);
    if (oldInvitation === undefined) throw new Error("the invitation was not listed");

    const resend = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${oldInvitation.id}/resend`,
      adminCookie,
    );
    expect(resend.status).toBe(200);
    const fresh = InvitationSummary.parse(await resend.json());
    expect(fresh).toMatchObject({
      email: INVITEE,
      status: "pending",
      target: { kind: "workspace", id: workspace.id, name: "Rocket Team" },
      delivery: { status: "sent", attemptedAt: expect.any(String) },
      acceptedAt: null,
      declinedAt: null,
      expiredAt: null,
      revokedAt: null,
    });
    expect(fresh.id).not.toBe(oldInvitation.id);
    const [oldRow] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, oldInvitation.id));
    expect(oldRow).toMatchObject({ status: "revoked" });
    expect(oldRow?.revokedAt).not.toBeNull();
    const [freshRow] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, fresh.id));
    expect(freshRow?.expiresAt.getTime() ?? 0).toBe(
      (freshRow?.createdAt.getTime() ?? 0) + 7 * 24 * 60 * 60 * 1000,
    );
    expect(sent).toHaveLength(2);
    const newToken = tokenFrom(sent[1]?.text ?? "");
    expect(newToken).not.toBe(oldToken);

    expect(
      (await getJson(app, `/api/workspace-invitations/preview?token=${oldToken}`)).status,
    ).toBe(400);
    const oldAttempt = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: oldToken },
      memberCookie,
    );
    expect(oldAttempt.status).toBe(400);
    expect(
      (await getJson(app, `/api/workspace-invitations/preview?token=${newToken}`)).status,
    ).toBe(200);
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: newToken },
      memberCookie,
    );
    expect(accepted.status).toBe(200);

    const history = await invitationList(app, adminCookie, workspace.id);
    expect(history.find((candidate) => candidate.id === oldInvitation.id)).toMatchObject({
      status: "revoked",
    });
    expect(history.find((candidate) => candidate.id === fresh.id)).toMatchObject({
      status: "accepted",
    });
  });

  it("copies offered project grants to a resent invitation", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const projectId = await createProjectDirect(workspace.id, admin.id, "Resent Project");
    await invite(app, adminCookie, workspace.id, INVITEE, [{ projectId, level: "contribute" }]);
    const [oldInvitation] = await invitationList(app, adminCookie, workspace.id);
    if (oldInvitation === undefined) throw new Error("the invitation was not listed");
    const oldToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");

    const res = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${oldInvitation.id}/resend`,
      adminCookie,
    );
    expect(res.status).toBe(200);
    const fresh = InvitationSummary.parse(await res.json());
    expect(fresh.grants).toContainEqual({
      kind: "project_access",
      projectId,
      projectName: "Resent Project",
      level: "contribute",
    });

    expect(await database.db.select().from(workspaceInvitationGrants)).toHaveLength(2);
    const newToken = tokenFrom(sent.at(-1)?.text ?? "");
    expect(newToken).not.toBe(oldToken);
    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${newToken}`);
    expect(WorkspaceInvitationPreview.parse(await preview.json()).grants).toContainEqual({
      kind: "project_access",
      projectId,
      projectName: "Resent Project",
      level: "contribute",
    });
  });

  it("resends workspace invitations on both sides of the expiry boundary with a fresh seven-day deadline", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    for (const email of ["just-before@example.com", "just-after@example.com"]) {
      await invite(app, adminCookie, workspace.id, email);
    }
    const listed = await invitationList(app, adminCookie, workspace.id);
    const before = listed.find((candidate) => candidate.email === "just-before@example.com");
    const after = listed.find((candidate) => candidate.email === "just-after@example.com");
    if (before === undefined || after === undefined) throw new Error("invitations missing");
    const beforeToken = await workspaceInviteToken(sent, "just-before@example.com", "Rocket Team");
    const afterToken = await workspaceInviteToken(sent, "just-after@example.com", "Rocket Team");

    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() + interval '1 second'` })
      .where(eq(workspaceInvitations.id, before.id));
    await database.db
      .update(workspaceInvitations)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(workspaceInvitations.id, after.id));

    const resendBefore = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${before.id}/resend`,
      adminCookie,
    );
    expect(resendBefore.status).toBe(200);
    const freshBefore = InvitationSummary.parse(await resendBefore.json());
    const resendAfter = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${after.id}/resend`,
      adminCookie,
    );
    expect(resendAfter.status).toBe(200);
    const freshAfter = InvitationSummary.parse(await resendAfter.json());

    const rows = await database.db.select().from(workspaceInvitations);
    const oldBefore = rows.find((row) => row.id === before.id);
    const oldAfter = rows.find((row) => row.id === after.id);
    expect(oldBefore).toMatchObject({ status: "revoked" });
    expect(oldBefore?.revokedAt).not.toBeNull();
    expect(oldAfter).toMatchObject({ status: "expired" });
    expect(oldAfter?.expiredAt?.getTime()).toBe(oldAfter?.expiresAt.getTime());
    for (const fresh of [freshBefore, freshAfter]) {
      const row = rows.find((candidate) => candidate.id === fresh.id);
      expect(row?.expiresAt.getTime() ?? 0).toBe(
        (row?.createdAt.getTime() ?? 0) + 7 * 24 * 60 * 60 * 1000,
      );
      expect(fresh).toMatchObject({ status: "pending" });
    }

    for (const token of [beforeToken, afterToken]) {
      expect((await getJson(app, `/api/workspace-invitations/preview?token=${token}`)).status).toBe(
        400,
      );
    }
  });

  it("keeps a failed workspace resend delivery separate from the pending lifecycle", async () => {
    const made = await readyApp();
    const { app, sent, adminCookie } = made;
    const workspace = await createWorkspace(app, adminCookie);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const [invitation] = await invitationList(app, adminCookie, workspace.id);
    if (invitation === undefined) throw new Error("the invitation was not listed");

    made.failDelivery(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
    const failed = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${invitation.id}/resend`,
      adminCookie,
    );
    expect(failed.status).toBe(502);
    expect(await problemBody(failed)).toMatchObject({ code: "smtp_unreachable" });

    const after = await invitationList(app, adminCookie, workspace.id);
    expect(after).toHaveLength(2);
    const failedRow = after.find((candidate) => candidate.status === "pending");
    expect(failedRow).toMatchObject({
      status: "pending",
      delivery: { status: "failed", attemptedAt: expect.any(String) },
    });

    made.repairDelivery();
    if (failedRow === undefined) throw new Error("the replacement invitation is missing");
    const retried = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${failedRow.id}/resend`,
      adminCookie,
    );
    expect(retried.status).toBe(200);
    expect(InvitationSummary.parse(await retried.json())).toMatchObject({
      status: "pending",
      delivery: { status: "sent" },
    });
    expect(sent).toHaveLength(3);
  });

  it("refuses to resend or revoke a workspace invitation that is no longer pending or expired", async () => {
    const { app, sent, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE);
    const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    expect(
      (await postJson(app, "/api/workspace-invitations/acceptance", { token }, memberCookie))
        .status,
    ).toBe(200);
    const [invitation] = await invitationList(app, adminCookie, workspace.id);
    if (invitation === undefined) throw new Error("the invitation was not listed");

    for (const action of ["resend", "revoke"]) {
      const res = await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${invitation.id}/${action}`,
        adminCookie,
      );
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ code: "invitation_not_pending" });
    }
    const missing = await postEmpty(
      app,
      `/api/workspaces/${workspace.id}/invitations/${randomUUID()}/revoke`,
      adminCookie,
    );
    expect(missing.status).toBe(404);
    expect(await problemBody(missing)).toMatchObject({ code: "invitation_not_found" });
  });

  it("rejects duplicate project offers as request validation errors", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const projectId = await createProjectDirect(workspace.id, admin.id, "Offered Project");
    const response = await postJson(
      app,
      `/api/workspaces/${workspace.id}/invitations`,
      {
        email: INVITEE,
        projectGrants: [
          { projectId, level: "read" },
          { projectId, level: "manage" },
        ],
      },
      adminCookie,
    );
    expect(response.status).toBe(400);
    expect(await problemBody(response)).toMatchObject({ code: "validation_failed" });
    expect(await invitationList(app, adminCookie, workspace.id)).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("shows offered project access and applies it on both acceptance paths", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const projectId = await createProjectDirect(workspace.id, admin.id, "Offered Project");

    const { human: existing, cookie: existingCookie } = await verifiedCookie(app, INVITEE);
    await invite(app, adminCookie, workspace.id, INVITEE, [{ projectId, level: "contribute" }]);
    const existingToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const preview = await getJson(app, `/api/workspace-invitations/preview?token=${existingToken}`);
    expect(preview.status).toBe(200);
    expect(WorkspaceInvitationPreview.parse(await preview.json()).grants).toContainEqual({
      kind: "project_access",
      projectId,
      projectName: "Offered Project",
      level: "contribute",
    });
    expect(
      (
        await postJson(
          app,
          "/api/workspace-invitations/acceptance",
          { token: existingToken },
          existingCookie,
        )
      ).status,
    ).toBe(200);
    const [existingGrant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.projectId, projectId),
          eq(projectAccessGrants.humanId, existing.id),
        ),
      );
    expect(existingGrant).toMatchObject({
      level: "contribute",
      grantedByHumanId: admin.id,
    });

    await invite(app, adminCookie, workspace.id, "new.project@example.com", [
      { projectId, level: "manage" },
    ]);
    const registrationToken = await workspaceInviteToken(
      sent,
      "new.project@example.com",
      "Rocket Team",
    );
    expect(
      (
        await postJson(app, "/api/workspace-invitations/registration", {
          token: registrationToken,
          password: "new-project-password",
        })
      ).status,
    ).toBe(200);
    const [registered] = await database.db
      .select()
      .from(humans)
      .where(eq(humans.email, "new.project@example.com"));
    if (registered === undefined) throw new Error("the registered account was not created");
    const [registeredGrant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.projectId, projectId),
          eq(projectAccessGrants.humanId, registered.id),
        ),
      );
    expect(registeredGrant).toMatchObject({
      level: "manage",
      grantedByHumanId: admin.id,
    });
  });

  it("rejects a project that left the workspace on both acceptance paths, leaving the offers pending", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const otherWorkspaceId = await directSharedWorkspace([admin.id], "Other Team");
    const projectId = await createProjectDirect(workspace.id, admin.id, "Moved Project");
    const { cookie: existingCookie } = await verifiedCookie(app, INVITEE);
    const newEmail = "moved.project@example.com";

    await invite(app, adminCookie, workspace.id, INVITEE, [{ projectId, level: "read" }]);
    await invite(app, adminCookie, workspace.id, newEmail, [{ projectId, level: "contribute" }]);
    const existingToken = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
    const registrationToken = await workspaceInviteToken(sent, newEmail, "Rocket Team");

    await database.db
      .update(projects)
      .set({ workspaceId: otherWorkspaceId })
      .where(eq(projects.id, projectId));
    expect(await database.db.select().from(workspaceInvitationGrants)).toHaveLength(2);

    await database.db
      .update(projects)
      .set({ name: "Destination-only name" })
      .where(eq(projects.id, projectId));
    const history = await invitationList(app, adminCookie, workspace.id);
    expect(history).toHaveLength(2);
    for (const row of history) {
      expect(row.grants).toContainEqual(
        expect.objectContaining({
          kind: "project_access",
          projectId,
          projectName: null,
        }),
      );
      const resend = await postEmpty(
        app,
        `/api/workspaces/${workspace.id}/invitations/${row.id}/resend`,
        adminCookie,
      );
      expect(resend.status).toBe(409);
      expect(await problemBody(resend)).toMatchObject({ code: "invitation_scope_invalid" });
    }
    expect(sent).toHaveLength(2);
    for (const token of [existingToken, registrationToken]) {
      const preview = await getJson(app, `/api/workspace-invitations/preview?token=${token}`);
      expect(preview.status).toBe(409);
      expect(await problemBody(preview)).toMatchObject({ code: "invitation_scope_invalid" });
    }

    const existing = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: existingToken },
      existingCookie,
    );
    expect(existing.status).toBe(409);
    expect(await problemBody(existing)).toMatchObject({ code: "invitation_scope_invalid" });

    const registration = await postJson(app, "/api/workspace-invitations/registration", {
      token: registrationToken,
      password: "moved-project-password",
    });
    expect(registration.status).toBe(409);
    expect(await problemBody(registration)).toMatchObject({
      code: "invitation_scope_invalid",
    });

    const pendingOffers = await database.db.select().from(workspaceInvitations);
    expect(pendingOffers.map((invitation) => invitation.status)).toEqual(["pending", "pending"]);
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspace.id)),
    ).toHaveLength(1);
    expect(await database.db.select().from(projectAccessGrants)).toHaveLength(0);
    expect(await database.db.select().from(humans).where(eq(humans.email, newEmail))).toHaveLength(
      0,
    );
  });

  it("enforces valid and invalid ownership states at the database, including moves", async () => {
    const { admin } = await readyApp();
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    const [third] = await insertHuman({ email: "third.member@example.com", verified: true });

    const orphanId = randomUUID();
    expect(
      await rejection(
        database.db.insert(workspaces).values({ id: orphanId, kind: "shared", name: "Orphan" }),
      ),
    ).toContain("must keep at least one owner");
    expect(
      await database.db.select().from(workspaces).where(eq(workspaces.id, orphanId)),
    ).toHaveLength(0);

    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, admin.id));
    expect(
      await rejection(
        database.db
          .update(workspaces)
          .set({ kind: "shared", personalOwnerHumanId: null })
          .where(eq(workspaces.id, personal?.id ?? "")),
      ),
    ).toContain("must keep at least one owner");
    const [stillPersonal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, personal?.id ?? ""));
    expect(stillPersonal?.kind).toBe("personal");

    const workspaceA = await directSharedWorkspace([admin.id], "Move A");
    const [aOwner] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceA));
    expect(
      await rejection(
        database.db
          .update(workspaceMemberships)
          .set({ isOwner: false })
          .where(eq(workspaceMemberships.id, aOwner?.id ?? "")),
      ),
    ).toContain("must keep at least one owner");
    const [stillOwner] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.id, aOwner?.id ?? ""));
    expect(stillOwner?.isOwner).toBe(true);

    const workspaceB = await directSharedWorkspace([second.id], "Move B");
    expect(
      await rejection(
        database.db
          .update(workspaceMemberships)
          .set({ workspaceId: workspaceB })
          .where(eq(workspaceMemberships.workspaceId, workspaceA)),
      ),
    ).toContain("must keep at least one owner");
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceA)),
    ).toHaveLength(1);

    const moving = randomUUID();
    await database.db.insert(workspaceMemberships).values({
      id: moving,
      workspaceId: workspaceA,
      humanId: third.id,
      isOwner: false,
    });
    await database.db
      .update(workspaceMemberships)
      .set({ workspaceId: workspaceB })
      .where(eq(workspaceMemberships.id, moving));
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, moving)),
    ).toMatchObject([{ workspaceId: workspaceB }]);

    const removable = await directSharedWorkspace([admin.id], "Removable");
    await database.db.transaction(async (tx) => {
      await tx.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, removable));
      await tx.delete(workspaces).where(eq(workspaces.id, removable));
    });
    expect(
      await database.db.select().from(workspaces).where(eq(workspaces.id, removable)),
    ).toHaveLength(0);
  });

  it("serializes repeatable-read owner removals through the guard version", async () => {
    const { admin } = await readyApp();
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    const workspaceId = await directSharedWorkspace([admin.id, second.id], "Repeatable Team");

    let ready = 0;
    let open!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      open = resolve;
    });
    const removeAs = (humanId: string) =>
      database.sql.begin("isolation level repeatable read", async (tx) => {
        await tx`select count(*) from workspace_memberships where workspace_id = ${workspaceId}`;
        ready += 1;
        if (ready === 2) open();
        await bothReady;
        await tx`delete from workspace_memberships where workspace_id = ${workspaceId} and human_id = ${humanId}`;
      });

    const results = await Promise.allSettled([removeAs(admin.id), removeAs(second.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    if (loser?.status !== "rejected") throw new Error("expected one stale writer to fail");
    expect(rootCause(loser.reason)?.message ?? String(loser.reason)).toContain(
      "could not serialize access",
    );
    const owners = await database.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.isOwner, true),
        ),
      );
    expect(owners).toHaveLength(1);
  });

  it("refuses truncating ownership tables and leaves every shared workspace owned", async () => {
    const { admin } = await readyApp();
    const workspaceId = await directSharedWorkspace([admin.id], "Truncate Guard");

    expect(await rejection(database.sql`truncate workspace_memberships`)).toContain(
      "cannot be truncated",
    );
    expect(await rejection(database.sql`truncate workspaces cascade`)).toContain(
      "cannot be truncated",
    );
    const owners = await database.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.isOwner, true),
        ),
      );
    expect(owners).toHaveLength(1);
  });

  it("keeps one lock order when a service removal meets a direct membership write", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const [member] = await insertHuman({ email: "mixed.member@example.com", verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: member.id,
      isOwner: false,
    });

    const release = createGate();
    let deleted!: () => void;
    const hasDeleted = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    const holder = database.sql.begin(async (tx) => {
      await tx`
        delete from workspace_memberships
        where workspace_id = ${workspace.id} and human_id = ${member.id}
      `;
      deleted();
      await release.opened;
    });

    await hasDeleted;
    const removal = deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${member.id}`,
      adminCookie,
    );
    try {
      await waitForLockWait("lock_workspace_ownership_writes");
    } finally {
      release.release();
    }
    await holder;

    const res = await removal;
    expect(res.status).toBe(404);
    expect(await problemBody(res)).toMatchObject({ code: "member_not_found" });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, member.id)),
    ).toHaveLength(0);
  });

  it("lets an ownership writer finish before a competing direct delete takes the member row", async () => {
    const { admin } = await readyApp();
    const [member] = await insertHuman({ email: "waiting.member@example.com", verified: true });
    const workspaceId = await directSharedWorkspace([admin.id], "Write Order");
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: member.id,
      isOwner: false,
    });

    const release = createGate();
    const acquired = createGate();
    const holder = database.sql.begin(async (tx) => {
      await tx`select lock_workspace_ownership_writes()`;
      acquired.release();
      await release.opened;
      return tx`delete from workspace_memberships where workspace_id = ${workspaceId} and human_id = ${member.id} returning human_id`;
    });
    await acquired.opened;
    const competing =
      database.sql`delete from workspace_memberships where workspace_id = ${workspaceId} and human_id = ${member.id} returning human_id`.execute();
    try {
      await waitForLockWait("delete from workspace_memberships");
    } finally {
      release.release();
      const results = await Promise.all([holder, competing]);
      expect(results[0]).toMatchObject([{ human_id: member.id }]);
      expect(results[1]).toHaveLength(0);
    }
  });

  it("locks both guards in id order for opposite cross-workspace membership moves", async () => {
    const { admin } = await readyApp();
    const [second] = await insertHuman({ email: "second.owner@example.com", verified: true });
    const [third] = await insertHuman({ email: "third.member@example.com", verified: true });
    const [fourth] = await insertHuman({ email: "fourth.member@example.com", verified: true });
    const workspaceA = await directSharedWorkspace([admin.id], "Order A");
    const workspaceB = await directSharedWorkspace([second.id], "Order B");
    const fromA = randomUUID();
    const fromB = randomUUID();
    await database.db.insert(workspaceMemberships).values([
      { id: fromA, workspaceId: workspaceA, humanId: third.id, isOwner: false },
      { id: fromB, workspaceId: workspaceB, humanId: fourth.id, isOwner: false },
    ]);

    await Promise.all([
      database.db
        .update(workspaceMemberships)
        .set({ workspaceId: workspaceB })
        .where(eq(workspaceMemberships.id, fromA)),
      database.db
        .update(workspaceMemberships)
        .set({ workspaceId: workspaceA })
        .where(eq(workspaceMemberships.id, fromB)),
    ]);

    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, fromA)),
    ).toMatchObject([{ workspaceId: workspaceB }]);
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, fromB)),
    ).toMatchObject([{ workspaceId: workspaceA }]);
    for (const workspaceId of [workspaceA, workspaceB]) {
      const owners = await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspaceId),
            eq(workspaceMemberships.isOwner, true),
          ),
        );
      expect(owners).toHaveLength(1);
    }
  });

  it.each(["workspace_ownership_guards", "workspace_invitations"] as const)(
    "refuses redemption when a lock on %s outlasts the deadline",
    async (table) => {
      const { app, sent, adminCookie } = await readyApp();
      const workspace = await createWorkspace(app, adminCookie);
      const { cookie: memberCookie } = await verifiedCookie(app, INVITEE);
      await invite(app, adminCookie, workspace.id, INVITEE);
      const token = await workspaceInviteToken(sent, INVITEE, "Rocket Team");
      await database.db
        .update(workspaceInvitations)
        .set({ expiresAt: sql`statement_timestamp() + interval '1 second'` })
        .where(eq(workspaceInvitations.workspaceId, workspace.id));

      const release = createGate();
      let locked!: () => void;
      const hasLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = database.sql.begin(async (tx) => {
        await tx`
        select workspace_id
        from ${tx(table)}
        where workspace_id = ${workspace.id}
        for update
      `;
        locked();
        await release.opened;
      });

      await hasLocked;
      const acceptance = postJson(
        app,
        "/api/workspace-invitations/acceptance",
        { token },
        memberCookie,
      );
      let timedOut: unknown;
      try {
        await waitForLockWait(table);
        const [waiting] = await database.sql<{ query_start: string }[]>`
        select query_start
        from pg_stat_activity
        where wait_event_type = 'Lock'
          and query ilike ${`%${table}%`}
          and pid <> pg_backend_pid()
        order by query_start
        limit 1
      `;
        const [invitation] = await database.db
          .select({ expiresAt: workspaceInvitations.expiresAt })
          .from(workspaceInvitations)
          .where(eq(workspaceInvitations.workspaceId, workspace.id));
        if (waiting === undefined || invitation === undefined) {
          throw new Error("the blocked redemption or its invitation was not found");
        }

        expect(new Date(waiting.query_start).getTime()).toBeLessThan(
          invitation.expiresAt.getTime(),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      } catch (error) {
        timedOut = error;
      } finally {
        release.release();
      }
      await holder;
      const refused = await acceptance;
      if (timedOut !== undefined) throw timedOut;

      expect(refused.status).toBe(400);
      expect(await problemBody(refused)).toMatchObject({ code: "invitation_invalid" });
      expect(
        await database.db
          .select()
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.workspaceId, workspace.id)),
      ).toHaveLength(1);
    },
  );

  type CapabilityFlags = {
    canCreateProjects?: boolean;
    canInviteMembers?: boolean;
    canRemoveMembers?: boolean;
    canManageMemberPermissions?: boolean;
  };

  async function addMember(
    app: Hono,
    workspaceId: string,
    email: string,
    flags: CapabilityFlags = {},
  ) {
    const [human] = await insertHuman({ email, verified: true });
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: human.id,
      isOwner: false,
      ...flags,
    });
    return { human, cookie: await sessionFor(app, human.id) };
  }

  async function grantProjectManage(projectId: string, humanId: string, grantedByHumanId: string) {
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId,
      humanId,
      level: "manage",
      grantedByHumanId,
    });
  }

  it("exposes four independent effective capabilities on workspaces and members", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const ownerView = await getJson(app, `/api/workspaces/${workspace.id}`, adminCookie);
    expect(ownerView.status).toBe(200);
    expect(Workspace.parse(await ownerView.json())).toMatchObject({
      isOwner: true,
      canCreateProjects: true,
      canInviteMembers: true,
      canRemoveMembers: true,
      canManageMemberPermissions: true,
    });

    const member = await addMember(app, workspace.id, "flags.member@example.com");
    const memberView = await getJson(app, `/api/workspaces/${workspace.id}`, member.cookie);
    expect(memberView.status).toBe(200);
    expect(Workspace.parse(await memberView.json())).toMatchObject({
      isOwner: false,
      canCreateProjects: false,
      canInviteMembers: false,
      canRemoveMembers: false,
      canManageMemberPermissions: false,
    });

    const directory = await getJson(app, `/api/workspaces/${workspace.id}/members`, adminCookie);
    expect(directory.status).toBe(200);
    expect(WorkspaceMembersResponse.parse(await directory.json())).toContainEqual(
      expect.objectContaining({
        humanId: member.human.id,
        canCreateProjects: false,
        canInviteMembers: false,
        canRemoveMembers: false,
        canManageMemberPermissions: false,
      }),
    );

    const memberPath = `/api/workspaces/${workspace.id}/members/${member.human.id}`;
    const single = await patchJson(app, memberPath, { canCreateProjects: true }, adminCookie);
    expect(single.status).toBe(200);
    expect(WorkspaceMember.parse(await single.json())).toMatchObject({
      canCreateProjects: true,
      canInviteMembers: false,
    });
    const rest = await patchJson(
      app,
      memberPath,
      {
        canInviteMembers: true,
        canRemoveMembers: true,
        canManageMemberPermissions: true,
      },
      adminCookie,
    );
    expect(rest.status).toBe(200);
    expect(WorkspaceMember.parse(await rest.json())).toMatchObject({
      canCreateProjects: true,
      canInviteMembers: true,
      canRemoveMembers: true,
      canManageMemberPermissions: true,
    });
    const refreshed = await getJson(app, `/api/workspaces/${workspace.id}`, member.cookie);
    expect(Workspace.parse(await refreshed.json())).toMatchObject({
      canInviteMembers: true,
      canRemoveMembers: true,
      canManageMemberPermissions: true,
    });
    const empty = await patchJson(app, memberPath, {}, adminCookie);
    expect(empty.status).toBe(400);
    expect(await problemBody(empty)).toMatchObject({ code: "validation_failed" });
  });

  it("records one attributed event per real capability change and none for a no-op", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const member = await addMember(app, workspace.id, "events.member@example.com");
    const memberPath = `/api/workspaces/${workspace.id}/members/${member.human.id}`;

    const granted = await patchJson(
      app,
      memberPath,
      { canCreateProjects: true, canInviteMembers: true },
      adminCookie,
    );
    expect(granted.status).toBe(200);
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace_created",
        "create_projects_granted",
        "invite_members_granted",
      ]),
    );

    const noop = await patchJson(app, memberPath, { canCreateProjects: true }, adminCookie);
    expect(noop.status).toBe(200);
    expect(await eventsFor(workspace.id)).toHaveLength(3);

    const changed = await patchJson(
      app,
      memberPath,
      { canInviteMembers: false, canRemoveMembers: true, canManageMemberPermissions: true },
      adminCookie,
    );
    expect(changed.status).toBe(200);
    const events = await eventsFor(workspace.id);
    expect(events).toHaveLength(6);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace_created",
        "create_projects_granted",
        "invite_members_granted",
        "invite_members_revoked",
        "remove_members_granted",
        "manage_member_permissions_granted",
      ]),
    );
    for (const event of events.slice(1)) {
      expect(event).toMatchObject({
        workspaceId: workspace.id,
        actorHumanId: admin.id,
        subjectHumanId: member.human.id,
      });
    }

    const revoked = await patchJson(
      app,
      memberPath,
      { canRemoveMembers: false, canManageMemberPermissions: false },
      adminCookie,
    );
    expect(revoked.status).toBe(200);
    expect((await eventsFor(workspace.id)).map((event) => event.type)).toEqual(
      expect.arrayContaining(["remove_members_revoked", "manage_member_permissions_revoked"]),
    );

    const ownerNoop = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${admin.id}`,
      { canCreateProjects: true },
      adminCookie,
    );
    expect(ownerNoop.status).toBe(200);
    expect(await eventsFor(workspace.id)).toHaveLength(8);
  });

  it("lets only owners appoint permission managers and bounds a manager's delegation", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const manager = await addMember(app, workspace.id, "manager@example.com", {
      canManageMemberPermissions: true,
      canCreateProjects: true,
      canRemoveMembers: true,
    });
    const ordinary = await addMember(app, workspace.id, "ordinary.delegate@example.com");
    const path = (humanId: string) => `/api/workspaces/${workspace.id}/members/${humanId}`;

    const self = await patchJson(
      app,
      path(manager.human.id),
      { canInviteMembers: true },
      manager.cookie,
    );
    expect(self.status).toBe(403);
    expect(await problemBody(self)).toMatchObject({ code: "not_workspace_owner" });

    const appoint = await patchJson(
      app,
      path(ordinary.human.id),
      { canManageMemberPermissions: true },
      manager.cookie,
    );
    expect(appoint.status).toBe(403);
    const resign = await patchJson(
      app,
      path(manager.human.id),
      { canManageMemberPermissions: false },
      manager.cookie,
    );
    expect(resign.status).toBe(403);

    const aboveCeiling = await patchJson(
      app,
      path(ordinary.human.id),
      { canInviteMembers: true },
      manager.cookie,
    );
    expect(aboveCeiling.status).toBe(403);
    const withinCeiling = await patchJson(
      app,
      path(ordinary.human.id),
      { canCreateProjects: true },
      manager.cookie,
    );
    expect(withinCeiling.status).toBe(200);
    const revokeWithinCeiling = await patchJson(
      app,
      path(ordinary.human.id),
      { canCreateProjects: false },
      manager.cookie,
    );
    expect(revokeWithinCeiling.status).toBe(200);

    const owner = await patchJson(app, path(admin.id), { canCreateProjects: true }, manager.cookie);
    expect(owner.status).toBe(403);

    const removed = await patchJson(
      app,
      path(manager.human.id),
      { canManageMemberPermissions: false },
      adminCookie,
    );
    expect(removed.status).toBe(200);
    const nowPowerless = await patchJson(
      app,
      path(ordinary.human.id),
      { canCreateProjects: true },
      manager.cookie,
    );
    expect(nowPowerless.status).toBe(403);
  });

  it("protects owner capabilities and hides workspaces from non-members", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const member = await addMember(app, workspace.id, "plain.capability@example.com");
    const outsider = await verifiedCookie(app, "outsider.capability@example.com");
    const path = (humanId: string) => `/api/workspaces/${workspace.id}/members/${humanId}`;

    const noop = await patchJson(app, path(admin.id), { canCreateProjects: true }, adminCookie);
    expect(noop.status).toBe(200);
    expect(WorkspaceMember.parse(await noop.json()).canCreateProjects).toBe(true);
    const reduce = await patchJson(app, path(admin.id), { canInviteMembers: false }, adminCookie);
    expect(reduce.status).toBe(409);
    expect(await problemBody(reduce)).toMatchObject({ code: "workspace_owner_capability" });

    const hidden = await patchJson(
      app,
      path(member.human.id),
      { canCreateProjects: true },
      outsider.cookie,
    );
    expect(hidden.status).toBe(404);
    expect(await problemBody(hidden)).toMatchObject({ code: "workspace_not_found" });
    const missingTarget = await patchJson(
      app,
      path(randomUUID()),
      { canCreateProjects: true },
      adminCookie,
    );
    expect(missingTarget.status).toBe(404);
    expect(await problemBody(missingTarget)).toMatchObject({ code: "member_not_found" });
    const ordinary = await patchJson(
      app,
      path(member.human.id),
      { canCreateProjects: true },
      member.cookie,
    );
    expect(ordinary.status).toBe(403);
  });

  it("protects owners and permission managers from delegated removal", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const remover = await addMember(app, workspace.id, "remover@example.com", {
      canRemoveMembers: true,
    });
    const manager = await addMember(app, workspace.id, "protected.manager@example.com", {
      canManageMemberPermissions: true,
    });
    const ordinary = await addMember(app, workspace.id, "removable@example.com");
    const path = (humanId: string) => `/api/workspaces/${workspace.id}/members/${humanId}`;

    const refuseOwner = await deleteRequest(app, path(admin.id), remover.cookie);
    expect(refuseOwner.status).toBe(403);
    const refuseManager = await deleteRequest(app, path(manager.human.id), remover.cookie);
    expect(refuseManager.status).toBe(403);
    const noAuthority = await deleteRequest(app, path(ordinary.human.id), manager.cookie);
    expect(noAuthority.status).toBe(403);
    const removed = await deleteRequest(app, path(ordinary.human.id), remover.cookie);
    expect(removed.status).toBe(204);

    const outsider = await verifiedCookie(app, "outsider.removal@example.com");
    const hidden = await deleteRequest(app, path(manager.human.id), outsider.cookie);
    expect(hidden.status).toBe(404);
    expect(await problemBody(hidden)).toMatchObject({ code: "workspace_not_found" });

    expect((await deleteRequest(app, path(manager.human.id), adminCookie)).status).toBe(204);
    const last = await deleteRequest(app, path(admin.id), adminCookie);
    expect(last.status).toBe(409);
    expect(await problemBody(last)).toMatchObject({ code: "last_owner" });
  });

  it("limits the member directory to callers with member-management authority", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const manager = await addMember(app, workspace.id, "directory.manager@example.com", {
      canManageMemberPermissions: true,
    });
    const remover = await addMember(app, workspace.id, "directory.remover@example.com", {
      canRemoveMembers: true,
    });
    const plain = await addMember(app, workspace.id, "directory.plain@example.com");
    const outsider = await verifiedCookie(app, "directory.outsider@example.com");
    const url = `/api/workspaces/${workspace.id}/members`;

    for (const cookie of [adminCookie, manager.cookie, remover.cookie]) {
      expect((await getJson(app, url, cookie)).status).toBe(200);
    }
    const denied = await getJson(app, url, plain.cookie);
    expect(denied.status).toBe(403);
    expect(await problemBody(denied)).toMatchObject({ code: "not_workspace_owner" });
    const hidden = await getJson(app, url, outsider.cookie);
    expect(hidden.status).toBe(404);
    expect(await problemBody(hidden)).toMatchObject({ code: "workspace_not_found" });
  });

  it("bounds a delegated inviter to the projects they Manage", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const managed = await createProjectDirect(workspace.id, admin.id, "Managed Project");
    const other = await createProjectDirect(workspace.id, admin.id, "Other Project");
    const inviter = await addMember(app, workspace.id, "delegated.inviter@example.com", {
      canInviteMembers: true,
    });
    const noAuthority = await addMember(app, workspace.id, "no.invite@example.com");
    const url = `/api/workspaces/${workspace.id}/invitations`;

    expect((await getJson(app, url, inviter.cookie)).status).toBe(200);
    const plain = await postJson(
      app,
      url,
      { email: "delegated.first@example.com" },
      inviter.cookie,
    );
    expect(plain.status).toBe(201);

    const outOfScope = await postJson(
      app,
      url,
      {
        email: "delegated.second@example.com",
        projectGrants: [{ projectId: managed, level: "read" }],
      },
      inviter.cookie,
    );
    expect(outOfScope.status).toBe(403);
    expect(await problemBody(outOfScope)).toMatchObject({ code: "not_workspace_owner" });

    await grantProjectManage(managed, inviter.human.id, admin.id);
    const inScope = await postJson(
      app,
      url,
      {
        email: "delegated.third@example.com",
        projectGrants: [{ projectId: managed, level: "contribute" }],
      },
      inviter.cookie,
    );
    expect(inScope.status).toBe(201);

    const pending = (await invitationList(app, inviter.cookie, workspace.id)).find(
      (item) => item.email === "delegated.third@example.com" && item.status === "pending",
    );
    expect(pending).toBeDefined();
    if (pending === undefined) throw new Error("the delegated invitation was not listed");
    const resent = await postEmpty(app, `${url}/${pending.id}/resend`, inviter.cookie);
    expect(resent.status).toBe(200);

    await invite(app, adminCookie, workspace.id, "delegated.fourth@example.com", [
      { projectId: other, level: "read" },
    ]);
    const inviterHistory = await invitationList(app, inviter.cookie, workspace.id);
    expect(inviterHistory.some((item) => item.email === "delegated.fourth@example.com")).toBe(
      false,
    );
    const foreign = (await invitationList(app, adminCookie, workspace.id)).find(
      (item) => item.email === "delegated.fourth@example.com" && item.status === "pending",
    );
    expect(foreign).toBeDefined();
    if (foreign === undefined) throw new Error("the owner invitation was not listed for the owner");
    expect((await postEmpty(app, `${url}/${foreign.id}/resend`, inviter.cookie)).status).toBe(403);
    expect((await postEmpty(app, `${url}/${foreign.id}/revoke`, inviter.cookie)).status).toBe(403);

    expect((await getJson(app, url, noAuthority.cookie)).status).toBe(403);
    expect(
      (await postJson(app, url, { email: "delegated.fifth@example.com" }, noAuthority.cookie))
        .status,
    ).toBe(403);
    expect((await postEmpty(app, `${url}/${pending.id}/resend`, noAuthority.cookie)).status).toBe(
      403,
    );
    expect((await postEmpty(app, `${url}/${foreign.id}/revoke`, noAuthority.cookie)).status).toBe(
      403,
    );
  });

  it("scopes a delegated inviter's invitation history to projects they currently Manage", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie, "Scoped Directory Team");
    const managed = await createProjectDirect(workspace.id, admin.id, "Visible Project");
    const unmanaged = await createProjectDirect(workspace.id, admin.id, "Hidden Project");
    const inviter = await addMember(app, workspace.id, "scope.directory@example.com", {
      canInviteMembers: true,
    });
    await grantProjectManage(managed, inviter.human.id, admin.id);

    await invite(app, adminCookie, workspace.id, "scope.hidden@example.com", [
      { projectId: unmanaged, level: "manage" },
    ]);
    await invite(app, inviter.cookie, workspace.id, "scope.visible@example.com", [
      { projectId: managed, level: "read" },
    ]);
    await invite(app, inviter.cookie, workspace.id, "scope.plain@example.com");

    const delegateHistory = await invitationList(app, inviter.cookie, workspace.id);
    const emails = delegateHistory.map((item) => item.email);
    expect(emails).toContain("scope.visible@example.com");
    expect(emails).toContain("scope.plain@example.com");
    expect(emails).not.toContain("scope.hidden@example.com");
    expect(JSON.stringify(delegateHistory)).not.toContain(unmanaged);
    expect(JSON.stringify(delegateHistory)).not.toContain("Hidden Project");

    const ownerHistory = await invitationList(app, adminCookie, workspace.id);
    expect(ownerHistory.some((item) => item.email === "scope.hidden@example.com")).toBe(true);
    expect(JSON.stringify(ownerHistory)).toContain(unmanaged);
  });

  it("frees a dead pending invitation for revoke and immediate re-invite after Manage is lost", async () => {
    const { app, sent, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie, "Reinvite Team");
    const project = await createProjectDirect(workspace.id, admin.id, "Revocable Project");
    const inviter = await addMember(app, workspace.id, "reinvite.inviter@example.com", {
      canInviteMembers: true,
    });
    await grantProjectManage(project, inviter.human.id, admin.id);
    const url = `/api/workspaces/${workspace.id}/invitations`;
    const dropManage = () =>
      database.db
        .delete(projectAccessGrants)
        .where(
          and(
            eq(projectAccessGrants.projectId, project),
            eq(projectAccessGrants.humanId, inviter.human.id),
          ),
        );
    const lastToken = (email: string) => {
      const mail = sent.findLast(
        (candidate) => candidate.to === email && candidate.text.includes('"Reinvite Team"'),
      );
      const token = mail === undefined ? undefined : tokenFrom(mail.text);
      if (token === undefined) throw new Error(`no invitation token for ${email}`);
      return token;
    };

    const firstEmail = "reinvite.revoke@example.com";
    await invite(app, inviter.cookie, workspace.id, firstEmail, [
      { projectId: project, level: "read" },
    ]);
    const firstToken = lastToken(firstEmail);
    await dropManage();
    const [firstHuman] = await insertHuman({ email: firstEmail, verified: true });
    const firstRefused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: firstToken },
      await sessionFor(app, firstHuman.id),
    );
    expect(firstRefused.status).toBe(403);
    expect(await problemBody(firstRefused)).toMatchObject({ code: "inviter_not_authorized" });
    const own = (await invitationList(app, adminCookie, workspace.id)).find(
      (item) => item.email === firstEmail && item.status === "pending",
    );
    expect(own).toBeDefined();
    if (own === undefined) throw new Error("the dead invitation was not listed for the owner");
    expect((await postEmpty(app, `${url}/${own.id}/revoke`, inviter.cookie)).status).toBe(200);
    expect((await postJson(app, url, { email: firstEmail }, inviter.cookie)).status).toBe(201);

    const secondEmail = "reinvite.replace@example.com";
    await grantProjectManage(project, inviter.human.id, admin.id);
    await invite(app, inviter.cookie, workspace.id, secondEmail, [
      { projectId: project, level: "contribute" },
    ]);
    const secondToken = lastToken(secondEmail);
    await dropManage();
    const [secondHuman] = await insertHuman({ email: secondEmail, verified: true });
    const secondRefused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: secondToken },
      await sessionFor(app, secondHuman.id),
    );
    expect(secondRefused.status).toBe(403);
    expect(await problemBody(secondRefused)).toMatchObject({ code: "inviter_not_authorized" });
    const replacement = await postJson(app, url, { email: secondEmail }, inviter.cookie);
    expect(replacement.status).toBe(201);

    const rows = await database.db
      .select({ status: workspaceInvitations.status })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspace.id),
          eq(workspaceInvitations.email, secondEmail),
        ),
      );
    expect(rows.map((row) => row.status).toSorted()).toEqual(["pending", "revoked"]);
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: lastToken(secondEmail) },
      await sessionFor(app, secondHuman.id),
    );
    expect(accepted.status).toBe(200);
  });

  it("refuses a pending invitation once the inviter loses capability or project Manage", async () => {
    const { app, sent, adminCookie, admin } = await readyApp();

    const first = await createWorkspace(app, adminCookie, "Withdraw Capability Team");
    const firstProject = await createProjectDirect(first.id, admin.id, "Withdraw Project");
    const inviter = await addMember(app, first.id, "withdraw.capability@example.com", {
      canInviteMembers: true,
    });
    await grantProjectManage(firstProject, inviter.human.id, admin.id);
    const firstRecipient = "withdraw.capability.recipient@example.com";
    await invite(app, inviter.cookie, first.id, firstRecipient, [
      { projectId: firstProject, level: "read" },
    ]);
    const firstToken = await workspaceInviteToken(sent, firstRecipient, "Withdraw Capability Team");
    expect(
      (
        await patchJson(
          app,
          `/api/workspaces/${first.id}/members/${inviter.human.id}`,
          { canInviteMembers: false },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    const [firstHuman] = await insertHuman({ email: firstRecipient, verified: true });
    const firstCookie = await sessionFor(app, firstHuman.id);
    const refused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: firstToken },
      firstCookie,
    );
    expect(refused.status).toBe(403);
    expect(await problemBody(refused)).toMatchObject({ code: "inviter_not_authorized" });
    const [firstInvitation] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, first.id));
    expect(firstInvitation).toMatchObject({ status: "pending", acceptedAt: null });
    expect(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.humanId, firstHuman.id)),
    ).toHaveLength(0);

    const second = await createWorkspace(app, adminCookie, "Withdraw Manage Team");
    const secondProject = await createProjectDirect(second.id, admin.id, "Manage Project");
    const secondInviter = await addMember(app, second.id, "withdraw.manage@example.com", {
      canInviteMembers: true,
    });
    await grantProjectManage(secondProject, secondInviter.human.id, admin.id);
    const secondRecipient = "withdraw.manage.recipient@example.com";
    await invite(app, secondInviter.cookie, second.id, secondRecipient, [
      { projectId: secondProject, level: "contribute" },
    ]);
    const secondToken = await workspaceInviteToken(sent, secondRecipient, "Withdraw Manage Team");
    await database.db
      .delete(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.projectId, secondProject),
          eq(projectAccessGrants.humanId, secondInviter.human.id),
        ),
      );
    const [secondHuman] = await insertHuman({ email: secondRecipient, verified: true });
    const secondRefused = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: secondToken },
      await sessionFor(app, secondHuman.id),
    );
    expect(secondRefused.status).toBe(403);
    expect(await problemBody(secondRefused)).toMatchObject({ code: "inviter_not_authorized" });
    const [secondInvitation] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, second.id));
    expect(secondInvitation).toMatchObject({ status: "pending", acceptedAt: null });

    const third = await createWorkspace(app, adminCookie, "Withdraw Registration Team");
    const thirdInviter = await addMember(app, third.id, "withdraw.registration@example.com", {
      canInviteMembers: true,
    });
    const thirdRecipient = "withdraw.registration.new@example.com";
    await invite(app, thirdInviter.cookie, third.id, thirdRecipient);
    const thirdToken = await workspaceInviteToken(
      sent,
      thirdRecipient,
      "Withdraw Registration Team",
    );
    expect(
      (
        await patchJson(
          app,
          `/api/workspaces/${third.id}/members/${thirdInviter.human.id}`,
          { canInviteMembers: false },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    const registration = await postJson(app, "/api/workspace-invitations/registration", {
      token: thirdToken,
      password: "a-strong-password-123",
    });
    expect(registration.status).toBe(403);
    expect(await problemBody(registration)).toMatchObject({ code: "inviter_not_authorized" });
    expect(
      await database.db.select().from(humans).where(eq(humans.email, thirdRecipient)),
    ).toHaveLength(0);
    const [thirdInvitation] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, third.id));
    expect(thirdInvitation).toMatchObject({ status: "pending", acceptedAt: null });
  });

  it("gives Project Manage no workspace-wide authority", async () => {
    const { app, adminCookie, admin } = await readyApp();
    const workspace = await createWorkspace(app, adminCookie);
    const project = await createProjectDirect(workspace.id, admin.id);
    const manager = await addMember(app, workspace.id, "project.manager@example.com");
    await grantProjectManage(project, manager.human.id, admin.id);
    const other = await addMember(app, workspace.id, "project.other@example.com");

    const view = await getJson(app, `/api/workspaces/${workspace.id}`, manager.cookie);
    expect(view.status).toBe(200);
    expect(Workspace.parse(await view.json())).toMatchObject({
      isOwner: false,
      canCreateProjects: false,
      canInviteMembers: false,
      canRemoveMembers: false,
      canManageMemberPermissions: false,
    });

    await assertForbidden(getJson(app, `/api/workspaces/${workspace.id}/members`, manager.cookie));
    await assertForbidden(
      patchJson(
        app,
        `/api/workspaces/${workspace.id}/members/${other.human.id}`,
        { canCreateProjects: true },
        manager.cookie,
      ),
    );
    await assertForbidden(
      deleteRequest(
        app,
        `/api/workspaces/${workspace.id}/members/${other.human.id}`,
        manager.cookie,
      ),
    );
    await assertForbidden(
      getJson(app, `/api/workspaces/${workspace.id}/invitations`, manager.cookie),
    );
    await assertForbidden(
      postJson(
        app,
        `/api/workspaces/${workspace.id}/invitations`,
        { email: "project.manager.blocked@example.com" },
        manager.cookie,
      ),
    );
    await assertForbidden(
      postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "Blocked" },
        manager.cookie,
      ),
    );

    await invite(app, adminCookie, workspace.id, "project.manager.pending@example.com");
    const [invitation] = await database.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, workspace.id));
    expect(invitation).toBeDefined();
    if (invitation === undefined) throw new Error("the owner invitation was not found");
    const url = `/api/workspaces/${workspace.id}/invitations`;
    await assertForbidden(postEmpty(app, `${url}/${invitation.id}/resend`, manager.cookie));
    await assertForbidden(postEmpty(app, `${url}/${invitation.id}/revoke`, manager.cookie));
  });

  it("supersedes an owner's stale-scope offer instead of blocking the email for seven days", async () => {
    const { app, sent, admin, adminCookie } = await readyApp();
    const name = "Stale Scope Team";
    const workspace = await createWorkspace(app, adminCookie, name);
    const destination = await directSharedWorkspace([admin.id], "Destination Team");
    const projectId = await createProjectDirect(workspace.id, admin.id, "Moved Out");

    await invite(app, adminCookie, workspace.id, INVITEE, [{ projectId, level: "read" }]);
    const staleToken = await workspaceInviteToken(sent, INVITEE, name);

    await database.db
      .update(projects)
      .set({ workspaceId: destination })
      .where(eq(projects.id, projectId));

    const stale = await getJson(app, `/api/workspace-invitations/preview?token=${staleToken}`);
    expect(stale.status).toBe(409);
    expect(await problemBody(stale)).toMatchObject({ code: "invitation_scope_invalid" });

    await invite(app, adminCookie, workspace.id, INVITEE);
    const rows = await database.db
      .select({ status: workspaceInvitations.status })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspace.id),
          eq(workspaceInvitations.email, INVITEE),
        ),
      );
    expect(rows.map((row) => row.status).toSorted()).toEqual(["pending", "revoked"]);

    const replacementToken = (() => {
      const mail = sent.findLast(
        (candidate) => candidate.to === INVITEE && candidate.text.includes(`"${name}"`),
      );
      const token = mail === undefined ? undefined : tokenFrom(mail.text);
      if (token === undefined) throw new Error("the replacement invitation carried no token");
      return token;
    })();
    const [invitee] = await insertHuman({ email: INVITEE, verified: true });
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: replacementToken },
      await sessionFor(app, invitee.id),
    );
    expect(accepted.status).toBe(200);
  });

  it("revokes a removed member's keys so a re-invitation cannot revive them", async () => {
    const { app, sent, admin, adminCookie } = await readyAgentsApp();
    const name = "Key Revocation Team";
    const workspace = await createWorkspace(app, adminCookie, name);
    const projectId = await createProjectDirect(workspace.id, admin.id, "Team Work");
    const member = await addMember(app, workspace.id, INVITEE);
    await grantProjectManage(projectId, member.human.id, admin.id);

    const me = (bearer: string) =>
      app.request("/api/agents/me", { headers: { authorization: `Bearer ${bearer}` } });
    const agentRes = await postJson(app, "/api/agents", { name: "member-bot" }, member.cookie);
    expect(agentRes.status).toBe(201);
    const agentId = Agent.parse(await agentRes.json()).id;
    const keyRes = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        projects: [{ projectId, level: "contribute" }],
      },
      member.cookie,
    );
    expect(keyRes.status).toBe(201);
    const issued = CreateAgentKeyResponse.parse(await keyRes.json());
    expect((await me(issued.secret)).status).toBe(200);

    const removed = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      adminCookie,
    );
    expect(removed.status).toBe(204);
    const [storedKey] = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, issued.key.id));
    expect(storedKey?.revokedAt).not.toBeNull();
    expect(storedKey?.revokedByHumanId).toBe(admin.id);
    const revokeEvents = await database.db
      .select()
      .from(agentKeyEvents)
      .where(
        and(eq(agentKeyEvents.keyId, issued.key.id), eq(agentKeyEvents.type, "agent_key_revoked")),
      );
    expect(revokeEvents).toHaveLength(1);
    expect(revokeEvents[0]).toMatchObject({
      actorHumanId: admin.id,
      workspaceId: workspace.id,
      agentId,
    });
    expect(JSON.stringify(revokeEvents)).not.toContain(issued.secret);
    const refused = await me(issued.secret);
    expect(refused.status).toBe(401);
    expect(await problemBody(refused)).toMatchObject({ code: "key_revoked" });

    await invite(app, adminCookie, workspace.id, INVITEE, [{ projectId, level: "read" }]);
    const replacementToken = (() => {
      const mail = sent.findLast(
        (candidate) => candidate.to === INVITEE && candidate.text.includes(`"${name}"`),
      );
      const token = mail === undefined ? undefined : tokenFrom(mail.text);
      if (token === undefined) throw new Error("the re-invitation carried no token");
      return token;
    })();
    const accepted = await postJson(
      app,
      "/api/workspace-invitations/acceptance",
      { token: replacementToken },
      member.cookie,
    );
    expect(accepted.status).toBe(200);
    const stillRefused = await me(issued.secret);
    expect(stillRefused.status).toBe(401);
    expect(await problemBody(stillRefused)).toMatchObject({ code: "key_revoked" });

    const newKeyRes = await postJson(
      app,
      "/api/agents/keys",
      { agentId, workspaceId: workspace.id, projects: [{ projectId, level: "read" }] },
      member.cookie,
    );
    expect(newKeyRes.status).toBe(201);
    const fresh = CreateAgentKeyResponse.parse(await newKeyRes.json());
    const newMe = await me(fresh.secret);
    expect(newMe.status).toBe(200);
    expect(await newMe.json()).toMatchObject({ projects: [{ projectId, level: "read" }] });

    expect(await database.db.select().from(agentKeyEvents)).toHaveLength(3);
  });

  it("serializes issueKey with removeMember so a removed member keeps no live key", async () => {
    const { app, admin, adminCookie } = await readyAgentsApp();
    const workspace = await createWorkspace(app, adminCookie, "Lock Order Team");
    const projectId = await createProjectDirect(workspace.id, admin.id, "Locked Work");
    const member = await addMember(app, workspace.id, "lock.member@example.com");
    await grantProjectManage(projectId, member.human.id, admin.id);
    const agentRes = await postJson(app, "/api/agents", { name: "lock-bot" }, member.cookie);
    const agentId = Agent.parse(await agentRes.json()).id;

    const release = createGate();
    const acquired = createGate();
    const holder = database.sql.begin(async (tx) => {
      await tx`select lock_workspace_ownership_writes()`;
      acquired.release();
      await release.opened;
    });
    await acquired.opened;

    const issuing = postJson(
      app,
      "/api/agents/keys",
      { agentId, workspaceId: workspace.id, projects: [{ projectId, level: "read" }] },
      member.cookie,
    );
    const removing = deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      adminCookie,
    );

    await expect
      .poll(
        async () => {
          const [row] = await database.sql<{ count: number }[]>`
            select count(*)::int as count
            from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike '%lock_workspace_ownership_writes%'
              and pid <> pg_backend_pid()
          `;
          return row?.count ?? 0;
        },
        { timeout: 5_000, interval: 25 },
      )
      .toBeGreaterThanOrEqual(2);

    release.release();
    await holder;
    const [issued, removed] = await Promise.all([issuing, removing]);
    expect(removed.status).toBe(204);

    const keys = await database.db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.workspaceId, workspace.id), eq(agentApiKeys.agentId, agentId)));
    expect(keys.filter((key) => key.revokedAt === null)).toHaveLength(0);
    const issuance = {
      status: issued.status,
      code: issued.status === 201 ? "issued" : (await problemBody(issued)).code,
      keys: keys.length,
    };
    expect(issuance).toMatchObject(
      issuance.status === 201
        ? { status: 201, code: "issued", keys: 1 }
        : { status: 404, code: "workspace_not_found", keys: 0 },
    );
  });
});

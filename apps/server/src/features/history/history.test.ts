import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  HistoryResponse,
  Project,
  ProjectAccessLevel,
  Workspace,
  type HistoryEvent,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  browserSessions,
  humans,
  invitations,
  projects,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAgentsFeature, revokeMemberWorkspaceKeys } from "../agents/index.ts";
import {
  createProjectsFeature,
  projectAccessAtLeast,
  projectAccessCeilingInTransaction,
} from "../projects/index.ts";
import { createWorkspacesFeature } from "../workspaces/index.ts";
import { createHistoryFeature, createHistoryService } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const patchJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);
const deleteRequest = (app: Hono, path: string, cookie: string) =>
  app.request(path, { method: "DELETE", headers: { cookie } });

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
function text(value: unknown, what: string): string {
  const result = field(value, "id") ?? field(value, "secret") ?? value;
  if (typeof result !== "string") throw new Error(`missing ${what}`);
  return result;
}
function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what}`);
  return id;
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(await res.json()).toMatchObject({ status, code });
}

async function readHistory(app: Hono, path: string, cookie: string): Promise<HistoryEvent[]> {
  const res = await getJson(app, path, cookie);
  expect(res.status).toBe(200);
  return HistoryResponse.parse(await res.json());
}

describe("history visibility against real Postgres", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

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
      await tx.execute(sql`delete from project_access_events`);
      await tx.execute(sql`delete from agent_key_events`);
      await tx.execute(sql`delete from project_access_grants`);
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from agent_api_key_projects`);
      await tx.execute(sql`delete from agent_api_keys`);
      await tx.execute(sql`delete from agents`);
      await tx.execute(sql`delete from issue_comments`);
      await tx.execute(sql`delete from knowledge_entries`);
      await tx.execute(sql`delete from issues`);
      await tx.execute(sql`delete from projects`);
      await tx.execute(sql`delete from workspace_events`);
      await tx.execute(sql`delete from workspace_invitations`);
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
      projectAccessAtLeast,
    });
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
      revokeMemberWorkspaceKeys,
      releaseMemberWorkSessions: async () => {},
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projectsFeature.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
    });
    return createApp({
      features: [
        accounts,
        workspacesFeature,
        projectsFeature,
        agentsFeature,
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
  }

  async function insertHuman(email: string, admin = false) {
    const [human] = await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email,
        passwordHash: "scrypt$anything",
        emailVerifiedAt: sql`now()`,
        isSystemAdministrator: admin,
      })
      .returning();
    if (human === undefined) throw new Error("the human was not created");
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

  async function addMembership(workspaceId: string, humanId: string, flags = {}) {
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId,
      ...flags,
    });
  }

  async function recordWorkspaceEvent(
    type: "member_joined" | "manage_member_permissions_granted",
    workspaceId: string,
    actorHumanId: string,
    subjectHumanId: string,
  ) {
    await database.db.insert(workspaceEvents).values({
      id: randomUUID(),
      type,
      workspaceId,
      actorHumanId,
      subjectHumanId,
    });
  }

  async function readyScenario() {
    const app = makeApp();
    const setup = await postJson(app, "/api/setup/admin", {
      secret: SECRET,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(setup.status).toBe(201);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the administrator was not created");
    const adminCookie = await sessionFor(admin.id);

    const delegate = await insertHuman("delegate@example.com");
    const member = await insertHuman("member@example.com");
    const outsider = await insertHuman("outsider@example.com");
    const otherOwner = await insertHuman("owner@example.com");
    const delegateCookie = await sessionFor(delegate.id);
    const memberCookie = await sessionFor(member.id);
    const outsiderCookie = await sessionFor(outsider.id);
    const otherOwnerCookie = await sessionFor(otherOwner.id);

    const created = await postJson(app, "/api/workspaces", { name: "History Lab" }, adminCookie);
    expect(created.status).toBe(201);
    const workspace = Workspace.parse(await created.json());
    await addMembership(workspace.id, delegate.id, { canManageMemberPermissions: true });
    await addMembership(workspace.id, member.id);
    await recordWorkspaceEvent("member_joined", workspace.id, admin.id, delegate.id);
    await recordWorkspaceEvent("member_joined", workspace.id, admin.id, member.id);
    await recordWorkspaceEvent(
      "manage_member_permissions_granted",
      workspace.id,
      admin.id,
      delegate.id,
    );

    const otherCreated = await postJson(
      app,
      "/api/workspaces",
      { name: "Private Team" },
      otherOwnerCookie,
    );
    expect(otherCreated.status).toBe(201);
    const otherWorkspace = Workspace.parse(await otherCreated.json());
    const [otherProject] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId: otherWorkspace.id,
        name: "Private Project",
        key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
        createdByHumanId: otherOwner.id,
      })
      .returning();
    if (otherProject === undefined) throw new Error("the other project was not created");

    const projectResponse = await postJson(
      app,
      `/api/workspaces/${workspace.id}/projects`,
      { name: "Visible Project" },
      adminCookie,
    );
    expect(projectResponse.status).toBe(201);
    const project = Project.parse(await projectResponse.json());
    const issue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "A visible issue" },
      adminCookie,
    );
    expect(issue.status).toBe(201);
    const granted = await patchJson(
      app,
      `/api/projects/${project.id}/access`,
      { email: member.email, level: ProjectAccessLevel.enum.read },
      adminCookie,
    );
    expect(granted.status).toBe(200);

    const delegateGrant = await patchJson(
      app,
      `/api/projects/${project.id}/access`,
      { email: delegate.email, level: ProjectAccessLevel.enum.manage },
      adminCookie,
    );
    expect(delegateGrant.status).toBe(200);

    const agentResponse = await postJson(app, "/api/agents", { name: "Builder" }, adminCookie);
    expect(agentResponse.status).toBe(201);
    const agentId = idOf(await agentResponse.json(), "the agent id");
    const keyResponse = await postJson(
      app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: workspace.id,
        validity: "30",
        projects: [{ projectId: project.id, level: "read" }],
      },
      adminCookie,
    );
    expect(keyResponse.status).toBe(201);
    const keyBody = await keyResponse.json();
    const secret = text(field(keyBody, "secret"), "the key secret");
    const keyId = idOf(field(keyBody, "key"), "the key id");
    const revoked = await deleteRequest(app, `/api/agents/keys/${keyId}`, adminCookie);
    expect(revoked.status).toBe(204);

    const [invitation] = await database.db
      .insert(invitations)
      .values({
        id: randomUUID(),
        email: "invited@example.com",
        status: "accepted",
        tokenHash: tokenHash(randomBytes(32).toString("base64url")),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '7 days'`,
        acceptedAt: sql`now()`,
      })
      .returning();
    if (invitation === undefined) throw new Error("the invitation was not created");
    const [declinedInvitation] = await database.db
      .insert(invitations)
      .values({
        id: randomUUID(),
        email: "declined@example.com",
        status: "declined",
        tokenHash: tokenHash(randomBytes(32).toString("base64url")),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '7 days'`,
        declinedAt: sql`now()`,
      })
      .returning();
    if (declinedInvitation === undefined)
      throw new Error("the declined invitation was not created");

    return {
      app,
      admin: { id: admin.id, email: admin.email },
      delegate: { id: delegate.id, email: delegate.email, cookie: delegateCookie },
      member: { id: member.id, email: member.email, cookie: memberCookie },
      outsider: { id: outsider.id, cookie: outsiderCookie },
      otherOwner: { id: otherOwner.id, cookie: otherOwnerCookie },
      adminCookie,
      workspace,
      otherWorkspace,
      project,
      otherProject,
      secret,
      invitation,
      declinedInvitation,
    };
  }

  it("shows every recorded event kind to the owner, newest first, without secrets", async () => {
    const s = await readyScenario();
    const events = await readHistory(
      s.app,
      `/api/workspaces/${s.workspace.id}/history`,
      s.adminCookie,
    );
    expect(events.length).toBeGreaterThan(0);
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds).toEqual(new Set(["workspace_access", "project_access", "agent_key"]));

    const activity = await readHistory(
      s.app,
      `/api/projects/${s.project.id}/history`,
      s.adminCookie,
    );
    expect(activity.some((event) => event.kind === "project_activity")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace_created",
        "member_joined",
        "manage_member_permissions_granted",
        "project_access_granted",
        "agent_key_created",
        "agent_key_revoked",
      ]),
    );
    expect(activity.map((event) => event.type)).toEqual(
      expect.arrayContaining(["project_created", "issue_created"]),
    );
    expect(events.map((event) => event.scope.kind)).toContain("project");
    for (const event of events) {
      expect(event.actor.displayName).not.toBe("");
      expect(event.scope.id).not.toBe("");
    }
    const timestamps = events.map((event) => event.createdAt);
    expect(timestamps).toEqual([...timestamps].toSorted().toReversed());

    const body = JSON.stringify(events);
    expect(body).not.toContain(s.secret);
    for (const forbidden of [
      "tokenHash",
      "token_hash",
      "passwordHash",
      "password_hash",
      "secret",
    ]) {
      expect(body).not.toContain(forbidden);
    }
    const keyRow = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.workspaceId, s.workspace.id));
    for (const row of keyRow) expect(body).not.toContain(row.tokenHash);
  });

  it("limits a delegated permission manager to workspace events and projects they Manage", async () => {
    const s = await readyScenario();
    const events = await readHistory(
      s.app,
      `/api/workspaces/${s.workspace.id}/history`,
      s.delegate.cookie,
    );
    expect(events.some((event) => event.kind === "workspace_access")).toBe(true);
    expect(events.some((event) => event.kind === "agent_key")).toBe(false);
    expect(
      events.every((event) => event.scope.id === s.workspace.id || event.scope.id === s.project.id),
    ).toBe(true);
    const access = events.filter((event) => event.kind === "project_access");
    expect(access.length).toBeGreaterThan(0);
    expect(access.every((event) => event.scope.id === s.project.id)).toBe(true);

    await expectProblem(
      await getJson(s.app, `/api/workspaces/${s.otherWorkspace.id}/history`, s.delegate.cookie),
      404,
      "workspace_not_found",
    );
  });

  it("gives an ordinary member only granted-project activity, never access history", async () => {
    const s = await readyScenario();
    await expectProblem(
      await getJson(s.app, `/api/workspaces/${s.workspace.id}/history`, s.member.cookie),
      403,
      "workspace_history_forbidden",
    );
    const projectEvents = await readHistory(
      s.app,
      `/api/projects/${s.project.id}/history`,
      s.member.cookie,
    );
    expect(projectEvents.length).toBeGreaterThan(0);
    expect(projectEvents.every((event) => event.kind === "project_activity")).toBe(true);

    await expectProblem(
      await getJson(s.app, `/api/projects/${s.otherProject.id}/history`, s.member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(s.app, `/api/workspaces/${s.otherWorkspace.id}/history`, s.member.cookie),
      404,
      "workspace_not_found",
    );
  });

  it("refuses a non-member and an agent bearer key on every history route", async () => {
    const s = await readyScenario();
    await expectProblem(
      await getJson(s.app, `/api/workspaces/${s.workspace.id}/history`, s.outsider.cookie),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await getJson(s.app, `/api/projects/${s.project.id}/history`, s.outsider.cookie),
      404,
      "project_not_found",
    );

    const bearer = { headers: { authorization: "Bearer not-a-session" } };
    for (const path of [
      `/api/workspaces/${s.workspace.id}/history`,
      `/api/projects/${s.project.id}/history`,
      "/api/installation/history",
    ]) {
      const res = await s.app.request(path, bearer);
      expect(res.status).toBe(401);
    }
  });

  it("lets a system administrator see installation events but no private workspace history", async () => {
    const s = await readyScenario();
    const events = await readHistory(s.app, "/api/installation/history", s.adminCookie);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "installation_bootstrap",
        "installation_invitation_created",
        "installation_invitation_accepted",
      ]),
    );
    expect(events.every((event) => event.scope.kind === "installation")).toBe(true);

    const issued = events.find((event) => event.id.startsWith(`${s.invitation.id}:`));
    expect(issued).toMatchObject({
      actor: { humanId: s.admin.id, email: s.admin.email },
      subject: { humanId: null, email: "invited@example.com" },
    });
    const accepted = events.find((event) => event.type === "installation_invitation_accepted");
    expect(accepted).toMatchObject({
      actor: { humanId: null, email: "invited@example.com" },
      subject: { humanId: s.admin.id, email: s.admin.email },
    });
    const declined = events.find((event) => event.type === "installation_invitation_declined");
    expect(declined).toMatchObject({
      actor: { humanId: null, email: "declined@example.com" },
      subject: { humanId: s.admin.id, email: s.admin.email },
    });
    expect(JSON.stringify(events)).not.toContain(s.otherWorkspace.id);
    expect(JSON.stringify(events)).not.toContain(s.otherProject.id);

    await expectProblem(
      await getJson(s.app, `/api/workspaces/${s.otherWorkspace.id}/history`, s.adminCookie),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await getJson(s.app, `/api/projects/${s.otherProject.id}/history`, s.adminCookie),
      404,
      "project_not_found",
    );

    await expectProblem(
      await getJson(s.app, "/api/installation/history", s.member.cookie),
      403,
      "not_system_administrator",
    );
  });

  it("keeps the project owner's access events in project history behind Manage", async () => {
    const s = await readyScenario();
    const ownerEvents = await readHistory(
      s.app,
      `/api/projects/${s.project.id}/history`,
      s.adminCookie,
    );
    expect(ownerEvents.some((event) => event.kind === "project_access")).toBe(true);
    const delegateEvents = await readHistory(
      s.app,
      `/api/projects/${s.project.id}/history`,
      s.delegate.cookie,
    );
    expect(delegateEvents.some((event) => event.kind === "project_access")).toBe(true);

    await expectProblem(
      await getJson(s.app, `/api/projects/${randomUUID()}/history`, s.adminCookie),
      404,
      "project_not_found",
    );
  });

  it("reads project access and activity inside one repeatable-read snapshot", async () => {
    const s = await readyScenario();
    const service = createHistoryService({
      db: database.db,
      projectAccessCeiling: async (tx, workspaceId, humanId, projectIds) => {
        const ceiling = await projectAccessCeilingInTransaction(
          tx,
          workspaceId,
          humanId,
          projectIds,
        );
        // Commit a concurrent purge after this transaction has taken its snapshot
        // but before the activity and access reads. A split read would observe the
        // deletion; the single repeatable-read transaction must still see both.
        await database.sql`delete from project_activity where project_id = ${s.project.id}`;
        await database.sql`delete from project_access_events where project_id = ${s.project.id}`;
        return ceiling;
      },
    });

    const events = await service.projectHistory(
      {
        humanId: s.admin.id,
        email: s.admin.email,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
      s.project.id,
    );
    expect(events.some((event) => event.kind === "project_activity")).toBe(true);
    expect(events.some((event) => event.kind === "project_access")).toBe(true);
  });

  it("lets a personal workspace owner read their credential events and refuses everyone else", async () => {
    const s = await readyScenario();
    const [personal] = await database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, s.admin.id))
      .limit(1);
    if (personal === undefined) throw new Error("the administrator has no personal workspace");

    const projectResponse = await postJson(
      s.app,
      `/api/workspaces/${personal.id}/projects`,
      { name: "Personal Project" },
      s.adminCookie,
    );
    expect(projectResponse.status).toBe(201);
    const project = Project.parse(await projectResponse.json());
    const agentResponse = await postJson(
      s.app,
      "/api/agents",
      { name: "Personal Bot" },
      s.adminCookie,
    );
    expect(agentResponse.status).toBe(201);
    const agentId = idOf(await agentResponse.json(), "the agent id");
    const keyResponse = await postJson(
      s.app,
      "/api/agents/keys",
      {
        agentId,
        workspaceId: personal.id,
        validity: "30",
        projects: [{ projectId: project.id, level: "read" }],
      },
      s.adminCookie,
    );
    expect(keyResponse.status).toBe(201);

    const events = await readHistory(
      s.app,
      `/api/workspaces/${personal.id}/history`,
      s.adminCookie,
    );
    expect(
      events.some((event) => event.kind === "agent_key" && event.type === "agent_key_created"),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(
      text(field(await keyResponse.json(), "secret"), "the key secret"),
    );
    await expectProblem(
      await getJson(s.app, `/api/workspaces/${personal.id}/history`, s.member.cookie),
      404,
      "workspace_not_found",
    );
  });
});

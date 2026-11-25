import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  IssueDetail,
  Problem,
  Project,
  ProjectAccessCandidatesResponse,
  ProjectAccessHumanIds,
  ProjectAccessGrant,
  ProjectAccessGrantsResponse,
  ProjectsResponse,
  Workspace,
  WorkspaceMember,
  WorkspaceMembersResponse,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  browserSessions,
  humans,
  projectAccessEvents,
  projectAccessGrants,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createWorkspacesFeature } from "../workspaces/index.ts";
import { createProjectsFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const MEMBER_EMAIL = "member@example.com";
const COLLEAGUE_EMAIL = "colleague@example.com";
const OUTSIDER_EMAIL = "outsider@example.com";
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

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(await problemBody(res)).toMatchObject({ status, code });
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string") throw new Error(`missing ${what}`);
  return id;
}

function activityTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event): string[] => {
    const type = field(event, "type");
    return typeof type === "string" ? [type] : [];
  });
}

let databaseForHelpers: Database;
const currentDatabase = () => databaseForHelpers;

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  const cause = rootCause(error);
  const name =
    typeof cause === "object" && cause !== null
      ? (Reflect.get(cause, "constraint") ?? Reflect.get(cause, "constraint_name"))
      : undefined;
  return [cause?.message ?? String(error), typeof name === "string" ? name : ""]
    .filter((part) => part !== "")
    .join(" ");
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

async function insertHuman(email: string, isSystemAdministrator = false) {
  const [human] = await currentDatabase()
    .db.insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`now()`,
      isSystemAdministrator,
    })
    .returning();
  if (human === undefined) throw new Error("the account was not created");
  return human;
}

async function sessionFor(humanId: string) {
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

async function addMembership(workspaceId: string, humanId: string) {
  await currentDatabase()
    .db.insert(workspaceMemberships)
    .values({ id: randomUUID(), workspaceId, humanId, isOwner: false });
}

async function secondHuman(email: string, workspaceId?: string) {
  const human = await insertHuman(email);
  if (workspaceId !== undefined) await addMembership(workspaceId, human.id);
  return { human, cookie: await sessionFor(human.id) };
}

async function adminId() {
  const [admin] = await currentDatabase()
    .db.select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, ADMIN_EMAIL));
  if (admin === undefined) throw new Error("the administrator was not found");
  return admin.id;
}

async function personalWorkspaceId(humanId: string) {
  const [workspace] = await currentDatabase()
    .db.select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("the personal workspace was not found");
  return workspace.id;
}

async function createSharedWorkspace(app: Hono, cookie: string, name: string) {
  const res = await postJson(app, "/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  return Workspace.parse(await res.json());
}

async function createProject(app: Hono, cookie: string, workspaceId: string, name: string) {
  const res = await postJson(app, `/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(app: Hono, cookie: string, projectId: string, title = "An issue") {
  const res = await postJson(app, `/api/projects/${projectId}/issues`, { title }, cookie);
  expect(res.status).toBe(201);
  return { id: idOf(await res.json(), "the issue id") };
}

async function grantAccess(
  app: Hono,
  cookie: string,
  projectId: string,
  email: string,
  level: "read" | "contribute" | "manage",
) {
  const res = await patchJson(app, `/api/projects/${projectId}/access`, { email, level }, cookie);
  expect(res.status).toBe(200);
  return ProjectAccessGrant.parse(await res.json());
}

describe("shared project access", () => {
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
      await tx.execute(sql`delete from project_access_events`);
      await tx.execute(sql`delete from project_access_grants`);
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from issue_links`);
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
    const projects = createProjectsFeature({
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
      deliver: async () => {},
      log: silentLogger,
      revokeMemberProjectAccess: (tx, targetWorkspaceId, humanId, actorHumanId) =>
        projects.revokeMemberProjectAccess(tx, targetWorkspaceId, humanId, actorHumanId),
      revokeMemberWorkspaceKeys: async () => {},
      releaseMemberWorkSessions: async () => {},
      applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
        projects.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
    });
    return createApp({
      features: [accounts, workspacesFeature, projects],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
  }

  async function readyApp() {
    const app = makeApp();
    await bootstrapAdmin(app);
    const id = await adminId();
    return {
      app,
      admin: { id, email: ADMIN_EMAIL },
      adminCookie: await cookieFor(app, ADMIN_EMAIL, ADMIN_PASSWORD),
      personalWorkspaceId: await personalWorkspaceId(id),
    };
  }

  it("lets a shared workspace owner create and manage every project", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");

    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    expect(project).toMatchObject({
      workspaceId: workspace.id,
      name: "Launch",
      workspaceKind: "shared",
      accessLevel: "manage",
      createdBy: { email: ADMIN_EMAIL },
    });

    const listed = await getJson(app, `/api/workspaces/${workspace.id}/projects`, adminCookie);
    expect(listed.status).toBe(200);
    expect(ProjectsResponse.parse(await listed.json())).toEqual([project]);

    const renamed = await patchJson(
      app,
      `/api/projects/${project.id}`,
      { name: "Launch Plan" },
      adminCookie,
    );
    expect(renamed.status).toBe(200);
    expect(Project.parse(await renamed.json())).toMatchObject({
      id: project.id,
      name: "Launch Plan",
      workspaceKind: "shared",
      accessLevel: "manage",
    });

    const activity = await getJson(app, `/api/projects/${project.id}/activity`, adminCookie);
    expect(activity.status).toBe(200);
    expect(activityTypes(await activity.json())).toEqual(["project_created", "project_renamed"]);
  });

  it("grants Create projects and gives the member Manage on the project they create", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");
    const ownerProject = await createProject(app, adminCookie, workspace.id, "Owner Project");
    const member = await secondHuman(MEMBER_EMAIL, workspace.id);

    const memberWorkspace = await getJson(app, `/api/workspaces/${workspace.id}`, member.cookie);
    expect(memberWorkspace.status).toBe(200);
    expect(Workspace.parse(await memberWorkspace.json())).toMatchObject({
      id: workspace.id,
      isOwner: false,
      canCreateProjects: false,
    });
    const memberList = await getJson(
      app,
      `/api/workspaces/${workspace.id}/projects`,
      member.cookie,
    );
    expect(memberList.status).toBe(200);
    expect(await memberList.json()).toEqual([]);
    await expectProblem(
      await getJson(app, `/api/projects/${ownerProject.id}`, member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "No" },
        member.cookie,
      ),
      403,
      "project_creation_not_allowed",
    );

    const members = await getJson(app, `/api/workspaces/${workspace.id}/members`, adminCookie);
    expect(members.status).toBe(200);
    expect(WorkspaceMembersResponse.parse(await members.json())).toContainEqual(
      expect.objectContaining({ humanId: member.human.id, canCreateProjects: false }),
    );

    const granted = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      { canCreateProjects: true },
      adminCookie,
    );
    expect(granted.status).toBe(200);
    expect(WorkspaceMember.parse(await granted.json())).toMatchObject({
      humanId: member.human.id,
      canCreateProjects: true,
    });

    const [grantEvent] = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.type, "create_projects_granted"));
    expect(grantEvent).toMatchObject({
      workspaceId: workspace.id,
      actorHumanId: await adminId(),
      subjectHumanId: member.human.id,
    });

    const memberProject = await createProject(app, member.cookie, workspace.id, "Member Project");
    expect(memberProject).toMatchObject({
      workspaceId: workspace.id,
      workspaceKind: "shared",
      accessLevel: "manage",
      createdBy: { humanId: member.human.id, email: MEMBER_EMAIL },
    });

    const [creatorGrant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, memberProject.id));
    expect(creatorGrant).toMatchObject({
      humanId: member.human.id,
      level: "manage",
      grantedByHumanId: member.human.id,
    });
    const visible = await getJson(app, `/api/workspaces/${workspace.id}/projects`, member.cookie);
    expect(visible.status).toBe(200);
    expect(ProjectsResponse.parse(await visible.json())).toEqual([memberProject]);

    const ownerView = await getJson(app, `/api/projects/${memberProject.id}`, adminCookie);
    expect(ownerView.status).toBe(200);
    expect(Project.parse(await ownerView.json())).toMatchObject({
      id: memberProject.id,
      accessLevel: "manage",
    });
    const ownerRename = await patchJson(
      app,
      `/api/projects/${memberProject.id}`,
      { name: "Member Project Renamed" },
      adminCookie,
    );
    expect(ownerRename.status).toBe(200);
    const ownerList = await getJson(app, `/api/workspaces/${workspace.id}/projects`, adminCookie);
    expect(ownerList.status).toBe(200);
    expect(ProjectsResponse.parse(await ownerList.json()).map((item) => item.id)).toEqual([
      ownerProject.id,
      memberProject.id,
    ]);

    const revoked = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      { canCreateProjects: false },
      adminCookie,
    );
    expect(revoked.status).toBe(200);
    expect(WorkspaceMember.parse(await revoked.json()).canCreateProjects).toBe(false);
    await expectProblem(
      await postJson(
        app,
        `/api/workspaces/${workspace.id}/projects`,
        { name: "No" },
        member.cookie,
      ),
      403,
      "project_creation_not_allowed",
    );
    const revokeEvents = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.type, "create_projects_revoked"));
    expect(revokeEvents).toHaveLength(1);
  });

  it("enforces Read, Contribute, and Manage through direct requests", async () => {
    const { app, adminCookie, personalWorkspaceId: adminPersonal } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");
    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    const issue = await createIssue(app, adminCookie, project.id);
    const knowledgeRes = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Runbook" },
      adminCookie,
    );
    expect(knowledgeRes.status).toBe(201);
    const knowledge = { id: idOf(await knowledgeRes.json(), "the knowledge entry id") };

    const member = await secondHuman(MEMBER_EMAIL, workspace.id);
    const colleague = await secondHuman(COLLEAGUE_EMAIL, workspace.id);
    const outsider = await secondHuman(OUTSIDER_EMAIL);
    await addMembership(workspace.id, outsider.human.id);

    const nonMember = await secondHuman("nonmember@example.com");

    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "read");
    const reads = [
      `/api/projects/${project.id}`,
      `/api/projects/${project.id}/issues`,
      `/api/issues/${issue.id}`,
      `/api/issues/${issue.id}/comments`,
      `/api/projects/${project.id}/activity`,
      `/api/projects/${project.id}/knowledge`,
      `/api/knowledge/${knowledge.id}`,
    ];
    for (const path of reads) {
      const res = await getJson(app, path, member.cookie);
      expect(res.status).toBe(200);
    }

    const deniedMutations = [
      await postJson(app, `/api/projects/${project.id}/issues`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/issues/${issue.id}`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/issues/${issue.id}`, { status: "done" }, member.cookie),
      await postJson(app, `/api/issues/${issue.id}/comments`, { body: "No" }, member.cookie),
      await postJson(app, `/api/projects/${project.id}/knowledge`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/knowledge/${knowledge.id}`, { title: "No" }, member.cookie),
      await patchJson(app, `/api/projects/${project.id}`, { name: "No" }, member.cookie),
      await getJson(app, `/api/projects/${project.id}/access`, member.cookie),
      await patchJson(
        app,
        `/api/projects/${project.id}/access`,
        { email: COLLEAGUE_EMAIL, level: "read" },
        member.cookie,
      ),
      await deleteRequest(
        app,
        `/api/projects/${project.id}/access/${colleague.human.id}`,
        member.cookie,
      ),
    ];
    for (const res of deniedMutations) {
      await expectProblem(res, 403, "insufficient_project_access");
    }

    await expectProblem(
      await getJson(app, `/api/projects/${project.id}`, nonMember.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${adminPersonal}`, nonMember.cookie),
      404,
      "project_not_found",
    );

    const contribute = await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "contribute");
    expect(contribute).toMatchObject({ level: "contribute", email: MEMBER_EMAIL });

    const createdIssue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "Contributed issue" },
      member.cookie,
    );
    expect(createdIssue.status).toBe(201);
    const contributedIssue = { id: idOf(await createdIssue.json(), "the contributed issue id") };

    const edited = await patchJson(
      app,
      `/api/issues/${contributedIssue.id}`,
      { title: "Edited by member" },
      member.cookie,
    );
    expect(edited.status).toBe(200);
    const closed = await patchJson(
      app,
      `/api/issues/${contributedIssue.id}`,
      { status: "done" },
      member.cookie,
    );
    expect(closed.status).toBe(200);
    const reopened = await patchJson(
      app,
      `/api/issues/${contributedIssue.id}`,
      { status: "todo" },
      member.cookie,
    );
    expect(reopened.status).toBe(200);
    const commented = await postJson(
      app,
      `/api/issues/${contributedIssue.id}/comments`,
      { body: "A member comment." },
      member.cookie,
    );
    expect(commented.status).toBe(201);
    const createdKnowledge = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Member knowledge" },
      member.cookie,
    );
    expect(createdKnowledge.status).toBe(201);
    const editedKnowledge = await patchJson(
      app,
      `/api/knowledge/${knowledge.id}`,
      { body: "Updated by member." },
      member.cookie,
    );
    expect(editedKnowledge.status).toBe(200);

    await expectProblem(
      await patchJson(app, `/api/projects/${project.id}`, { name: "No" }, member.cookie),
      403,
      "insufficient_project_access",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}/access`, member.cookie),
      403,
      "insufficient_project_access",
    );

    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "manage");
    const renamed = await patchJson(
      app,
      `/api/projects/${project.id}`,
      { name: "Launch Plan" },
      member.cookie,
    );
    expect(renamed.status).toBe(200);
    expect(Project.parse(await renamed.json())).toMatchObject({ name: "Launch Plan" });

    const accessList = await getJson(app, `/api/projects/${project.id}/access`, member.cookie);
    expect(accessList.status).toBe(200);
    expect(ProjectAccessGrantsResponse.parse(await accessList.json())).toContainEqual(
      expect.objectContaining({ humanId: member.human.id, level: "manage" }),
    );

    const colleagueGrant = await grantAccess(
      app,
      member.cookie,
      project.id,
      COLLEAGUE_EMAIL,
      "read",
    );
    expect(colleagueGrant).toMatchObject({
      email: COLLEAGUE_EMAIL,
      level: "read",
      grantedBy: { email: MEMBER_EMAIL },
    });
    const colleagueRead = await getJson(app, `/api/projects/${project.id}`, colleague.cookie);
    expect(colleagueRead.status).toBe(200);
    expect(Project.parse(await colleagueRead.json()).accessLevel).toBe("read");

    const deleted = await deleteRequest(
      app,
      `/api/projects/${project.id}/access/${colleague.human.id}`,
      member.cookie,
    );
    expect(deleted.status).toBe(204);
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}`, colleague.cookie),
      404,
      "project_not_found",
    );

    await expectProblem(
      await patchJson(
        app,
        `/api/projects/${project.id}/access`,
        { email: "stranger@example.com", level: "read" },
        member.cookie,
      ),
      404,
      "member_not_found",
    );

    const events = await database.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.projectId, project.id))
      .orderBy(projectAccessEvents.createdAt, projectAccessEvents.id);
    expect(
      events.map((event) => ({
        type: event.type,
        level: event.level,
        previousLevel: event.previousLevel,
        subject: event.subjectHumanId,
        actor: event.actorHumanId,
      })),
    ).toEqual([
      {
        type: "project_access_granted",
        level: "read",
        previousLevel: null,
        subject: member.human.id,
        actor: await adminId(),
      },
      {
        type: "project_access_level_changed",
        level: "contribute",
        previousLevel: "read",
        subject: member.human.id,
        actor: await adminId(),
      },
      {
        type: "project_access_level_changed",
        level: "manage",
        previousLevel: "contribute",
        subject: member.human.id,
        actor: await adminId(),
      },
      {
        type: "project_access_granted",
        level: "read",
        previousLevel: null,
        subject: colleague.human.id,
        actor: member.human.id,
      },
      {
        type: "project_access_revoked",
        level: null,
        previousLevel: "read",
        subject: colleague.human.id,
        actor: member.human.id,
      },
    ]);

    const removed = await deleteRequest(
      app,
      `/api/workspaces/${workspace.id}/members/${member.human.id}`,
      adminCookie,
    );
    expect(removed.status).toBe(204);
    const memberGrants = await database.db
      .select()
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.humanId, member.human.id));
    expect(memberGrants).toEqual([]);
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}`, member.cookie),
      404,
      "project_not_found",
    );
    const removalEvents = await database.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.subjectHumanId, member.human.id));
    expect(removalEvents.map((event) => event.type)).toContain("project_access_revoked");
  });

  it("keeps personal projects private and gives the system administrator no free access", async () => {
    const { app, admin, adminCookie, personalWorkspaceId: adminPersonal } = await readyApp();
    const adminProject = await createProject(app, adminCookie, adminPersonal, "Private Notes");
    const adminIssue = await createIssue(app, adminCookie, adminProject.id, "Private issue");

    const member = await secondHuman(MEMBER_EMAIL);
    const outsider = await secondHuman(OUTSIDER_EMAIL);

    await expectProblem(
      await getJson(app, `/api/workspaces/${adminPersonal}/projects`, member.cookie),
      404,
      "workspace_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${adminProject.id}`, member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/issues/${adminIssue.id}`, member.cookie),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${adminPersonal}/projects`, outsider.cookie),
      404,
      "workspace_not_found",
    );

    const otherWorkspace = await createSharedWorkspace(app, outsider.cookie, "Elsewhere");
    const otherProject = await createProject(app, outsider.cookie, otherWorkspace.id, "Their Work");
    await expectProblem(
      await getJson(app, `/api/projects/${otherProject.id}`, member.cookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${otherWorkspace.id}/projects`, member.cookie),
      404,
      "workspace_not_found",
    );

    await expectProblem(
      await getJson(app, `/api/projects/${otherProject.id}`, adminCookie),
      404,
      "project_not_found",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${otherWorkspace.id}/projects`, adminCookie),
      404,
      "workspace_not_found",
    );

    await addMembership(otherWorkspace.id, admin.id);
    const list = await getJson(app, `/api/workspaces/${otherWorkspace.id}/projects`, adminCookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    await expectProblem(
      await getJson(app, `/api/projects/${otherProject.id}`, adminCookie),
      404,
      "project_not_found",
    );

    await expectProblem(
      await getJson(app, `/api/projects/${adminProject.id}`, outsider.cookie),
      404,
      "project_not_found",
    );
  });

  it("enforces grant scope and level shapes at the database", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Rocket Team");
    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    const member = await secondHuman(MEMBER_EMAIL, workspace.id);
    const outsider = await secondHuman(OUTSIDER_EMAIL);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");

    const personal = await createProject(
      app,
      adminCookie,
      await personalWorkspaceId(admin.id),
      "Private",
    );

    expect(
      await rejection(
        database.db.insert(projectAccessGrants).values({
          id: randomUUID(),
          projectId: personal.id,
          humanId: member.human.id,
          level: "read",
          grantedByHumanId: admin.id,
        }),
      ),
    ).toContain("project_access_grant_shared_only");

    expect(
      await rejection(
        database.db.insert(projectAccessGrants).values({
          id: randomUUID(),
          projectId: project.id,
          humanId: outsider.human.id,
          level: "read",
          grantedByHumanId: admin.id,
        }),
      ),
    ).toContain("project_access_grant_member");

    expect(
      await rejection(
        database.sql`
          insert into project_access_grants
            (id, project_id, human_id, level, granted_by_human_id)
          values
            (${randomUUID()}, ${project.id}, ${member.human.id}, ${"owner"}, ${admin.id})
        `,
      ),
    ).toContain("project_access_grants_level");

    expect(
      await rejection(
        database.db.insert(projectAccessEvents).values({
          id: randomUUID(),
          projectId: project.id,
          workspaceId: workspace.id,
          actorHumanId: admin.id,
          subjectHumanId: member.human.id,
          type: "project_access_granted",
          level: "read",
          previousLevel: "contribute",
        }),
      ),
    ).toContain("project_access_events_shape");

    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: project.id,
      humanId: member.human.id,
      level: "read",
      grantedByHumanId: admin.id,
    });
    await database.db.insert(projectAccessEvents).values({
      id: randomUUID(),
      projectId: project.id,
      workspaceId: workspace.id,
      actorHumanId: admin.id,
      subjectHumanId: member.human.id,
      type: "project_access_granted",
      level: "read",
    });
  });

  it("refuses mutating a workspace owner's implicit project access or Create projects capability", async () => {
    const { app, adminCookie } = await readyApp();
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");
    const workspace = await createSharedWorkspace(app, adminCookie, "Owner Authority");
    const manager = await secondHuman("manager@example.com", workspace.id);
    const project = await createProject(app, adminCookie, workspace.id, "Core");

    const granted = await patchJson(
      app,
      `/api/projects/${project.id}/access`,
      { email: manager.human.email, level: "manage" },
      adminCookie,
    );
    expect(granted.status).toBe(200);

    const eventsBefore = await database.db.select().from(projectAccessEvents);

    const grantOwner = await patchJson(
      app,
      `/api/projects/${project.id}/access`,
      { email: admin.email, level: "read" },
      manager.cookie,
    );
    expect(grantOwner.status).toBe(409);
    expect(await problemBody(grantOwner)).toMatchObject({ code: "workspace_owner_access" });

    const revokeOwner = await deleteRequest(
      app,
      `/api/projects/${project.id}/access/${admin.id}`,
      manager.cookie,
    );
    expect(revokeOwner.status).toBe(409);
    expect(await problemBody(revokeOwner)).toMatchObject({ code: "workspace_owner_access" });

    expect(await database.db.select().from(projectAccessEvents)).toHaveLength(eventsBefore.length);
    const grantsAfter = ProjectAccessGrantsResponse.parse(
      await (await getJson(app, `/api/projects/${project.id}/access`, adminCookie)).json(),
    );
    expect(grantsAfter.map((g) => g.humanId)).toEqual([manager.human.id]);

    const promoted = await postJson(
      app,
      `/api/workspaces/${workspace.id}/owners`,
      { humanId: manager.human.id },
      adminCookie,
    );
    expect(promoted.status).toBe(200);
    const grantsAfterPromotion = ProjectAccessGrantsResponse.parse(
      await (await getJson(app, `/api/projects/${project.id}/access`, adminCookie)).json(),
    );
    expect(grantsAfterPromotion).toEqual([]);

    const wsEventsBefore = await database.db.select().from(workspaceEvents);

    const revokeOwnerCap = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${admin.id}`,
      { canCreateProjects: false },
      adminCookie,
    );
    expect(revokeOwnerCap.status).toBe(409);
    expect(await problemBody(revokeOwnerCap)).toMatchObject({
      code: "workspace_owner_capability",
    });

    const grantOwnerCap = await patchJson(
      app,
      `/api/workspaces/${workspace.id}/members/${admin.id}`,
      { canCreateProjects: true },
      adminCookie,
    );
    expect(grantOwnerCap.status).toBe(200);
    expect(WorkspaceMember.parse(await grantOwnerCap.json())).toMatchObject({
      humanId: admin.id,
      isOwner: true,
      canCreateProjects: true,
    });
    expect(await database.db.select().from(workspaceEvents)).toHaveLength(wsEventsBefore.length);
  });

  it("lets Read inspect issue links but only Contribute add or remove them", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Linked Team");
    const project = await createProject(app, adminCookie, workspace.id, "Links");
    const issue = await createIssue(app, adminCookie, project.id, "Link permissions");
    const reader = await secondHuman(MEMBER_EMAIL, workspace.id);
    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "read");

    const added = await postJson(
      app,
      `/api/issues/${issue.id}/links`,
      { url: "https://github.com/forge-orbit/orrery/pull/87", title: "PR", kind: "pr" },
      adminCookie,
    );
    expect(added.status).toBe(201);
    const linkId = idOf(await added.json(), "the link");

    const asReader = await getJson(app, `/api/issues/${issue.id}`, reader.cookie);
    expect(asReader.status).toBe(200);
    expect(IssueDetail.parse(await asReader.json()).links).toHaveLength(1);

    await expectProblem(
      await postJson(
        app,
        `/api/issues/${issue.id}/links`,
        { url: "https://example.com/a", title: "Nope", kind: "link" },
        reader.cookie,
      ),
      403,
      "insufficient_project_access",
    );
    await expectProblem(
      await deleteRequest(app, `/api/issues/${issue.id}/links/${linkId}`, reader.cookie),
      403,
      "insufficient_project_access",
    );

    const outsider = await secondHuman(OUTSIDER_EMAIL);
    await expectProblem(
      await getJson(app, `/api/issues/${issue.id}`, outsider.cookie),
      404,
      "issue_not_found",
    );

    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "contribute");
    const contributed = await postJson(
      app,
      `/api/issues/${issue.id}/links`,
      { url: "https://example.com/docs", title: "Doc", kind: "doc" },
      reader.cookie,
    );
    expect(contributed.status).toBe(201);
    const removed = await deleteRequest(
      app,
      `/api/issues/${issue.id}/links/${linkId}`,
      reader.cookie,
    );
    expect(removed.status).toBe(204);
    expect(
      IssueDetail.parse(await (await getJson(app, `/api/issues/${issue.id}`, reader.cookie)).json())
        .links,
    ).toHaveLength(1);
  });

  it("exposes only current grant holders to project contributors for the assignee warning", async () => {
    const { app, adminCookie } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Access Lab");
    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    const member = await secondHuman(MEMBER_EMAIL, workspace.id);
    const colleague = await secondHuman(COLLEAGUE_EMAIL, workspace.id);
    const outsider = await secondHuman(OUTSIDER_EMAIL);

    const before = await getJson(app, `/api/projects/${project.id}/access/humans`, adminCookie);
    expect(before.status).toBe(200);
    expect(ProjectAccessHumanIds.parse(await before.json())).toEqual([]);

    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "contribute");
    const granted = await getJson(app, `/api/projects/${project.id}/access/humans`, adminCookie);
    expect(ProjectAccessHumanIds.parse(await granted.json())).toEqual([member.human.id]);
    // A Contributor can assign issues, so they can see the ids used for the warning.
    const contributorView = await getJson(
      app,
      `/api/projects/${project.id}/access/humans`,
      member.cookie,
    );
    expect(ProjectAccessHumanIds.parse(await contributorView.json())).toEqual([member.human.id]);
    await grantAccess(app, adminCookie, project.id, COLLEAGUE_EMAIL, "read");
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}/access/humans`, colleague.cookie),
      403,
      "insufficient_project_access",
    );
    await expectProblem(
      await getJson(app, `/api/projects/${project.id}/access/humans`, outsider.cookie),
      404,
      "project_not_found",
    );
  });

  it("suggests grant candidates to a project manager without the member directory", async () => {
    const { app, adminCookie, personalWorkspaceId: adminPersonal } = await readyApp();
    const workspace = await createSharedWorkspace(app, adminCookie, "Candidates Lab");
    const project = await createProject(app, adminCookie, workspace.id, "Launch");
    const manager = await secondHuman(MEMBER_EMAIL, workspace.id);
    const colleague = await secondHuman(COLLEAGUE_EMAIL, workspace.id);
    const reader = await secondHuman("reader@example.com", workspace.id);
    const suspended = await secondHuman("suspended@example.com", workspace.id);
    const deactivated = await secondHuman("deactivated@example.com", workspace.id);
    const outsider = await secondHuman(OUTSIDER_EMAIL);

    await database.db
      .update(workspaceMemberships)
      .set({ suspendedAt: sql`now()` })
      .where(eq(workspaceMemberships.humanId, suspended.human.id));
    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`now()` })
      .where(eq(humans.id, deactivated.human.id));
    await grantAccess(app, adminCookie, project.id, reader.human.email, "read");

    const path = `/api/projects/${project.id}/access/candidates`;
    await expectProblem(await getJson(app, path), 401, "not_signed_in");
    await expectProblem(await getJson(app, path, outsider.cookie), 404, "project_not_found");
    await expectProblem(
      await getJson(app, path, reader.cookie),
      403,
      "insufficient_project_access",
    );
    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "contribute");
    await expectProblem(
      await getJson(app, path, manager.cookie),
      403,
      "insufficient_project_access",
    );

    await grantAccess(app, adminCookie, project.id, MEMBER_EMAIL, "manage");
    const suggested = await getJson(app, path, manager.cookie);
    expect(suggested.status).toBe(200);
    expect(ProjectAccessCandidatesResponse.parse(await suggested.json())).toEqual([
      {
        humanId: colleague.human.id,
        email: COLLEAGUE_EMAIL,
        displayName: null,
        avatarUrl: null,
      },
    ]);

    await grantAccess(app, manager.cookie, project.id, COLLEAGUE_EMAIL, "read");
    const afterGrant = await getJson(app, path, manager.cookie);
    expect(afterGrant.status).toBe(200);
    expect(ProjectAccessCandidatesResponse.parse(await afterGrant.json())).toEqual([]);

    const personal = await createProject(app, adminCookie, adminPersonal, "Private");
    const personalCandidates = await getJson(
      app,
      `/api/projects/${personal.id}/access/candidates`,
      adminCookie,
    );
    expect(personalCandidates.status).toBe(200);
    expect(await personalCandidates.json()).toEqual([]);
  });
});

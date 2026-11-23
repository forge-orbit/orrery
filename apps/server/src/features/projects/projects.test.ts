import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Issue,
  IssueComment,
  IssueCommentsResponse,
  IssueDependency,
  IssueDetail,
  IssueLink,
  IssuesResponse,
  type CreateIssueRequest,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Problem,
  Project,
  ProjectActivityResponse,
  ProjectKey,
  ProjectsResponse,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  humans,
  issueComments,
  issueDependencies,
  issues,
  knowledgeEntries,
  projectActivity,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";

const silentLogger = createLogger("error");

const postJson = async (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const patchJson = async (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const patchIssue = (app: Hono, issueId: string, body: unknown, cookie: string) =>
  patchJson(app, `/api/issues/${issueId}`, body, cookie);

const getJson = async (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const deleteJson = async (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const addDependency = async (
  app: Hono,
  cookie: string,
  issueId: string,
  blockedByIssueId: string,
) => postJson(app, `/api/issues/${issueId}/blocked-by`, { blockedByIssueId }, cookie);

const deleteRequest = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { method: "DELETE", ...(cookie ? { headers: { cookie } } : {}) });

const problemBody = async (res: Response) => Problem.parse(await res.json());

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(await problemBody(res)).toMatchObject({ status, code });
}

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
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  return cookie;
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
  return rootCause(error)?.message ?? String(error);
}

async function personalWorkspaceId(humanId: string) {
  const [workspace] = await currentDatabase()
    .db.select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, humanId));
  if (workspace === undefined) throw new Error("the personal workspace was not found");
  return workspace.id;
}

async function adminId() {
  const [admin] = await currentDatabase()
    .db.select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, EMAIL));
  if (admin === undefined) throw new Error("the administrator was not found");
  return admin.id;
}

async function createProject(
  app: Hono,
  cookie: string,
  workspaceId: string,
  name = "Personal Project",
) {
  const res = await postJson(app, `/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(
  app: Hono,
  cookie: string,
  projectId: string,
  input: CreateIssueRequest = { title: "First issue" },
) {
  const res = await postJson(app, `/api/projects/${projectId}/issues`, input, cookie);
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

async function activityFor(app: Hono, cookie: string, projectId: string) {
  const res = await getJson(app, `/api/projects/${projectId}/activity`, cookie);
  expect(res.status).toBe(200);
  return ProjectActivityResponse.parse(await res.json());
}

describe("projects", () => {
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
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from agent_api_keys`);
      await tx.execute(sql`delete from agents`);
      await tx.execute(sql`delete from issue_dependencies`);
      await tx.execute(sql`delete from issue_labels`);
      await tx.execute(sql`delete from project_labels`);
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
    const projectsFeature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async () => null,
      sessionGate: async () => true,
    });
    const app = createApp({
      features: [accounts, projectsFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    return app;
  }

  async function readyApp() {
    const app = makeApp();
    await bootstrapAdmin(app);
    const id = await adminId();
    return {
      app,
      admin: { id, email: EMAIL },
      adminCookie: await cookieFor(app, EMAIL, PASSWORD),
      workspaceId: await personalWorkspaceId(id),
    };
  }

  it("refuses every unauthenticated path to a personal project", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const issue = await createIssue(app, adminCookie, project.id);

    expect(project).toMatchObject({
      workspaceId,
      name: "Personal Project",
      createdBy: { humanId: admin.id, email: EMAIL },
    });
    expect(project.createdAt).toMatch(/Z$/);
    expect(issue).toMatchObject({
      projectId: project.id,
      number: 1,
      status: "todo",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
      closedAt: null,
    });

    const anonymous = [
      await getJson(app, `/api/workspaces/${workspaceId}/projects`),
      await getJson(app, `/api/projects/${project.id}`),
      await getJson(app, `/api/projects/${project.id}/issues`),
      await getJson(app, `/api/issues/${issue.id}`),
      await getJson(app, `/api/issues/${issue.id}/comments`),
      await getJson(app, `/api/projects/${project.id}/activity`),
      await getJson(app, `/api/projects/${project.id}/knowledge`),
      await postJson(app, `/api/workspaces/${workspaceId}/projects`, { name: "No" }),
      await postJson(app, `/api/projects/${project.id}/issues`, { title: "No" }),
      await postJson(app, `/api/issues/${issue.id}/comments`, { body: "No" }),
      await postJson(app, `/api/projects/${project.id}/knowledge`, { title: "No" }),
      await patchJson(app, `/api/issues/${issue.id}`, { status: "done" }),
      await patchJson(app, `/api/knowledge/${randomUUID()}`, { title: "No" }),
    ];
    for (const res of anonymous) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
    }

    const visible = await getJson(app, `/api/workspaces/${workspaceId}/projects`, adminCookie);
    expect(visible.status).toBe(200);
    expect(ProjectsResponse.parse(await visible.json())).toEqual([project]);
  });

  it("runs the issue cycle and persists authorship and activity", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const created = await createIssue(app, adminCookie, project.id, {
      title: "Write the release notes",
      body: "Draft the **release notes** for the next version.",
    });

    const [createdRow] = await database.db.select().from(issues).where(eq(issues.id, created.id));
    expect(createdRow).toMatchObject({
      projectId: project.id,
      number: 1,
      title: "Write the release notes",
      body: "Draft the **release notes** for the next version.",
      status: "todo",
      createdByHumanId: admin.id,
      updatedByHumanId: admin.id,
      closedAt: null,
    });

    const edited = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { title: "Write the final release notes", body: "Final **release notes**." },
      adminCookie,
    );
    expect(edited.status).toBe(200);
    const editedIssue = Issue.parse(await edited.json());
    expect(editedIssue).toMatchObject({
      title: "Write the final release notes",
      body: "Final **release notes**.",
      status: "todo",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
    });
    expect(editedIssue.updatedAt >= created.updatedAt).toBe(true);

    const commented = await postJson(
      app,
      `/api/issues/${created.id}/comments`,
      { body: "The notes are ready for review." },
      adminCookie,
    );
    expect(commented.status).toBe(201);
    const comment = IssueComment.parse(await commented.json());
    expect(comment).toMatchObject({
      issueId: created.id,
      body: "The notes are ready for review.",
      author: { humanId: admin.id, email: EMAIL },
    });
    const [commentRow] = await database.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, comment.id));
    expect(commentRow).toMatchObject({ issueId: created.id, createdByHumanId: admin.id });

    const comments = await getJson(app, `/api/issues/${created.id}/comments`, adminCookie);
    expect(comments.status).toBe(200);
    expect(IssueCommentsResponse.parse(await comments.json())).toEqual([comment]);

    const closed = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { status: "done" },
      adminCookie,
    );
    expect(closed.status).toBe(200);
    const closedIssue = Issue.parse(await closed.json());
    expect(closedIssue.status).toBe("done");
    expect(closedIssue.closedAt).not.toBeNull();
    const closedAt = closedIssue.closedAt;

    const editedWhileClosed = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { body: "An addendum while closed." },
      adminCookie,
    );
    expect(editedWhileClosed.status).toBe(200);
    const stillClosed = Issue.parse(await editedWhileClosed.json());
    expect(stillClosed.status).toBe("done");
    expect(stillClosed.closedAt).toBe(closedAt);

    const reopened = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { status: "todo" },
      adminCookie,
    );
    expect(reopened.status).toBe(200);
    const reopenedIssue = Issue.parse(await reopened.json());
    expect(reopenedIssue.status).toBe("todo");
    expect(reopenedIssue.closedAt).toBeNull();

    const closeAgain = await patchJson(
      app,
      `/api/issues/${created.id}`,
      { status: "todo" },
      adminCookie,
    );
    expect(closeAgain.status).toBe(200);
    expect(Issue.parse(await closeAgain.json()).status).toBe("todo");

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.map((event) => event.type)).toEqual([
      "project_created",
      "issue_created",
      "issue_edited",
      "issue_commented",
      "issue_closed",
      "issue_edited",
      "issue_reopened",
    ]);
    for (const event of activity) {
      expect(event.actor).toMatchObject({ humanId: admin.id, email: EMAIL });
      expect(event.projectId).toBe(project.id);
    }
    expect(activity[0]?.summary).toBe("Personal Project");
    expect(activity[1]).toMatchObject({ summary: "Write the release notes", issueId: created.id });
    expect(activity[2]).toMatchObject({ summary: "Write the final release notes" });
    expect(activity[3]).toMatchObject({ summary: "Write the final release notes" });
    expect(activity[4]).toMatchObject({ summary: "Write the final release notes" });

    const eventRows = await database.db
      .select()
      .from(projectActivity)
      .where(eq(projectActivity.projectId, project.id))
      .orderBy(projectActivity.createdAt, projectActivity.id);
    expect(eventRows.map((row) => row.type)).toEqual(activity.map((event) => event.type));
    for (const row of eventRows) expect(row.actorHumanId).toBe(admin.id);

    const fetched = await getJson(app, `/api/issues/${created.id}`, adminCookie);
    expect(fetched.status).toBe(200);
    expect(Issue.parse(await fetched.json())).toMatchObject({
      title: "Write the final release notes",
      body: "An addendum while closed.",
      status: "todo",
      createdBy: { humanId: admin.id },
      updatedBy: { humanId: admin.id },
    });
    const listed = await getJson(app, `/api/projects/${project.id}/issues`, adminCookie);
    expect(listed.status).toBe(200);
    expect(IssuesResponse.parse(await listed.json())).toHaveLength(1);
  });

  it("numbers issues per project and settles concurrent creations without duplicates", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const other = await createProject(app, adminCookie, workspaceId, "Another Project");

    const results = await Promise.all(
      ["One", "Two", "Three", "Four", "Five"].map((title) =>
        postJson(app, `/api/projects/${project.id}/issues`, { title }, adminCookie),
      ),
    );
    expect(results.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    const numbers = await Promise.all(
      results.map(async (res) => Issue.parse(await res.json()).number),
    );
    expect(numbers.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    const firstInOther = await createIssue(app, adminCookie, other.id, { title: "Other first" });
    expect(firstInOther.number).toBe(1);

    const rows = await database.db
      .select({ number: issues.number })
      .from(issues)
      .where(eq(issues.projectId, project.id));
    expect(rows.map((row) => row.number).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("creates and updates priority and sortOrder, and lists issues in board order", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);

    const plain = await createIssue(app, adminCookie, project.id, { title: "Plain" });
    expect(plain).toMatchObject({ priority: "none", sortOrder: 65535 });

    const urgent = await createIssue(app, adminCookie, project.id, {
      title: "Urgent",
      priority: "urgent",
      sortOrder: 42,
    });
    expect(urgent).toMatchObject({ priority: "urgent", sortOrder: 42 });
    const low = await createIssue(app, adminCookie, project.id, {
      title: "Low",
      priority: "low",
      sortOrder: 10,
    });

    const listed = await getJson(app, `/api/projects/${project.id}/issues`, adminCookie);
    expect(listed.status).toBe(200);
    expect(IssuesResponse.parse(await listed.json()).map((issue) => issue.id)).toEqual([
      urgent.id,
      low.id,
      plain.id,
    ]);

    const updated = await patchJson(
      app,
      `/api/issues/${plain.id}`,
      { priority: "high", sortOrder: 20 },
      adminCookie,
    );
    expect(updated.status).toBe(200);
    const updatedIssue = Issue.parse(await updated.json());
    expect(updatedIssue).toMatchObject({
      priority: "high",
      sortOrder: 20,
      updatedBy: { humanId: await adminId() },
    });
    const afterReorder = await getJson(app, `/api/projects/${project.id}/issues`, adminCookie);
    expect(IssuesResponse.parse(await afterReorder.json()).map((issue) => issue.id)).toEqual([
      urgent.id,
      plain.id,
      low.id,
    ]);

    const before = await activityFor(app, adminCookie, project.id);
    const noop = await patchJson(
      app,
      `/api/issues/${plain.id}`,
      { priority: "high", sortOrder: 20 },
      adminCookie,
    );
    expect(noop.status).toBe(200);
    expect(Issue.parse(await noop.json()).updatedAt).toBe(updatedIssue.updatedAt);
    expect((await activityFor(app, adminCookie, project.id)).length).toBe(before.length);

    const writerId = await adminId();
    expect(
      await rejection(
        database.db.execute(sql`
          insert into issues
            (id, project_id, number, title, status, priority, sort_order, created_by_human_id, updated_by_human_id)
          values
            (${randomUUID()}, ${project.id}, 99, 'Bypass', 'todo', 'critical', 1, ${writerId}, ${writerId})
        `),
      ),
    ).toContain("issues_priority");

    for (const nonFinite of [
      "'Infinity'::double precision",
      "'-Infinity'::double precision",
      "'NaN'::double precision",
    ]) {
      expect(
        await rejection(
          database.db.execute(sql`
            insert into issues
              (id, project_id, number, title, status, priority, sort_order, created_by_human_id, updated_by_human_id)
            values
              (${randomUUID()}, ${project.id}, 98, 'Non-finite', 'todo', 'none', ${sql.raw(nonFinite)}, ${writerId}, ${writerId})
          `),
        ),
      ).toContain("issues_sort_order_finite");
    }
  });

  it("creates and edits a basic Markdown knowledge entry with authorship and activity", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);

    const created = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Deployment notes", body: "# Deploy\n\nRun `pnpm build` first." },
      adminCookie,
    );
    expect(created.status).toBe(201);
    const entry = KnowledgeEntry.parse(await created.json());
    expect(entry).toMatchObject({
      projectId: project.id,
      title: "Deployment notes",
      body: "# Deploy\n\nRun `pnpm build` first.",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
    });

    const edited = await patchJson(
      app,
      `/api/knowledge/${entry.id}`,
      { title: "Deployment runbook", body: "## Deploy\n\nRun `pnpm build` then `pnpm start`." },
      adminCookie,
    );
    expect(edited.status).toBe(200);
    const editedEntry = KnowledgeEntry.parse(await edited.json());
    expect(editedEntry).toMatchObject({
      title: "Deployment runbook",
      body: "## Deploy\n\nRun `pnpm build` then `pnpm start`.",
      createdBy: { humanId: admin.id, email: EMAIL },
      updatedBy: { humanId: admin.id, email: EMAIL },
    });
    expect(editedEntry.updatedAt >= entry.updatedAt).toBe(true);

    const [row] = await database.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, entry.id));
    expect(row).toMatchObject({
      projectId: project.id,
      title: "Deployment runbook",
      body: "## Deploy\n\nRun `pnpm build` then `pnpm start`.",
      createdByHumanId: admin.id,
      updatedByHumanId: admin.id,
    });

    const listed = await getJson(app, `/api/projects/${project.id}/knowledge`, adminCookie);
    expect(listed.status).toBe(200);
    expect(KnowledgeEntriesResponse.parse(await listed.json())).toEqual([editedEntry]);

    const fetched = await getJson(app, `/api/knowledge/${entry.id}`, adminCookie);
    expect(fetched.status).toBe(200);
    expect(KnowledgeEntry.parse(await fetched.json())).toEqual(editedEntry);

    const noop = await patchJson(
      app,
      `/api/knowledge/${entry.id}`,
      { title: "Deployment runbook" },
      adminCookie,
    );
    expect(noop.status).toBe(200);
    expect(KnowledgeEntry.parse(await noop.json())).toEqual(editedEntry);

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.map((event) => event.type)).toEqual([
      "project_created",
      "knowledge_created",
      "knowledge_edited",
    ]);
    expect(activity[1]).toMatchObject({
      summary: "Deployment notes",
      knowledgeEntryId: entry.id,
      actor: { humanId: admin.id, email: EMAIL },
    });
    expect(activity[2]).toMatchObject({
      summary: "Deployment runbook",
      knowledgeEntryId: entry.id,
      actor: { humanId: admin.id, email: EMAIL },
    });
  });

  it("enforces the activity target by event type at the database", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const issue = await createIssue(app, adminCookie, project.id);
    const knowledgeResponse = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "Target check" },
      adminCookie,
    );
    expect(knowledgeResponse.status).toBe(201);
    const knowledge = KnowledgeEntry.parse(await knowledgeResponse.json());

    const invalid = [
      { type: "project_created", issueId: issue.id, knowledgeEntryId: null },
      { type: "project_created", issueId: null, knowledgeEntryId: knowledge.id },
      { type: "issue_created", issueId: null, knowledgeEntryId: null },
      { type: "issue_commented", issueId: issue.id, knowledgeEntryId: knowledge.id },
      { type: "knowledge_created", issueId: issue.id, knowledgeEntryId: knowledge.id },
      { type: "knowledge_edited", issueId: null, knowledgeEntryId: null },
    ] as const;
    for (const values of invalid) {
      expect(
        await rejection(
          database.db.insert(projectActivity).values({
            id: randomUUID(),
            projectId: project.id,
            actorHumanId: admin.id,
            summary: "Target check",
            createdAt: sql`statement_timestamp()`,
            ...values,
          }),
        ),
      ).toContain("project_activity_target_matches_type");
    }

    await database.db.insert(projectActivity).values({
      id: randomUUID(),
      projectId: project.id,
      actorHumanId: admin.id,
      type: "project_created",
      summary: "Valid target",
      createdAt: sql`statement_timestamp()`,
    });
  });

  it("answers invalid ids and request shapes with validation Problems", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const tooLong = "a".repeat(201);

    const invalidIds = [
      await getJson(app, `/api/workspaces/${tooLong}/projects`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}/issues`, adminCookie),
      await getJson(app, `/api/issues/${tooLong}`, adminCookie),
      await getJson(app, `/api/issues/${tooLong}/comments`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}/activity`, adminCookie),
      await getJson(app, `/api/projects/${tooLong}/knowledge`, adminCookie),
      await getJson(app, `/api/knowledge/${tooLong}`, adminCookie),
    ];
    for (const res of invalidIds) {
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });
    }

    const blankProject = await postJson(
      app,
      `/api/workspaces/${workspaceId}/projects`,
      { name: "   " },
      adminCookie,
    );
    expect(blankProject.status).toBe(400);
    expect(await problemBody(blankProject)).toMatchObject({
      code: "validation_failed",
      errors: [{ pointer: "/name" }],
    });

    const blankIssue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "  " },
      adminCookie,
    );
    expect(blankIssue.status).toBe(400);
    expect(await problemBody(blankIssue)).toMatchObject({
      code: "validation_failed",
      errors: [{ pointer: "/title" }],
    });

    const validIssue = await postJson(
      app,
      `/api/projects/${project.id}/issues`,
      { title: "Valid" },
      adminCookie,
    );
    expect(validIssue.status).toBe(201);
    const issue = Issue.parse(await validIssue.json());
    const emptyComment = await postJson(
      app,
      `/api/issues/${issue.id}/comments`,
      { body: "   " },
      adminCookie,
    );
    expect(emptyComment.status).toBe(400);
    expect(await problemBody(emptyComment)).toMatchObject({ code: "validation_failed" });

    const blankKnowledge = await postJson(
      app,
      `/api/projects/${project.id}/knowledge`,
      { title: "  " },
      adminCookie,
    );
    expect(blankKnowledge.status).toBe(400);
    expect(await problemBody(blankKnowledge)).toMatchObject({ code: "validation_failed" });

    expect(await database.db.select().from(projects)).toHaveLength(1);
    expect(await database.db.select().from(issues)).toHaveLength(1);
    expect(await database.db.select().from(issueComments)).toHaveLength(0);
    expect(await database.db.select().from(knowledgeEntries)).toHaveLength(0);
  });

  it("lets a shared workspace owner create and manage its projects", async () => {
    const { app, adminCookie } = await readyApp();
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("expected bootstrapped admin");

    const sharedId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: sharedId,
        kind: "shared",
        name: "Shared Team",
      });
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: sharedId,
        humanId: admin.id,
        isOwner: true,
      });
    });

    const empty = await getJson(app, `/api/workspaces/${sharedId}/projects`, adminCookie);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const created = await postJson(
      app,
      `/api/workspaces/${sharedId}/projects`,
      { name: "Shared Project" },
      adminCookie,
    );
    expect(created.status).toBe(201);
    expect(Project.parse(await created.json())).toMatchObject({
      workspaceId: sharedId,
      name: "Shared Project",
      workspaceKind: "shared",
      accessLevel: "manage",
    });

    const listed = await getJson(app, `/api/workspaces/${sharedId}/projects`, adminCookie);
    expect(listed.status).toBe(200);
    expect(ProjectsResponse.parse(await listed.json())).toHaveLength(1);
  });

  it("serializes concurrent issue updates so edits and closes never lose updates or duplicate events", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Concurrency");
    const issue = await createIssue(app, adminCookie, project.id, {
      title: "Original title",
      body: "Original body",
    });

    const [close1, editTitle, close2] = await Promise.all([
      patchJson(app, `/api/issues/${issue.id}`, { status: "done" }, adminCookie),
      patchJson(app, `/api/issues/${issue.id}`, { title: "Updated title" }, adminCookie),
      patchJson(app, `/api/issues/${issue.id}`, { status: "done" }, adminCookie),
    ]);
    expect(close1.status).toBe(200);
    expect(editTitle.status).toBe(200);
    expect(close2.status).toBe(200);

    const finalRes = await getJson(app, `/api/issues/${issue.id}`, adminCookie);
    expect(finalRes.status).toBe(200);
    expect(await finalRes.json()).toMatchObject({
      title: "Updated title",
      status: "done",
    });

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.filter((entry) => entry.type === "issue_closed")).toHaveLength(1);
    expect(activity.filter((entry) => entry.type === "issue_edited")).toHaveLength(1);
  });

  it("records blocked_by relations in both directions and in activity", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId);
    const blocker = await createIssue(app, adminCookie, project.id, { title: "Prerequisite" });
    const downstream = await createIssue(app, adminCookie, project.id, { title: "Downstream" });

    const added = await addDependency(app, adminCookie, downstream.id, blocker.id);
    expect(added.status).toBe(201);
    expect(IssueDependency.parse(await added.json())).toMatchObject({
      issueId: downstream.id,
      blockedByIssueId: blocker.id,
      createdBy: { humanId: admin.id, email: EMAIL },
    });

    expect((await addDependency(app, adminCookie, downstream.id, blocker.id)).status).toBe(201);
    const rows = await database.db
      .select()
      .from(issueDependencies)
      .where(eq(issueDependencies.issueId, downstream.id));
    expect(rows).toHaveLength(1);

    const listed = await getJson(app, `/api/projects/${project.id}/issues`, adminCookie);
    const listedDownstream = IssuesResponse.parse(await listed.json()).find(
      (issue) => issue.id === downstream.id,
    );
    expect(listedDownstream?.blockedByIds).toEqual([blocker.id]);

    const blockedBy = await getJson(app, `/api/issues/${downstream.id}/blocked-by`, adminCookie);
    expect(blockedBy.status).toBe(200);
    expect(IssuesResponse.parse(await blockedBy.json()).map((issue) => issue.id)).toEqual([
      blocker.id,
    ]);
    const blocking = await getJson(app, `/api/issues/${blocker.id}/blocking`, adminCookie);
    expect(blocking.status).toBe(200);
    expect(IssuesResponse.parse(await blocking.json()).map((issue) => issue.id)).toEqual([
      downstream.id,
    ]);

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.filter((entry) => entry.type === "issue_dependency_added")).toHaveLength(1);

    expect(
      (await deleteJson(app, `/api/issues/${downstream.id}/blocked-by/${blocker.id}`, adminCookie))
        .status,
    ).toBe(204);

    expect(
      (await deleteJson(app, `/api/issues/${downstream.id}/blocked-by/${blocker.id}`, adminCookie))
        .status,
    ).toBe(204);
    const afterRemoval = await getJson(app, `/api/issues/${downstream.id}/blocked-by`, adminCookie);
    expect(IssuesResponse.parse(await afterRemoval.json())).toEqual([]);
    const afterActivity = await activityFor(app, adminCookie, project.id);
    expect(afterActivity.filter((entry) => entry.type === "issue_dependency_removed")).toHaveLength(
      1,
    );
  });

  it("refuses self-links, cross-project links and cycles as Problems", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Deps");
    const other = await createProject(app, adminCookie, workspaceId, "Other");
    const a = await createIssue(app, adminCookie, project.id, { title: "A" });
    const b = await createIssue(app, adminCookie, project.id, { title: "B" });
    const c = await createIssue(app, adminCookie, project.id, { title: "C" });
    const foreign = await createIssue(app, adminCookie, other.id, { title: "Foreign" });

    const self = await addDependency(app, adminCookie, a.id, a.id);
    expect(self.status).toBe(400);
    expect(await problemBody(self)).toMatchObject({ status: 400, code: "self_dependency" });

    const cross = await addDependency(app, adminCookie, a.id, foreign.id);
    expect(cross.status).toBe(400);
    expect(await problemBody(cross)).toMatchObject({
      status: 400,
      code: "cross_project_dependency",
    });

    expect((await addDependency(app, adminCookie, a.id, b.id)).status).toBe(201);
    expect((await addDependency(app, adminCookie, b.id, c.id)).status).toBe(201);
    const cycle = await addDependency(app, adminCookie, c.id, a.id);
    expect(cycle.status).toBe(409);
    expect(await problemBody(cycle)).toMatchObject({ status: 409, code: "dependency_cycle" });

    const constraint = await rejection(
      database.db.insert(issueDependencies).values({
        id: randomUUID(),
        issueId: a.id,
        blockedByIssueId: a.id,
        createdByHumanId: admin.id,
        createdAt: new Date(),
      }),
    );
    expect(constraint).toContain("issue_dependencies_no_self_link");
  });

  it("serializes concurrent adds so two disjoint pairs cannot close a longer cycle", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Concurrent deps");
    const a = await createIssue(app, adminCookie, project.id, { title: "A" });
    const b = await createIssue(app, adminCookie, project.id, { title: "B" });
    const c = await createIssue(app, adminCookie, project.id, { title: "C" });
    const d = await createIssue(app, adminCookie, project.id, { title: "D" });

    expect((await addDependency(app, adminCookie, a.id, b.id)).status).toBe(201);
    expect((await addDependency(app, adminCookie, c.id, d.id)).status).toBe(201);
    const raced = await Promise.all([
      addDependency(app, adminCookie, b.id, c.id),
      addDependency(app, adminCookie, d.id, a.id),
    ]);
    const accepted = raced.filter((res) => res.status === 201);
    const refused = raced.filter((res) => res.status === 409);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await problemBody(refused[0]!)).toMatchObject({
      status: 409,
      code: "dependency_cycle",
    });
  });

  it("persists structured links with web-only validation, uniqueness, and activity", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Linked");
    const issue = await createIssue(app, adminCookie, project.id, { title: "With links" });

    const detail = async () => {
      const res = await getJson(app, `/api/issues/${issue.id}`, adminCookie);
      expect(res.status).toBe(200);
      return IssueDetail.parse(await res.json());
    };
    expect((await detail()).links).toEqual([]);

    const prUrl = "https://github.com/forge-orbit/orrery/pull/87";
    const added = await postJson(
      app,
      `/api/issues/${issue.id}/links`,
      { url: prUrl, title: "Structured links PR", kind: "pr" },
      adminCookie,
    );
    expect(added.status).toBe(201);
    const link = IssueLink.parse(await added.json());
    expect(link).toMatchObject({
      issueId: issue.id,
      url: prUrl,
      title: "Structured links PR",
      kind: "pr",
      createdBy: { humanId: admin.id, email: EMAIL },
    });

    const doc = await postJson(
      app,
      `/api/issues/${issue.id}/links`,
      { url: "http://docs.example.com/design", title: "Design note", kind: "doc" },
      adminCookie,
    );
    expect(doc.status).toBe(201);
    expect((await detail()).links.map((entry) => entry.kind)).toEqual(["pr", "doc"]);

    const duplicate = await postJson(
      app,
      `/api/issues/${issue.id}/links`,
      { url: prUrl, title: "Again", kind: "link" },
      adminCookie,
    );
    await expectProblem(duplicate, 409, "issue_link_exists");

    for (const scheme of ["javascript:alert(1)", "file:///etc/passwd"]) {
      const rejected = await postJson(
        app,
        `/api/issues/${issue.id}/links`,
        { url: scheme, title: "Unsafe", kind: "link" },
        adminCookie,
      );
      await expectProblem(rejected, 400, "validation_failed");
    }
    expect((await detail()).links).toHaveLength(2);

    const activity = await activityFor(app, adminCookie, project.id);
    expect(activity.filter((entry) => entry.type === "issue_link_added")).toHaveLength(2);

    const removed = await deleteRequest(
      app,
      `/api/issues/${issue.id}/links/${link.id}`,
      adminCookie,
    );
    expect(removed.status).toBe(204);
    expect((await detail()).links).toHaveLength(1);

    const removedAgain = await deleteRequest(
      app,
      `/api/issues/${issue.id}/links/${link.id}`,
      adminCookie,
    );
    await expectProblem(removedAgain, 404, "issue_link_not_found");

    const afterRemoval = await activityFor(app, adminCookie, project.id);
    expect(afterRemoval.filter((entry) => entry.type === "issue_link_removed")).toHaveLength(1);
  });

  async function seedAgent(workspaceId: string, humanId: string, name: string) {
    const agentId = randomUUID();
    await database.db.insert(agents).values({
      id: agentId,
      humanId,
      name,
      createdAt: sql`statement_timestamp()`,
    });
    const keyId = randomUUID();
    await database.db.insert(agentApiKeys).values({
      id: keyId,
      agentId,
      workspaceId,
      createdByHumanId: humanId,
      validity: "never",
      tokenHash: randomUUID(),
      createdAt: sql`statement_timestamp()`,
    });
    return { agentId, keyId };
  }

  it("sets, changes and clears an assignee, and validates it against the workspace", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Assigned");
    const issue = await createIssue(app, adminCookie, project.id, { title: "Assign me" });
    expect(issue.assignee).toBeNull();
    expect(issue.needsInput).toBe(false);
    const { agentId } = await seedAgent(workspaceId, admin.id, "Builder");

    const toHuman = await patchIssue(
      app,
      issue.id,
      { assignee: { type: "human", id: admin.id } },
      adminCookie,
    );
    expect(toHuman.status).toBe(200);
    expect(Issue.parse(await toHuman.json()).assignee).toMatchObject({
      humanId: admin.id,
      email: EMAIL,
      displayName: EMAIL,
    });

    const toAgent = await patchIssue(
      app,
      issue.id,
      { assignee: { type: "agent", id: agentId } },
      adminCookie,
    );
    expect(toAgent.status).toBe(200);
    expect(Issue.parse(await toAgent.json()).assignee).toMatchObject({
      agentId,
      agentName: "Builder",
      displayName: "Builder",
    });
    const [row] = await database.db
      .select({ type: issues.assigneeType, id: issues.assigneeId })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(row).toEqual({ type: "agent", id: agentId });

    const cleared = await patchIssue(app, issue.id, { assignee: null }, adminCookie);
    expect(cleared.status).toBe(200);
    expect(Issue.parse(await cleared.json()).assignee).toBeNull();
    const [afterClear] = await database.db
      .select({ type: issues.assigneeType, id: issues.assigneeId })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(afterClear).toEqual({ type: null, id: null });

    const kept = await patchIssue(app, issue.id, { title: "Still unassigned" }, adminCookie);
    expect(Issue.parse(await kept.json()).assignee).toBeNull();
  });

  it("refuses unknown, unregistered and deactivated assignees with one 404", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Bad assignees");
    const issue = await createIssue(app, adminCookie, project.id, { title: "Guarded" });

    await expectProblem(
      await patchIssue(
        app,
        issue.id,
        { assignee: { type: "human", id: randomUUID() } },
        adminCookie,
      ),
      404,
      "assignee_not_found",
    );
    const { agentId } = await seedAgent(workspaceId, admin.id, "No key here");
    await database.db.delete(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
    await expectProblem(
      await patchIssue(app, issue.id, { assignee: { type: "agent", id: agentId } }, adminCookie),
      404,
      "assignee_not_found",
    );

    const { agentId: revokedId, keyId } = await seedAgent(workspaceId, admin.id, "Revoked");
    await database.db
      .update(agentApiKeys)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(agentApiKeys.id, keyId));
    await expectProblem(
      await patchIssue(app, issue.id, { assignee: { type: "agent", id: revokedId } }, adminCookie),
      404,
      "assignee_not_found",
    );

    const [row] = await database.db
      .select({ type: issues.assigneeType, id: issues.assigneeId })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(row).toEqual({ type: null, id: null });
  });

  it("stores an explicit workspace-unique key and derives one from the name when omitted", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const createWithKey = async (name: string, key?: string) => {
      const res = await postJson(
        app,
        `/api/workspaces/${workspaceId}/projects`,
        key === undefined ? { name } : { name, key },
        adminCookie,
      );
      expect(res.status).toBe(201);
      return Project.parse(await res.json());
    };

    const explicit = await createWithKey("Orchard", "ORR");
    expect(explicit.key).toBe("ORR");
    expect(ProjectKey.parse(explicit.key)).toBe("ORR");
    const fetched = await getJson(app, `/api/projects/${explicit.id}`, adminCookie);
    expect(Project.parse(await fetched.json()).key).toBe("ORR");
    const listed = await getJson(app, `/api/workspaces/${workspaceId}/projects`, adminCookie);
    expect(
      ProjectsResponse.parse(await listed.json()).find((p) => p.id === explicit.id),
    ).toMatchObject({ key: "ORR" });

    await expectProblem(
      await postJson(
        app,
        `/api/workspaces/${workspaceId}/projects`,
        { name: "Other Orchard", key: "ORR" },
        adminCookie,
      ),
      409,
      "project_key_taken",
    );
    await expectProblem(
      await postJson(
        app,
        `/api/workspaces/${workspaceId}/projects`,
        { name: "Lowercase", key: "orr" },
        adminCookie,
      ),
      400,
      "validation_failed",
    );

    const first = await createProject(app, adminCookie, workspaceId, "Alpha Beta");
    const second = await createProject(app, adminCookie, workspaceId, "Alpha Beta");
    expect(first.key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(second.key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    expect(first.key).not.toBe(second.key);
    expect(first.key).not.toBe("ORR");
  });

  it("keeps the key immutable and enforces its format and workspace uniqueness in the database", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await postJson(
      app,
      `/api/workspaces/${workspaceId}/projects`,
      { name: "Fixed", key: "FIX" },
      adminCookie,
    );
    expect(project.status).toBe(201);
    const fixed = Project.parse(await project.json());

    await expectProblem(
      await patchJson(
        app,
        `/api/projects/${fixed.id}`,
        { name: "Renamed", key: "NEW" },
        adminCookie,
      ),
      409,
      "project_key_immutable",
    );
    const after = await getJson(app, `/api/projects/${fixed.id}`, adminCookie);
    expect(Project.parse(await after.json())).toMatchObject({ name: "Fixed", key: "FIX" });
    const renamed = await patchJson(
      app,
      `/api/projects/${fixed.id}`,
      { name: "Renamed" },
      adminCookie,
    );
    expect(Project.parse(await renamed.json())).toMatchObject({ name: "Renamed", key: "FIX" });

    const other = await postJson(
      app,
      `/api/workspaces/${workspaceId}/projects`,
      { name: "Other", key: "OTH" },
      adminCookie,
    );
    expect(other.status).toBe(201);
    expect(
      await rejection(
        database.db.execute(sql`update projects set key = 'bad' where id = ${fixed.id}`),
      ),
    ).toContain("projects_key_format");
    expect(
      await rejection(
        database.db.execute(sql`update projects set key = 'OTH' where id = ${fixed.id}`),
      ),
    ).toContain("one_project_key_per_workspace");
  });

  it("carries the formatted <KEY>-<N> identifier on every issue payload", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const created = await postJson(
      app,
      `/api/workspaces/${workspaceId}/projects`,
      { name: "Issue Keys", key: "ISK" },
      adminCookie,
    );
    expect(created.status).toBe(201);
    const project = Project.parse(await created.json());

    const first = await createIssue(app, adminCookie, project.id, { title: "First" });
    const second = await createIssue(app, adminCookie, project.id, { title: "Second" });
    expect(first.identifier).toBe("ISK-1");
    expect(second.identifier).toBe("ISK-2");

    const listed = await getJson(app, `/api/projects/${project.id}/issues`, adminCookie);
    expect(IssuesResponse.parse(await listed.json()).map((issue) => issue.identifier)).toEqual([
      "ISK-1",
      "ISK-2",
    ]);
    const fetched = await getJson(app, `/api/issues/${first.id}`, adminCookie);
    expect(IssueDetail.parse(await fetched.json()).identifier).toBe("ISK-1");
    const edited = await patchIssue(app, first.id, { title: "Edited" }, adminCookie);
    expect(Issue.parse(await edited.json()).identifier).toBe("ISK-1");
  });

  it("keeps the assignee pair integral in the database and records only real changes", async () => {
    const { app, admin, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Integral");
    const issue = await createIssue(app, adminCookie, project.id, { title: "Integrity" });

    expect(
      await rejection(
        database.db.execute(sql`update issues set assignee_type = 'human' where id = ${issue.id}`),
      ),
    ).toContain("issues_assignee_pair");
    expect(
      await rejection(
        database.db.execute(
          sql`update issues set assignee_type = 'robot', assignee_id = ${randomUUID()} where id = ${issue.id}`,
        ),
      ),
    ).toContain("issues_assignee_type");

    await patchIssue(app, issue.id, { assignee: { type: "human", id: admin.id } }, adminCookie);
    const before = await activityFor(app, adminCookie, project.id);
    const repeat = await patchIssue(
      app,
      issue.id,
      { assignee: { type: "human", id: admin.id } },
      adminCookie,
    );
    expect(repeat.status).toBe(200);
    const after = await activityFor(app, adminCookie, project.id);
    expect(after.length).toBe(before.length);
    expect(after.filter((entry) => entry.type === "issue_edited")).toHaveLength(1);
  });

  it("defaults new issues to todo, allows backlog at creation, and enforces the six-state closedAt invariant", async () => {
    const { app, adminCookie, workspaceId } = await readyApp();
    const project = await createProject(app, adminCookie, workspaceId, "Workflow");

    const ready = await createIssue(app, adminCookie, project.id, { title: "Ready" });
    expect(ready).toMatchObject({ status: "todo", closedAt: null });

    const staged = await createIssue(app, adminCookie, project.id, {
      title: "Staged",
      status: "backlog",
    });
    expect(staged).toMatchObject({ status: "backlog", closedAt: null });

    const done = await patchJson(app, `/api/issues/${ready.id}`, { status: "done" }, adminCookie);
    expect(done.status).toBe(200);
    const doneIssue = Issue.parse(await done.json());
    expect(doneIssue).toMatchObject({ status: "done" });
    expect(doneIssue.closedAt).not.toBeNull();

    const reopened = await patchJson(
      app,
      `/api/issues/${ready.id}`,
      { status: "todo" },
      adminCookie,
    );
    expect(Issue.parse(await reopened.json())).toMatchObject({ status: "todo", closedAt: null });

    const cancelled = await patchJson(
      app,
      `/api/issues/${ready.id}`,
      { status: "cancelled" },
      adminCookie,
    );
    expect(Issue.parse(await cancelled.json()).closedAt).not.toBeNull();

    const probe = await createIssue(app, adminCookie, project.id, { title: "Constraint probe" });
    expect(
      await rejection(
        database.db.execute(sql`update issues set status = 'not_a_status' where id = ${probe.id}`),
      ),
    ).toContain("issues_status");
    expect(
      await rejection(
        database.db.execute(
          sql`update issues set status = 'done', closed_at = null where id = ${probe.id}`,
        ),
      ),
    ).toContain("issues_closed_at_matches_status");
  });
});

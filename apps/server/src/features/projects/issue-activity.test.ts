import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Issue,
  IssueCommentsResponse,
  IssueLink,
  Project,
  ProjectActivityResponse,
  ProjectLabel,
  type AgentIdentity,
  type IssueActivityDetail,
  type ProjectActivity,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { humans, projectActivity, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "timeline@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger = createLogger("error");

async function postJson(app: Hono, path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function patchJson(app: Hono, path: string, body: unknown, cookie: string) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function getJson(app: Hono, path: string, cookie?: string) {
  return app.request(path, cookie ? { headers: { cookie } } : undefined);
}

async function deleteRequest(app: Hono, path: string, cookie: string) {
  return app.request(path, { method: "DELETE", headers: { cookie } });
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

async function issueActivity(app: Hono, cookie: string, issueId: string) {
  const res = await getJson(app, `/api/issues/${issueId}/activity`, cookie);
  expect(res.status).toBe(200);
  return ProjectActivityResponse.parse(await res.json());
}

function detailOf(event: ProjectActivity): IssueActivityDetail | null {
  return event.detail;
}

async function createProject(app: Hono, cookie: string, workspaceId: string) {
  const res = await postJson(
    app,
    `/api/workspaces/${workspaceId}/projects`,
    { name: `Timeline ${randomUUID()}` },
    cookie,
  );
  expect(res.status).toBe(201);
  return Project.parse(await res.json());
}

async function createIssue(app: Hono, cookie: string, projectId: string, title = "Timeline issue") {
  const res = await postJson(app, `/api/projects/${projectId}/issues`, { title }, cookie);
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

describe("issue activity timeline", () => {
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
      await tx.execute(sql`delete from project_access_events`);
      await tx.execute(sql`delete from project_access_grants`);
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
    return { app, projects: projectsFeature };
  }

  async function readyApp() {
    const { app, projects: projectsFeature } = makeApp();
    expect(
      (
        await postJson(app, "/api/setup/admin", {
          secret: SECRET,
          email: EMAIL,
          password: PASSWORD,
        })
      ).status,
    ).toBe(201);
    const [admin] = await database.db
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");
    const [workspace] = await database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, admin.id));
    if (workspace === undefined) throw new Error("the personal workspace was not found");
    const cookie = await cookieFor(app, EMAIL, PASSWORD);
    return { app, projects: projectsFeature, admin, workspaceId: workspace.id, cookie };
  }

  it("records structured details for label, status, priority, assignee and parent changes", async () => {
    const { app, admin, cookie, workspaceId } = await readyApp();
    const project = await createProject(app, cookie, workspaceId);
    const issue = await createIssue(app, cookie, project.id);
    const parent = await createIssue(app, cookie, project.id, "Parent issue");

    const labelRes = await postJson(
      app,
      `/api/projects/${project.id}/labels`,
      {
        name: "enhancement",
        color: "#3b74d6",
      },
      cookie,
    );
    expect(labelRes.status).toBe(201);
    const label = ProjectLabel.parse(await labelRes.json());

    expect(
      (await postJson(app, `/api/issues/${issue.id}/labels/${label.id}`, {}, cookie)).status,
    ).toBe(201);
    expect(
      (await deleteRequest(app, `/api/issues/${issue.id}/labels/${label.id}`, cookie)).status,
    ).toBe(200);

    expect(
      (await patchJson(app, `/api/issues/${issue.id}`, { priority: "high" }, cookie)).status,
    ).toBe(200);
    expect(
      (
        await patchJson(
          app,
          `/api/issues/${issue.id}`,
          {
            assignee: { type: "human", id: admin.id },
          },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await patchJson(app, `/api/issues/${issue.id}`, { status: "in_progress" }, cookie)).status,
    ).toBe(200);
    expect(
      (
        await patchJson(
          app,
          `/api/issues/${issue.id}`,
          {
            parentIssueId: parent.id,
          },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (await patchJson(app, `/api/issues/${issue.id}`, { status: "done" }, cookie)).status,
    ).toBe(200);
    expect(
      (await patchJson(app, `/api/issues/${issue.id}`, { status: "todo" }, cookie)).status,
    ).toBe(200);

    const events = await issueActivity(app, cookie, issue.id);
    const find = (kind: IssueActivityDetail["kind"] | "status" | "priority" | "assignee") =>
      events.find((event) => {
        const detail = detailOf(event);
        if (detail === null) return false;
        if (detail.kind === kind) return true;
        return (
          detail.kind === "issue_edited" && detail.changes.some((change) => change.kind === kind)
        );
      });

    expect(find("label_added")).toMatchObject({
      type: "issue_label_added",
      summary: `${issue.title} labelled enhancement`,
      detail: {
        kind: "label_added",
        label: { id: label.id, name: "enhancement", color: "#3b74d6" },
      },
    });
    expect(find("label_removed")).toMatchObject({
      type: "issue_label_removed",
      detail: {
        kind: "label_removed",
        label: { id: label.id, name: "enhancement", color: "#3b74d6" },
      },
    });
    expect(find("priority")).toMatchObject({
      type: "issue_edited",
      detail: {
        kind: "issue_edited",
        changes: [{ kind: "priority", from: "none", to: "high" }],
      },
    });
    expect(find("assignee")).toMatchObject({
      type: "issue_edited",
      detail: {
        kind: "issue_edited",
        changes: [{ kind: "assignee", from: null, to: { humanId: admin.id } }],
      },
    });
    expect(find("status")).toMatchObject({
      type: "issue_edited",
      detail: {
        kind: "issue_edited",
        changes: [{ kind: "status", from: "todo", to: "in_progress" }],
      },
    });
    expect(find("parent_changed")).toMatchObject({
      type: "issue_parent_changed",
      detail: { kind: "parent_changed", from: null, to: parent.id },
    });
    expect(find("issue_closed")).toMatchObject({
      type: "issue_closed",
      detail: { kind: "issue_closed", from: "in_progress", to: "done" },
    });
    expect(find("issue_reopened")).toMatchObject({
      type: "issue_reopened",
      detail: { kind: "issue_reopened", from: "done", to: "todo" },
    });
    for (const event of events) expect(event.actor).toMatchObject({ humanId: admin.id });
  });

  it("records structured details for dependency and link changes", async () => {
    const { app, cookie, workspaceId } = await readyApp();
    const project = await createProject(app, cookie, workspaceId);
    const issue = await createIssue(app, cookie, project.id);
    const blocker = await createIssue(app, cookie, project.id, "Blocker");

    expect(
      (
        await postJson(
          app,
          `/api/issues/${issue.id}/blocked-by`,
          {
            blockedByIssueId: blocker.id,
          },
          cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (await deleteRequest(app, `/api/issues/${issue.id}/blocked-by/${blocker.id}`, cookie)).status,
    ).toBe(204);
    const linkRes = await postJson(
      app,
      `/api/issues/${issue.id}/links`,
      {
        url: "https://example.com/pr/1",
        title: "Pull request",
        kind: "pr",
      },
      cookie,
    );
    expect(linkRes.status).toBe(201);
    const link = IssueLink.parse(await linkRes.json());
    expect(
      (await deleteRequest(app, `/api/issues/${issue.id}/links/${link.id}`, cookie)).status,
    ).toBe(204);

    const events = await issueActivity(app, cookie, issue.id);
    expect(events.find((event) => event.type === "issue_dependency_added")?.detail).toMatchObject({
      kind: "issue_dependency_added",
      blockedByIssueId: blocker.id,
    });
    expect(events.find((event) => event.type === "issue_dependency_removed")?.detail).toMatchObject(
      {
        kind: "issue_dependency_removed",
        blockedByIssueId: blocker.id,
      },
    );
    expect(events.find((event) => event.type === "issue_link_added")?.detail).toMatchObject({
      kind: "issue_link_added",
      linkId: link.id,
      url: "https://example.com/pr/1",
      title: "Pull request",
    });
    expect(events.find((event) => event.type === "issue_link_removed")?.detail).toMatchObject({
      kind: "issue_link_removed",
      linkId: link.id,
    });
  });

  it("returns only the requested issue's activity in chronological order", async () => {
    const { app, cookie, workspaceId } = await readyApp();
    const project = await createProject(app, cookie, workspaceId);
    const first = await createIssue(app, cookie, project.id, "First");
    const second = await createIssue(app, cookie, project.id, "Second");

    expect(
      (
        await postJson(
          app,
          `/api/issues/${first.id}/comments`,
          {
            body: "Only on the first issue",
          },
          cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await postJson(
          app,
          `/api/issues/${second.id}/comments`,
          {
            body: "Only on the second issue",
          },
          cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (await patchJson(app, `/api/issues/${first.id}`, { priority: "urgent" }, cookie)).status,
    ).toBe(200);

    const events = await issueActivity(app, cookie, first.id);
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.issueId === first.id)).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "issue_created",
      "issue_commented",
      "issue_edited",
    ]);
    const timestamps = events.map((event) => Date.parse(event.createdAt));
    expect(timestamps).toEqual(timestamps.toSorted((a, b) => a - b));

    const comment = IssueCommentsResponse.parse(
      await (await getJson(app, `/api/issues/${first.id}/comments`, cookie)).json(),
    );
    expect(comment[0]?.body).toBe("Only on the first issue");
  });

  it("requires Read access and returns a Problem for anonymous or missing issues", async () => {
    const { app, projects: projectsFeature, cookie, workspaceId } = await readyApp();
    const project = await createProject(app, cookie, workspaceId);
    const issue = await createIssue(app, cookie, project.id);

    const anonymous = await getJson(app, `/api/issues/${issue.id}/activity`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toBe("application/problem+json");

    const missing = await getJson(app, `/api/issues/${randomUUID()}/activity`, cookie);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("application/problem+json");

    const identity: AgentIdentity = {
      agentId: randomUUID(),
      name: "reader",
      humanId: "nobody",
      keyId: randomUUID(),
      workspaceId,
      validity: "90",
      projects: [{ projectId: project.id, projectName: project.name, level: "read" }],
    };
    await expect(
      projectsFeature.service.listIssueActivity({ kind: "agent", identity }, issue.id),
    ).resolves.toHaveLength(1);

    const withoutGrant: AgentIdentity = {
      ...identity,
      agentId: randomUUID(),
      projects: [],
    };
    await expect(
      projectsFeature.service.listIssueActivity(
        { kind: "agent", identity: withoutGrant },
        issue.id,
      ),
    ).rejects.toMatchObject({ kind: "issue_not_found" });
  });

  it("falls back to the summary for historical activity rows without detail", async () => {
    const { app, cookie, workspaceId } = await readyApp();
    const project = await createProject(app, cookie, workspaceId);
    const issue = await createIssue(app, cookie, project.id, "Historical");

    const [stored] = await database.db
      .select({ id: projectActivity.id, projectId: projectActivity.projectId })
      .from(projectActivity)
      .where(and(eq(projectActivity.issueId, issue.id), eq(projectActivity.type, "issue_created")))
      .limit(1);
    if (stored === undefined) throw new Error("the issue creation activity was not recorded");
    await database.db
      .update(projectActivity)
      .set({ detail: null, summary: "Legacy creation summary" })
      .where(eq(projectActivity.id, stored.id));

    const events = await issueActivity(app, cookie, issue.id);
    expect(events.find((event) => event.id === stored.id)).toMatchObject({
      id: stored.id,
      summary: "Legacy creation summary",
      detail: null,
    });
  });

  it("keeps the detail column nullable in the Drizzle schema", async () => {
    const { app, cookie, workspaceId } = await readyApp();
    const project = await createProject(app, cookie, workspaceId);
    const issue = await createIssue(app, cookie, project.id);
    const events = await issueActivity(app, cookie, issue.id);
    expect(events.every((event) => event.detail === null || typeof event.detail === "object")).toBe(
      true,
    );

    expect(events[0]?.detail).toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  humans,
  notifications,
  projectAccessGrants,
  projectActivity,
  projects,
  workspaceMemberships,
  workspaces,
  issues,
  issueComments,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { migrate } from "../../platform/migrate.ts";
import { createProjectsService, type WorkActor } from "../projects/index.ts";
import { createNotificationsService } from "./service.ts";

const humanActor = (handle: string, humanId: string, email: string): WorkActor => ({
  kind: "human",
  account: {
    humanId,
    email,
    handle,
    isSystemAdministrator: false,
    emailVerifiedAt: new Date(),
    avatarUrl: null,
  },
});

describe("issue_mentioned notifications", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let workspaceId: string;
  let projectId: string;
  let actor: WorkActor;
  let editorId: string;
  let readerId: string;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterEach(async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from notifications`);
      await tx.execute(sql`delete from issue_comments`);
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from project_access_grants`);
      await tx.execute(sql`delete from issues`);
      await tx.execute(sql`delete from agents`);
      await tx.execute(sql`delete from projects`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from humans`);
    });
  });

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  async function seedHuman(email: string, handle: string) {
    const [row] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email, handle, passwordHash: "hash" })
      .returning({ id: humans.id, handle: humans.handle, email: humans.email });
    if (row === undefined) throw new Error("failed to seed human");
    return row;
  }

  beforeEach(async () => {
    const editor = await seedHuman("editor@example.com", "editor");
    editorId = editor.id;
    const reader = await seedHuman("reader@example.com", "reader");
    readerId = reader.id;
    const reader2 = await seedHuman("reader2@example.com", "reader2");
    const outsider = await seedHuman("outsider@example.com", "outsider");
    workspaceId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: workspaceId,
        kind: "shared",
        name: "Team",
        personalOwnerHumanId: null,
      });
      for (const human of [editor, reader, reader2, outsider]) {
        await tx.insert(workspaceMemberships).values({
          id: randomUUID(),
          workspaceId,
          humanId: human.id,
          isOwner: human.id === editor.id,
        });
      }
    });
    projectId = randomUUID();
    await database.db.insert(projects).values({
      id: projectId,
      workspaceId,
      name: "Mention project",
      key: "MEN",
      nextIssueNumber: 1,
      createdByHumanId: editor.id,
      fallbackPolicy: "require_human",
    });
    await database.db.insert(projectAccessGrants).values([
      {
        id: randomUUID(),
        projectId,
        humanId: reader.id,
        grantedByHumanId: editor.id,
        level: "read",
      },
      {
        id: randomUUID(),
        projectId,
        humanId: reader2.id,
        grantedByHumanId: editor.id,
        level: "read",
      },
    ]);
    actor = humanActor(editor.handle ?? "editor", editor.id, editor.email);
  });

  function services() {
    const notificationsService = createNotificationsService({
      db: database.db,
    });
    const projectsService = createProjectsService({
      db: database.db,
      sessionGate: async () => false,
      notifyActivity: notificationsService.createForActivity,
    });
    return { notificationsService, projectsService };
  }

  async function notificationsFor(handle: string) {
    const [human] = await database.db.select().from(humans).where(eq(humans.handle, handle));
    if (human === undefined) throw new Error("human not found");
    const { notificationsService } = services();
    const result = await notificationsService.list(
      humanActor(human.handle ?? handle, human.id, human.email),
    );
    return result.items;
  }

  it("notifies a mentioned Human with live Read access, once per event", async () => {
    const { projectsService } = services();
    await projectsService.createIssue(actor, projectId, {
      title: "Mention the reader",
      body: "Hello @reader and @reader, please look.",
    });
    const items = await notificationsFor("reader");
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("issue_mentioned");
  });

  it("notifies every readable mentioned Human once from a single activity", async () => {
    const { projectsService } = services();
    await projectsService.createIssue(actor, projectId, {
      title: "Mention both readers",
      body: "Hello @reader and @reader2, please look.",
    });

    expect(await notificationsFor("reader")).toHaveLength(1);
    expect(await notificationsFor("reader2")).toHaveLength(1);
    const [activity] = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(
        and(eq(projectActivity.projectId, projectId), eq(projectActivity.type, "issue_created")),
      );
    expect(activity).toBeDefined();
    const rows = await database.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.activityId, activity!.id));
    expect(rows).toHaveLength(2);
  });

  it("does not notify a Human without project Read access or the author", async () => {
    const { projectsService } = services();
    await projectsService.createIssue(actor, projectId, {
      title: "Mention outsider and self",
      body: "cc @outsider and @editor",
    });
    expect(await notificationsFor("outsider")).toHaveLength(0);
    expect(await notificationsFor("editor")).toHaveLength(0);
  });

  it("notifies only newly added mentions on an edit", async () => {
    const { projectsService } = services();
    const issue = await projectsService.createIssue(actor, projectId, {
      title: "Editing mentions",
      body: "Hello @reader",
    });
    expect(await notificationsFor("reader")).toHaveLength(1);

    await projectsService.updateIssue(actor, issue.id, { body: "Hello @reader and @outsider" });
    expect(await notificationsFor("reader")).toHaveLength(1);
    expect(await notificationsFor("outsider")).toHaveLength(0);

    await projectsService.updateIssue(actor, issue.id, {
      body: "Hello @reader, @outsider and @reader2",
    });
    expect(await notificationsFor("reader2")).toHaveLength(1);
    expect(await notificationsFor("reader")).toHaveLength(1);
  });

  it("notifies mentions in comments", async () => {
    const { projectsService } = services();
    const issue = await projectsService.createIssue(actor, projectId, { title: "A question" });
    await projectsService.createComment(actor, issue.id, { body: "Ping @reader for input" });
    const items = await notificationsFor("reader");
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("issue_mentioned");
    const [activity] = await database.db
      .select({ type: projectActivity.type })
      .from(projectActivity)
      .where(eq(projectActivity.projectId, projectId));
    expect(activity?.type).toBe("issue_created");
  });

  it("ignores mentions inside code and email addresses", async () => {
    const { projectsService } = services();
    await projectsService.createIssue(actor, projectId, {
      title: "No notification",
      body: "`@reader` and reader@example.com and [x](https://example.com/@reader)",
    });
    expect(await notificationsFor("reader")).toHaveLength(0);
    const stored = await database.db.select().from(notifications);
    expect(stored).toHaveLength(0);
  });

  it("stops notifying once Read access is revoked before the event", async () => {
    const { projectsService } = services();
    await database.db
      .delete(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, projectId));
    await projectsService.createIssue(actor, projectId, {
      title: "Revoked reader",
      body: "Hello @reader",
    });
    expect(await notificationsFor("reader")).toHaveLength(0);
    expect(
      await database.db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, projectId)),
    ).toHaveLength(1);
    expect(await database.db.select({ id: issueComments.id }).from(issueComments)).toHaveLength(0);
  });

  it("does not send issue_mentioned to an assignee whose handle was not written", async () => {
    const { projectsService } = services();
    await projectsService.createIssue(actor, projectId, {
      title: "Mention someone else",
      body: "Please review this, @reader2.",
      assigneeHumanId: readerId,
    });
    // The assignee still gets ordinary assignment activity, never a mention notification.
    expect(await notificationsFor("reader")).toHaveLength(0);
    expect(await notificationsFor("reader2")).toHaveLength(1);
    const stored = await database.db.select({ kind: notifications.kind }).from(notifications);
    expect(stored.every((row) => row.kind === "issue_mentioned")).toBe(true);
  });

  it("lets an acting agent @mention its own owning Human", async () => {
    const agentId = randomUUID();
    await database.db.insert(agents).values({ id: agentId, humanId: editorId, name: "builder" });
    const agentActor: WorkActor = {
      kind: "agent",
      identity: {
        agentId,
        name: "builder",
        humanId: editorId,
        keyId: randomUUID(),
        workspaceId,
        validity: "never",
        projects: [{ projectId, projectName: "Mention project", level: "contribute" }],
      },
    };
    const { projectsService } = services();
    await projectsService.createIssue(agentActor, projectId, {
      title: "Agent asks its owner",
      body: "Hey @editor, can you take a look?",
    });
    const items = await notificationsFor("editor");
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("issue_mentioned");
  });
});

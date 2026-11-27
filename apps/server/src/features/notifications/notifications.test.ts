import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AgentIdentity, NotificationsResponse } from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  browserSessions,
  humans,
  issues,
  projectAccessGrants,
  projectActivity,
  projects,
  runs as runRows,
  workSessions,
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
import { createInboxFeature, type InboxService } from "../inbox/index.ts";
import { createProjectsFeature, projectAccessAtLeast, type WorkActor } from "../projects/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { createSessionsFeature, type SessionsService } from "../work-sessions/index.ts";
import { createNotificationsFeature } from "./index.ts";
import { createNotificationsService, type NotificationsService } from "./service.ts";

const SECRET = "correct horse battery staple notifications";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let projectsFeature: ReturnType<typeof createProjectsFeature>;
let agentsFeature: ReturnType<typeof createAgentsFeature>;
let sessions: SessionsService;
let inbox: InboxService;
let notificationsService: NotificationsService;
let liveAuth: AgentAuthenticator | undefined;
let delivered: OutgoingMail[];
let sweepDueQuestions: () => Promise<string[]> = async () => [];

const lateAuth: AgentAuthenticator = (request) => {
  if (liveAuth === undefined) throw new Error("authenticator not wired");
  return liveAuth(request);
};

const humanActor = (humanId: string): WorkActor => ({
  kind: "human",
  account: {
    humanId,
    email: `${humanId}@orrery.test`,
    isSystemAdministrator: false,
    emailVerifiedAt: new Date(),
  },
});

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
  delivered = [];

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  let gate: Parameters<typeof createProjectsFeature>[0]["sessionGate"] | undefined;
  let deadlineEvaluate:
    | Parameters<typeof createProjectsFeature>[0]["evaluateQuestionDeadline"]
    | undefined;
  projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: (tx, agentId, workspaceId, issueId) => {
      if (gate === undefined) throw new Error("gate not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
    evaluateQuestionDeadline: (tx, issueId) => {
      if (deadlineEvaluate === undefined) throw new Error("deadline seam not wired");
      return deadlineEvaluate(tx, issueId);
    },
  });
  agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
  });
  liveAuth = agentsFeature.authenticator;

  notificationsService = createNotificationsService({
    db: database.db,
  });

  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
    questionLeaseDeadline: (tx, issueId) => inbox.questionDeadline(tx, issueId),
    evaluateQuestionDeadline: (tx, issueId) => inbox.evaluateDeadline(tx, issueId),
    dueQuestionIssueIds: () => sweepDueQuestions(),
    notifyActivity: notificationsService.createForActivity,
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  sessions = sessionsFeature.service;

  const inboxFeature = createInboxFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    deliver: async (mail) => {
      delivered.push(mail);
    },
    log: silentLogger,
    notifyActivity: notificationsService.createForActivity,
  });
  inbox = inboxFeature.service;
  deadlineEvaluate = (tx, issueId) => inbox.evaluateDeadline(tx, issueId);
  sweepDueQuestions = () => inbox.findDueQuestionIssueIds();
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  delivered = [];
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from notifications`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from questions`);
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from run_children`);
    await tx.execute(sql`delete from run_model_changes`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from project_labels`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from instance_setup`);
    await tx.execute(sql`delete from instance_settings`);
    await tx.execute(sql`delete from email_verification_tokens`);
    await tx.execute(sql`delete from humans`);
  });
});

type Fixture = {
  owner: string;
  member: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  identity: AgentIdentity;
  secret: string;
  keyId: string;
};

async function insertHuman(email: string) {
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: tokenHash(randomBytes(32).toString("hex")),
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (human === undefined) throw new Error("human not created");
  return human;
}

async function bootstrap(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await insertHuman(`owner-${suffix}@orrery.test`);
  const member = await insertHuman(`member-${suffix}@orrery.test`);
  const workspaceId = randomUUID();
  await database.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      kind: "shared",
      name: `Notifications team ${suffix}`,
    });
    await tx.insert(workspaceMemberships).values([
      { id: randomUUID(), workspaceId, humanId: owner.id, isOwner: true },
      { id: randomUUID(), workspaceId, humanId: member.id },
    ]);
  });
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name: "Notifications project",
      key: `N${suffix.toUpperCase()}`,
      createdByHumanId: owner.id,
    })
    .returning();
  await database.db.insert(projectAccessGrants).values({
    id: randomUUID(),
    projectId: project!.id,
    humanId: member.id,
    level: "read",
    grantedByHumanId: owner.id,
  });
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: owner.id, name: `notifications-agent-${suffix}` })
    .returning();
  const secret = `key-${randomBytes(24).toString("hex")}`;
  const [key] = await database.db
    .insert(agentApiKeys)
    .values({
      id: randomUUID(),
      agentId: agent!.id,
      workspaceId,
      createdByHumanId: owner.id,
      validity: "90",
      tokenHash: tokenHash(secret),
      createdAt: new Date(),
      expiresAt: sql`now() + interval '90 days'`,
    })
    .returning();
  await database.db.insert(agentApiKeyProjects).values({
    id: randomUUID(),
    keyId: key!.id,
    projectId: project!.id,
    level: "contribute",
  });
  const identity = AgentIdentity.parse({
    agentId: agent!.id,
    name: agent!.name,
    humanId: owner.id,
    keyId: key!.id,
    workspaceId,
    validity: "90",
    projects: [{ projectId: project!.id, projectName: project!.name, level: "contribute" }],
  });
  return {
    owner: owner.id,
    member: member.id,
    workspaceId,
    projectId: project!.id,
    agentId: agent!.id,
    identity,
    secret,
    keyId: key!.id,
  };
}

async function newIssue(
  f: Fixture,
  options: { createdByHumanId?: string; assigneeHumanId?: string } = {},
) {
  const [issue] = await database.db
    .insert(issues)
    .values({
      id: randomUUID(),
      projectId: f.projectId,
      number: Math.floor(Math.random() * 1_000_000) + 1,
      title: "Tracked issue",
      status: "todo",
      sortOrder: 1,
      createdByHumanId: options.createdByHumanId ?? f.owner,
      updatedByHumanId: options.createdByHumanId ?? f.owner,
      ...(options.assigneeHumanId === undefined
        ? {}
        : { assigneeHumanId: options.assigneeHumanId }),
    })
    .returning();
  return issue!;
}

async function newRun(f: Fixture) {
  const [run] = await database.db
    .insert(runRows)
    .values({
      id: randomUUID(),
      agentId: f.agentId,
      workspaceId: f.workspaceId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return run!.id;
}

async function claim(f: Fixture, issueId: string, direct = false): Promise<string> {
  const runId = await newRun(f);
  if (direct) {
    await database.db.insert(workSessions).values({
      id: randomUUID(),
      agentId: f.agentId,
      runId,
      workspaceId: f.workspaceId,
      issueId,
      status: "active",
      leaseExpiresAt: sql`statement_timestamp() + interval '5 minutes'`,
      createdAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    });
    await database.db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    return runId;
  }
  await sessions.claim({ kind: "agent", identity: f.identity }, { issueId, runId });
  return runId;
}

function kinds(rows: readonly { kind: string }[]): string[] {
  return rows.map((row) => row.kind).toSorted();
}

async function memberNotification() {
  const f = await bootstrap();
  const issue = await newIssue(f, { assigneeHumanId: f.member });
  await claim(f, issue.id, true);
  await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");
  const note = (await notificationsService.list(humanActor(f.member))).items[0]!;
  return { f, issue, note };
}

async function inaccessibleResult(f: Fixture, notificationId: string) {
  let readError: unknown;
  try {
    await notificationsService.markRead(humanActor(f.member), notificationId);
  } catch (error) {
    readError = error;
  }
  const markedCount = await notificationsService.markAllRead(humanActor(f.member));
  return { readError, markedCount };
}

describe("notifications", () => {
  it("records a handoff notification for the agent owner and human assignee", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, { assigneeHumanId: f.member });
    await claim(f, issue.id, true);
    await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");

    const forOwner = await notificationsService.list(humanActor(f.owner));
    const forMember = await notificationsService.list(humanActor(f.member));
    expect(kinds(forOwner.items)).toEqual(["handoff"]);
    expect(kinds(forMember.items)).toEqual(["handoff"]);
    expect(forOwner.unreadCount).toBe(1);
    expect(forMember.items[0]!.issue.id).toBe(issue.id);
    expect(forMember.items[0]!.issue.identifier).toMatch(/^N[0-9A-F]+-\d+$/);
    expect(forMember.items[0]!.project.workspaceId).toBe(f.workspaceId);
  });

  it("falls back to the human creator when a handed-off issue has no human assignee", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, { createdByHumanId: f.member });
    await claim(f, issue.id);
    await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");

    expect(kinds((await notificationsService.list(humanActor(f.member))).items)).toEqual([
      "handoff",
    ]);
    expect(kinds((await notificationsService.list(humanActor(f.owner))).items)).toEqual([
      "handoff",
    ]);
  });

  it("excludes the triggering human actor from a notification", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const activityId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(projectActivity).values({
        id: activityId,
        projectId: f.projectId,
        issueId: issue.id,
        type: "issue_review_handoff",
        actorHumanId: f.member,
        summary: "Handled elsewhere",
      });
      await notificationsService.createForActivity(tx, {
        activityId,
        projectId: f.projectId,
        issueId: issue.id,
        kind: "handoff",
        summary: "Handled elsewhere",
        actorHumanId: f.member,
      });
    });
    expect((await notificationsService.list(humanActor(f.member))).items).toEqual([]);
    expect(kinds((await notificationsService.list(humanActor(f.owner))).items)).toEqual([
      "handoff",
    ]);
  });

  it("notifies the agent owner and human assignee when a question is asked and paused", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, { assigneeHumanId: f.member });
    const runId = await claim(f, issue.id, true);
    await inbox.ask(
      { kind: "agent", identity: f.identity },
      { issueId: issue.id, runId, question: "Which API?", proposedFallback: "v1" },
    );
    expect(kinds((await notificationsService.list(humanActor(f.owner))).items)).toEqual([
      "needs_input",
    ]);
    expect(kinds((await notificationsService.list(humanActor(f.member))).items)).toEqual([
      "needs_input",
    ]);

    await database.db.execute(
      sql`update questions set response_deadline_at = statement_timestamp() - interval '1 minute', created_at = statement_timestamp() - interval '2 hours' where issue_id = ${issue.id}`,
    );
    await sessions.sweep();

    const owner = await notificationsService.list(humanActor(f.owner));
    expect(kinds(owner.items)).toEqual(["needs_input", "needs_input"]);
    expect(
      owner.items.some((item) => item.summary.includes("paused at the one-hour deadline")),
    ).toBe(true);
  });

  it("emits exactly one session_expired activity and notification under a concurrent sweep", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, { assigneeHumanId: f.member });
    await claim(f, issue.id, true);
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 minute' where issue_id = ${issue.id}`,
    );

    await Promise.all([sessions.sweep(), sessions.sweep()]);

    const activities = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(
        and(
          eq(projectActivity.issueId, issue.id),
          eq(projectActivity.type, "issue_session_expired"),
        ),
      );
    expect(activities).toHaveLength(1);
    expect(kinds((await notificationsService.list(humanActor(f.owner))).items)).toEqual([
      "session_expired",
    ]);
    expect(kinds((await notificationsService.list(humanActor(f.member))).items)).toEqual([
      "session_expired",
    ]);
    const fresh = await database.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(fresh[0]!.status).toBe("todo");
  });

  it("filters notifications immediately when access, membership or issue state changes", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, { assigneeHumanId: f.member });
    await claim(f, issue.id, true);
    await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");
    expect((await notificationsService.list(humanActor(f.member))).unreadCount).toBe(1);

    await database.db.execute(
      sql`delete from project_access_grants where human_id = ${f.member} and project_id = ${f.projectId}`,
    );
    expect((await notificationsService.list(humanActor(f.member))).items).toEqual([]);
    expect((await notificationsService.list(humanActor(f.member))).unreadCount).toBe(0);

    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: f.projectId,
      humanId: f.member,
      level: "read",
      grantedByHumanId: f.owner,
    });
    await database.db.execute(
      sql`update workspace_memberships set suspended_at = statement_timestamp() where human_id = ${f.member}`,
    );
    expect((await notificationsService.list(humanActor(f.member))).items).toEqual([]);

    await database.db.execute(
      sql`update workspace_memberships set suspended_at = null where human_id = ${f.member}`,
    );
    await database.db.execute(
      sql`update humans set deactivated_at = statement_timestamp() where id = ${f.member}`,
    );
    expect((await notificationsService.list(humanActor(f.member))).items).toEqual([]);

    await database.db.execute(sql`update humans set deactivated_at = null where id = ${f.member}`);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp(), deleted_by_human_id = ${f.owner} where id = ${issue.id}`,
    );
    expect((await notificationsService.list(humanActor(f.member))).items).toEqual([]);
  });

  it("read and read-all are idempotent and scoped to accessible notifications", async () => {
    const f = await bootstrap();
    const first = await newIssue(f);
    await claim(f, first.id);
    await sessions.stop({ kind: "agent", identity: f.identity }, first.id, "review");
    const second = await newIssue(f);
    await claim(f, second.id);
    await sessions.stop({ kind: "agent", identity: f.identity }, second.id, "review");

    const listed = await notificationsService.list(humanActor(f.owner));
    expect(listed.items).toHaveLength(2);
    expect(listed.unreadCount).toBe(2);
    const page = await notificationsService.list(humanActor(f.owner), { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const following = await notificationsService.list(humanActor(f.owner), {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(following.items).toHaveLength(1);
    expect(following.items[0]!.id).not.toBe(page.items[0]!.id);

    await notificationsService.markRead(humanActor(f.owner), listed.items[0]!.id);
    await notificationsService.markRead(humanActor(f.owner), listed.items[0]!.id);
    const unread = await notificationsService.list(humanActor(f.owner), { unreadOnly: true });
    expect(unread.items).toHaveLength(1);
    expect(unread.unreadCount).toBe(1);

    expect(await notificationsService.markAllRead(humanActor(f.owner))).toBe(1);
    expect(await notificationsService.markAllRead(humanActor(f.owner))).toBe(0);
    expect((await notificationsService.list(humanActor(f.owner))).unreadCount).toBe(0);

    await expect(
      notificationsService.markRead(humanActor(f.member), listed.items[1]!.id),
    ).rejects.toMatchObject({
      kind: "notification_not_found",
    });
  });

  it("prunes read notifications after 90 days and all notifications after 180 days", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    await claim(f, issue.id);
    await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");
    await database.db.execute(
      sql`update notifications set read_at = statement_timestamp() - interval '91 days', created_at = statement_timestamp() - interval '91 days'`,
    );
    expect(await notificationsService.prune()).toBe(1);

    await database.db
      .update(issues)
      .set({ status: "todo", closedAt: null })
      .where(eq(issues.id, issue.id));
    await claim(f, issue.id);
    await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");
    await database.db.execute(
      sql`update notifications set read_at = null, created_at = statement_timestamp() - interval '181 days'`,
    );
    expect(await notificationsService.prune()).toBe(1);
  });

  it("rejects agent keys with 403 and serves humans over the REST API", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    await claim(f, issue.id);
    await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");

    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const feature = createNotificationsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      authenticate: liveAuth!,
      log: silentLogger,
    });
    const app = createApp({
      features: [accounts, agentsFeature, feature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });

    const anonymous = await app.request("/api/notifications");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ status: 401, code: "not_signed_in" });

    const invalid = await app.request("/api/notifications", {
      headers: { authorization: "Bearer not-a-real-key" },
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ status: 401, code: "invalid_key" });

    await database.db
      .update(agentApiKeys)
      .set({ revokedAt: sql`now()` })
      .where(eq(agentApiKeys.id, f.keyId));
    const revoked = await app.request("/api/notifications", {
      headers: { authorization: `Bearer ${f.secret}` },
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ status: 401, code: "key_revoked" });

    await database.db
      .update(agentApiKeys)
      .set({ revokedAt: null })
      .where(eq(agentApiKeys.id, f.keyId));
    const refused = await app.request("/api/notifications", {
      headers: { authorization: `Bearer ${f.secret}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      status: 403,
      code: "agents_cannot_use_notifications",
    });

    const token = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: f.owner,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    const cookie = `orrery_session=${token}`;
    const listed = await app.request("/api/notifications", { headers: { cookie } });
    expect(listed.status).toBe(200);
    const body = NotificationsResponse.parse(await listed.json());
    expect(body.unreadCount).toBe(1);
    expect(body.items).toHaveLength(1);

    const read = await app.request(`/api/notifications/${body.items[0]!.id}/read`, {
      method: "POST",
      headers: { cookie },
    });
    expect(read.status).toBe(204);
    const readAll = await app.request("/api/notifications/read-all", {
      method: "POST",
      headers: { cookie },
    });
    expect(readAll.status).toBe(200);
    expect(await readAll.json()).toEqual({ markedCount: 0 });
  });

  it("emits one session_expired activity when a sweep races hot-path expiry", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    await claim(f, issue.id);
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 minute' where issue_id = ${issue.id}`,
    );

    await Promise.allSettled([
      sessions.sweep(),
      sessions.renew({ kind: "agent", identity: f.identity }, issue.id),
      sessions.readyWork(humanActor(f.owner), f.projectId),
    ]);

    const activities = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(
        and(
          eq(projectActivity.issueId, issue.id),
          eq(projectActivity.type, "issue_session_expired"),
        ),
      );
    expect(activities).toHaveLength(1);
    expect(
      (await notificationsService.list(humanActor(f.owner))).items.filter(
        (item) => item.kind === "session_expired",
      ),
    ).toHaveLength(1);
    // No human assignee: only the agent's owner is notified.
    expect(
      (await notificationsService.list(humanActor(f.member))).items.filter(
        (item) => item.kind === "session_expired",
      ),
    ).toHaveLength(0);
  });

  it("pauses a require_human question at its deadline without a spurious session_expired activity", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await claim(f, issue.id);
    await inbox.ask(
      { kind: "agent", identity: f.identity },
      { issueId: issue.id, runId, question: "Which API?", proposedFallback: "v1" },
    );
    await database.db.execute(
      sql`update questions set response_deadline_at = statement_timestamp() - interval '1 minute', created_at = statement_timestamp() - interval '2 hours' where issue_id = ${issue.id}`,
    );
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 minute' where issue_id = ${issue.id}`,
    );

    await sessions.sweep();

    const paused = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(
        and(
          eq(projectActivity.issueId, issue.id),
          eq(projectActivity.type, "issue_question_paused"),
        ),
      );
    const expired = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(
        and(
          eq(projectActivity.issueId, issue.id),
          eq(projectActivity.type, "issue_session_expired"),
        ),
      );
    expect(paused).toHaveLength(1);
    expect(expired).toHaveLength(0);
    const note = (await notificationsService.list(humanActor(f.owner))).items.find(
      (item) => item.kind === "needs_input",
    );
    expect(note?.summary).toContain("paused at the one-hour deadline");
  });

  it("refuses read and read-all after access, membership, identity, workspace or issue changes", async () => {
    {
      const { f, note } = await memberNotification();
      await database.db.execute(
        sql`delete from project_access_grants where human_id = ${f.member} and project_id = ${f.projectId}`,
      );
      const { readError, markedCount } = await inaccessibleResult(f, note.id);
      expect(readError).toMatchObject({ kind: "notification_not_found" });
      expect(markedCount).toBe(0);
    }
    {
      const { f, note } = await memberNotification();
      await database.db.execute(
        sql`update workspace_memberships set suspended_at = statement_timestamp() where human_id = ${f.member}`,
      );
      const { readError, markedCount } = await inaccessibleResult(f, note.id);
      expect(readError).toMatchObject({ kind: "notification_not_found" });
      expect(markedCount).toBe(0);
    }
    {
      const { f, note } = await memberNotification();
      await database.db.execute(
        sql`update humans set deactivated_at = statement_timestamp() where id = ${f.member}`,
      );
      const { readError, markedCount } = await inaccessibleResult(f, note.id);
      expect(readError).toMatchObject({ kind: "notification_not_found" });
      expect(markedCount).toBe(0);
    }
    {
      const { f, note } = await memberNotification();
      const other = await insertHuman(`transfer-${randomUUID().slice(0, 8)}@orrery.test`);
      const [workspace] = await database.db
        .insert(workspaces)
        .values({
          id: randomUUID(),
          kind: "personal",
          name: "Transfer target",
          personalOwnerHumanId: other.id,
        })
        .returning();
      await database.db
        .update(projects)
        .set({ workspaceId: workspace!.id })
        .where(eq(projects.id, f.projectId));
      const { readError, markedCount } = await inaccessibleResult(f, note.id);
      expect(readError).toMatchObject({ kind: "notification_not_found" });
      expect(markedCount).toBe(0);
    }
    {
      const { f, issue, note } = await memberNotification();
      await database.db.execute(
        sql`update issues set deleted_at = statement_timestamp(), deleted_by_human_id = ${f.owner} where id = ${issue.id}`,
      );
      const { readError, markedCount } = await inaccessibleResult(f, note.id);
      expect(readError).toMatchObject({ kind: "notification_not_found" });
      expect(markedCount).toBe(0);
    }
  });

  it("keeps keyset pagination stable when the cursor row is read or trashed, and rejects bad cursors", async () => {
    const f = await bootstrap();
    for (let index = 0; index < 3; index++) {
      const issue = await newIssue(f);
      await claim(f, issue.id);
      await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");
      await database.db
        .update(issues)
        .set({ status: "todo", closedAt: null })
        .where(eq(issues.id, issue.id));
    }
    const first = await notificationsService.list(humanActor(f.owner), { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor!;

    await notificationsService.markRead(humanActor(f.owner), first.items[0]!.id);
    const afterRead = await notificationsService.list(humanActor(f.owner), {
      limit: 1,
      unreadOnly: true,
      cursor,
    });
    expect(afterRead.items).toHaveLength(1);
    expect(afterRead.items[0]!.id).not.toBe(first.items[0]!.id);

    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp(), deleted_by_human_id = ${f.owner} where id = ${first.items[0]!.issue.id}`,
    );
    const afterTrash = await notificationsService.list(humanActor(f.owner), { limit: 1, cursor });
    expect(afterTrash.items).toHaveLength(1);
    expect(afterTrash.items[0]!.id).not.toBe(first.items[0]!.id);

    await expect(
      notificationsService.list(humanActor(f.owner), { cursor: "not-a-base64-cursor" }),
    ).rejects.toMatchObject({ kind: "invalid_cursor" });
  });

  it("preserves sub-millisecond ordering across keyset pages without skipping same-millisecond rows", async () => {
    const f = await bootstrap();
    for (let index = 0; index < 2; index++) {
      const issue = await newIssue(f);
      await claim(f, issue.id);
      await sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review");
    }
    const existing = await notificationsService.list(humanActor(f.owner));
    expect(existing.items).toHaveLength(2);
    const [firstId, secondId] = existing.items.map((item) => item.id);
    // Two notifications in the exact same millisecond, differing only in microseconds.
    await database.db.execute(
      sql`update notifications set created_at = '2026-11-21T12:00:00.123456Z'::timestamptz where id = ${firstId!}`,
    );
    await database.db.execute(
      sql`update notifications set created_at = '2026-11-21T12:00:00.123100Z'::timestamptz where id = ${secondId!}`,
    );

    const page1 = await notificationsService.list(humanActor(f.owner), { limit: 1 });
    expect(page1.items.map((item) => item.id)).toEqual([firstId]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await notificationsService.list(humanActor(f.owner), {
      limit: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((item) => item.id)).toEqual([secondId]);
    expect(page2.nextCursor).toBeNull();
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AgentIdentity, ProjectAccessLevel } from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  humans,
  issues,
  projectAccessGrants,
  projectActivity,
  projects,
  questions as questionRows,
  runs as runRows,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAgentsFeature, type AgentAuthenticator } from "../agents/index.ts";
import { createHistoryService } from "../history/index.ts";
import { createProjectsFeature, projectAccessAtLeast, ProjectsError } from "../projects/index.ts";
import {
  createSessionsFeature,
  releaseIssueWorkSessions,
  SessionsError,
  type SessionsService,
} from "../work-sessions/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import { createInboxService, InboxError, type InboxService } from "./service.ts";

const SECRET = "correct horse battery staple inbox";
const ADMIN_EMAIL = "inbox-admin@example.com";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let inbox: InboxService;
let sessions: SessionsService;
let projectsService: ReturnType<typeof createProjectsFeature>["service"];
let history: ReturnType<typeof createHistoryService>;
let delivered: OutgoingMail[];
let liveAuth: AgentAuthenticator | undefined;

const lateAuth: AgentAuthenticator = (request) => {
  if (liveAuth === undefined) throw new Error("authenticator not wired");
  return liveAuth(request);
};

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
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: (tx, agentId, workspaceId, issueId) => {
      if (gate === undefined) throw new Error("gate not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
    releaseIssueWorkSessions,
    evaluateQuestionDeadline: (tx, issueId) => {
      if (deadlineEvaluate === undefined) throw new Error("deadline seam not wired");
      return deadlineEvaluate(tx, issueId);
    },
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
  });
  liveAuth = agentsFeature.authenticator;
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
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  inbox = createInboxService({
    db: database.db,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
    deliver: async (mail) => {
      delivered.push(mail);
    },
    log: silentLogger,
  });
  projectsService = projectsFeature.service;
  sessions = sessionsFeature.service;
  deadlineEvaluate = (tx, issueId) => inbox.evaluateDeadline(tx, issueId);
  history = createHistoryService({
    db: database.db,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
  });
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  delivered = [];
  await database.db.transaction(async (tx) => {
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
  humanId: string;
  email: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  identity: AgentIdentity;
};

async function bootstrap(email = ADMIN_EMAIL): Promise<Fixture> {
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
  const [workspace] = await database.db
    .insert(workspaces)
    .values({
      id: randomUUID(),
      kind: "personal",
      name: "Inbox personal",
      personalOwnerHumanId: human.id,
    })
    .returning();
  if (workspace === undefined) throw new Error("workspace not created");
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId: workspace.id,
      name: "Inbox project",
      key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
      createdByHumanId: human.id,
    })
    .returning();
  if (project === undefined) throw new Error("project not created");
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: human.id, name: `inbox-agent-${randomUUID()}` })
    .returning();
  if (agent === undefined) throw new Error("agent not created");
  const secret = `key-${randomBytes(24).toString("hex")}`;
  const [key] = await database.db
    .insert(agentApiKeys)
    .values({
      id: randomUUID(),
      agentId: agent.id,
      workspaceId: workspace.id,
      createdByHumanId: human.id,
      validity: "90",
      tokenHash: tokenHash(secret),
      createdAt: new Date(),
    })
    .returning();
  await database.db.insert(agentApiKeyProjects).values({
    id: randomUUID(),
    keyId: key!.id,
    projectId: project.id,
    level: "contribute",
  });
  const identity = AgentIdentity.parse({
    agentId: agent.id,
    name: agent.name,
    humanId: human.id,
    keyId: key!.id,
    workspaceId: workspace.id,
    validity: "90",
    projects: [{ projectId: project.id, projectName: project.name, level: "contribute" }],
  });
  return {
    humanId: human.id,
    email: human.email,
    workspaceId: workspace.id,
    projectId: project.id,
    agentId: agent.id,
    identity,
  };
}

async function humanActor(f: Fixture) {
  return {
    kind: "human" as const,
    account: {
      humanId: f.humanId,
      email: f.email,
      isSystemAdministrator: false,
      emailVerifiedAt: new Date(),
    },
  };
}

async function newIssue(f: Fixture, title = "Blocked issue") {
  return projectsService.createIssue(await humanActor(f), f.projectId, { title });
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
    .returning({ id: runRows.id });
  if (run === undefined) throw new Error("run not created");
  return run.id;
}

async function claim(f: Fixture, issueId: string, runId: string) {
  return sessions.claim({ kind: "agent", identity: f.identity }, { issueId, runId });
}

async function ask(f: Fixture, issueId: string, runId: string) {
  return inbox.ask(
    { kind: "agent", identity: f.identity },
    { issueId, runId, question: "Which API should we use?", proposedFallback: "Use v1" },
  );
}

async function setDeadline(questionId: string, expression: string) {
  await database.db.execute(
    sql`update questions set response_deadline_at = ${sql.raw(expression)}, created_at = statement_timestamp() - interval '2 hours' where id = ${questionId}`,
  );
}

async function isNeedsInput(issueId: string): Promise<boolean> {
  const [row] = await database.db
    .select({ needsInput: issues.needsInput })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.needsInput ?? false;
}

async function activeSessions(issueId: string): Promise<number> {
  const rows = await database.db
    .select({ id: workSessions.id })
    .from(workSessions)
    .where(and(eq(workSessions.issueId, issueId), eq(workSessions.status, "active")));
  return rows.length;
}

function kindOf(error: unknown): string {
  return error instanceof InboxError ? error.kind : "unexpected_error";
}

function refused(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => Promise.reject(new Error("expected the operation to be refused")),
    (error: unknown) => error,
  );
}

describe("questions against real Postgres", () => {
  it("opens a question with Needs input, emails the agent owner and refuses agent answerers", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);

    expect(question.status).toBe("open");
    expect(question.proposedFallback).toBe("Use v1");
    expect(await isNeedsInput(issue.id)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe(f.email);
    expect(delivered[0]?.text).toContain(question.question);

    const agentAnswer = await refused(
      inbox.answer({ kind: "agent", identity: f.identity }, question.id, "v2"),
    );
    expect(kindOf(agentAnswer)).toBe("agents_cannot_answer");
    expect((await database.db.select().from(questionRows))[0]?.status).toBe("open");
  });

  it("resolves exactly once when two humans answer concurrently", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    const human = await humanActor(f);

    const results = await Promise.allSettled([
      inbox.answer(human, question.id, "first"),
      inbox.answer(human, question.id, "second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(kindOf(rejected?.status === "rejected" ? rejected.reason : undefined)).toBe(
      "question_resolved",
    );
    const [stored] = await database.db.select().from(questionRows);
    expect(stored?.status).toBe("answered");
    expect(["first", "second"]).toContain(stored?.answer);
    expect(await isNeedsInput(issue.id)).toBe(false);
  });

  it("accepts an answer just before the deadline in database time", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() + interval '10 seconds'");

    const answered = await inbox.answer(await humanActor(f), question.id, "use v2");
    expect(answered.status).toBe("answered");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect(await activeSessions(issue.id)).toBe(1);
  });

  it("at the deadline pauses, releases the claim and keeps Needs input until a human answers", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    await refused(claim(f, issue.id, runId));
    const [paused] = await database.db.select().from(questionRows);
    expect(paused?.status).toBe("paused");
    expect(await isNeedsInput(issue.id)).toBe(true);
    expect(await activeSessions(issue.id)).toBe(0);

    const answered = await inbox.answer(await humanActor(f), question.id, "here is the answer");
    expect(answered.status).toBe("answered");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect(await activeSessions(issue.id)).toBe(0);
    expect((await database.db.select().from(questionRows))[0]?.answer).toBe("here is the answer");
  });

  it("keeps the question and Needs input when the claim lapses, then unblocks on answer", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    await ask(f, issue.id, runId);
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 second' where issue_id = ${issue.id}`,
    );
    const [open] = await database.db.select().from(questionRows);
    expect(open?.status).toBe("open");
    expect(await isNeedsInput(issue.id)).toBe(true);

    const answered = await inbox.answer(await humanActor(f), open!.id, "reacquire first");
    expect(answered.status).toBe("answered");
    expect(await isNeedsInput(issue.id)).toBe(false);
  });

  it("renews a claim while waiting but never past the question deadline", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() + interval '30 seconds'");
    const dbDeadline = await database.db.transaction((tx) => inbox.questionDeadline(tx, issue.id));
    expect(dbDeadline, "question deadline seam must find the open question").not.toBeNull();
    await sessions.renew({ kind: "agent", identity: f.identity }, issue.id);
    const [row] = await database.db
      .select({ lease: workSessions.leaseExpiresAt, deadline: questionRows.responseDeadlineAt })
      .from(workSessions)
      .innerJoin(questionRows, eq(questionRows.sessionId, workSessions.id))
      .where(eq(workSessions.issueId, issue.id))
      .limit(1);
    expect(row?.lease.getTime()).toBeLessThanOrEqual(row!.deadline.getTime());
    expect(await activeSessions(issue.id)).toBe(1);
  });

  it("refuses readers, unrelated members and sibling agent keys", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);

    const [agent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: f.humanId, name: `sibling-${randomUUID()}` })
      .returning();
    const [key] = await database.db
      .insert(agentApiKeys)
      .values({
        id: randomUUID(),
        agentId: agent!.id,
        workspaceId: f.workspaceId,
        createdByHumanId: f.humanId,
        validity: "90",
        tokenHash: tokenHash(randomBytes(24).toString("hex")),
        createdAt: new Date(),
      })
      .returning();
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: key!.id,
      projectId: f.projectId,
      level: "contribute",
    });
    const siblingIdentity = AgentIdentity.parse({
      agentId: agent!.id,
      name: agent!.name,
      humanId: f.humanId,
      keyId: key!.id,
      workspaceId: f.workspaceId,
      validity: "90",
      projects: [{ projectId: f.projectId, projectName: "Inbox project", level: "contribute" }],
    });
    const sibling = await refused(
      inbox.answer({ kind: "agent", identity: siblingIdentity }, question.id, "sibling answer"),
    );
    expect(kindOf(sibling)).toBe("agents_cannot_answer");

    const readOnly = createInboxService({
      db: database.db,
      projectAccessCeiling: async () => new Map([[f.projectId, ProjectAccessLevel.enum.read]]),
      projectAccessAtLeast,
      deliver: async () => {},
      log: silentLogger,
    });
    expect(kindOf(await refused(readOnly.answer(await humanActor(f), question.id, "reader")))).toBe(
      "insufficient_access",
    );
    const unrelated = createInboxService({
      db: database.db,
      projectAccessCeiling: async () => new Map([[f.projectId, null]]),
      projectAccessAtLeast,
      deliver: async () => {},
      log: silentLogger,
    });

    expect(
      kindOf(await refused(unrelated.answer(await humanActor(f), question.id, "outsider"))),
    ).toBe("question_not_found");
    expect(kindOf(await refused(unrelated.issueHistory(await humanActor(f), issue.id)))).toBe(
      "issue_not_found",
    );
  });

  it("scopes the inbox to the human's workspaces and reports DB-time status on reads", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const mine = await ask(f, issue.id, runId);

    const other = await bootstrap(`inbox-other-${randomUUID()}@example.com`);
    const otherIssue = await newIssue(other);
    const otherRun = await newRun(other);
    await claim(other, otherIssue.id, otherRun);
    const theirs = await ask(other, otherIssue.id, otherRun);
    const ids = (await inbox.list(await humanActor(f))).map((row) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids.length).toBeLessThanOrEqual(200);

    await setDeadline(mine.id, "statement_timestamp() - interval '1 second'");
    const fromList = (await inbox.list(await humanActor(f))).find((row) => row.id === mine.id);
    expect(fromList?.status).toBe("paused");
    const fromHistory = await inbox.issueHistory(await humanActor(f), issue.id);
    expect(fromHistory[0]?.status).toBe("paused");
  });

  it("lists questions from every accessible workspace with one ceiling call per workspace", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const mine = await ask(f, issue.id, runId);

    const secondWorkspaceId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: secondWorkspaceId,
        kind: "shared",
        name: "Second inbox workspace",
      });
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: secondWorkspaceId,
        humanId: f.humanId,
        isOwner: true,
      });
    });
    const [secondProject] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId: secondWorkspaceId,
        name: "Second inbox project",
        key: `S${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
        createdByHumanId: f.humanId,
      })
      .returning();
    const [secondIssue] = await database.db
      .insert(issues)
      .values({
        id: randomUUID(),
        projectId: secondProject!.id,
        number: 1,
        title: "Second workspace issue",
        status: "in_progress",
        priority: "medium",
        sortOrder: 65535,
        createdByHumanId: f.humanId,
        updatedByHumanId: f.humanId,
        needsInput: true,
      })
      .returning();
    const [secondRun] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId: f.agentId,
        workspaceId: secondWorkspaceId,
        status: "active",
      })
      .returning();
    const [secondSession] = await database.db
      .insert(workSessions)
      .values({
        id: randomUUID(),
        agentId: f.agentId,
        runId: secondRun!.id,
        workspaceId: secondWorkspaceId,
        issueId: secondIssue!.id,
        status: "active",
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        progress: "working",
      })
      .returning();
    const secondQuestionId = randomUUID();
    await database.db.insert(questionRows).values({
      id: secondQuestionId,
      issueId: secondIssue!.id,
      projectId: secondProject!.id,
      workspaceId: secondWorkspaceId,
      agentId: f.agentId,
      runId: secondRun!.id,
      sessionId: secondSession!.id,
      question: "A second workspace question?",
      proposedFallback: "Use the default",
      status: "open",
      responseDeadlineAt: sql`statement_timestamp() - interval '1 second'`,
      createdAt: sql`statement_timestamp() - interval '2 hours'`,
    });

    const calls: { workspaceId: string; projectIds: string[] }[] = [];
    const measured = createInboxService({
      db: database.db,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) => {
        calls.push({ workspaceId, projectIds: [...projectIds] });
        return projectsService.projectAccessCeiling(tx, workspaceId, humanId, projectIds);
      },
      projectAccessAtLeast,
      deliver: async () => {},
      log: silentLogger,
    });
    const rows = await measured.list(await humanActor(f));
    expect(rows.map((row) => row.id).toSorted()).toEqual([mine.id, secondQuestionId].toSorted());
    expect(rows.find((row) => row.id === secondQuestionId)?.status).toBe("paused");

    expect(calls.map((call) => call.workspaceId).toSorted()).toEqual(
      [f.workspaceId, secondWorkspaceId].toSorted(),
    );
    expect(calls).toHaveLength(2);
  });

  it("records the question and its resolution in project history", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await inbox.answer(await humanActor(f), question.id, "recorded answer");

    const events = await history.projectHistory(
      {
        humanId: f.humanId,
        email: f.email,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
      f.projectId,
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("issue_question_asked");
    expect(types).toContain("issue_question_answered");
    const rows = await database.db.select().from(projectActivity);
    expect(rows.map((row) => row.issueId)).toContain(issue.id);
  });

  it("preserves an already-lapsed session as expired (not released) when the question deadline pauses", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    const claimed = await claim(f, issue.id, runId);
    const actor = { kind: "agent" as const, identity: f.identity };
    await sessions.progress(actor, issue.id, "halfway through migration");
    const question = await ask(f, issue.id, runId);

    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: sql`statement_timestamp() - interval '10 minutes'` })
      .where(eq(workSessions.id, claimed.id));
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    await inbox.answer(await humanActor(f), question.id, "proceed with option A");

    const resumed = await sessions.resume(actor, { issueId: issue.id, runId });
    expect(resumed.disposition).toBe("expired");
    expect(resumed.session?.status).toBe("expired");
    expect(resumed.session?.progress).toBe("halfway through migration");

    const reacquired = await sessions.reacquire(actor, { issueId: issue.id, runId });
    expect(reacquired.status).toBe("active");
    expect(reacquired.progress).toBe("halfway through migration");
  });
});

function errorKindOf(error: unknown): string {
  if (error instanceof InboxError) return error.kind;
  if (error instanceof ProjectsError) return error.kind;
  if (error instanceof SessionsError) return error.kind;
  return "unexpected_error";
}

type Member = { humanId: string; email: string };

function actorOf(member: Member) {
  return {
    humanId: member.humanId,
    email: member.email,
    isSystemAdministrator: false,
    emailVerifiedAt: new Date(),
  };
}

async function sharedFixture() {
  const owner = await bootstrap();
  const humansIn: Member[] = [];
  for (const role of ["contributor", "reader", "outsider"]) {
    const [human] = await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email: `${role}-${randomUUID()}@example.com`,
        passwordHash: tokenHash(randomBytes(32).toString("hex")),
        emailVerifiedAt: new Date(),
      })
      .returning();
    humansIn.push({ humanId: human!.id, email: human!.email });
  }
  const contributor = humansIn[0]!;
  const reader = humansIn[1]!;
  const outsider = humansIn[2]!;
  const workspaceId = randomUUID();

  await database.db.transaction(async (tx) => {
    await tx
      .insert(workspaces)
      .values({ id: workspaceId, kind: "shared", name: "Shared fallback workspace" });
    await tx.insert(workspaceMemberships).values([
      {
        id: randomUUID(),
        workspaceId,
        humanId: owner.humanId,
        isOwner: true,
      },
      {
        id: randomUUID(),
        workspaceId,
        humanId: contributor.humanId,
        isOwner: false,
      },
      {
        id: randomUUID(),
        workspaceId,
        humanId: reader.humanId,
        isOwner: false,
      },
    ]);
  });
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name: "Shared fallback project",
      key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
      createdByHumanId: owner.humanId,
    })
    .returning();
  const projectId = project!.id;
  await database.db.insert(projectAccessGrants).values([
    {
      id: randomUUID(),
      projectId,
      humanId: contributor.humanId,
      level: "contribute",
      grantedByHumanId: owner.humanId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      projectId,
      humanId: reader.humanId,
      level: "read",
      grantedByHumanId: owner.humanId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const [agent] = await database.db
    .insert(agents)
    .values({
      id: randomUUID(),
      humanId: contributor.humanId,
      name: `fallback-agent-${randomUUID()}`,
    })
    .returning();
  const [key] = await database.db
    .insert(agentApiKeys)
    .values({
      id: randomUUID(),
      agentId: agent!.id,
      workspaceId,
      createdByHumanId: contributor.humanId,
      validity: "90",
      tokenHash: tokenHash(randomBytes(24).toString("hex")),
      createdAt: new Date(),
    })
    .returning();
  await database.db.insert(agentApiKeyProjects).values({
    id: randomUUID(),
    keyId: key!.id,
    projectId,
    level: "contribute",
  });
  const identity = AgentIdentity.parse({
    agentId: agent!.id,
    name: agent!.name,
    humanId: contributor.humanId,
    keyId: key!.id,
    workspaceId,
    validity: "90",
    projects: [{ projectId, projectName: project!.name, level: "contribute" }],
  });
  return {
    owner,
    projectId,
    contributor,
    reader,
    outsider,
    identity,
  };
}

async function activityTypes(projectId: string): Promise<string[]> {
  const rows = await database.db
    .select({ type: projectActivity.type })
    .from(projectActivity)
    .where(eq(projectActivity.projectId, projectId));
  return rows.map((row) => row.type);
}

async function questionOf(questionId: string) {
  const [row] = await database.db
    .select()
    .from(questionRows)
    .where(eq(questionRows.id, questionId))
    .limit(1);
  return row;
}

describe("fallback policy permission matrix against real Postgres", () => {
  it("defaults to require_human and lets only Manage set the project policy", async () => {
    const s = await sharedFixture();
    const manage = (await humanActor(s.owner)).account;
    expect(
      (await projectsService.getProject(await humanActor(s.owner), s.projectId)).fallbackPolicy,
    ).toBe("require_human");

    expect(
      errorKindOf(
        await refused(
          projectsService.setProjectFallbackPolicy(actorOf(s.contributor), s.projectId, {
            fallbackPolicy: "fallback_allowed",
          }),
        ),
      ),
    ).toBe("insufficient_project_access");
    expect(
      errorKindOf(
        await refused(
          projectsService.setProjectFallbackPolicy(actorOf(s.reader), s.projectId, {
            fallbackPolicy: "fallback_allowed",
          }),
        ),
      ),
    ).toBe("insufficient_project_access");

    expect(
      errorKindOf(
        await refused(
          projectsService.setProjectFallbackPolicy(actorOf(s.outsider), s.projectId, {
            fallbackPolicy: "fallback_allowed",
          }),
        ),
      ),
    ).toBe("project_not_found");

    const changed = await projectsService.setProjectFallbackPolicy(manage, s.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    expect(changed.fallbackPolicy).toBe("fallback_allowed");
    expect(
      (await projectsService.getProject(await humanActor(s.owner), s.projectId)).fallbackPolicy,
    ).toBe("fallback_allowed");
    expect(await activityTypes(s.projectId)).toContain("project_fallback_policy_changed");
  });

  it("lets Contribute tighten but only Manage loosen an issue override", async () => {
    const s = await sharedFixture();
    const manage = (await humanActor(s.owner)).account;
    await projectsService.setProjectFallbackPolicy(manage, s.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await projectsService.createIssue(await humanActor(s.owner), s.projectId, {
      title: "Override matrix",
    });

    const tightened = await projectsService.setIssueFallbackPolicyOverride(
      actorOf(s.contributor),
      issue.id,
      { override: "require_human" },
    );
    expect(tightened.fallbackPolicyOverride).toBe("require_human");
    expect(tightened.effectiveFallbackPolicy).toBe("require_human");

    expect(
      errorKindOf(
        await refused(
          projectsService.setIssueFallbackPolicyOverride(actorOf(s.contributor), issue.id, {
            override: null,
          }),
        ),
      ),
    ).toBe("insufficient_project_access");
    expect(
      errorKindOf(
        await refused(
          projectsService.setIssueFallbackPolicyOverride(actorOf(s.contributor), issue.id, {
            override: "fallback_allowed",
          }),
        ),
      ),
    ).toBe("insufficient_project_access");
    expect(
      errorKindOf(
        await refused(
          projectsService.setIssueFallbackPolicyOverride(actorOf(s.reader), issue.id, {
            override: "require_human",
          }),
        ),
      ),
    ).toBe("insufficient_project_access");
    expect(
      errorKindOf(
        await refused(
          projectsService.setIssueFallbackPolicyOverride(actorOf(s.outsider), issue.id, {
            override: "require_human",
          }),
        ),
      ),
    ).toBe("issue_not_found");

    const cleared = await projectsService.setIssueFallbackPolicyOverride(manage, issue.id, {
      override: null,
    });
    expect(cleared.fallbackPolicyOverride).toBeNull();
    expect(cleared.effectiveFallbackPolicy).toBe("fallback_allowed");
    const explicit = await projectsService.setIssueFallbackPolicyOverride(manage, issue.id, {
      override: "fallback_allowed",
    });
    expect(explicit.effectiveFallbackPolicy).toBe("fallback_allowed");
    expect(await activityTypes(s.projectId)).toContain("issue_fallback_policy_override_changed");
  });

  it("never enlarges agent permissions after a fallback is authorized", async () => {
    const s = await sharedFixture();
    await projectsService.setProjectFallbackPolicy(
      (await humanActor(s.owner)).account,
      s.projectId,
      {
        fallbackPolicy: "fallback_allowed",
      },
    );
    const issue = await projectsService.createIssue(await humanActor(s.owner), s.projectId, {
      title: "No permission growth",
    });
    const [run] = await database.db
      .insert(runRows)
      .values({
        id: randomUUID(),
        agentId: s.identity.agentId,
        workspaceId: s.identity.workspaceId,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    const agentActor = { kind: "agent" as const, identity: s.identity };
    await sessions.claim(agentActor, { issueId: issue.id, runId: run!.id });
    const question = await inbox.ask(agentActor, {
      issueId: issue.id,
      runId: run!.id,
      question: "Proceed?",
      proposedFallback: "Use v1",
    });
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");
    await sessions.renew(agentActor, issue.id);
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
    expect(await isNeedsInput(issue.id)).toBe(false);

    const readIdentity = AgentIdentity.parse({
      ...s.identity,
      projects: [{ projectId: s.projectId, projectName: "Shared fallback project", level: "read" }],
    });
    const readActor = { kind: "agent" as const, identity: readIdentity };
    expect(
      errorKindOf(await refused(projectsService.updateIssue(readActor, issue.id, { title: "x" }))),
    ).toBe("insufficient_project_access");
    expect(errorKindOf(await refused(sessions.renew(readActor, issue.id)))).toBe(
      "insufficient_access",
    );
    expect((await projectsService.getIssue(await humanActor(s.owner), issue.id)).title).toBe(
      "No permission growth",
    );
  });
});

describe("fallback deadline and late answers against real Postgres", () => {
  it("at the deadline returns only the authorized fallback and keeps a checking-in claim", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    expect(question.authorizedFallback).toBeNull();

    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    const projected = (
      await inbox.issueHistory({ kind: "agent", identity: f.identity }, issue.id)
    )[0];
    expect(projected?.status).toBe("fallback_used");
    expect(projected?.authorizedFallback).toBe("Use v1");

    await sessions.renew({ kind: "agent", identity: f.identity }, issue.id);
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
    expect((await questionOf(question.id))?.resolvedAt).not.toBeNull();
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect(await activeSessions(issue.id)).toBe(1);
    expect(await activityTypes(f.projectId)).toContain("issue_question_fallback_used");

    const [row] = await database.db
      .select({ lease: workSessions.leaseExpiresAt })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    expect(row?.lease.getTime()).toBeGreaterThan(Date.now());
  });

  it("requires human: pauses at the deadline, releases the claim and authorizes nothing", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    expect(
      errorKindOf(await refused(sessions.renew({ kind: "agent", identity: f.identity }, issue.id))),
    ).toBe("session_required");
    const stored = await questionOf(question.id);
    expect(stored?.status).toBe("paused");
    expect(await isNeedsInput(issue.id)).toBe(true);
    expect(await activeSessions(issue.id)).toBe(0);
    const listed = (await inbox.list(await humanActor(f))).find((row) => row.id === question.id);
    expect(listed?.status).toBe("paused");
    expect(listed?.authorizedFallback).toBeNull();
  });

  it("an issue require_human override wins over a fallback_allowed project", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    await projectsService.setIssueFallbackPolicyOverride((await humanActor(f)).account, issue.id, {
      override: "require_human",
    });
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    expect(
      errorKindOf(await refused(sessions.renew({ kind: "agent", identity: f.identity }, issue.id))),
    ).toBe("session_required");
    expect((await questionOf(question.id))?.status).toBe("paused");
    expect(await isNeedsInput(issue.id)).toBe(true);
  });

  it("stores a late answer on fallback_used as a follow-up without reversing work", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");
    await sessions.renew({ kind: "agent", identity: f.identity }, issue.id);

    await projectsService.updateIssue(await humanActor(f), issue.id, { status: "done" });
    const late = await inbox.answer(await humanActor(f), question.id, "Use v2 after all");

    expect(late.status).toBe("fallback_used");
    expect(late.authorizedFallback).toBe("Use v1");
    expect(late.answer).toBeNull();
    expect(late.followUp).toBe("Use v2 after all");
    expect(late.followUpByHumanId).toBe(f.humanId);
    expect(late.followUpAt).not.toBeNull();
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe("done");
    expect(await activityTypes(f.projectId)).toContain("issue_question_follow_up");

    expect(
      errorKindOf(
        await refused(inbox.answer(await humanActor(f), question.id, "another follow-up")),
      ),
    ).toBe("question_resolved");
  });

  it("records an answer racing the deadline under fallback_allowed as a follow-up", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);

    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    const raced = await inbox.answer(await humanActor(f), question.id, "late answer");
    expect(raced.status).toBe("fallback_used");
    expect(raced.answer).toBeNull();
    expect(raced.followUp).toBe("late answer");
    expect(await isNeedsInput(issue.id)).toBe(false);
  });

  it("keeps a checking-in claim across the boundary when the fallback is authorized", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    const agentActor = { kind: "agent" as const, identity: f.identity };

    await setDeadline(question.id, "statement_timestamp() + interval '10 seconds'");
    await sessions.renew(agentActor, issue.id);
    const [leaseBefore] = await database.db
      .select({ lease: workSessions.leaseExpiresAt })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    const [deadlineRow] = await database.db
      .select({ deadline: questionRows.responseDeadlineAt })
      .from(questionRows)
      .where(eq(questionRows.id, question.id));
    expect(leaseBefore!.lease.getTime()).toBeGreaterThan(deadlineRow!.deadline.getTime());

    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");
    await sessions.renew(agentActor, issue.id);
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect(await activeSessions(issue.id)).toBe(1);
  });

  it("releases a checking-in claim at the boundary when a human is required", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    const agentActor = { kind: "agent" as const, identity: f.identity };

    await setDeadline(question.id, "statement_timestamp() + interval '10 seconds'");
    await sessions.renew(agentActor, issue.id);
    const [leaseBefore] = await database.db
      .select({ lease: workSessions.leaseExpiresAt })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    const [deadlineRow] = await database.db
      .select({ deadline: questionRows.responseDeadlineAt })
      .from(questionRows)
      .where(eq(questionRows.id, question.id));
    expect(leaseBefore!.lease.getTime()).toBeLessThanOrEqual(deadlineRow!.deadline.getTime());

    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");
    expect(errorKindOf(await refused(sessions.renew(agentActor, issue.id)))).toBe(
      "session_required",
    );
    expect((await questionOf(question.id))?.status).toBe("paused");
    expect(await isNeedsInput(issue.id)).toBe(true);
    expect(await activeSessions(issue.id)).toBe(0);
  });

  it("reacquires a lapsed claim after the deadline once the fallback is authorized", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 second' where issue_id = ${issue.id}`,
    );
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    const reacquired = await sessions.reacquire(
      { kind: "agent", identity: f.identity },
      { issueId: issue.id, runId },
    );
    expect(reacquired.status).toBe("active");
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect(await activeSessions(issue.id)).toBe(1);
  });

  it("freezes an already-due question before changing the project policy", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    const read = () =>
      inbox.issueHistory({ kind: "agent", identity: f.identity }, issue.id).then((rows) => rows[0]);
    expect((await read())?.status).toBe("fallback_used");

    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "require_human",
    });
    expect((await read())?.status).toBe("fallback_used");
    expect((await read())?.authorizedFallback).toBe("Use v1");
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
  });

  it("freezes an already-due question before setting an issue override", async () => {
    const f = await bootstrap();
    await projectsService.setProjectFallbackPolicy((await humanActor(f)).account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const issue = await newIssue(f);
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");

    await projectsService.setIssueFallbackPolicyOverride((await humanActor(f)).account, issue.id, {
      override: "require_human",
    });
    expect((await questionOf(question.id))?.status).toBe("fallback_used");
    const fromHistory = (
      await inbox.issueHistory({ kind: "agent", identity: f.identity }, issue.id)
    )[0];
    expect(fromHistory?.status).toBe("fallback_used");
    expect(fromHistory?.authorizedFallback).toBe("Use v1");
  });

  it("reverts an in_progress issue to todo at the require_human pause and re-offers it when answered", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, "Paused work");
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    await ask(f, issue.id, runId);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe(
      "in_progress",
    );

    const question = (await inbox.list(await humanActor(f)))[0];
    if (question === undefined) throw new Error("the question was not found");
    await setDeadline(question.id, "statement_timestamp() - interval '1 second'");
    expect(
      errorKindOf(await refused(sessions.renew({ kind: "agent", identity: f.identity }, issue.id))),
    ).toBe("session_required");
    expect((await questionOf(question.id))?.status).toBe("paused");
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe("todo");
    expect(await isNeedsInput(issue.id)).toBe(true);
    expect(
      (await sessions.readyWork(await humanActor(f), f.projectId)).map((i) => i.id),
    ).not.toContain(issue.id);

    await inbox.answer(await humanActor(f), question.id, "Use v2");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe("todo");
    expect((await sessions.readyWork(await humanActor(f), f.projectId)).map((i) => i.id)).toContain(
      issue.id,
    );
  });

  it("reverts an in_progress issue to todo when answering after the claim lease lapsed", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, "Lapsed claim");
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe(
      "in_progress",
    );

    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 second' where issue_id = ${issue.id}`,
    );
    const answered = await inbox.answer(await humanActor(f), question.id, "Use v2");
    expect(answered.status).toBe("answered");
    expect(await isNeedsInput(issue.id)).toBe(false);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe("todo");
    expect(await activeSessions(issue.id)).toBe(0);
    expect((await sessions.readyWork(await humanActor(f), f.projectId)).map((i) => i.id)).toContain(
      issue.id,
    );
  });

  it("releases an active claim when a human moves an issue to done so stop('review') cannot reopen it", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, "Human closes claimed work");
    const runId = await newRun(f);
    await claim(f, issue.id, runId);

    const closed = await projectsService.updateIssue(await humanActor(f), issue.id, {
      status: "done",
    });
    expect(closed.status).toBe("done");
    expect(closed.closedAt).not.toBeNull();
    expect(await activeSessions(issue.id)).toBe(0);

    expect(
      errorKindOf(
        await refused(sessions.stop({ kind: "agent", identity: f.identity }, issue.id, "review")),
      ),
    ).toBe("session_required");
    const after = await projectsService.getIssue(await humanActor(f), issue.id);
    expect(after.status).toBe("done");
    expect(after.closedAt).not.toBeNull();
  });

  it("ends an agent's active claim as completed when the agent closes the issue via updateIssue", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, "Agent closes via patch");
    const runId = await newRun(f);
    await claim(f, issue.id, runId);

    const closed = await projectsService.updateIssue(
      { kind: "agent", identity: f.identity },
      issue.id,
      { status: "done" },
    );
    expect(closed.status).toBe("done");
    expect(await activeSessions(issue.id)).toBe(0);
    expect(
      (await sessions.getSession({ kind: "agent", identity: f.identity }, issue.id)).status,
    ).toBe("completed");
  });

  it("refuses stop('done') and stop('review') while a question is open, while still allowing release", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, "Blocked by open question");
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    await ask(f, issue.id, runId);

    const agent = { kind: "agent" as const, identity: f.identity };
    expect(errorKindOf(await refused(sessions.stop(agent, issue.id, "done")))).toBe(
      "issue_needs_input",
    );
    expect(errorKindOf(await refused(sessions.stop(agent, issue.id, "review")))).toBe(
      "issue_needs_input",
    );
    expect(await activeSessions(issue.id)).toBe(1);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe(
      "in_progress",
    );

    const released = await sessions.stop(agent, issue.id, "released");
    expect(released.status).toBe("released");
    expect(await activeSessions(issue.id)).toBe(0);
    expect((await projectsService.getIssue(await humanActor(f), issue.id)).status).toBe("todo");
    expect(await isNeedsInput(issue.id)).toBe(true);
  });

  it("refuses moving an issue to review or closing it via updateIssue while a question is open or paused, until answered or fallback authorized", async () => {
    const f = await bootstrap();
    const issue = await newIssue(f, "Needs answer before close");
    const runId = await newRun(f);
    await claim(f, issue.id, runId);
    const question = await ask(f, issue.id, runId);
    const human = await humanActor(f);

    for (const status of ["review", "done", "cancelled"] as const) {
      expect(
        errorKindOf(await refused(projectsService.updateIssue(human, issue.id, { status }))),
      ).toBe("issue_needs_input");
    }
    // Non-status edits remain allowed while waiting on input
    const renamed = await projectsService.updateIssue(human, issue.id, {
      title: "Clarified title",
    });
    expect(renamed.title).toBe("Clarified title");

    // Moving back to todo releases the active claim while keeping the question open
    const movedToTodo = await projectsService.updateIssue(human, issue.id, { status: "todo" });
    expect(movedToTodo.status).toBe("todo");
    expect(movedToTodo.needsInput).toBe(true);
    expect(await activeSessions(issue.id)).toBe(0);

    // Still refused to close while paused/open question remains unanswered
    expect(
      errorKindOf(await refused(projectsService.updateIssue(human, issue.id, { status: "done" }))),
    ).toBe("issue_needs_input");

    // Answering unblocks closing
    await inbox.answer(human, question.id, "Use v2");
    const closed = await projectsService.updateIssue(human, issue.id, { status: "done" });
    expect(closed.status).toBe("done");
    expect(closed.needsInput).toBe(false);

    // Under fallback_allowed, a past-due question resolves in-tx and unblocks closing/handoff
    await projectsService.setProjectFallbackPolicy(human.account, f.projectId, {
      fallbackPolicy: "fallback_allowed",
    });
    const fallbackIssue = await newIssue(f, "Fallback unblocks completion");
    await claim(f, fallbackIssue.id, runId);
    const fallbackQ = await ask(f, fallbackIssue.id, runId);
    await setDeadline(fallbackQ.id, "statement_timestamp() - interval '1 second'");

    const handedOff = await sessions.stop(
      { kind: "agent", identity: f.identity },
      fallbackIssue.id,
      "review",
    );
    expect(handedOff.status).toBe("completed");
    const reviewed = await projectsService.getIssue(human, fallbackIssue.id);
    expect(reviewed.status).toBe("review");
    expect(reviewed.needsInput).toBe(false);
    expect((await questionOf(fallbackQ.id))?.status).toBe("fallback_used");
  });
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FallbackPolicy, IssueStatus, ProjectAccessLevel } from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  browserSessions,
  humans,
  issues,
  projectAccessGrants,
  projects,
  questions,
  runs,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  createAccountsFeature,
  type SessionAccount,
  type SessionReader,
} from "../accounts/index.ts";
import { createProjectsFeature, projectAccessAtLeast } from "../projects/index.ts";
import { createMyWorkRest } from "./rest.ts";
import { createMyWorkService, MyWorkError, type MyWorkService } from "./service.ts";

const SETUP_SECRET = "correct horse battery staple my work";
const PUBLIC_URL = "http://orrery.test";

let pg: StartedPostgreSqlContainer;
let database: Database;
let service: MyWorkService;
let rest: ReturnType<typeof createMyWorkRest>;
let sessionReader: SessionReader;
let projectsFeature: ReturnType<typeof createProjectsFeature>;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SETUP_SECRET,
    publicUrl: PUBLIC_URL,
  });
  sessionReader = accounts.sessionReader;
  projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => false,
    issueSessionGate: async () => false,
    evaluateQuestionDeadline: async () => {},
  });
  service = createMyWorkService({
    db: database.db,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast,
  });
  rest = createMyWorkRest(service, sessionReader);
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
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

type Human = { id: string; email: string };
type Workspace = { id: string; name: string };
type Project = { id: string; workspaceId: string; name: string; key: string };
type Issue = { id: string; projectId: string; number: number; title: string };
type Agent = { id: string; humanId: string; name: string };
type Run = { id: string; agentId: string; workspaceId: string };
type Session = { id: string; issueId: string };

let nextIssueNumber = 1;
let defaultHumanId = "";

async function human(label: string): Promise<Human> {
  const [row] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email: `${label}-${randomUUID()}@example.com`,
      passwordHash: tokenHash(randomUUID()),
      emailVerifiedAt: new Date(),
    })
    .returning();
  return { id: row!.id, email: row!.email };
}

async function personalWorkspace(owner: Human, label: string): Promise<Workspace> {
  const [row] = await database.db
    .insert(workspaces)
    .values({
      id: randomUUID(),
      kind: "personal",
      name: `${label} personal`,
      personalOwnerHumanId: owner.id,
    })
    .returning();
  return { id: row!.id, name: row!.name };
}

async function sharedWorkspace(owner: Human, label: string): Promise<Workspace> {
  return database.db.transaction(async (tx) => {
    const id = randomUUID();
    const [row] = await tx
      .insert(workspaces)
      .values({ id, kind: "shared", name: `${label} shared` })
      .returning();
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: id,
      humanId: owner.id,
      isOwner: true,
    });
    return { id: row!.id, name: row!.name };
  });
}

async function membership(workspace: Workspace, who: Human): Promise<string> {
  const [row] = await database.db
    .insert(workspaceMemberships)
    .values({ id: randomUUID(), workspaceId: workspace.id, humanId: who.id, isOwner: false })
    .returning();
  return row!.id;
}

async function project(
  workspace: Workspace,
  label: string,
  fallbackPolicy: FallbackPolicy = "require_human",
): Promise<Project> {
  const key = `${label.slice(0, 2)}${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const [row] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId: workspace.id,
      name: `${label} project`,
      key,
      createdByHumanId: defaultHumanId,
      fallbackPolicy,
    })
    .returning();
  return { id: row!.id, workspaceId: row!.workspaceId, name: row!.name, key: row!.key };
}

async function grant(
  target: Project,
  who: Human,
  level: ProjectAccessLevel,
  grantedBy: Human,
): Promise<string> {
  const [row] = await database.db
    .insert(projectAccessGrants)
    .values({
      id: randomUUID(),
      projectId: target.id,
      humanId: who.id,
      level,
      grantedByHumanId: grantedBy.id,
    })
    .returning();
  return row!.id;
}

async function issue(
  target: Project,
  author: Human,
  opts: {
    title?: string;
    status?: IssueStatus;
    assignee?: Human;
    deletedBy?: Human;
  } = {},
): Promise<Issue> {
  const number = nextIssueNumber++;
  const status = opts.status ?? "todo";
  const [row] = await database.db
    .insert(issues)
    .values({
      id: randomUUID(),
      projectId: target.id,
      number,
      title: opts.title ?? `Issue ${number}`,
      status,
      priority: "medium",
      sortOrder: number * 65535,
      createdByHumanId: author.id,
      updatedByHumanId: author.id,
      needsInput: false,
      assigneeHumanId: opts.assignee?.id ?? null,
      closedAt: status === "done" || status === "cancelled" ? new Date() : null,
      deletedAt: opts.deletedBy === undefined ? null : new Date(),
      deletedByHumanId: opts.deletedBy?.id ?? null,
    })
    .returning();
  return { id: row!.id, projectId: row!.projectId, number: row!.number, title: row!.title };
}

async function agent(owner: Human, label: string): Promise<Agent> {
  const [row] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: owner.id, name: `${label}-${randomUUID()}` })
    .returning();
  return { id: row!.id, humanId: row!.humanId, name: row!.name };
}

async function run(
  owner: Agent,
  workspace: Workspace,
  harness: string | null,
  model: string | null,
) {
  const [row] = await database.db
    .insert(runs)
    .values({
      id: randomUUID(),
      agentId: owner.id,
      workspaceId: workspace.id,
      status: "active",
      harness,
      model,
    })
    .returning();
  return { id: row!.id, agentId: row!.agentId, workspaceId: row!.workspaceId };
}

async function session(
  owner: Agent,
  via: Run,
  on: Issue,
  opts: {
    leaseMinutes?: number;
    progress?: string;
    stopReason?: string;
    requester?: Human;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsdMicros?: number | null;
  } = {},
): Promise<Session> {
  const stop = opts.stopReason === undefined ? null : new Date();
  const [row] = await database.db
    .insert(workSessions)
    .values({
      id: randomUUID(),
      agentId: owner.id,
      runId: via.id,
      workspaceId: via.workspaceId,
      issueId: on.id,
      status: "active",
      leaseExpiresAt: new Date(Date.now() + (opts.leaseMinutes ?? 5) * 60_000),
      progress: opts.progress ?? "working",
      stopRequestedAt: stop,
      stopRequestedByHumanId: stop === null ? null : (opts.requester?.id ?? defaultHumanId),
      stopReason: opts.stopReason ?? null,
      inputTokens: opts.inputTokens ?? null,
      outputTokens: opts.outputTokens ?? null,
      costUsdMicros: opts.costUsdMicros ?? null,
    })
    .returning();
  return { id: row!.id, issueId: row!.issueId };
}

async function question(
  on: Issue,
  by: Agent,
  via: Run,
  held: Session,
  author: Human,
  opts: {
    status?: "open" | "paused" | "answered" | "fallback_used";
    deadlineMinutes?: number;
    createdMinutesAgo?: number;
    text?: string;
  } = {},
): Promise<string> {
  const status = opts.status ?? "open";
  const createdAt = new Date(Date.now() - (opts.createdMinutesAgo ?? 0) * 60_000);
  const [row] = await database.db
    .insert(questions)
    .values({
      id: randomUUID(),
      issueId: on.id,
      projectId: on.projectId,
      workspaceId: via.workspaceId,
      agentId: by.id,
      runId: via.id,
      sessionId: held.id,
      question: opts.text ?? "Which approach should we take?",
      proposedFallback: "Use the safe default",
      status,
      responseDeadlineAt: new Date(Date.now() + (opts.deadlineMinutes ?? 30) * 60_000),
      createdAt,
      answer: status === "answered" ? "Use the safe default" : null,
      answeredByHumanId: status === "answered" ? author.id : null,
      answeredAt: status === "answered" ? new Date() : null,
      resolvedAt:
        status === "answered" || status === "paused" || status === "fallback_used"
          ? new Date()
          : null,
    })
    .returning();
  return row!.id;
}

const actor = (who: Human): SessionAccount => ({
  humanId: who.id,
  email: who.email,
  isSystemAdministrator: false,
  emailVerifiedAt: new Date(),
});

async function buildWorld() {
  const alice = await human("alice");
  defaultHumanId = alice.id;
  const bob = await human("bob");
  const carol = await human("carol");

  const personal = await personalWorkspace(alice, "ALICE");
  const shared = await sharedWorkspace(bob, "TEAM");
  const aliceMembership = await membership(shared, alice);

  const personalProject = await project(personal, "PER");
  const readProject = await project(shared, "REA");
  const contributeProject = await project(shared, "CON");
  const noAccessProject = await project(shared, "NOA");
  const fallbackProject = await project(shared, "FAL", "fallback_allowed");

  const readGrant = await grant(readProject, alice, "read", bob);
  const contributeGrant = await grant(contributeProject, alice, "contribute", bob);

  await grant(fallbackProject, alice, "contribute", bob);

  const aliceAgent = await agent(alice, "alice-bot");
  const carolAgent = await agent(carol, "carol-bot");
  const aliceRun = await run(aliceAgent, personal, "claude-code", "claude-sonnet-4");
  const aliceTeamRun = await run(aliceAgent, shared, "codex", "gpt-5");
  const carolTeamRun = await run(carolAgent, shared, "codex", null);

  const personalIssue = await issue(personalProject, alice, {
    title: "Personal assignment",
    assignee: alice,
  });
  const personalDone = await issue(personalProject, alice, {
    title: "Done assignment",
    status: "done",
    assignee: alice,
  });
  const personalCancelled = await issue(personalProject, alice, {
    title: "Cancelled assignment",
    status: "cancelled",
    assignee: alice,
  });
  const personalDeleted = await issue(personalProject, alice, {
    title: "Trashed assignment",
    assignee: alice,
    deletedBy: alice,
  });
  const readIssue = await issue(readProject, bob, {
    title: "Shared read assignment",
    assignee: alice,
  });
  const contributeIssue = await issue(contributeProject, bob, {
    title: "Shared contribute assignment",
    status: "in_progress",
    assignee: alice,
  });
  const noAccessIssue = await issue(noAccessProject, bob, {
    title: "Hidden assignment",
    assignee: alice,
  });

  const personalSession = await session(aliceAgent, aliceRun, personalIssue, {
    progress: "halfway",
    inputTokens: 1200,
    outputTokens: 340,
    costUsdMicros: 98765,
  });
  const readSession = await session(aliceAgent, aliceTeamRun, readIssue, {
    stopReason: "pause for review",
    requester: bob,
  });
  const contributeActiveIssue = await issue(contributeProject, bob, {
    title: "Agent on shared project",
  });
  const contributeSession = await session(aliceAgent, aliceTeamRun, contributeActiveIssue);
  const lapsedIssue = await issue(contributeProject, bob, { title: "Lapsed lease" });
  const lapsedSession = await session(aliceAgent, aliceTeamRun, lapsedIssue, { leaseMinutes: -5 });
  const trashedSessionIssue = await issue(contributeProject, bob, {
    title: "Trashed with session",
    deletedBy: alice,
  });
  const trashedSession = await session(aliceAgent, aliceTeamRun, trashedSessionIssue);
  const foreignIssue = await issue(contributeProject, bob, { title: "Carol's work" });
  const foreignSession = await session(carolAgent, carolTeamRun, foreignIssue);

  const openIssue = await issue(contributeProject, bob, { title: "Open question issue" });
  const openSession = await session(aliceAgent, aliceTeamRun, openIssue, { leaseMinutes: -5 });
  const openQuestion = await question(openIssue, aliceAgent, aliceTeamRun, openSession, bob);

  const pausedIssue = await issue(contributeProject, bob, { title: "Paused question issue" });
  const pausedSession = await session(aliceAgent, aliceTeamRun, pausedIssue, { leaseMinutes: -5 });
  const pausedQuestion = await question(pausedIssue, aliceAgent, aliceTeamRun, pausedSession, bob, {
    status: "paused",
  });

  const expiredIssue = await issue(contributeProject, bob, { title: "Expired question issue" });
  const expiredSession = await session(aliceAgent, aliceTeamRun, expiredIssue, {
    leaseMinutes: -5,
  });
  const expiredQuestion = await question(
    expiredIssue,
    aliceAgent,
    aliceTeamRun,
    expiredSession,
    bob,
    {
      deadlineMinutes: -30,
      createdMinutesAgo: 120,
    },
  );

  const fallbackIssue = await issue(fallbackProject, bob, { title: "Fallback question issue" });
  const fallbackSession = await session(aliceAgent, aliceTeamRun, fallbackIssue, {
    leaseMinutes: -5,
  });
  const fallbackQuestion = await question(
    fallbackIssue,
    aliceAgent,
    aliceTeamRun,
    fallbackSession,
    bob,
    {
      deadlineMinutes: -30,
      createdMinutesAgo: 120,
    },
  );

  const answeredIssue = await issue(contributeProject, bob, { title: "Answered question issue" });
  const answeredSession = await session(aliceAgent, aliceTeamRun, answeredIssue, {
    leaseMinutes: -5,
  });
  const answeredQuestion = await question(
    answeredIssue,
    aliceAgent,
    aliceTeamRun,
    answeredSession,
    bob,
    {
      status: "answered",
    },
  );

  const usedIssue = await issue(contributeProject, bob, { title: "Fallback used issue" });
  const usedSession = await session(aliceAgent, aliceTeamRun, usedIssue, { leaseMinutes: -5 });
  const usedQuestion = await question(usedIssue, aliceAgent, aliceTeamRun, usedSession, bob, {
    status: "fallback_used",
  });

  const readOnlyQuestionIssue = await issue(readProject, bob, { title: "Reader question issue" });
  const readOnlySession = await session(aliceAgent, aliceTeamRun, readOnlyQuestionIssue, {
    leaseMinutes: -5,
  });
  const readOnlyQuestion = await question(
    readOnlyQuestionIssue,
    aliceAgent,
    aliceTeamRun,
    readOnlySession,
    bob,
  );

  const trashedQuestionIssue = await issue(contributeProject, bob, {
    title: "Trashed question issue",
    deletedBy: alice,
  });
  const trashedQuestionSession = await session(aliceAgent, aliceTeamRun, trashedQuestionIssue, {
    leaseMinutes: -5,
  });
  const trashedQuestion = await question(
    trashedQuestionIssue,
    aliceAgent,
    aliceTeamRun,
    trashedQuestionSession,
    bob,
  );

  return {
    alice,
    bob,
    carol,
    personal,
    shared,
    aliceMembership,
    personalProject,
    readProject,
    contributeProject,
    noAccessProject,
    fallbackProject,
    readGrant,
    contributeGrant,
    aliceAgent,
    carolAgent,
    aliceRun,
    personalIssue,
    personalDone,
    personalCancelled,
    personalDeleted,
    readIssue,
    contributeIssue,
    noAccessIssue,
    personalSession,
    readSession,
    contributeSession,
    lapsedSession,
    trashedSession,
    foreignSession,
    openQuestion,
    pausedQuestion,
    expiredQuestion,
    fallbackQuestion,
    answeredQuestion,
    usedQuestion,
    readOnlyQuestion,
    trashedQuestion,
    openIssue,
  };
}

const ids = (items: readonly { id: string }[]): string[] => items.map((item) => item.id).toSorted();

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

describe("my-work service (real Postgres)", () => {
  it("aggregates assigned issues, live agent sessions and actionable questions across workspaces", async () => {
    const w = await buildWorld();
    const result = await service.get(actor(w.alice));

    expect(ids(result.assignedIssues)).toEqual(
      ids([w.personalIssue, w.readIssue, w.contributeIssue]),
    );
    const personal = result.assignedIssues.find((i) => i.id === w.personalIssue.id)!;
    expect(personal.identifier).toBe(`${w.personalProject.key}-${w.personalIssue.number}`);
    expect(personal.projectName).toBe(w.personalProject.name);
    expect(personal.workspaceId).toBe(w.personal.id);
    expect(personal.workspaceName).toBe(w.personal.name);
    expect(personal.status).toBe("todo");
    expect(personal.priority).toBe("medium");
    const sharedIssue = result.assignedIssues.find((i) => i.id === w.contributeIssue.id)!;
    expect(sharedIssue.identifier).toBe(`${w.contributeProject.key}-${w.contributeIssue.number}`);
    expect(sharedIssue.workspaceName).toBe(w.shared.name);

    expect(result.assignedIssues.map((i) => i.id)).not.toContain(w.personalDone.id);
    expect(result.assignedIssues.map((i) => i.id)).not.toContain(w.personalCancelled.id);
    expect(result.assignedIssues.map((i) => i.id)).not.toContain(w.personalDeleted.id);
    expect(result.assignedIssues.map((i) => i.id)).not.toContain(w.noAccessIssue.id);

    expect(result.activeAgentSessions.map((s) => s.sessionId).toSorted()).toEqual(
      [w.personalSession.id, w.readSession.id, w.contributeSession.id].toSorted(),
    );
    const live = result.activeAgentSessions.find((s) => s.sessionId === w.personalSession.id)!;
    expect(live.agentId).toBe(w.aliceAgent.id);
    expect(live.agentName).toBe(w.aliceAgent.name);
    expect(live.runId).toBe(w.aliceRun.id);
    expect(live.harness).toBe("claude-code");
    expect(live.model).toBe("claude-sonnet-4");
    expect(live.issueIdentifier).toBe(`${w.personalProject.key}-${w.personalIssue.number}`);
    expect(live.issueTitle).toBe(w.personalIssue.title);
    expect(live.workspaceName).toBe(w.personal.name);
    expect(live.leaseExpiresAt).toBeTruthy();
    expect(live.inputTokens).toBe(1200);
    expect(live.outputTokens).toBe(340);
    expect(live.costUsdMicros).toBe(98765);
    const stopping = result.activeAgentSessions.find((s) => s.sessionId === w.readSession.id)!;
    expect(stopping.stopRequestedAt).toBeTruthy();
    expect(stopping.stopReason).toBe("pause for review");
    expect(stopping.inputTokens).toBeNull();

    for (const excluded of [w.lapsedSession.id, w.trashedSession.id, w.foreignSession.id]) {
      expect(result.activeAgentSessions.map((s) => s.sessionId)).not.toContain(excluded);
    }

    expect(result.needsInputQuestions.map((q) => q.id).toSorted()).toEqual(
      [w.openQuestion, w.pausedQuestion, w.expiredQuestion].toSorted(),
    );
    const open = result.needsInputQuestions.find((q) => q.id === w.openQuestion)!;
    expect(open.status).toBe("open");
    expect(open.issueIdentifier).toBe(`${w.contributeProject.key}-${w.openIssue.number}`);
    expect(open.issueTitle).toBe(w.openIssue.title);
    expect(open.agentName).toBe(w.aliceAgent.name);
    expect(open.workspaceName).toBe(w.shared.name);
    const paused = result.needsInputQuestions.find((q) => q.id === w.expiredQuestion)!;
    expect(paused.status).toBe("paused");
    for (const excluded of [
      w.fallbackQuestion,
      w.answeredQuestion,
      w.usedQuestion,
      w.readOnlyQuestion,
      w.trashedQuestion,
    ]) {
      expect(result.needsInputQuestions.map((q) => q.id)).not.toContain(excluded);
    }
  });

  it("resolves project access once per workspace while aggregating every scope", async () => {
    const w = await buildWorld();
    const calls: { workspaceId: string; projectIds: string[] }[] = [];
    const measured = createMyWorkService({
      db: database.db,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) => {
        calls.push({ workspaceId, projectIds: [...projectIds] });
        return projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds);
      },
      projectAccessAtLeast,
    });

    const result = await measured.get(actor(w.alice));
    expect(ids(result.assignedIssues)).toEqual(
      ids([w.personalIssue, w.readIssue, w.contributeIssue]),
    );
    expect(result.activeAgentSessions.map((s) => s.sessionId).toSorted()).toEqual(
      [w.personalSession.id, w.readSession.id, w.contributeSession.id].toSorted(),
    );
    expect(result.needsInputQuestions.map((q) => q.id).toSorted()).toEqual(
      [w.openQuestion, w.pausedQuestion, w.expiredQuestion].toSorted(),
    );

    expect(calls.map((call) => call.workspaceId).toSorted()).toEqual(
      [w.personal.id, w.shared.id].toSorted(),
    );
    expect(calls.map((call) => call.projectIds.length).toSorted((a, b) => a - b)).toEqual([1, 4]);
  });

  it("excludes shared data immediately after a project grant is revoked", async () => {
    const w = await buildWorld();
    await database.db
      .delete(projectAccessGrants)
      .where(eq(projectAccessGrants.id, w.contributeGrant));

    const result = await service.get(actor(w.alice));
    expect(result.assignedIssues.map((i) => i.id)).not.toContain(w.contributeIssue.id);
    expect(result.assignedIssues.map((i) => i.id)).toContain(w.readIssue.id);
    expect(result.activeAgentSessions.map((s) => s.sessionId)).not.toContain(
      w.contributeSession.id,
    );
    expect(result.activeAgentSessions.map((s) => s.sessionId)).toContain(w.readSession.id);
    expect(result.needsInputQuestions.map((q) => q.id)).not.toContain(w.openQuestion);
    expect(result.needsInputQuestions).toEqual([]);

    expect(result.assignedIssues.map((i) => i.id)).toContain(w.personalIssue.id);
  });

  it("excludes shared data immediately after a membership is suspended or removed", async () => {
    const w = await buildWorld();
    await database.db
      .update(workspaceMemberships)
      .set({ suspendedAt: new Date() })
      .where(eq(workspaceMemberships.id, w.aliceMembership));

    const suspended = await service.get(actor(w.alice));
    expect(ids(suspended.assignedIssues)).toEqual([w.personalIssue.id]);
    expect(suspended.activeAgentSessions.map((s) => s.sessionId)).toEqual([w.personalSession.id]);
    expect(suspended.needsInputQuestions).toEqual([]);

    await database.db
      .update(workspaceMemberships)
      .set({ suspendedAt: null })
      .where(eq(workspaceMemberships.id, w.aliceMembership));
    await database.db
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.id, w.aliceMembership));

    const removed = await service.get(actor(w.alice));
    expect(ids(removed.assignedIssues)).toEqual([w.personalIssue.id]);
    expect(removed.activeAgentSessions.map((s) => s.sessionId)).toEqual([w.personalSession.id]);
    expect(removed.needsInputQuestions).toEqual([]);
  });

  it("refuses a missing caller and a deactivated human in the read transaction", async () => {
    await expect(service.get(null)).rejects.toBeInstanceOf(MyWorkError);
    await expect(service.get(null)).rejects.toMatchObject({ kind: "not_signed_in" });

    const w = await buildWorld();
    await database.db
      .update(humans)
      .set({ deactivatedAt: new Date() })
      .where(eq(humans.id, w.alice.id));
    await expect(service.get(actor(w.alice))).rejects.toBeInstanceOf(MyWorkError);
    await expect(service.get(actor(w.alice))).rejects.toMatchObject({ kind: "human_deactivated" });
  });
});

async function signInCookie(who: Human): Promise<string> {
  const token = `session-${randomUUID()}`;
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId: who.id,
    tokenHash: tokenHash(token),
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
  return `orrery_session=${token}`;
}

describe("my-work REST (real Postgres, real session reader)", () => {
  it("answers 200 for a human cookie and 401 for anonymous and agent-key-only callers", async () => {
    const w = await buildWorld();
    const cookie = await signInCookie(w.alice);

    const signedIn = await rest.request("/api/my-work", { headers: { cookie } });
    expect(signedIn.status).toBe(200);
    const body: unknown = await signedIn.json();
    expect(asArray(field(body, "assignedIssues")).length).toBe(3);
    expect(asArray(field(body, "activeAgentSessions")).length).toBe(3);
    expect(asArray(field(body, "needsInputQuestions")).length).toBe(3);

    const anonymous = await rest.request("/api/my-work");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toContain("application/problem+json");
    expect(field(await anonymous.json(), "code")).toBe("not_signed_in");

    const agentKey = `key-${randomUUID()}`;
    await database.db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId: w.aliceAgent.id,
      workspaceId: w.personal.id,
      createdByHumanId: w.alice.id,
      validity: "90",
      tokenHash: tokenHash(agentKey),
    });
    const withKey = await rest.request("/api/my-work", {
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(withKey.status).toBe(401);
    expect(field(await withKey.json(), "code")).toBe("not_signed_in");
  });

  it("refuses a deactivated human's retained cookie", async () => {
    const w = await buildWorld();
    const cookie = await signInCookie(w.alice);
    await database.db
      .update(humans)
      .set({ deactivatedAt: new Date() })
      .where(eq(humans.id, w.alice.id));

    const denied = await rest.request("/api/my-work", { headers: { cookie } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-type")).toContain("application/problem+json");

    expect(field(await denied.json(), "code")).toBe("not_signed_in");
  });
});

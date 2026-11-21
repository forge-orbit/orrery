import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  ActivityDetailBlockV1,
  ActiveWorkSessionsResponse,
  AgentIdentity,
  CreateAgentKeyResponse,
  IssuesResponse,
  Problem,
  RenewWorkSessionInput,
  RequestStopWorkSessionInput,
  SessionActivitiesResponse,
  SessionActivity,
  SessionActivityDetail,
  StopWorkSessionInput,
  WorkSession,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  browserSessions,
  humans,
  issueComments,
  issues,
  projectAccessGrants,
  projectActivity,
  projects,
  runs as runRows,
  workSessionActivities,
  workSessions,
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
import { createAgentsFeature, type AgentAuthenticator } from "../agents/index.ts";
import { createProjectsFeature, ProjectsError, type WorkSessionGate } from "../projects/index.ts";
import {
  createSessionsFeature,
  releaseIssueWorkSessions,
  SessionsError,
  type SessionsService,
} from "./index.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "sessions-admin@example.com";
const ADMIN_PASSWORD = "sessions-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let projectsService: ReturnType<typeof createProjectsFeature>["service"];
let sessionsService: SessionsService;

const atLeast = (actual: string, required: string) =>
  ["read", "contribute", "manage"].indexOf(actual) >=
  ["read", "contribute", "manage"].indexOf(required);

const postJson = (path: string, body: unknown, cookie?: string, bearer?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const getJson = (path: string, cookie?: string, bearer?: string) =>
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

function errorKind(error: unknown): string {
  if (error instanceof SessionsError || error instanceof ProjectsError) return error.kind;
  return "unexpected_error";
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

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
      if (gate === undefined) throw new Error("work session gate is not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
    releaseIssueWorkSessions,
  });
  let liveAuthenticator: AgentAuthenticator | undefined;
  const lateAuth: AgentAuthenticator = (request) => {
    if (liveAuthenticator === undefined) throw new Error("authenticator not wired");
    return liveAuthenticator(request);
  };
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) => atLeast(actual, required),
  });
  liveAuthenticator = agentsFeature.authenticator;
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: lateAuth,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: (actual, required) => atLeast(actual, required),
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
  projectsService = projectsFeature.service;
  sessionsService = sessionsFeature.service;
  app = createApp({
    features: [accounts, projectsFeature, agentsFeature, sessionsFeature],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from work_session_activities`);
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from issue_dependencies`);
    await tx.execute(sql`delete from issue_labels`);
    await tx.execute(sql`delete from project_labels`);
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

type Fixture = {
  cookie: string;
  humanId: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  secret: string;
};

async function bootstrap(): Promise<Fixture> {
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(setup.status).toBe(201);
  const login = await postJson("/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie");
  const [workspace] = await database.db.select().from(workspaces);
  if (workspace?.personalOwnerHumanId == null) throw new Error("no personal workspace");
  const humanId = workspace.personalOwnerHumanId;
  const created = await postJson(
    `/api/workspaces/${workspace.id}/projects`,
    { name: "Sessions project" },
    cookie,
  );
  expect(created.status).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentName = `sessions-agent-${randomUUID()}`;
  const agentRes = await postJson("/api/agents", { name: agentName }, cookie);
  expect(agentRes.status).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const keyRes = await postJson(
    "/api/agents/keys",
    {
      agentId,
      workspaceId: workspace.id,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
    cookie,
  );
  expect(keyRes.status).toBe(201);
  const secret = CreateAgentKeyResponse.parse(await keyRes.json()).secret;
  return { cookie, humanId, workspaceId: workspace.id, projectId, agentId, secret };
}

async function identityFor(secret: string): Promise<AgentIdentity> {
  const res = await getJson("/api/agents/me", undefined, secret);
  expect(res.status).toBe(200);
  return AgentIdentity.parse(await res.json());
}

async function newRun(identity: AgentIdentity): Promise<string> {
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
  return run.id;
}

function humanActor(f: Fixture) {
  return {
    kind: "human" as const,
    account: {
      humanId: f.humanId,
      email: ADMIN_EMAIL,
      isSystemAdministrator: false,
      emailVerifiedAt: new Date(),
    },
  };
}

async function humanIssue(f: Fixture, title: string) {
  return projectsService.createIssue(
    {
      kind: "human",
      account: {
        humanId: f.humanId,
        email: ADMIN_EMAIL,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    },
    f.projectId,
    { title },
  );
}

async function registerSecondAgent(f: Fixture) {
  const created = await postJson("/api/agents", { name: `other-agent-${randomUUID()}` }, f.cookie);
  expect(created.status).toBe(201);
  const agentId = idOf(await created.json(), "agent");
  const key = await postJson(
    "/api/agents/keys",
    {
      agentId,
      workspaceId: f.workspaceId,
      validity: "90",
      projects: [{ projectId: f.projectId, level: "contribute" }],
    },
    f.cookie,
  );
  expect(key.status).toBe(201);
  const secret = CreateAgentKeyResponse.parse(await key.json()).secret;
  return { agentId, secret, identity: await identityFor(secret) };
}

async function assign(
  issueId: string,
  f: Fixture,
  assignee: { type: "human" | "agent"; id: string },
) {
  await projectsService.updateIssue(humanActor(f), issueId, { assignee });
}

async function setLease(issueId: string, sqlExpression: string) {
  await database.db.execute(
    sql`update work_sessions set lease_expires_at = ${sql.raw(sqlExpression)} where issue_id = ${issueId} and status = 'active'`,
  );
}

async function activeCount(issueId: string): Promise<number> {
  const rows = await database.db
    .select({ id: workSessions.id })
    .from(workSessions)
    .where(and(eq(workSessions.issueId, issueId), eq(workSessions.status, "active")));
  return rows.length;
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => Promise.reject(new Error("expected the operation to be refused")),
    (error: unknown) => error,
  );
}

async function issueStatus(issueId: string) {
  const [row] = await database.db
    .select({ status: issues.status, closedAt: issues.closedAt })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (row === undefined) throw new Error("missing issue");
  return row;
}

describe("work sessions against real Postgres", () => {
  it("claims and stops a session tied to the agent, run, workspace and issue", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Claimed issue");
    const runId = await newRun(identity);

    const claim = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId },
    );
    expect(claim).toMatchObject({
      agentId: identity.agentId,
      runId,
      workspaceId: f.workspaceId,
      issueId: issue.id,
      status: "active",
    });
    const [row] = await database.db
      .select({ lease: workSessions.leaseExpiresAt })
      .from(workSessions)
      .where(eq(workSessions.id, claim.id));
    const [inWindow] = await database.db.execute<{ ok: boolean }>(sql`
      select ${sql.raw("true")} as ok from work_sessions
      where id = ${claim.id}
        and lease_expires_at > statement_timestamp()
        and lease_expires_at <= statement_timestamp() + interval '5 minutes' + interval '1 second'
    `);
    expect(inWindow?.ok).toBe(true);
    expect(row?.lease).toBeInstanceOf(Date);

    const stopped = await sessionsService.stop({ kind: "agent", identity }, issue.id, "completed");
    expect(stopped).toMatchObject({ status: "completed" });
    expect(stopped.endedAt).not.toBeNull();
    expect(await activeCount(issue.id)).toBe(0);

    expect(await issueStatus(issue.id)).toMatchObject({ status: "review", closedAt: null });
    expect(await sessionsService.readyWork({ kind: "agent", identity }, f.projectId)).toEqual([]);
  });

  it("lets one of two concurrent claims win and enforces the unique index", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Raced issue");
    const runA = await newRun(identity);
    const runB = await newRun(identity);

    const results = await Promise.allSettled([
      sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId: runA }),
      sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId: runB }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(SessionsError);
    expect(errorKind(rejected?.reason)).toBe("issue_claimed");
    expect(await activeCount(issue.id)).toBe(1);

    const winner = results.find(
      (result): result is PromiseFulfilledResult<WorkSession> => result.status === "fulfilled",
    )?.value;
    let insertError: unknown;
    try {
      await database.db.insert(workSessions).values({
        id: randomUUID(),
        agentId: identity.agentId,
        runId: runB,
        workspaceId: f.workspaceId,
        issueId: issue.id,
        status: "active",
        leaseExpiresAt: new Date(Date.now() + 300_000),
      });
      insertError = new Error("the unique index did not refuse a second active session");
    } catch (error) {
      insertError = error;
    }
    expect(rootCause(insertError)).toMatchObject({
      code: "23505",
      constraint_name: "one_active_work_session_per_issue",
    });
    expect((await database.db.select().from(workSessions)).map((row) => row.id)).toEqual([
      winner?.id,
    ]);
  });

  it("expires at five minutes in database time, retaining progress and sparing other claims", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const a = await humanIssue(f, "Lapsing issue");
    const b = await humanIssue(f, "Healthy issue");
    await sessionsService.claim({ kind: "agent", identity }, { issueId: a.id, runId });
    await sessionsService.claim({ kind: "agent", identity }, { issueId: b.id, runId });
    await sessionsService.progress({ kind: "agent", identity }, a.id, "Halfway through");

    await setLease(b.id, "statement_timestamp() + interval '1 second'");
    await expect(sessionsService.renew({ kind: "agent", identity }, b.id)).resolves.toMatchObject({
      status: "active",
    });

    await setLease(a.id, "statement_timestamp() - interval '1 second'");
    const error = await rejection(sessionsService.renew({ kind: "agent", identity }, a.id));
    expect(error).toBeInstanceOf(SessionsError);
    expect(errorKind(error)).toBe("session_required");
    const stored = await sessionsService.getSession({ kind: "agent", identity }, a.id);
    expect(stored).toMatchObject({ status: "expired", progress: "Halfway through" });
    expect(await activeCount(a.id)).toBe(0);
    expect(await activeCount(b.id)).toBe(1);
    const ready = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(ready.map((item) => item.id)).toContain(a.id);
    expect(ready.map((item) => item.id)).not.toContain(b.id);
  });

  it("rejects a stale edit, close, progress and completion even when nobody else claimed", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Fenced issue");
    const runId = await newRun(identity);
    await sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId });
    await sessionsService.progress({ kind: "agent", identity }, issue.id, "before lapse");
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    const actor = { kind: "agent" as const, identity };

    const staleWrites = [
      () => projectsService.updateIssue(actor, issue.id, { title: "Stale edit" }),
      () => projectsService.updateIssue(actor, issue.id, { body: "Stale body" }),
      () => projectsService.updateIssue(actor, issue.id, { status: "done" }),
    ];
    for (const write of staleWrites) {
      const error = await rejection(write());
      expect(error).toBeInstanceOf(ProjectsError);
      expect(errorKind(error)).toBe("session_required");
    }
    for (const operation of [
      () => sessionsService.progress(actor, issue.id, "after lapse"),
      () => sessionsService.renew(actor, issue.id),
      () => sessionsService.stop(actor, issue.id, "completed"),
    ]) {
      const error = await rejection(operation());
      expect(error).toBeInstanceOf(SessionsError);
      expect(errorKind(error)).toBe("session_required");
    }
    const [row] = await database.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row?.title).toBe("Fenced issue");
    expect(row?.body).toBe("");
    expect(row?.status).toBe("todo");
    expect(await activeCount(issue.id)).toBe(0);
    expect((await sessionsService.getSession(actor, issue.id)).progress).toBe("before lapse");

    await expect(sessionsService.claim(actor, { issueId: issue.id, runId })).resolves.toMatchObject(
      { status: "active" },
    );
  });

  it("lets a replacement key renew, but a Read downgrade stops renewal and fenced writes", async () => {
    const f = await bootstrap();
    const issue = await humanIssue(f, "Rotated issue");

    const second = await postJson(
      "/api/agents/keys",
      {
        agentId: f.agentId,
        workspaceId: f.workspaceId,
        validity: "never",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    expect(second.status).toBe(201);
    const replacementSecret = CreateAgentKeyResponse.parse(await second.json()).secret;
    const firstIdentity = await identityFor(f.secret);
    const replacement = await identityFor(replacementSecret);
    expect(replacement.agentId).toBe(firstIdentity.agentId);
    const runId = await newRun(firstIdentity);
    const session = await sessionsService.claim(
      { kind: "agent", identity: firstIdentity },
      { issueId: issue.id, runId },
    );
    await expect(
      sessionsService.renew({ kind: "agent", identity: replacement }, issue.id),
    ).resolves.toMatchObject({ id: session.id, status: "active" });

    const [team] = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Rotation team" })
        .returning();
      if (created === undefined) throw new Error("the team was not created");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: f.humanId,
        isOwner: true,
      });
      return [created];
    });
    if (team === undefined) throw new Error("the team was not created");
    const teamId = team.id;
    const [member] = await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email: "rotation-member@example.com",
        passwordHash: "x",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: humans.id });
    if (member === undefined) throw new Error("the member was not created");
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: teamId,
      humanId: member.id,
    });
    const memberProject = await postJson(
      `/api/workspaces/${teamId}/projects`,
      { name: "Member project" },
      f.cookie,
    );
    expect(memberProject.status).toBe(201);
    const memberProjectId = idOf(await memberProject.json(), "project");
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: memberProjectId,
      humanId: member.id,
      level: "contribute",
      grantedByHumanId: f.humanId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const memberToken = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: member.id,
      tokenHash: tokenHash(memberToken),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    const memberCookie = `orrery_session=${memberToken}`;
    const memberAgent = await postJson(
      "/api/agents",
      { name: `rotation-member-bot-${randomUUID()}` },
      memberCookie,
    );
    const memberAgentId = idOf(await memberAgent.json(), "agent");
    const memberKey = await postJson(
      "/api/agents/keys",
      {
        agentId: memberAgentId,
        workspaceId: teamId,
        validity: "90",
        projects: [{ projectId: memberProjectId, level: "contribute" }],
      },
      memberCookie,
    );
    expect(memberKey.status).toBe(201);
    const memberSecret = CreateAgentKeyResponse.parse(await memberKey.json()).secret;
    let memberIdentity = await identityFor(memberSecret);
    const memberIssue = await projectsService.createIssue(
      {
        kind: "human",
        account: {
          humanId: f.humanId,
          email: ADMIN_EMAIL,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
      },
      memberProjectId,
      { title: "Downgraded issue" },
    );
    const memberRun = await newRun(memberIdentity);
    await sessionsService.claim(
      { kind: "agent", identity: memberIdentity },
      { issueId: memberIssue.id, runId: memberRun },
    );

    const downgrade = database.db
      .update(projectAccessGrants)
      .set({ level: "read" })
      .where(
        and(
          eq(projectAccessGrants.projectId, memberProjectId),
          eq(projectAccessGrants.humanId, member.id),
        ),
      );
    await Promise.allSettled([
      sessionsService.renew({ kind: "agent", identity: memberIdentity }, memberIssue.id),
      downgrade,
    ]);
    memberIdentity = await identityFor(memberSecret);
    expect(memberIdentity.projects).toMatchObject([{ projectId: memberProjectId, level: "read" }]);
    const renewError = await rejection(
      sessionsService.renew({ kind: "agent", identity: memberIdentity }, memberIssue.id),
    );
    expect(errorKind(renewError)).toBe("insufficient_access");
    const editError = await rejection(
      projectsService.updateIssue({ kind: "agent", identity: memberIdentity }, memberIssue.id, {
        title: "After downgrade",
      }),
    );
    expect(errorKind(editError)).toBe("insufficient_project_access");
  });

  it("coordinates a parent run, shared helpers and independent subagents", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const parentIssues = await Promise.all(
      ["Parent A", "Parent B", "Parent C"].map((title) => humanIssue(f, title)),
    );
    const sessions = await Promise.all(
      parentIssues.map((issue) =>
        sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId }),
      ),
    );
    expect(sessions.every((session) => session.runId === runId)).toBe(true);
    expect(new Set(sessions.map((session) => session.issueId)).size).toBe(3);

    const helper = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: parentIssues[0]!.id, runId },
    );
    expect(helper.id).toBe(sessions[0]!.id);
    expect(await activeCount(parentIssues[0]!.id)).toBe(1);

    const other = await postJson("/api/agents", { name: `subagent-${randomUUID()}` }, f.cookie);
    const otherId = idOf(await other.json(), "agent");
    const otherKey = await postJson(
      "/api/agents/keys",
      {
        agentId: otherId,
        workspaceId: f.workspaceId,
        validity: "90",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    const otherIdentity = await identityFor(
      CreateAgentKeyResponse.parse(await otherKey.json()).secret,
    );
    const otherRun = await newRun(otherIdentity);
    const subagentIssue = await humanIssue(f, "Subagent issue");
    const otherSession = await sessionsService.claim(
      { kind: "agent", identity: otherIdentity },
      { issueId: subagentIssue.id, runId: otherRun },
    );
    expect(otherSession.agentId).toBe(otherId);
    expect(otherSession.runId).toBe(otherRun);
    expect(
      (await sessionsService.listSessions({ kind: "agent", identity }, subagentIssue.id)).map(
        (s) => s.id,
      ),
    ).toContain(otherSession.id);
  });

  it("lists only open, unclaimed issues that are not Needs input", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const plain = await humanIssue(f, "Ready");
    const claimed = await humanIssue(f, "Claimed");
    const needsInput = await humanIssue(f, "Paused");
    const closed = await humanIssue(f, "Done");
    await sessionsService.claim({ kind: "agent", identity }, { issueId: claimed.id, runId });
    await database.db.update(issues).set({ needsInput: true }).where(eq(issues.id, needsInput.id));
    await projectsService.updateIssue(
      {
        kind: "human",
        account: {
          humanId: f.humanId,
          email: ADMIN_EMAIL,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
      },
      closed.id,
      { status: "done" },
    );

    const ready = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(ready.map((item) => item.id)).toEqual([plain.id]);
    await setLease(claimed.id, "statement_timestamp() - interval '1 second'");

    expect((await issueStatus(claimed.id)).status).toBe("in_progress");
    const afterExpiry = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect((await issueStatus(claimed.id)).status).toBe("todo");
    expect(afterExpiry.map((item) => item.id)).toEqual([plain.id, claimed.id]);
  });

  it("excludes an issue with an open blocker and includes it once the blocker closes", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const human = {
      kind: "human" as const,
      account: {
        humanId: f.humanId,
        email: ADMIN_EMAIL,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    };
    const blocker = await humanIssue(f, "Prerequisite");
    const downstream = await humanIssue(f, "Downstream");
    await projectsService.addBlockedBy(human, downstream.id, { blockedByIssueId: blocker.id });

    const before = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(before.map((item) => item.id)).toContain(blocker.id);
    expect(before.map((item) => item.id)).not.toContain(downstream.id);

    await projectsService.updateIssue(human, blocker.id, { status: "done" });
    const after = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(after.map((item) => item.id)).toContain(downstream.id);

    await projectsService.removeBlockedBy(human, downstream.id, blocker.id);
    const afterRemoval = await sessionsService.readyWork({ kind: "agent", identity }, f.projectId);
    expect(afterRemoval.map((item) => item.id)).toContain(downstream.id);
  });

  it("offers eligible todo subtasks independently of their parent (#97)", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const agent = { kind: "agent" as const, identity };
    const run = await newRun(identity);
    const parent = await humanIssue(f, "Parent");
    const first = await humanIssue(f, "Subtask one");
    const second = await humanIssue(f, "Subtask two");
    await projectsService.updateIssue(humanActor(f), first.id, { parentIssueId: parent.id });
    await projectsService.updateIssue(humanActor(f), second.id, { parentIssueId: parent.id });

    const ready = (await sessionsService.readyWork(agent, f.projectId)).map((item) => item.id);
    expect(ready).toContain(parent.id);
    expect(ready).toContain(first.id);
    expect(ready).toContain(second.id);

    await sessionsService.claim(agent, { issueId: first.id, runId: run });
    const afterClaim = (await sessionsService.readyWork(agent, f.projectId)).map((item) => item.id);
    expect(afterClaim).not.toContain(first.id);
    expect(afterClaim).toContain(parent.id);
    expect(afterClaim).toContain(second.id);
  });

  it("open subtasks never block the parent; only explicit blocked_by does (#97)", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const agent = { kind: "agent" as const, identity };
    const run = await newRun(identity);
    const parent = await humanIssue(f, "Parent with open subtask");
    const subtask = await humanIssue(f, "Open subtask");
    await projectsService.updateIssue(humanActor(f), subtask.id, { parentIssueId: parent.id });

    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).toContain(
      parent.id,
    );
    await sessionsService.claim(agent, { issueId: parent.id, runId: run });
    await sessionsService.stop(agent, parent.id, "done");
    expect((await issueStatus(parent.id)).status).toBe("done");
    expect((await issueStatus(subtask.id)).status).toBe("todo");

    await projectsService.addBlockedBy(humanActor(f), parent.id, { blockedByIssueId: subtask.id });
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).not.toContain(
      parent.id,
    );
  });

  it("unblocks a dependent when its blocker is cancelled, but not when it is in review", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const agent = { kind: "agent" as const, identity };
    const blocker = await humanIssue(f, "Cancelled prerequisite");
    const downstream = await humanIssue(f, "Downstream of cancelled");
    await projectsService.addBlockedBy(humanActor(f), downstream.id, {
      blockedByIssueId: blocker.id,
    });

    await projectsService.updateIssue(humanActor(f), blocker.id, { status: "review" });
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).not.toContain(
      downstream.id,
    );

    await projectsService.updateIssue(humanActor(f), blocker.id, { status: "cancelled" });
    expect((await issueStatus(blocker.id)).closedAt).not.toBeNull();
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).toContain(
      downstream.id,
    );
  });

  it("orders ready work by priority, then sortOrder, then createdAt", async () => {
    const f = await bootstrap();
    const human = humanActor(f);
    const identity = await identityFor(f.secret);
    const actor = { kind: "agent" as const, identity };
    const make = (
      title: string,
      input: { priority?: "urgent" | "high" | "medium" | "low" | "none"; sortOrder?: number } = {},
    ) => projectsService.createIssue(human, f.projectId, { title, ...input });

    const urgent = await make("Urgent", { priority: "urgent", sortOrder: 100_000 });
    const high = await make("High", { priority: "high", sortOrder: 200_000 });
    const medium = await make("Medium", { priority: "medium", sortOrder: 300_000 });
    const low = await make("Low", { priority: "low", sortOrder: 400_000 });
    const none = await make("None", { sortOrder: 500_000 });

    const first = await sessionsService.readyWork(actor, f.projectId);
    expect(first.map((issue) => issue.id)).toEqual([
      urgent.id,
      high.id,
      medium.id,
      low.id,
      none.id,
    ]);

    const earlier = await make("Earlier", { priority: "urgent", sortOrder: 10 });
    const later = await make("Later", { priority: "urgent", sortOrder: 10 });
    await database.db
      .update(issues)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(issues.id, earlier.id));
    await database.db
      .update(issues)
      .set({ createdAt: new Date("2021-01-01T00:00:00Z") })
      .where(eq(issues.id, later.id));

    const second = await sessionsService.readyWork(actor, f.projectId);
    expect(second.map((issue) => issue.id)).toEqual([
      earlier.id,
      later.id,
      urgent.id,
      high.id,
      medium.id,
      low.id,
      none.id,
    ]);
  });

  it("reorders ready work by writing only the dragged card's midpoint", async () => {
    const f = await bootstrap();
    const human = humanActor(f);
    const identity = await identityFor(f.secret);
    const actor = { kind: "agent" as const, identity };
    const a = await projectsService.createIssue(human, f.projectId, { title: "A", sortOrder: 0 });
    const b = await projectsService.createIssue(human, f.projectId, {
      title: "B",
      sortOrder: 100,
    });
    const c = await projectsService.createIssue(human, f.projectId, {
      title: "C",
      sortOrder: 200,
    });

    expect((await sessionsService.readyWork(actor, f.projectId)).map((i) => i.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);

    await projectsService.updateIssue(human, c.id, { sortOrder: 50 });
    expect((await sessionsService.readyWork(actor, f.projectId)).map((i) => i.id)).toEqual([
      a.id,
      c.id,
      b.id,
    ]);
    const positions = new Map(
      (await database.db.select({ id: issues.id, sortOrder: issues.sortOrder }).from(issues)).map(
        (row) => [row.id, row.sortOrder],
      ),
    );
    expect(positions.get(a.id)).toBe(0);
    expect(positions.get(b.id)).toBe(100);
    expect(positions.get(c.id)).toBe(50);
  });

  it("lets an agent set priority and position at creation and update it while holding a session", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const actor = { kind: "agent" as const, identity };

    const issue = await projectsService.createIssue(actor, f.projectId, {
      title: "Agent triage",
      priority: "high",
      sortOrder: 500,
    });
    expect(issue).toMatchObject({ priority: "high", sortOrder: 500 });

    const runId = await newRun(identity);
    await sessionsService.claim(actor, { issueId: issue.id, runId });
    const updated = await projectsService.updateIssue(actor, issue.id, {
      priority: "urgent",
      sortOrder: 250,
    });
    expect(updated).toMatchObject({ priority: "urgent", sortOrder: 250 });
  });

  it("exposes claim, progress, read and stop through bearer REST", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "REST session");
    const runId = await newRun(identity);

    const claim = await postJson(
      `/api/issues/${issue.id}/work-sessions`,
      { runId },
      undefined,
      f.secret,
    );
    expect(claim.status).toBe(201);
    const session = WorkSession.parse(await claim.json());
    expect(session.status).toBe("active");

    const progress = await postJson(
      `/api/issues/${issue.id}/work-sessions/progress`,
      { summary: "REST progress" },
      undefined,
      f.secret,
    );
    expect(progress.status).toBe(200);
    expect(WorkSession.parse(await progress.json()).progress).toBe("REST progress");

    const current = await getJson(`/api/issues/${issue.id}/work-sessions`, undefined, f.secret);
    expect(current.status).toBe(200);
    const ready = await getJson(`/api/projects/${f.projectId}/ready-work`, undefined, f.secret);
    expect(ready.status).toBe(200);

    const stop = await postJson(
      `/api/issues/${issue.id}/work-sessions/stop`,
      { outcome: "released" },
      undefined,
      f.secret,
    );
    expect(stop.status).toBe(200);
    expect(WorkSession.parse(await stop.json()).status).toBe("released");

    const edit = await postJson(
      `/api/issues/${issue.id}/work-sessions/renew`,
      {},
      undefined,
      f.secret,
    );
    await expectProblem(edit, 409, "session_required");
    expect(identity.agentId).toBe(f.agentId);
  });

  it("reports progress and retains it across interruption, distinguishing a live claim from an expired one on resume", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Resumed issue");
    const runId = await newRun(identity);
    const actor = { kind: "agent" as const, identity };
    const claim = await sessionsService.claim(actor, { issueId: issue.id, runId });

    await sessionsService.progress(actor, issue.id, "Drafted the plan");
    const live = await sessionsService.resume(actor, { issueId: issue.id, runId });
    expect(live).toMatchObject({
      runId,
      issueId: issue.id,
      disposition: "active",
      session: { id: claim.id, status: "active", progress: "Drafted the plan" },
    });

    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    const interrupted = await sessionsService.resume(actor, { issueId: issue.id, runId });
    expect(interrupted).toMatchObject({
      disposition: "expired",
      session: { id: claim.id, status: "expired", progress: "Drafted the plan" },
    });
    const [raw] = await database.db
      .select({ status: workSessions.status })
      .from(workSessions)
      .where(eq(workSessions.id, claim.id));
    expect(raw?.status).toBe("active");

    const otherRun = await newRun(identity);
    const none = await sessionsService.resume(actor, { issueId: issue.id, runId: otherRun });
    expect(none).toMatchObject({ disposition: "none", session: null });

    const staleStop = await rejection(sessionsService.stop(actor, issue.id, "completed"));
    expect(errorKind(staleStop)).toBe("session_required");
    expect(await activeCount(issue.id)).toBe(0);
    const readBack = await sessionsService.getSession(actor, issue.id);
    expect(readBack).toMatchObject({ status: "expired", progress: "Drafted the plan" });
  });

  it("reacquires an expired claim with its progress, and retries never duplicate the claim", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Reacquired issue");
    const runId = await newRun(identity);
    const actor = { kind: "agent" as const, identity };
    const original = await sessionsService.claim(actor, { issueId: issue.id, runId });
    await sessionsService.progress(actor, issue.id, "Halfway through", undefined, {
      inputTokens: 50,
      outputTokens: 10,
      costUsdMicros: 200,
    });
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    const reacquired = await sessionsService.reacquire(actor, { issueId: issue.id, runId });
    expect(reacquired).toMatchObject({
      status: "active",
      runId,
      agentId: identity.agentId,
      issueId: issue.id,
      progress: "Halfway through",
    });

    expect(reacquired).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
    });
    const sessions = await database.db
      .select()
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    expect(sessions.find((row) => row.id === original.id)).toMatchObject({
      status: "expired",
      inputTokens: 50,
      outputTokens: 10,
      costUsdMicros: 200,
    });
    expect(reacquired.id).not.toBe(original.id);
    expect(await activeCount(issue.id)).toBe(1);

    const second = await postJson(
      "/api/agents/keys",
      {
        agentId: f.agentId,
        workspaceId: f.workspaceId,
        validity: "never",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    const replacement = await identityFor(CreateAgentKeyResponse.parse(await second.json()).secret);
    const retry = await sessionsService.reacquire(
      { kind: "agent", identity: replacement },
      { issueId: issue.id, runId },
    );
    expect(retry.id).toBe(reacquired.id);
    expect(await activeCount(issue.id)).toBe(1);

    const claimRetry = await sessionsService.claim(actor, { issueId: issue.id, runId });
    expect(claimRetry.id).toBe(reacquired.id);
    expect(await activeCount(issue.id)).toBe(1);
  });

  it("reacquires only when the issue is available, and refuses a paused issue", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Paused reacquire issue");
    const runId = await newRun(identity);
    const actor = { kind: "agent" as const, identity };
    await sessionsService.claim(actor, { issueId: issue.id, runId });
    await sessionsService.progress(actor, issue.id, "Blocked midway");
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    await database.db.update(issues).set({ needsInput: true }).where(eq(issues.id, issue.id));

    const blocked = await rejection(sessionsService.reacquire(actor, { issueId: issue.id, runId }));
    expect(errorKind(blocked)).toBe("issue_blocked");
    expect(await activeCount(issue.id)).toBe(0);

    await database.db.update(issues).set({ needsInput: false }).where(eq(issues.id, issue.id));
    await expect(
      sessionsService.reacquire(actor, { issueId: issue.id, runId }),
    ).resolves.toMatchObject({ status: "active", progress: "Blocked midway" });
  });

  it("refuses stale writes and reacquisition when another worker holds the issue", async () => {
    const f = await bootstrap();
    const first = await identityFor(f.secret);
    const otherAgent = await postJson(
      "/api/agents",
      { name: `resent-agent-${randomUUID()}` },
      f.cookie,
    );
    const otherId = idOf(await otherAgent.json(), "agent");
    const otherKey = await postJson(
      "/api/agents/keys",
      {
        agentId: otherId,
        workspaceId: f.workspaceId,
        validity: "90",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    const replacement = await identityFor(
      CreateAgentKeyResponse.parse(await otherKey.json()).secret,
    );
    const issue = await humanIssue(f, "Contested issue");
    const firstRun = await newRun(first);
    const otherRun = await newRun(replacement);
    const stale = { kind: "agent" as const, identity: first };
    const current = { kind: "agent" as const, identity: replacement };

    await sessionsService.claim(stale, { issueId: issue.id, runId: firstRun });
    await sessionsService.progress(stale, issue.id, "Original progress");
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    const replacementSession = await sessionsService.claim(current, {
      issueId: issue.id,
      runId: otherRun,
    });
    expect(replacementSession).toMatchObject({ status: "active", agentId: otherId });

    const reacquireError = await rejection(
      sessionsService.reacquire(stale, { issueId: issue.id, runId: firstRun }),
    );
    expect(errorKind(reacquireError)).toBe("issue_claimed");
    for (const operation of [
      () => sessionsService.renew(stale, issue.id),
      () => sessionsService.progress(stale, issue.id, "Stale overwrite"),
      () => sessionsService.stop(stale, issue.id, "completed"),
      () => projectsService.updateIssue(stale, issue.id, { title: "Stale title" }),
      () => projectsService.updateIssue(stale, issue.id, { status: "done" }),
    ]) {
      const error = await rejection(operation());
      expect(errorKind(error)).toBe("session_required");
    }

    expect(await activeCount(issue.id)).toBe(1);
    const [row] = await database.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row?.title).toBe("Contested issue");

    expect(row?.status).toBe("in_progress");

    const history = await sessionsService.listSessions(current, issue.id);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: first.agentId,
          status: "expired",
          progress: "Original progress",
        }),
        expect.objectContaining({ id: replacementSession.id, status: "active" }),
      ]),
    );
  });

  it("fences stale writes to an expired session even when the same agent holds a newer one", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Fenced stale issue");
    const run1 = await newRun(identity);
    const actor = { kind: "agent" as const, identity };
    const s1 = await sessionsService.claim(actor, { issueId: issue.id, runId: run1 });
    await sessionsService.progress(actor, issue.id, "Original progress");
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    const s2 = await sessionsService.reacquire(actor, { issueId: issue.id, runId: run1 });
    expect(s2.id).not.toBe(s1.id);
    expect(s2).toMatchObject({ status: "active", progress: "Original progress" });

    for (const stale of [
      () => sessionsService.renew(actor, issue.id, s1.id),
      () => sessionsService.progress(actor, issue.id, "Stale overwrite", s1.id),
      () => sessionsService.stop(actor, issue.id, "completed", s1.id),
    ]) {
      const error = await rejection(stale());
      expect(errorKind(error)).toBe("session_required");
    }

    await expect(sessionsService.renew(actor, issue.id, s2.id)).resolves.toMatchObject({
      id: s2.id,
      status: "active",
    });
    expect((await sessionsService.getSession(actor, issue.id)).progress).toBe("Original progress");
    expect(await activeCount(issue.id)).toBe(1);

    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    const run2 = await newRun(identity);
    const s3 = await sessionsService.claim(actor, { issueId: issue.id, runId: run2 });
    expect(s3.id).not.toBe(s2.id);
    for (const oldId of [s1.id, s2.id]) {
      for (const stale of [
        () => sessionsService.renew(actor, issue.id, oldId),
        () => sessionsService.progress(actor, issue.id, "Another stale write", oldId),
        () => sessionsService.stop(actor, issue.id, "completed", oldId),
      ]) {
        const error = await rejection(stale());
        expect(errorKind(error)).toBe("session_required");
      }
    }
    await expect(sessionsService.renew(actor, issue.id, s3.id)).resolves.toMatchObject({
      id: s3.id,
      status: "active",
    });
    expect(await activeCount(issue.id)).toBe(1);
    const history = await sessionsService.listSessions(actor, issue.id);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: s1.id, status: "expired" }),
        expect.objectContaining({ id: s2.id, status: "expired" }),
        expect.objectContaining({ id: s3.id, status: "active" }),
      ]),
    );
  });

  it("refuses to reacquire a claim on an issue closed while the lease was expired", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Closed reacquire issue");
    const runId = await newRun(identity);
    const actor = { kind: "agent" as const, identity };
    await sessionsService.claim(actor, { issueId: issue.id, runId });
    await sessionsService.progress(actor, issue.id, "Done mostly");
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    await projectsService.updateIssue(
      {
        kind: "human",
        account: {
          humanId: f.humanId,
          email: ADMIN_EMAIL,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
      },
      issue.id,
      { status: "done" },
    );
    const blocked = await rejection(sessionsService.reacquire(actor, { issueId: issue.id, runId }));
    expect(errorKind(blocked)).toBe("issue_blocked");
    expect(await activeCount(issue.id)).toBe(0);

    await projectsService.updateIssue(
      {
        kind: "human",
        account: {
          humanId: f.humanId,
          email: ADMIN_EMAIL,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
      },
      issue.id,
      { status: "todo" },
    );
    await expect(
      sessionsService.reacquire(actor, { issueId: issue.id, runId }),
    ).resolves.toMatchObject({ status: "active", progress: "Done mostly" });
  });

  it("exposes resume and reacquire over bearer REST without wrapping the resource", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "REST resume issue");
    const runId = await newRun(identity);
    const claim = await postJson(
      `/api/issues/${issue.id}/work-sessions`,
      { runId },
      undefined,
      f.secret,
    );
    expect(claim.status).toBe(201);
    const originalId = WorkSession.parse(await claim.clone().json()).id;
    await postJson(
      `/api/issues/${issue.id}/work-sessions/progress`,
      { summary: "REST progress" },
      undefined,
      f.secret,
    );

    const live = await postJson(
      `/api/issues/${issue.id}/work-sessions/resume`,
      { runId },
      undefined,
      f.secret,
    );
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      disposition: "active",
      session: { status: "active", progress: "REST progress" },
    });

    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    const expired = await postJson(
      `/api/issues/${issue.id}/work-sessions/resume`,
      { runId },
      undefined,
      f.secret,
    );
    expect(await expired.json()).toMatchObject({
      disposition: "expired",
      session: { status: "expired", progress: "REST progress" },
    });

    const staleStop = await postJson(
      `/api/issues/${issue.id}/work-sessions/stop`,
      { outcome: "completed" },
      undefined,
      f.secret,
    );
    await expectProblem(staleStop, 409, "session_required");

    const reacquired = await postJson(
      `/api/issues/${issue.id}/work-sessions/reacquire`,
      { runId },
      undefined,
      f.secret,
    );
    expect(reacquired.status).toBe(201);

    const current = WorkSession.parse(await reacquired.clone().json());
    expect(current).toMatchObject({ status: "active", progress: "REST progress" });

    const staleFenced = await postJson(
      `/api/issues/${issue.id}/work-sessions/stop`,
      { outcome: "completed", sessionId: originalId },
      undefined,
      f.secret,
    );
    await expectProblem(staleFenced, 409, "session_required");
    const liveFenced = await postJson(
      `/api/issues/${issue.id}/work-sessions/renew`,
      { sessionId: current.id },
      undefined,
      f.secret,
    );
    expect(liveFenced.status).toBe(200);
    expect(WorkSession.parse(await liveFenced.json()).id).toBe(current.id);
    const noBody = await postJson(
      `/api/issues/${issue.id}/work-sessions/renew`,
      {},
      undefined,
      f.secret,
    );
    expect(noBody.status).toBe(200);
    const trulyBodyless = await app.request(`/api/issues/${issue.id}/work-sessions/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.secret}` },
    });
    expect(trulyBodyless.status).toBe(200);
    expect(identity.agentId).toBe(f.agentId);
  });
});

describe("human stop requests on active work sessions (#82)", () => {
  it("sets the stop fields atomically, records activity and surfaces the signal on heartbeat and progress", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Stop requested issue");
    const runId = await newRun(identity);
    const agent = { kind: "agent" as const, identity };
    const claim = await sessionsService.claim(agent, { issueId: issue.id, runId });
    expect(claim).toMatchObject({ stopRequested: false, stopRequestedAt: null, stopReason: null });

    const requested = await sessionsService.requestStop(humanActor(f), issue.id, "Wrong direction");
    expect(requested).toMatchObject({
      id: claim.id,
      status: "active",
      stopRequested: true,
      stopReason: "Wrong direction",
    });
    expect(requested.stopRequestedAt).not.toBeNull();
    expect(requested.endedAt).toBeNull();

    const [row] = await database.db
      .select()
      .from(workSessions)
      .where(eq(workSessions.id, claim.id));
    expect(row).toMatchObject({
      status: "active",
      stopRequestedByHumanId: f.humanId,
      stopReason: "Wrong direction",
    });
    expect(row?.stopRequestedAt).toBeInstanceOf(Date);
    expect(row?.endedAt).toBeNull();

    const renewed = await sessionsService.renew(agent, issue.id);
    expect(renewed).toMatchObject({
      id: claim.id,
      status: "active",
      stopRequested: true,
      stopReason: "Wrong direction",
    });
    const progressed = await sessionsService.progress(agent, issue.id, "Writing a handoff");
    expect(progressed).toMatchObject({ stopRequested: true, progress: "Writing a handoff" });

    const activity = await database.db
      .select()
      .from(projectActivity)
      .where(
        and(
          eq(projectActivity.issueId, issue.id),
          eq(projectActivity.type, "issue_stop_requested"),
        ),
      );
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actorHumanId: f.humanId,
      actorAgentId: null,
      summary: "Wrong direction",
    });

    const current = await getJson(`/api/issues/${issue.id}/work-sessions`, f.cookie);
    expect(current.status).toBe(200);
    expect(WorkSession.parse(await current.json())).toMatchObject({
      stopRequested: true,
      stopReason: "Wrong direction",
    });

    const ended = await sessionsService.stop(agent, issue.id, "completed");
    expect(ended).toMatchObject({ status: "completed", stopRequested: true });
  });

  it("refuses agents, unauthenticated callers, readers, non-members and inactive or expired sessions", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Guarded stop issue");
    const runId = await newRun(identity);
    const agent = { kind: "agent" as const, identity };
    await sessionsService.claim(agent, { issueId: issue.id, runId });

    const other = await humanIssue(f, "No session issue");
    expect(errorKind(await rejection(sessionsService.requestStop(humanActor(f), other.id)))).toBe(
      "session_not_active",
    );

    expect(errorKind(await rejection(sessionsService.requestStop(agent, issue.id)))).toBe(
      "agents_cannot_request_stop",
    );
    await expectProblem(
      await postJson(
        `/api/issues/${issue.id}/work-sessions/stop-request`,
        { reason: "agent asked" },
        undefined,
        f.secret,
      ),
      403,
      "agents_cannot_request_stop",
    );
    await expectProblem(
      await postJson(`/api/issues/${issue.id}/work-sessions/stop-request`, {}, undefined),
      401,
      "human_sign_in_required",
    );

    const outsider = {
      kind: "human" as const,
      account: {
        humanId: randomUUID(),
        email: "outsider@example.com",
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    };
    expect(errorKind(await rejection(sessionsService.requestStop(outsider, issue.id)))).toBe(
      "issue_not_found",
    );

    const readerId = randomUUID();
    const readerEmail = `reader-${readerId}@example.com`;
    await database.db.insert(humans).values({
      id: readerId,
      email: readerEmail,
      passwordHash: "unused",
      emailVerifiedAt: new Date(),
    });
    const sharedId = randomUUID();
    let sharedProjectId = "";
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: sharedId,
        kind: "shared",
        name: "Shared stop workspace",
        createdAt: new Date(),
      });
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: sharedId,
        humanId: f.humanId,
        isOwner: true,
      });
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: sharedId,
        humanId: readerId,
      });
      const [project] = await tx
        .insert(projects)
        .values({
          id: randomUUID(),
          workspaceId: sharedId,
          name: "Shared stop project",
          key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
          createdByHumanId: f.humanId,
        })
        .returning({ id: projects.id });
      if (project === undefined) throw new Error("no shared project");
      sharedProjectId = project.id;
      await tx.insert(projectAccessGrants).values({
        id: randomUUID(),
        projectId: project.id,
        humanId: readerId,
        level: "read",
        grantedByHumanId: f.humanId,
      });
    });
    const readerIssue = await projectsService.createIssue(humanActor(f), sharedProjectId, {
      title: "Reader issue",
    });
    const sharedKey = await postJson(
      "/api/agents/keys",
      {
        agentId: f.agentId,
        workspaceId: sharedId,
        validity: "90",
        projects: [{ projectId: sharedProjectId, level: "contribute" }],
      },
      f.cookie,
    );
    expect(sharedKey.status).toBe(201);
    const sharedIdentity = await identityFor(
      CreateAgentKeyResponse.parse(await sharedKey.json()).secret,
    );
    await sessionsService.claim(
      { kind: "agent", identity: sharedIdentity },
      { issueId: readerIssue.id, runId: await newRun(sharedIdentity) },
    );
    const reader = {
      kind: "human" as const,
      account: {
        humanId: readerId,
        email: readerEmail,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    };
    expect(errorKind(await rejection(sessionsService.requestStop(reader, readerIssue.id)))).toBe(
      "insufficient_access",
    );

    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    expect(errorKind(await rejection(sessionsService.requestStop(humanActor(f), issue.id)))).toBe(
      "session_not_active",
    );
    expect(await activeCount(issue.id)).toBe(0);
    const [raw] = await database.db
      .select({ stopAt: workSessions.stopRequestedAt })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    expect(raw?.stopAt).toBeNull();
    const activity = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(eq(projectActivity.type, "issue_stop_requested"));
    expect(activity).toHaveLength(0);
  });

  it("records a stop request once: repeated calls and blank reasons neither overwrite nor duplicate", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Idempotent stop issue");
    const runId = await newRun(identity);
    await sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId });

    const first = await sessionsService.requestStop(humanActor(f), issue.id, "  First reason  ");
    expect(first.stopReason).toBe("First reason");
    const again = await sessionsService.requestStop(
      humanActor(f),
      issue.id,
      "A later reason must be ignored",
    );
    expect(again.id).toBe(first.id);
    expect(again.stopReason).toBe("First reason");
    expect(again.stopRequestedAt).toBe(first.stopRequestedAt);
    expect(again.stopRequested).toBe(true);
    const blank = await sessionsService.requestStop(humanActor(f), issue.id, "   ");
    expect(blank.stopReason).toBe("First reason");

    const rows = await database.db
      .select()
      .from(projectActivity)
      .where(
        and(
          eq(projectActivity.issueId, issue.id),
          eq(projectActivity.type, "issue_stop_requested"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("First reason");

    expect(RequestStopWorkSessionInput.parse({ issueId: issue.id, reason: "   " }).reason).toBe(
      undefined,
    );
  });

  it("does not mutate a lease before authorization and refuses a deactivated human", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Unauthorized stop issue");
    const runId = await newRun(identity);
    await sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId });
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");

    const outsider = {
      kind: "human" as const,
      account: {
        humanId: randomUUID(),
        email: "outsider@example.com",
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    };
    expect(errorKind(await rejection(sessionsService.requestStop(outsider, issue.id)))).toBe(
      "issue_not_found",
    );

    const [before] = await database.db
      .select({ status: workSessions.status })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    expect(before?.status).toBe("active");

    expect(errorKind(await rejection(sessionsService.requestStop(humanActor(f), issue.id)))).toBe(
      "session_not_active",
    );
    const [after] = await database.db
      .select({ status: workSessions.status })
      .from(workSessions)
      .where(eq(workSessions.issueId, issue.id));
    expect(after?.status).toBe("expired");

    const liveIssue = await humanIssue(f, "Deactivated stop issue");
    const liveRun = await newRun(identity);
    await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: liveIssue.id, runId: liveRun },
    );
    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`statement_timestamp()` })
      .where(eq(humans.id, f.humanId));
    expect(
      errorKind(await rejection(sessionsService.requestStop(humanActor(f), liveIssue.id))),
    ).toBe("issue_not_found");
  });

  it("lists only live readable sessions for the agents view", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Active listing issue");
    const runId = await newRun(identity);
    const claim = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId },
    );

    expect(await sessionsService.activeSessions(humanActor(f), f.workspaceId)).toEqual([
      expect.objectContaining({ id: claim.id, projectId: f.projectId, status: "active" }),
    ]);

    const res = await getJson(`/api/workspaces/${f.workspaceId}/work-sessions/active`, f.cookie);
    expect(res.status).toBe(200);
    expect(ActiveWorkSessionsResponse.parse(await res.json())).toEqual([
      expect.objectContaining({ id: claim.id, projectId: f.projectId }),
    ]);

    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    expect(await sessionsService.activeSessions(humanActor(f), f.workspaceId)).toEqual([]);
  });
});

describe("ephemeral session activities (#83)", () => {
  it("lets only the live holder append activities and keeps them after expiry", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Activity issue");
    const runId = await newRun(identity);
    const session = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId },
    );
    const actor = { kind: "agent" as const, identity };

    const thought = await sessionsService.logActivity(actor, {
      issueId: issue.id,
      kind: "thought",
      summary: "Considering the options",
      detail: { step: 1, confidence: 0.7 },
    });
    expect(SessionActivity.parse(thought)).toMatchObject({
      workSessionId: session.id,
      runId,
      kind: "thought",
      summary: "Considering the options",
      detail: { step: 1, confidence: 0.7 },
    });
    const action = await sessionsService.logActivity(actor, {
      issueId: issue.id,
      kind: "action",
      summary: "Edited service.ts",
    });
    expect(action).toMatchObject({ kind: "action", detail: null });

    const otherAgent = await postJson(
      "/api/agents",
      { name: `activity-other-${randomUUID()}` },
      f.cookie,
    );
    expect(otherAgent.status).toBe(201);
    const otherKey = await postJson(
      "/api/agents/keys",
      {
        agentId: idOf(await otherAgent.json(), "agent"),
        workspaceId: f.workspaceId,
        validity: "90",
        projects: [{ projectId: f.projectId, level: "contribute" }],
      },
      f.cookie,
    );
    expect(otherKey.status).toBe(201);
    const other = await identityFor(CreateAgentKeyResponse.parse(await otherKey.json()).secret);
    expect(
      errorKind(
        await rejection(
          sessionsService.logActivity(
            { kind: "agent", identity: other },
            {
              issueId: issue.id,
              kind: "status",
              summary: "Not mine",
            },
          ),
        ),
      ),
    ).toBe("session_required");

    expect(
      errorKind(
        await rejection(
          sessionsService.logActivity(actor, {
            issueId: issue.id,
            kind: "status",
            summary: "Stale write",
            sessionId: randomUUID(),
          }),
        ),
      ),
    ).toBe("session_required");

    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    for (const fenced of [false, true]) {
      expect(
        errorKind(
          await rejection(
            sessionsService.logActivity(actor, {
              issueId: issue.id,
              kind: "status",
              summary: "After lapse",
              ...(fenced ? { sessionId: session.id } : {}),
            }),
          ),
        ),
      ).toBe("session_required");
    }
    const stored = await sessionsService.getSession(actor, issue.id);
    expect(stored.status).toBe("expired");
    const timeline = await sessionsService.listActivities(humanActor(f), issue.id, session.id);
    expect(SessionActivitiesResponse.parse(timeline).map((entry) => entry.summary)).toEqual([
      "Edited service.ts",
      "Considering the options",
    ]);
    const rows = await database.db
      .select({ id: workSessionActivities.id })
      .from(workSessionActivities)
      .where(eq(workSessionActivities.workSessionId, session.id));
    expect(rows).toHaveLength(2);
    const comments = await database.db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(0);

    const secondIssue = await humanIssue(f, "Completed activity issue");
    const secondRun = await newRun(identity);
    const second = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: secondIssue.id, runId: secondRun },
    );
    await sessionsService.logActivity(actor, {
      issueId: secondIssue.id,
      kind: "thought",
      summary: "Before completion",
    });
    await sessionsService.stop(actor, secondIssue.id, "completed");
    expect(
      (await sessionsService.listActivities(humanActor(f), secondIssue.id, second.id)).map(
        (entry) => entry.summary,
      ),
    ).toEqual(["Before completion"]);
  });

  it("reads an activity timeline with project Read and denies unrelated callers 404", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Readable activity issue");
    const runId = await newRun(identity);
    const session = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId },
    );
    await sessionsService.logActivity(
      { kind: "agent", identity },
      { issueId: issue.id, kind: "thought", summary: "Visible to readers" },
    );

    expect(await sessionsService.listActivities(humanActor(f), issue.id, session.id)).toHaveLength(
      1,
    );
    const readKey = await postJson(
      "/api/agents/keys",
      {
        agentId: f.agentId,
        workspaceId: f.workspaceId,
        validity: "90",
        projects: [{ projectId: f.projectId, level: "read" }],
      },
      f.cookie,
    );
    expect(readKey.status).toBe(201);
    const reader = await identityFor(CreateAgentKeyResponse.parse(await readKey.json()).secret);
    expect(
      await sessionsService.listActivities(
        { kind: "agent", identity: reader },
        issue.id,
        session.id,
      ),
    ).toHaveLength(1);

    expect(
      errorKind(
        await rejection(sessionsService.listActivities(humanActor(f), issue.id, randomUUID())),
      ),
    ).toBe("session_not_found");

    const outsider = {
      kind: "human" as const,
      account: {
        humanId: randomUUID(),
        email: "activity-outsider@example.com",
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    };
    expect(
      errorKind(await rejection(sessionsService.listActivities(outsider, issue.id, session.id))),
    ).toBe("issue_not_found");

    const [otherWorkspace] = await database.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: "shared", name: "Other activity team" })
        .returning();
      if (created === undefined) throw new Error("no other workspace");
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: created.id,
        humanId: f.humanId,
        isOwner: true,
      });
      return [created];
    });
    const otherAgent = await postJson(
      "/api/agents",
      { name: `activity-foreign-${randomUUID()}` },
      f.cookie,
    );
    const foreignKey = await postJson(
      "/api/agents/keys",
      {
        agentId: idOf(await otherAgent.json(), "agent"),
        workspaceId: otherWorkspace.id,
        validity: "90",
        projects: [],
      },
      f.cookie,
    );
    expect(foreignKey.status).toBe(201);
    const foreign = await identityFor(CreateAgentKeyResponse.parse(await foreignKey.json()).secret);
    expect(
      errorKind(
        await rejection(
          sessionsService.listActivities(
            { kind: "agent", identity: foreign },
            issue.id,
            session.id,
          ),
        ),
      ),
    ).toBe("issue_not_found");

    const res = await getJson(
      `/api/issues/${issue.id}/work-sessions/${session.id}/activities`,
      f.cookie,
    );
    expect(res.status).toBe(200);
    expect(SessionActivitiesResponse.parse(await res.json())).toHaveLength(1);
    const anonymous = await getJson(
      `/api/issues/${issue.id}/work-sessions/${session.id}/activities`,
    );
    await expectProblem(anonymous, 401, "not_signed_in");
  });

  it("denies activity reads to a deactivated human and to an agent whose owner is deactivated", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Deactivated reader issue");
    const session = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId: await newRun(identity) },
    );
    await sessionsService.logActivity(
      { kind: "agent", identity },
      { issueId: issue.id, kind: "thought", summary: "Before deactivation" },
    );

    expect(await sessionsService.listActivities(humanActor(f), issue.id, session.id)).toHaveLength(
      1,
    );

    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`statement_timestamp()` })
      .where(eq(humans.id, f.humanId));
    for (const actor of [humanActor(f), { kind: "agent" as const, identity }]) {
      expect(
        errorKind(await rejection(sessionsService.listActivities(actor, issue.id, session.id))),
      ).toBe("issue_not_found");
    }
  });

  it("appends over REST without adding an issue comment", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "REST activity issue");
    await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: issue.id, runId: await newRun(identity) },
    );

    const created = await postJson(
      `/api/issues/${issue.id}/work-sessions/activities`,
      { kind: "status", summary: "REST update", detail: { tool: "edit" } },
      undefined,
      f.secret,
    );
    expect(created.status).toBe(201);
    expect(SessionActivity.parse(await created.json())).toMatchObject({
      kind: "status",
      summary: "REST update",
      detail: { tool: "edit" },
    });

    const oversized = await postJson(
      `/api/issues/${issue.id}/work-sessions/activities`,
      { kind: "thought", summary: "Too large", detail: { blob: "x".repeat(64_001) } },
      undefined,
      f.secret,
    );
    await expectProblem(oversized, 400, "validation_failed");
    const comments = await database.db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(0);
  });
});

describe("agent assignment and the ready queue (#84)", () => {
  it("refuses claims on work reserved for a human or another agent", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const other = await registerSecondAgent(f);
    const humanOwned = await humanIssue(f, "Human reserved");
    const otherOwned = await humanIssue(f, "Other agent reserved");
    await assign(humanOwned.id, f, { type: "human", id: f.humanId });
    await assign(otherOwned.id, f, { type: "agent", id: other.agentId });

    const humanRefusal = await rejection(
      sessionsService.claim(
        { kind: "agent", identity },
        { issueId: humanOwned.id, runId: await newRun(identity) },
      ),
    );
    expect(errorKind(humanRefusal)).toBe("issue_assigned_to_human");
    const otherRefusal = await rejection(
      sessionsService.claim(
        { kind: "agent", identity },
        { issueId: otherOwned.id, runId: await newRun(identity) },
      ),
    );
    expect(errorKind(otherRefusal)).toBe("issue_assigned_to_other_agent");
    expect(await activeCount(humanOwned.id)).toBe(0);
    expect(await activeCount(otherOwned.id)).toBe(0);

    await expectProblem(
      await postJson(
        `/api/issues/${humanOwned.id}/work-sessions`,
        { runId: await newRun(identity) },
        undefined,
        f.secret,
      ),
      409,
      "issue_assigned_to_human",
    );
    const otherRest = await postJson(
      `/api/issues/${otherOwned.id}/work-sessions`,
      { runId: await newRun(identity) },
      undefined,
      f.secret,
    );
    await expectProblem(otherRest, 409, "issue_assigned_to_other_agent");
  });

  it("allows claims on unassigned work and on work assigned to the calling agent", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const free = await humanIssue(f, "Free work");
    const mine = await humanIssue(f, "Mine");
    await assign(mine.id, f, { type: "agent", id: f.agentId });

    const freeRun = await newRun(identity);
    expect(
      (
        await sessionsService.claim(
          { kind: "agent", identity },
          { issueId: free.id, runId: freeRun },
        )
      ).status,
    ).toBe("active");
    const mineRun = await newRun(identity);
    const claimed = await sessionsService.claim(
      { kind: "agent", identity },
      { issueId: mine.id, runId: mineRun },
    );
    expect(claimed.status).toBe("active");

    expect(
      (
        await sessionsService.claim(
          { kind: "agent", identity },
          { issueId: mine.id, runId: mineRun },
        )
      ).id,
    ).toBe(claimed.id);
    expect(await activeCount(free.id)).toBe(1);
    expect(await activeCount(mine.id)).toBe(1);
  });

  it("refuses reacquisition once the expired claim's issue is reassigned", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Interrupted");
    const runId = await newRun(identity);
    await sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId });
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    await assign(issue.id, f, { type: "human", id: f.humanId });
    const refused = await rejection(
      sessionsService.reacquire({ kind: "agent", identity }, { issueId: issue.id, runId }),
    );
    expect(errorKind(refused)).toBe("issue_assigned_to_human");
  });

  it("filters the ready queue and puts the caller's own work first", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const other = await registerSecondAgent(f);
    const mineUrgent = await humanIssue(f, "Mine urgent");
    const mineLow = await humanIssue(f, "Mine low");
    const unassigned = await humanIssue(f, "Unassigned high");
    const humanOwned = await humanIssue(f, "Human medium");
    const otherOwned = await humanIssue(f, "Other low");
    await projectsService.updateIssue(humanActor(f), mineUrgent.id, {
      priority: "urgent",
      sortOrder: 900_000,
      assignee: { type: "agent", id: f.agentId },
    });
    await projectsService.updateIssue(humanActor(f), mineLow.id, {
      priority: "low",
      sortOrder: 800_000,
      assignee: { type: "agent", id: f.agentId },
    });
    await projectsService.updateIssue(humanActor(f), unassigned.id, {
      priority: "high",
      sortOrder: 100_000,
    });
    await assign(humanOwned.id, f, { type: "human", id: f.humanId });
    await projectsService.updateIssue(humanActor(f), humanOwned.id, { priority: "medium" });
    await assign(otherOwned.id, f, { type: "agent", id: other.agentId });

    const agent = { kind: "agent" as const, identity };
    expect((await sessionsService.readyWork(agent, f.projectId, "all")).map((i) => i.id)).toEqual([
      mineUrgent.id,
      mineLow.id,
      unassigned.id,
    ]);
    expect(
      (await sessionsService.readyWork(agent, f.projectId, "assignedToMe")).map((i) => i.id),
    ).toEqual([mineUrgent.id, mineLow.id]);
    expect(
      (await sessionsService.readyWork(agent, f.projectId, "unassigned")).map((i) => i.id),
    ).toEqual([unassigned.id]);

    expect(
      (await sessionsService.readyWork(humanActor(f), f.projectId, "all")).map((i) => i.id),
    ).toEqual([humanOwned.id, mineUrgent.id, unassigned.id, mineLow.id, otherOwned.id]);
    expect(
      (await sessionsService.readyWork(humanActor(f), f.projectId, "assignedToMe")).map(
        (i) => i.id,
      ),
    ).toEqual([humanOwned.id]);

    const rest = await getJson(
      `/api/projects/${f.projectId}/ready-work?filter=assignedToMe`,
      undefined,
      f.secret,
    );
    expect(rest.status).toBe(200);
    const rows = IssuesResponse.parse(await rest.json());
    expect(rows.map((row) => row.id)).toEqual([mineUrgent.id, mineLow.id]);
  });

  it("moves todo -> in_progress on claim and back on release or lease expiry", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const agent = { kind: "agent" as const, identity };
    const issue = await humanIssue(f, "Workflow claim");
    expect((await issueStatus(issue.id)).status).toBe("todo");

    const run = await newRun(identity);
    await sessionsService.claim(agent, { issueId: issue.id, runId: run });
    expect((await issueStatus(issue.id)).status).toBe("in_progress");

    await sessionsService.stop(agent, issue.id, "released");
    expect((await issueStatus(issue.id)).status).toBe("todo");

    await sessionsService.claim(agent, { issueId: issue.id, runId: run });
    await setLease(issue.id, "statement_timestamp() - interval '1 second'");
    await rejection(sessionsService.renew(agent, issue.id));
    expect((await issueStatus(issue.id)).status).toBe("todo");
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).toContain(
      issue.id,
    );
  });

  it("completes to review by default and to done when asked, unblocking dependents only on done", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const agent = { kind: "agent" as const, identity };
    const blocked = await humanIssue(f, "Blocked dependent");
    const blocker = await humanIssue(f, "Blocking task");
    await projectsService.addBlockedBy(humanActor(f), blocked.id, {
      blockedByIssueId: blocker.id,
    });
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).not.toContain(
      blocked.id,
    );

    await sessionsService.claim(agent, { issueId: blocker.id, runId: await newRun(identity) });
    await sessionsService.stop(agent, blocker.id, "completed");
    expect(await issueStatus(blocker.id)).toMatchObject({ status: "review", closedAt: null });
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).not.toContain(
      blocked.id,
    );

    await projectsService.updateIssue(humanActor(f), blocker.id, { status: "done" });

    const doneIssue = await humanIssue(f, "Closed directly");
    await projectsService.addBlockedBy(humanActor(f), blocked.id, {
      blockedByIssueId: doneIssue.id,
    });
    await sessionsService.claim(agent, { issueId: doneIssue.id, runId: await newRun(identity) });
    await sessionsService.stop(agent, doneIssue.id, "done");
    expect((await issueStatus(doneIssue.id)).status).toBe("done");
    expect((await issueStatus(doneIssue.id)).closedAt).not.toBeNull();
    expect((await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id)).toContain(
      blocked.id,
    );
  });

  it("answers a REST claim on a non-todo issue with 409 issue_blocked", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const runId = await newRun(identity);
    const backlog = await humanIssue(f, "Triage queue");
    await projectsService.updateIssue(humanActor(f), backlog.id, { status: "backlog" });
    const review = await humanIssue(f, "Handoff");
    await projectsService.updateIssue(humanActor(f), review.id, { status: "review" });

    for (const issue of [backlog, review]) {
      const res = await postJson(
        `/api/issues/${issue.id}/work-sessions`,
        { runId },
        undefined,
        f.secret,
      );
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(Problem.parse(await res.json())).toMatchObject({
        status: 409,
        code: "issue_blocked",
      });
    }
  });

  it("offers only todo issues, and reacquisition returns an expired issue to in_progress", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const agent = { kind: "agent" as const, identity };
    const ready = await humanIssue(f, "Ready");
    const backlog = await humanIssue(f, "Backlog");
    await projectsService.updateIssue(humanActor(f), backlog.id, { status: "backlog" });

    const visible = (await sessionsService.readyWork(agent, f.projectId)).map((i) => i.id);
    expect(visible).toContain(ready.id);
    expect(visible).not.toContain(backlog.id);

    const run = await newRun(identity);
    await sessionsService.claim(agent, { issueId: ready.id, runId: run });
    await setLease(ready.id, "statement_timestamp() - interval '1 second'");
    await sessionsService.reacquire(agent, { issueId: ready.id, runId: run });
    expect((await issueStatus(ready.id)).status).toBe("in_progress");
  });
});

describe("cumulative session telemetry and v1 activity blocks (#96)", () => {
  it("overwrites reported totals on renew/progress/complete and preserves omitted fields", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const actor = { kind: "agent" as const, identity };
    const issue = await humanIssue(f, "Telemetry issue");
    const claim = await sessionsService.claim(actor, {
      issueId: issue.id,
      runId: await newRun(identity),
    });
    expect(WorkSession.parse(claim)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
    });

    const renewed = await sessionsService.renew(actor, issue.id, undefined, {
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(renewed).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsdMicros: null });

    const retried = await sessionsService.renew(actor, issue.id, undefined, {
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(retried).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsdMicros: null });

    const progressed = await sessionsService.progress(actor, issue.id, "Halfway", undefined, {
      inputTokens: 250,
      costUsdMicros: 750,
    });
    expect(progressed).toMatchObject({ inputTokens: 250, outputTokens: 20, costUsdMicros: 750 });

    expect(await sessionsService.progress(actor, issue.id, "Still going")).toMatchObject({
      inputTokens: 250,
      outputTokens: 20,
      costUsdMicros: 750,
    });
    expect(await sessionsService.renew(actor, issue.id)).toMatchObject({
      inputTokens: 250,
      outputTokens: 20,
      costUsdMicros: 750,
    });

    const stopped = await sessionsService.stop(actor, issue.id, "completed", undefined, {
      inputTokens: 400,
      costUsdMicros: 1200,
    });
    expect(stopped).toMatchObject({ inputTokens: 400, outputTokens: 20, costUsdMicros: 1200 });
    expect(await sessionsService.getSession(actor, issue.id)).toMatchObject({
      inputTokens: 400,
      outputTokens: 20,
      costUsdMicros: 1200,
    });

    const quiet = await humanIssue(f, "Quiet issue");
    await sessionsService.claim(actor, { issueId: quiet.id, runId: await newRun(identity) });
    expect(await sessionsService.renew(actor, quiet.id)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
    });
    expect(await sessionsService.progress(actor, quiet.id, "No numbers")).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
    });
    expect(await sessionsService.stop(actor, quiet.id, "completed")).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
    });
  });

  it("rejects negative or fractional totals in the contract and in the database", async () => {
    for (const input of [
      { issueId: "i", inputTokens: -1 },
      { issueId: "i", outputTokens: -1 },
      { issueId: "i", costUsdMicros: -1 },
      { issueId: "i", inputTokens: 1.5 },
    ]) {
      expect(RenewWorkSessionInput.safeParse(input).success).toBe(false);
    }
    expect(StopWorkSessionInput.safeParse({ issueId: "i", inputTokens: -1 }).success).toBe(false);

    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Constraint issue");
    const session = await sessionsService.claim(
      { kind: "agent", identity },
      {
        issueId: issue.id,
        runId: await newRun(identity),
      },
    );

    for (const [column, constraint] of [
      ["inputTokens", "work_sessions_input_tokens_nonnegative"],
      ["outputTokens", "work_sessions_output_tokens_nonnegative"],
      ["costUsdMicros", "work_sessions_cost_usd_micros_nonnegative"],
    ] as const) {
      let updateError: unknown;
      try {
        await database.db
          .update(workSessions)
          .set({ [column]: -1 })
          .where(eq(workSessions.id, session.id));
      } catch (error) {
        updateError = error;
      }
      expect(rootCause(updateError)).toMatchObject({ code: "23514", constraint_name: constraint });
    }

    await database.db
      .update(workSessions)
      .set({ inputTokens: 0, outputTokens: 0, costUsdMicros: 0 })
      .where(eq(workSessions.id, session.id));
    expect(await sessionsService.getSession({ kind: "agent", identity }, issue.id)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
    });
  });

  it("validates every v1 block, rejects malformed ones and keeps arbitrary JSON without a block", async () => {
    const blocks = [
      { version: 1, type: "key_value", items: [{ key: "model", value: "gpt" }] },
      { version: 1, type: "table", columns: ["name", "value"], rows: [["a", "1"]] },
      { version: 1, type: "checklist", items: [{ label: "tests", checked: true }] },
      {
        version: 1,
        type: "test_results",
        passed: 3,
        failed: 0,
        skipped: 1,
        cases: [{ name: "adds", status: "passed" }],
      },
    ] as const;
    for (const block of blocks) {
      expect(ActivityDetailBlockV1.parse(block)).toEqual(block);
      expect(SessionActivityDetail.safeParse({ source: "ci", block }).success).toBe(true);
    }
    for (const malformed of [
      { version: 2, type: "table", columns: [], rows: [] },
      { version: 1, type: "unknown", items: [] },
      { version: 1, type: "key_value", items: [{ key: "missing value" }] },
      { version: 1, type: "test_results", passed: -1, failed: 0 },
    ]) {
      expect(ActivityDetailBlockV1.safeParse(malformed).success).toBe(false);
      expect(SessionActivityDetail.safeParse({ source: "ci", block: malformed }).success).toBe(
        false,
      );
    }

    expect(SessionActivityDetail.parse({ tool: "edit", nested: { n: 1 } })).toEqual({
      tool: "edit",
      nested: { n: 1 },
    });

    expect(
      SessionActivityDetail.safeParse({ block: blocks[0], blob: "x".repeat(64_001) }).success,
    ).toBe(false);

    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Block issue");
    const actor = { kind: "agent" as const, identity };
    const session = await sessionsService.claim(actor, {
      issueId: issue.id,
      runId: await newRun(identity),
    });

    const testResults = ActivityDetailBlockV1.parse(blocks[3]);
    const withBlock = await sessionsService.logActivity(actor, {
      issueId: issue.id,
      kind: "status",
      summary: "Tests finished",
      detail: { source: "ci", block: testResults },
    });
    expect(withBlock.detail).toEqual({ source: "ci", block: testResults });
    const custom = await sessionsService.logActivity(actor, {
      issueId: issue.id,
      kind: "thought",
      summary: "Custom telemetry",
      detail: { tool: "edit", nested: { n: 1 } },
    });
    expect(custom.detail).toEqual({ tool: "edit", nested: { n: 1 } });
    const timeline = await sessionsService.listActivities(actor, issue.id, session.id);
    expect(timeline.map((entry) => entry.detail)).toEqual([custom.detail, withBlock.detail]);
  });

  it("accepts telemetry on REST check-ins and validates v1 blocks on the activity route", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "REST telemetry issue");
    await sessionsService.claim(
      { kind: "agent", identity },
      {
        issueId: issue.id,
        runId: await newRun(identity),
      },
    );

    const renewed = await postJson(
      `/api/issues/${issue.id}/work-sessions/renew`,
      { inputTokens: 12, outputTokens: 3 },
      undefined,
      f.secret,
    );
    expect(renewed.status).toBe(200);
    expect(WorkSession.parse(await renewed.json())).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsdMicros: null,
    });

    const progressed = await postJson(
      `/api/issues/${issue.id}/work-sessions/progress`,
      { summary: "REST progress", costUsdMicros: 42 },
      undefined,
      f.secret,
    );
    expect(progressed.status).toBe(200);
    expect(WorkSession.parse(await progressed.json())).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      costUsdMicros: 42,
    });

    const block = { version: 1, type: "checklist", items: [{ label: "done", checked: true }] };
    const activity = await postJson(
      `/api/issues/${issue.id}/work-sessions/activities`,
      { kind: "status", summary: "REST block", detail: { source: "ci", block } },
      undefined,
      f.secret,
    );
    expect(activity.status).toBe(201);
    expect(SessionActivity.parse(await activity.json()).detail).toEqual({ source: "ci", block });

    const malformed = await postJson(
      `/api/issues/${issue.id}/work-sessions/activities`,
      {
        kind: "status",
        summary: "Bad block",
        detail: { block: { version: 1, type: "checklist", items: [{ label: "done" }] } },
      },
      undefined,
      f.secret,
    );
    await expectProblem(malformed, 400, "validation_failed");
    const negative = await postJson(
      `/api/issues/${issue.id}/work-sessions/renew`,
      { inputTokens: -1 },
      undefined,
      f.secret,
    );
    await expectProblem(negative, 400, "validation_failed");

    const stopped = await postJson(
      `/api/issues/${issue.id}/work-sessions/stop`,
      { outcome: "completed", inputTokens: 20 },
      undefined,
      f.secret,
    );
    expect(stopped.status).toBe(200);
    expect(WorkSession.parse(await stopped.json())).toMatchObject({
      inputTokens: 20,
      outputTokens: 3,
      costUsdMicros: 42,
    });
  });

  it("returns 409 Problem Details on REST when stop or status update violates input or workflow guards", async () => {
    const f = await bootstrap();
    const identity = await identityFor(f.secret);
    const issue = await humanIssue(f, "Guarded stop");
    const runId = await newRun(identity);
    await sessionsService.claim({ kind: "agent", identity }, { issueId: issue.id, runId });

    await database.db.update(issues).set({ needsInput: true }).where(eq(issues.id, issue.id));

    await expectProblem(
      await postJson(
        `/api/issues/${issue.id}/work-sessions/stop`,
        { outcome: "review" },
        undefined,
        f.secret,
      ),
      409,
      "issue_needs_input",
    );
    await expectProblem(
      await postJson(
        `/api/issues/${issue.id}/work-sessions/stop`,
        { outcome: "done" },
        undefined,
        f.secret,
      ),
      409,
      "issue_needs_input",
    );
    await expectProblem(
      await app.request(`/api/issues/${issue.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: f.cookie },
        body: JSON.stringify({ status: "done" }),
      }),
      409,
      "issue_needs_input",
    );

    // Defense-in-depth: even if status drifted out of in_progress while a session row stayed active,
    // stop("review") refuses with 409 issue_blocked rather than overwriting the status.
    await database.db
      .update(issues)
      .set({ needsInput: false, status: "done", closedAt: new Date() })
      .where(eq(issues.id, issue.id));
    await expectProblem(
      await postJson(
        `/api/issues/${issue.id}/work-sessions/stop`,
        { outcome: "review" },
        undefined,
        f.secret,
      ),
      409,
      "issue_blocked",
    );
    expect(await activeCount(issue.id)).toBe(1);
  });
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentIdentity,
  CreateAgentKeyResponse,
  Problem,
  Workspace,
  WorkspaceInvitation,
  type ProjectAccessLevel,
  type SmtpSettings,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentKeyEvents,
  browserSessions,
  humans,
  issueComments,
  issues,
  projectAccessGrants,
  projects,
  runnerHosts,
  runners,
  runs as runRows,
  workspaceEvents,
  workspaceMemberships,
  workSessions,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAgentsFeature, revokeMemberWorkspaceKeys } from "../agents/index.ts";
import { createInvitationsFeature } from "../invitations/index.ts";
import { createProjectsFeature, type WorkSessionGate } from "../projects/index.ts";
import { createRunnersFeature, revokeWorkspaceRunnersForMember } from "../runners/index.ts";
import { createSettingsFeature } from "../settings/index.ts";
import {
  createSessionsFeature,
  SessionsError,
  type SessionsService,
} from "../work-sessions/index.ts";
import { createWorkspacesFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "removal-admin@example.com";
const PASSWORD = "removal-admin-password";
const MEMBER_EMAIL = "removal-member@example.com";
const PUBLIC_URL = "http://orrery.test";
const SMTP: SmtpSettings = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: null,
  password: null,
  from: "orrery@example.test",
};
const silentLogger: Logger = createLogger("error");
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const atLeast = (actual: string, required: string) =>
  ["read", "contribute", "manage"].indexOf(actual) >=
  ["read", "contribute", "manage"].indexOf(required);

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let projectsService: ReturnType<typeof createProjectsFeature>["service"];
let sessionsService: SessionsService;
let inviteMailBox: { to: string; text: string }[];

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
const getJson = (path: string, bearer?: string) =>
  app.request(path, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
const putJson = (path: string, body: unknown, cookie: string) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const deletePath = (path: string, cookie: string) =>
  app.request(path, { method: "DELETE", headers: { cookie } });
const postEmpty = (path: string, cookie: string) =>
  app.request(path, { method: "POST", headers: { cookie } });

function idOf(value: unknown, what: string): string {
  const id = typeof value === "object" && value !== null ? Reflect.get(value, "id") : undefined;
  if (typeof id !== "string") throw new Error(`missing ${what} id`);
  return id;
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const sent: { to: string; text: string }[] = [];
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
      sent.push({ to: mail.to, text: mail.text });
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
  let gate: WorkSessionGate | undefined;
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: (tx, agentId, workspaceId, issueId) => {
      if (gate === undefined) throw new Error("work session gate is not wired");
      return gate(tx, agentId, workspaceId, issueId);
    },
  });
  const agentsFeature = createAgentsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: atLeast,
  });
  const sessionsFeature = createSessionsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    authenticate: agentsFeature.authenticator,
    projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
      projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
    projectAccessAtLeast: atLeast,
    listIssues: (actor, projectId) => projectsFeature.service.listIssues(actor, projectId),
  });
  gate = (tx, agentId, workspaceId, issueId) =>
    sessionsFeature.agentHoldsSession(tx, agentId, workspaceId, issueId);
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
    releaseMemberWorkSessions: (tx, workspaceId, humanId) =>
      sessionsFeature.releaseMemberWorkSessions(tx, workspaceId, humanId),
    revokeMemberWorkspaceRunners: (tx, workspaceId, humanId) =>
      revokeWorkspaceRunnersForMember(tx, workspaceId, humanId),
    applyInvitationGrants: (tx, workspaceId, humanId, grantedByHumanId, offered) =>
      projectsFeature.applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered),
    log: silentLogger,
  });
  projectsService = projectsFeature.service;
  sessionsService = sessionsFeature.service;
  app = createApp({
    features: [
      accounts,
      settings,
      invitationsFeature,
      projectsFeature,
      agentsFeature,
      sessionsFeature,
      workspacesFeature,
      createRunnersFeature({
        db: database.db,
        sessionReader: accounts.sessionReader,
        publicUrl: PUBLIC_URL,
        projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
          projectsFeature.projectAccessCeiling(tx, workspaceId, humanId, projectIds),
        projectAccessAtLeast: atLeast,
      }),
    ],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });
  inviteMailBox = sent;
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

const cleanupTables = [
  "runners",
  "runner_hosts",
  "runner_device_codes",
  "runner_device_code_attempts",
  "work_sessions",
  "agent_key_events",
  "agent_api_key_projects",
  "agent_api_keys",
  "project_access_events",
  "project_access_grants",
  "project_activity",
  "knowledge_entries",
  "issue_comments",
  "issues",
  "run_children",
  "run_model_changes",
  "runs",
  "agents",
  "workspace_events",
  "workspace_invitation_grants",
  "workspace_invitations",
  "projects",
  "workspace_memberships",
  "workspace_ownership_guards",
  "workspaces",
  "invitations",
  "browser_sessions",
  "instance_setup",
  "instance_settings",
  "email_verification_tokens",
  "humans",
];

async function cleanDatabase() {
  await database.db.transaction(async (tx) => {
    for (const table of cleanupTables) {
      await tx.execute(sql.raw(`delete from ${table}`));
    }
  });
  inviteMailBox.length = 0;
}

afterEach(cleanDatabase);

async function signIn(email: string, password: string): Promise<string> {
  const res = await postJson("/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie");
  return cookie;
}

async function createVerifiedHuman(email: string) {
  const [human] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`now()`,
    })
    .returning();
  if (human === undefined) throw new Error("the account was not created");
  await database.db.insert(workspaces).values({
    id: randomUUID(),
    kind: "personal",
    name: `${email}'s personal workspace`,
    personalOwnerHumanId: human.id,
  });
  return human;
}

async function sessionFor(humanId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`now() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

async function createSharedWorkspace(cookie: string, name: string): Promise<string> {
  const res = await postJson("/api/workspaces", { name }, cookie);
  expect(res.status).toBe(201);
  return idOf(await res.json(), "workspace");
}

async function createProject(cookie: string, workspaceId: string, name: string): Promise<string> {
  const res = await postJson(`/api/workspaces/${workspaceId}/projects`, { name }, cookie);
  expect(res.status).toBe(201);
  return idOf(await res.json(), "project");
}

async function inviteAndAccept(input: {
  adminCookie: string;
  memberCookie: string;
  workspaceId: string;
  email: string;
  projectId: string;
  level: ProjectAccessLevel;
}) {
  const invited = await postJson(
    `/api/workspaces/${input.workspaceId}/invitations`,
    { email: input.email, projectGrants: [{ projectId: input.projectId, level: input.level }] },
    input.adminCookie,
  );
  if (invited.status !== 201) {
    throw new Error(`invite failed ${invited.status}: ${await invited.text()}`);
  }
  WorkspaceInvitation.parse(await invited.json());
  const accepted = await postJson(
    "/api/workspace-invitations/acceptance",
    { token: lastInvitationToken(input.email) },
    input.memberCookie,
  );
  expect(accepted.status).toBe(200);
  Workspace.parse(await accepted.json());
}

function lastInvitationToken(email: string): string {
  const candidates = inviteMailBox.filter((candidate) => candidate.to === email);
  const mail = candidates[candidates.length - 1];
  const token = mail?.text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("the invitation email carried no token");
  return token;
}

async function issueKey(
  cookie: string,
  agentId: string,
  workspaceId: string,
  projectId: string,
  level: ProjectAccessLevel = "contribute",
): Promise<string> {
  const res = await postJson(
    "/api/agents/keys",
    {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level }],
    },
    cookie,
  );
  expect(res.status).toBe(201);
  return CreateAgentKeyResponse.parse(await res.json()).secret;
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

type Fixture = {
  adminCookie: string;
  memberCookie: string;
  memberHumanId: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  secret: string;
  identity: AgentIdentity;
  issueId: string;
};

async function fixtureSetup(workspaceName = "Removal Team"): Promise<Fixture> {
  const setup = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: EMAIL,
    password: PASSWORD,
  });
  expect(setup.status).toBe(201);
  const adminCookie = await signIn(EMAIL, PASSWORD);

  await database.db
    .update(humans)
    .set({ emailVerifiedAt: sql`now()` })
    .where(eq(humans.email, EMAIL));
  expect((await putJson("/api/settings/smtp", SMTP, adminCookie)).status).toBe(200);
  const workspaceId = await createSharedWorkspace(adminCookie, workspaceName);
  const projectId = await createProject(adminCookie, workspaceId, "Removal project");

  const member = await createVerifiedHuman(MEMBER_EMAIL);
  const memberCookie = await sessionFor(member.id);
  await inviteAndAccept({
    adminCookie,
    memberCookie,
    workspaceId,
    email: MEMBER_EMAIL,
    projectId,
    level: "contribute",
  });

  const agentRes = await postJson(
    "/api/agents",
    { name: `removal-agent-${randomUUID()}` },
    memberCookie,
  );
  expect(agentRes.status).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const secret = await issueKey(memberCookie, agentId, workspaceId, projectId);
  const me = await getJson("/api/agents/me", secret);
  expect(me.status).toBe(200);
  const identity = AgentIdentity.parse(await me.json());

  const issue = await projectsService.createIssue(
    {
      kind: "human",
      account: {
        humanId: member.id,
        email: MEMBER_EMAIL,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
    },
    projectId,
    { title: "Issue the departing agent claimed" },
  );
  return {
    adminCookie,
    memberCookie,
    memberHumanId: member.id,
    workspaceId,
    projectId,
    agentId,
    secret,
    identity,
    issueId: issue.id,
  };
}

async function fixtureWithClaim(workspaceName = "Removal Team"): Promise<Fixture> {
  const f = await fixtureSetup(workspaceName);
  const runId = await newRun(f.identity);
  const claim = await sessionsService.claim(
    { kind: "agent", identity: f.identity },
    { issueId: f.issueId, runId },
  );
  expect(claim.status).toBe("active");
  return f;
}

async function sessionRow(issueId: string) {
  const [row] = await database.db
    .select()
    .from(workSessions)
    .where(eq(workSessions.issueId, issueId));
  return row;
}

async function waitForIssueLockWait(minimum = 1) {
  await expect
    .poll(
      async () => {
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike '%issues%for update%'
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThanOrEqual(minimum);
}

async function waitForMembershipDeleteLockWait() {
  await expect
    .poll(
      async () => {
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike '%delete from "workspace_memberships"%'
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThan(0);
}

async function adminHumanId() {
  const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
  if (admin === undefined) throw new Error("no administrator");
  return admin.id;
}

describe("member removal and voluntary leave against real Postgres (#37)", () => {
  it("releases the active claim on removal and refuses a stale in-flight renewal", async () => {
    const f = await fixtureWithClaim();
    await projectsService.createComment({ kind: "agent", identity: f.identity }, f.issueId, {
      body: "attributed work before departure",
    });

    expect(
      (
        await deletePath(
          `/api/workspaces/${f.workspaceId}/members/${f.memberHumanId}`,
          f.adminCookie,
        )
      ).status,
    ).toBe(204);

    const ended = await sessionRow(f.issueId);
    expect(ended?.status).toBe("released");
    expect(ended?.endedAt).toBeInstanceOf(Date);

    await expect(
      sessionsService.renew({ kind: "agent", identity: f.identity }, f.issueId),
    ).rejects.toMatchObject({ kind: "insufficient_access" });
    expect((await sessionRow(f.issueId))?.status).toBe("released");

    await expectProblem(await getJson("/api/agents/me", f.secret), 401, "key_revoked");

    const [grant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.humanId, f.memberHumanId),
          eq(projectAccessGrants.projectId, f.projectId),
        ),
      );
    expect(grant).toBeUndefined();

    const comments = await database.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.createdByAgentId).toBe(f.agentId);

    const events = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, f.workspaceId));
    expect(events.map((event) => event.type)).toContain("member_removed");
    const keyEvents = await database.db
      .select()
      .from(agentKeyEvents)
      .where(eq(agentKeyEvents.workspaceId, f.workspaceId));
    expect(keyEvents.map((event) => event.type)).toContain("agent_key_revoked");
  });

  it("cannot retain the claim when renewal races removal", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await cleanDatabase();
      const f = await fixtureWithClaim(`Race Team ${attempt}`);
      const removal = deletePath(
        `/api/workspaces/${f.workspaceId}/members/${f.memberHumanId}`,
        f.adminCookie,
      );
      const renewal = sessionsService
        .renew({ kind: "agent", identity: f.identity }, f.issueId)
        .then(
          () => "renewed",
          (error: unknown) => (error instanceof SessionsError ? error.kind : "unexpected_error"),
        );
      const [removalResult, renewalResult] = await Promise.all([removal, renewal]);
      expect(removalResult.status).toBe(204);

      expect(["renewed", "insufficient_access"]).toContain(renewalResult);
      const ended = await sessionRow(f.issueId);
      expect(ended?.status).toBe("released");
      expect(ended?.endedAt).toBeInstanceOf(Date);
    }
  });

  it("a claim racing removal cannot leave an active claim behind", async () => {
    const f = await fixtureSetup("Claim Race Team");
    const runId = await newRun(f.identity);

    let releaseHolder!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    const holding = database.db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      holderLocked();
      await release;
    });

    try {
      await locked;
      const claim = sessionsService
        .claim({ kind: "agent", identity: f.identity }, { issueId: f.issueId, runId })
        .then(
          () => "claimed",
          (error: unknown) => (error instanceof SessionsError ? error.kind : "unexpected_error"),
        );
      await waitForIssueLockWait();
      const removal = deletePath(
        `/api/workspaces/${f.workspaceId}/members/${f.memberHumanId}`,
        f.adminCookie,
      );

      await Promise.race([
        waitForIssueLockWait(2).then(() => "both-on-issue"),
        waitForMembershipDeleteLockWait().then(() => "blocked-at-membership"),
      ]);
      releaseHolder();
      const [claimResult, removalResult] = await Promise.all([claim, removal, holding]);
      expect(removalResult.status).toBe(204);
      expect(["claimed", "insufficient_access"]).toContain(claimResult);
      const [row] = await database.db
        .select()
        .from(workSessions)
        .where(eq(workSessions.issueId, f.issueId));
      expect(row?.status).toBe("released");
    } finally {
      releaseHolder();
      await holding.catch(() => {});
    }
  });

  it("answers workspace_not_found when a non-member tries to leave", async () => {
    const f = await fixtureWithClaim("Nonmember Leave Team");
    const stranger = await createVerifiedHuman("stranger-removal@example.com");
    const strangerCookie = await sessionFor(stranger.id);
    const left = await postEmpty(`/api/workspaces/${f.workspaceId}/leave`, strangerCookie);
    expect(left.status).toBe(404);
    expect(await left.json()).toMatchObject({ status: 404, code: "workspace_not_found" });
  });

  it("records owner_left when a co-owner leaves voluntarily", async () => {
    const f = await fixtureWithClaim("Co-owner Leave Team");
    const appointed = await postJson(
      `/api/workspaces/${f.workspaceId}/owners`,
      { humanId: f.memberHumanId },
      f.adminCookie,
    );
    expect(appointed.status).toBe(200);
    expect((await postEmpty(`/api/workspaces/${f.workspaceId}/leave`, f.memberCookie)).status).toBe(
      204,
    );
    const events = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, f.workspaceId));
    expect(events.map((event) => event.type)).toContain("owner_left");
    const owners = await database.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.workspaceId),
          eq(workspaceMemberships.isOwner, true),
        ),
      );
    expect(owners).toHaveLength(1);
  });

  it("lets a member leave voluntarily, but blocks the last owner and a personal workspace", async () => {
    const f = await fixtureWithClaim("Leaving Team");
    expect((await postEmpty(`/api/workspaces/${f.workspaceId}/leave`, f.memberCookie)).status).toBe(
      204,
    );
    expect((await sessionRow(f.issueId))?.status).toBe("released");
    const events = await database.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, f.workspaceId));
    expect(events.map((event) => event.type)).toContain("member_left");

    await expectProblem(
      await postEmpty(`/api/workspaces/${f.workspaceId}/leave`, f.adminCookie),
      409,
      "last_owner",
    );
    const [owner] = await database.db
      .select()
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, f.workspaceId),
          eq(workspaceMemberships.humanId, await adminHumanId()),
        ),
      );
    expect(owner?.isOwner).toBe(true);

    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.kind, "personal"));
    if (personal === undefined) throw new Error("no personal workspace");
    await expectProblem(
      await postEmpty(`/api/workspaces/${personal.id}/leave`, f.adminCookie),
      404,
      "workspace_not_found",
    );
  });

  it("keeps personal work and other memberships intact on departure", async () => {
    const f = await fixtureWithClaim("Other Team");
    const secondWorkspace = await createSharedWorkspace(f.adminCookie, "Second Team");
    const secondProjectId = idOf(
      await (
        await postJson(
          `/api/workspaces/${secondWorkspace}/projects`,
          { name: "Second project" },
          f.adminCookie,
        )
      ).json(),
      "project",
    );
    await inviteAndAccept({
      adminCookie: f.adminCookie,
      memberCookie: f.memberCookie,
      workspaceId: secondWorkspace,
      email: MEMBER_EMAIL,
      projectId: secondProjectId,
      level: "read",
    });

    const [memberPersonal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, f.memberHumanId));
    if (memberPersonal === undefined) throw new Error("no personal workspace for the member");
    const personalProjectId = randomUUID();
    await database.db.insert(projects).values({
      id: personalProjectId,
      workspaceId: memberPersonal.id,
      name: "Personal project",
      key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
      createdByHumanId: f.memberHumanId,
    });
    const personalIssueId = randomUUID();
    await database.db.insert(issues).values({
      id: personalIssueId,
      projectId: personalProjectId,
      number: 1,
      title: "Personal issue kept after departure",
      status: "todo",
      sortOrder: 65535,
      needsInput: false,
      createdByHumanId: f.memberHumanId,
      updatedByHumanId: f.memberHumanId,
    });

    expect(
      (
        await deletePath(
          `/api/workspaces/${f.workspaceId}/members/${f.memberHumanId}`,
          f.adminCookie,
        )
      ).status,
    ).toBe(204);

    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, f.memberHumanId));
    expect(personal).toBeDefined();
    const otherMemberships = await database.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.humanId, f.memberHumanId));
    expect(otherMemberships.map((row) => row.workspaceId)).toEqual([secondWorkspace]);
    expect(await database.db.select().from(issues).where(eq(issues.id, f.issueId))).toHaveLength(1);
    expect(
      await database.db.select().from(issues).where(eq(issues.id, personalIssueId)),
    ).toHaveLength(1);
  });

  it("re-invites with fresh grants while the old key stays revoked", async () => {
    const f = await fixtureWithClaim("Rejoin Team");
    expect(
      (
        await deletePath(
          `/api/workspaces/${f.workspaceId}/members/${f.memberHumanId}`,
          f.adminCookie,
        )
      ).status,
    ).toBe(204);

    expect(
      (
        await postJson(
          `/api/workspaces/${f.workspaceId}/invitations`,
          { email: MEMBER_EMAIL, projectGrants: [{ projectId: f.projectId, level: "read" }] },
          f.adminCookie,
        )
      ).status,
    ).toBe(201);
    const accepted = await postJson(
      "/api/workspace-invitations/acceptance",
      { token: lastInvitationToken(MEMBER_EMAIL) },
      f.memberCookie,
    );
    expect(accepted.status).toBe(200);

    const [grant] = await database.db
      .select()
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.humanId, f.memberHumanId),
          eq(projectAccessGrants.projectId, f.projectId),
        ),
      );
    expect(grant?.level).toBe("read");

    await expectProblem(await getJson("/api/agents/me", f.secret), 401, "key_revoked");
    const freshKey = await issueKey(f.memberCookie, f.agentId, f.workspaceId, f.projectId, "read");
    expect((await getJson("/api/agents/me", freshKey)).status).toBe(200);
  });

  it("revokes only the member's workspace-bound runners, not their Runner host (#195)", async () => {
    const f = await fixtureSetup("Runner Removal Team");
    const hostCredential = `orr_rh_${randomBytes(32).toString("hex")}`;
    const [host] = await database.db
      .insert(runnerHosts)
      .values({
        id: randomUUID(),
        humanId: f.memberHumanId,
        displayName: "member-laptop",
        platform: "linux-x64",
        credentialHash: tokenHash(hostCredential),
      })
      .returning();
    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, f.memberHumanId));
    const [otherProject] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId: personal!.id,
        name: "Personal repo",
        key: `K${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
        createdByHumanId: f.memberHumanId,
      })
      .returning();
    const [sharedRunner] = await database.db
      .insert(runners)
      .values({
        id: randomUUID(),
        hostId: host!.id,
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        agentId: f.agentId,
        displayName: "member-laptop",
        repoFingerprint: fingerprint("shared-repo"),
      })
      .returning();
    const [personalRunner] = await database.db
      .insert(runners)
      .values({
        id: randomUUID(),
        hostId: host!.id,
        workspaceId: personal!.id,
        projectId: otherProject!.id,
        agentId: f.agentId,
        displayName: "member-laptop",
        repoFingerprint: fingerprint("personal-repo"),
      })
      .returning();

    expect(
      (
        await deletePath(
          `/api/workspaces/${f.workspaceId}/members/${f.memberHumanId}`,
          f.adminCookie,
        )
      ).status,
    ).toBe(204);

    const [afterShared] = await database.db
      .select()
      .from(runners)
      .where(eq(runners.id, sharedRunner!.id));
    const [afterPersonal] = await database.db
      .select()
      .from(runners)
      .where(eq(runners.id, personalRunner!.id));
    const [afterHost] = await database.db
      .select()
      .from(runnerHosts)
      .where(eq(runnerHosts.id, host!.id));
    expect(afterShared?.revokedAt).not.toBeNull();
    expect(afterPersonal?.revokedAt).toBeNull();
    expect(afterHost?.revokedAt).toBeNull();

    // The removed member's Runner must learn about the revocation on its next
    // heartbeat with a 401 so the local CLI stops immediately (#195).
    const heartbeat = await postJson(
      `/api/runners/${sharedRunner!.id}/heartbeat`,
      { activeSlotCount: 0 },
      undefined,
      hostCredential,
    );
    await expectProblem(heartbeat, 401, "runner_revoked");
  });
});

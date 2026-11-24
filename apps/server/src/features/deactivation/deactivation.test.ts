import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentKeyValidity,
  InvitationStatus,
  Problem,
  ProjectAccessLevel,
  WorkSessionStatus,
  WorkspaceKind,
  AccountStatus,
  HistoryResponse,
  IssuesResponse,
  TransferAuthorization,
  WorkspacesResponse,
} from "@orrery/contract";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accountRecoveryEvents,
  agentApiKeys,
  agentKeyEvents,
  agents,
  browserSessions,
  humans,
  issues,
  passwordResetTokens,
  projectAccessEvents,
  projectAccessGrants,
  projectTransferAuthorizations,
  projects,
  runnerHosts,
  runners,
  runs,
  workSessions,
  workspaceInvitations,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature, type AccountsFeature } from "../accounts/index.ts";
import { createFeatures } from "../index.ts";

const SECRET = "deactivation-test-bootstrap-secret-123456";
const ADMIN_EMAIL = "deactivation-admin@example.com";
const ADMIN_PASSWORD = "deactivation-admin-password";
const PUBLIC_URL = "http://orrery.test";
const log = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let accounts: AccountsFeature;

function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row, got none");
  return row;
}

const postJson = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const getJson = (path: string, cookie?: string, bearer?: string) =>
  app.request(path, {
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

function cookieFrom(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((value) => value.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("no session cookie was set");
  return cookie;
}

async function login(email: string, password: string): Promise<string> {
  const res = await postJson("/api/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
  return cookieFrom(res);
}

async function createHuman(email: string, password: string) {
  const humanId = await database.db.transaction(async (tx) => {
    const created = await accounts.createInvitedHuman({ email, password }, tx);
    await accounts.markEmailVerified(created.humanId, tx);
    return created.humanId;
  });
  return { humanId, cookie: await login(email, password) };
}

async function insertSharedWorkspace(name: string, ownerHumanId: string) {
  return database.db.transaction(async (tx) => {
    const workspace = one(
      await tx
        .insert(workspaces)
        .values({ id: randomUUID(), kind: WorkspaceKind.enum.shared, name })
        .returning(),
    );
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: ownerHumanId,
      isOwner: true,
      canCreateProjects: true,
      canInviteMembers: true,
    });
    return workspace;
  });
}

async function insertProject(workspaceId: string, createdByHumanId: string) {
  return one(
    await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId,
        name: "Work",
        key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
        createdByHumanId,
      })
      .returning(),
  );
}

async function insertAgentWithKey(humanId: string, workspaceId: string) {
  const agent = one(
    await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId, name: `agent-${randomUUID()}` })
      .returning(),
  );
  const secret = randomBytes(32).toString("base64url");
  await database.db.insert(agentApiKeys).values({
    id: randomUUID(),
    agentId: agent.id,
    workspaceId,
    createdByHumanId: humanId,
    validity: AgentKeyValidity.enum.never,
    tokenHash: tokenHash(secret),
  });
  return { agent, secret };
}

async function insertActiveClaim(
  agentId: string,
  workspaceId: string,
  projectId: string,
  createdByHumanId: string,
) {
  const issue = one(
    await database.db
      .insert(issues)
      .values({
        id: randomUUID(),
        projectId,
        number: 1,
        title: "A task",
        body: "",
        status: "todo",
        sortOrder: 65535,
        createdByHumanId,
        updatedByHumanId: createdByHumanId,
      })
      .returning(),
  );
  const run = one(
    await database.db.insert(runs).values({ id: randomUUID(), agentId, workspaceId }).returning(),
  );
  await database.db.insert(workSessions).values({
    id: randomUUID(),
    agentId,
    runId: run.id,
    workspaceId,
    issueId: issue.id,
    status: WorkSessionStatus.enum.active,
    leaseExpiresAt: sql`now() + interval '5 minutes'`,
  });
  return issue;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  const config = loadConfig({
    DATABASE_URL: pg.getConnectionUri(),
    PUBLIC_URL,
    BOOTSTRAP_SECRET: SECRET,
    LOG_LEVEL: "error",
  });
  database = createDb(config.DATABASE_URL);
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
  accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  app = createApp({ features: createFeatures(database, config, log), publicUrl: PUBLIC_URL, log });

  const res = await postJson("/api/setup/admin", {
    secret: SECRET,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (res.status !== 201) throw new Error(`bootstrap failed with ${res.status}`);
});

afterAll(async () => {
  await database.sql.end();
  await pg.stop();
});

describe("account deactivation and reactivation (#38)", () => {
  it("refuses to deactivate the last active system administrator", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const admin = one(await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL)));
    await expectProblem(
      await postJson(`/api/admin/accounts/${admin.id}/deactivate`, {}, cookie),
      409,
      "last_admin",
    );
    const stillActive = one(
      await database.db
        .select({ at: humans.deactivatedAt })
        .from(humans)
        .where(eq(humans.id, admin.id)),
    );
    expect(stillActive.at).toBeNull();
  });

  it("requires an active administrator and a real account", async () => {
    const member = await createHuman("deactivation-guard@example.com", "guard-password");
    expect(member.humanId).toBeTruthy();
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await expectProblem(
      await postJson(`/api/admin/accounts/${member.humanId}/deactivate`, {}, member.cookie),
      403,
      "not_system_administrator",
    );
    await expectProblem(
      await postJson(`/api/admin/accounts/${randomUUID()}/deactivate`, {}, cookie),
      404,
      "account_not_found",
    );
  });

  it("stops sessions, keys, claims and grants, suspends memberships, and keeps authorship", async () => {
    const member = await createHuman("deactivation-member@example.com", "member-password");
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const admin = one(await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL)));

    const shared = await insertSharedWorkspace("Shared", admin.id);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: shared.id,
      humanId: member.humanId,
      isOwner: false,
      canCreateProjects: true,
      canInviteMembers: true,
    });
    const project = await insertProject(shared.id, admin.id);
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: project.id,
      humanId: member.humanId,
      level: ProjectAccessLevel.enum.manage,
      grantedByHumanId: admin.id,
    });
    const { agent, secret } = await insertAgentWithKey(member.humanId, shared.id);
    const claimed = await insertActiveClaim(agent.id, shared.id, project.id, member.humanId);

    const personal = one(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, member.humanId)),
    );
    const personalProject = await insertProject(personal.id, member.humanId);

    const res = await postJson(`/api/admin/accounts/${member.humanId}/deactivate`, {}, adminCookie);
    expect(res.status).toBe(200);
    expect(AccountStatus.parse(await res.json())).toMatchObject({
      humanId: member.humanId,
      email: "deactivation-member@example.com",
      deactivatedAt: expect.any(String),
      isSystemAdministrator: false,
    });

    expect(
      await database.db
        .select()
        .from(browserSessions)
        .where(eq(browserSessions.humanId, member.humanId)),
    ).toEqual([]);
    const key = one(
      await database.db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id)),
    );
    expect(key.revokedAt).not.toBeNull();
    expect(key.revokedByHumanId).toBe(admin.id);
    const keyEvents = await database.db
      .select()
      .from(agentKeyEvents)
      .where(eq(agentKeyEvents.keyId, key.id));
    expect(keyEvents.map((event) => event.type)).toEqual(["agent_key_revoked"]);
    expect(JSON.stringify(keyEvents)).not.toContain(secret);

    const session = one(
      await database.db.select().from(workSessions).where(eq(workSessions.agentId, agent.id)),
    );
    expect(session.status).toBe(WorkSessionStatus.enum.released);
    const issue = one(await database.db.select().from(issues).where(eq(issues.id, claimed.id)));
    expect(issue.status).toBe("todo");

    const authoredIssues = await getJson(`/api/projects/${project.id}/issues`, adminCookie);
    expect(authoredIssues.status).toBe(200);
    const authoredIssue = IssuesResponse.parse(await authoredIssues.json()).find(
      (row) => row.id === claimed.id,
    );
    expect(authoredIssue?.createdBy.displayName).toContain("deactivated");
    expect(authoredIssue?.createdBy.deactivated).toBe(true);

    expect(
      await database.db
        .select()
        .from(projectAccessGrants)
        .where(eq(projectAccessGrants.humanId, member.humanId)),
    ).toEqual([]);
    const accessEvents = await database.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.subjectHumanId, member.humanId));
    expect(accessEvents).toMatchObject([
      { type: "project_access_revoked", previousLevel: ProjectAccessLevel.enum.manage },
    ]);

    const membership = one(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, shared.id),
            eq(workspaceMemberships.humanId, member.humanId),
          ),
        ),
    );
    expect(membership.suspendedAt).not.toBeNull();
    expect(membership.isFormerOwner).toBe(false);
    expect(membership.isOwner).toBe(false);
    expect(membership.canCreateProjects).toBe(false);
    expect(membership.canInviteMembers).toBe(false);

    const personalRow = one(
      await database.db.select().from(projects).where(eq(projects.id, personalProject.id)),
    );
    expect(personalRow.createdByHumanId).toBe(member.humanId);
    const authored = one(
      await database.db.select().from(humans).where(eq(humans.id, member.humanId)),
    );
    expect(authored.email).toBe("deactivation-member@example.com");

    const deactivatedEvent = one(
      await database.db
        .select()
        .from(accountRecoveryEvents)
        .where(
          and(
            eq(accountRecoveryEvents.humanId, member.humanId),
            eq(accountRecoveryEvents.type, "account_deactivated"),
          ),
        ),
    );
    expect(deactivatedEvent.actorHumanId).toBe(admin.id);

    await expectProblem(
      await postJson("/api/auth/login", {
        email: "deactivation-member@example.com",
        password: "member-password",
      }),
      401,
      "invalid_credentials",
    );
    await expectProblem(await getJson("/api/auth/session", member.cookie), 401, "not_signed_in");
    await expectProblem(
      await getJson(`/api/agents/me?workspaceId=${shared.id}`, undefined, secret),
      401,
      "human_deactivated",
    );

    const reactivated = await postJson(
      `/api/admin/accounts/${member.humanId}/reactivate`,
      {},
      adminCookie,
    );
    expect(reactivated.status).toBe(200);
    expect(AccountStatus.parse(await reactivated.json()).deactivatedAt).toBeNull();
    const freshCookie = await login("deactivation-member@example.com", "member-password");
    const listed = await getJson("/api/workspaces", freshCookie);
    expect(listed.status).toBe(200);
    const names = WorkspacesResponse.parse(await listed.json()).map((w) => w.name);
    expect(names).toContain("Personal");
    expect(names).not.toContain("Shared");
    await expectProblem(
      await getJson(`/api/workspaces/${shared.id}`, freshCookie),
      404,
      "workspace_not_found",
    );

    await expectProblem(
      await getJson(`/api/agents/me?workspaceId=${shared.id}`, undefined, secret),
      401,
      "key_revoked",
    );

    const stillSuspended = one(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, shared.id),
            eq(workspaceMemberships.humanId, member.humanId),
          ),
        ),
    );
    expect(stillSuspended.suspendedAt).not.toBeNull();
    const reactivatedEvent = one(
      await database.db
        .select()
        .from(accountRecoveryEvents)
        .where(
          and(
            eq(accountRecoveryEvents.humanId, member.humanId),
            eq(accountRecoveryEvents.type, "account_reactivated"),
          ),
        ),
    );
    expect(reactivatedEvent.actorHumanId).toBe(admin.id);
  });

  it("records every revoked key and grant and bumps every affected workspace guard", async () => {
    const member = await createHuman("deactivation-batch@example.com", "batch-password");
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const admin = one(await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL)));

    const firstWorkspace = await insertSharedWorkspace("Batch shared one", admin.id);
    const secondWorkspace = await insertSharedWorkspace("Batch shared two", admin.id);
    await database.db.insert(workspaceMemberships).values(
      [firstWorkspace.id, secondWorkspace.id].map((workspaceId) => ({
        id: randomUUID(),
        workspaceId,
        humanId: member.humanId,
        isOwner: false,
      })),
    );
    await database.db
      .update(workspaceOwnershipGuards)
      .set({ version: 5 })
      .where(
        inArray(workspaceOwnershipGuards.workspaceId, [firstWorkspace.id, secondWorkspace.id]),
      );

    const firstProject = await insertProject(firstWorkspace.id, admin.id);
    const secondProject = await insertProject(secondWorkspace.id, admin.id);
    await database.db.insert(projectAccessGrants).values([
      {
        id: randomUUID(),
        projectId: firstProject.id,
        humanId: member.humanId,
        level: ProjectAccessLevel.enum.read,
        grantedByHumanId: admin.id,
      },
      {
        id: randomUUID(),
        projectId: secondProject.id,
        humanId: member.humanId,
        level: ProjectAccessLevel.enum.manage,
        grantedByHumanId: admin.id,
      },
    ]);

    const firstAgent = await insertAgentWithKey(member.humanId, firstWorkspace.id);
    const secondAgent = await insertAgentWithKey(member.humanId, secondWorkspace.id);

    const res = await postJson(`/api/admin/accounts/${member.humanId}/deactivate`, {}, adminCookie);
    expect(res.status).toBe(200);

    const keys = await database.db
      .select()
      .from(agentApiKeys)
      .where(inArray(agentApiKeys.agentId, [firstAgent.agent.id, secondAgent.agent.id]));
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.revokedAt !== null && key.revokedByHumanId === admin.id)).toBe(
      true,
    );
    const keyEvents = await database.db
      .select()
      .from(agentKeyEvents)
      .where(
        inArray(
          agentKeyEvents.keyId,
          keys.map((key) => key.id),
        ),
      );
    expect(keyEvents.map((event) => event.keyId).toSorted()).toEqual(
      keys.map((key) => key.id).toSorted(),
    );
    expect(
      keyEvents.every(
        (event) => event.type === "agent_key_revoked" && event.actorHumanId === admin.id,
      ),
    ).toBe(true);

    expect(
      await database.db
        .select()
        .from(projectAccessGrants)
        .where(eq(projectAccessGrants.humanId, member.humanId)),
    ).toEqual([]);
    const accessEvents = await database.db
      .select()
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.subjectHumanId, member.humanId));
    expect(accessEvents.map((event) => event.projectId).toSorted()).toEqual(
      [firstProject.id, secondProject.id].toSorted(),
    );
    expect(accessEvents.every((event) => event.type === "project_access_revoked")).toBe(true);

    const guards = await database.db
      .select()
      .from(workspaceOwnershipGuards)
      .where(
        inArray(workspaceOwnershipGuards.workspaceId, [firstWorkspace.id, secondWorkspace.id]),
      );
    expect(guards).toHaveLength(2);
    expect(guards.every((guard) => guard.version === 7)).toBe(true);
    expect(guards.map((guard) => guard.workspaceId).toSorted()).toEqual(
      [firstWorkspace.id, secondWorkspace.id].toSorted(),
    );
  });

  it("allows deactivating a sole owner and keeps the workspace eligible for recovery", async () => {
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const sole = await createHuman("deactivation-owner@example.com", "owner-password");
    const workspace = await insertSharedWorkspace("Sole owner workspace", sole.humanId);

    const res = await postJson(`/api/admin/accounts/${sole.humanId}/deactivate`, {}, adminCookie);
    expect(res.status).toBe(200);
    const membership = one(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspace.id),
            eq(workspaceMemberships.humanId, sole.humanId),
          ),
        ),
    );
    expect(membership.suspendedAt).not.toBeNull();
    expect(membership.isFormerOwner).toBe(true);
    expect(membership.isOwner).toBe(false);

    await postJson(`/api/admin/accounts/${sole.humanId}/reactivate`, {}, adminCookie);
    const after = one(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.id, membership.id)),
    );
    expect(after.isOwner).toBe(false);
    expect(after.suspendedAt).not.toBeNull();
    expect(after.isFormerOwner).toBe(true);
  });

  it("re-inviting a reactivated human unsuspends the membership with fresh access", async () => {
    const admin = one(await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL)));
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const inviteeEmail = "deactivation-reinvite@example.com";
    const invitee = await createHuman(inviteeEmail, "reinvite-password");
    const workspace = await insertSharedWorkspace("Reinvite workspace", admin.id);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      humanId: invitee.humanId,
      isOwner: false,
      canInviteMembers: true,
    });
    await postJson(`/api/admin/accounts/${invitee.humanId}/deactivate`, {}, adminCookie);
    await postJson(`/api/admin/accounts/${invitee.humanId}/reactivate`, {}, adminCookie);

    await database.db
      .update(humans)
      .set({ emailVerifiedAt: sql`now()` })
      .where(eq(humans.id, admin.id));
    const owner = one(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspace.id),
            eq(workspaceMemberships.humanId, admin.id),
          ),
        ),
    );
    const secret = randomBytes(32).toString("base64url");
    await database.db.insert(workspaceInvitations).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      email: inviteeEmail,
      status: InvitationStatus.enum.pending,
      tokenHash: tokenHash(secret),
      invitedByHumanId: owner.humanId,
      expiresAt: sql`now() + interval '7 days'`,
    });

    const cookie = await login(inviteeEmail, "reinvite-password");
    const res = await postJson("/api/workspace-invitations/acceptance", { token: secret }, cookie);
    expect(res.status).toBe(200);
    const after = one(
      await database.db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, workspace.id),
            eq(workspaceMemberships.humanId, invitee.humanId),
          ),
        ),
    );
    expect(after.suspendedAt).toBeNull();
    expect(after.isFormerOwner).toBe(false);
    expect(after.isOwner).toBe(false);
  });

  it("records deactivation and reactivation in installation history for administrators", async () => {
    const cookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await getJson("/api/installation/history", cookie);
    expect(res.status).toBe(200);
    const types = HistoryResponse.parse(await res.json()).map((event) => event.type);
    expect(types).toContain("account_deactivated");
    expect(types).toContain("account_reactivated");
  });

  it("refuses a password reset confirmation for a deactivated account", async () => {
    const member = await createHuman("deactivation-reset@example.com", "reset-password");
    expect(member.humanId).toBeTruthy();
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await postJson(`/api/admin/accounts/${member.humanId}/deactivate`, {}, adminCookie);
    const token = randomBytes(32).toString("base64url");
    await database.db.insert(passwordResetTokens).values({
      id: randomUUID(),
      humanId: member.humanId,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    await expectProblem(
      await postJson("/api/auth/password-reset/confirm", { token, password: "new-password" }),
      403,
      "account_deactivated",
    );
  });

  it("revokes a pending personal-workspace transfer when its authorizer is deactivated", async () => {
    const member = await createHuman(
      "deactivation-transfer@example.com",
      "deactivation-transfer-password",
    );
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const admin = one(await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL)));
    const personal = one(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, member.humanId)),
    );
    const project = await insertProject(personal.id, member.humanId);
    const destination = await insertSharedWorkspace("Transfer Destination", admin.id);

    const authorized = await postJson(
      `/api/projects/${project.id}/transfer`,
      { destinationWorkspaceId: destination.id },
      member.cookie,
    );
    expect(authorized.status).toBe(201);
    const authorization = TransferAuthorization.parse(await authorized.json());

    const res = await postJson(`/api/admin/accounts/${member.humanId}/deactivate`, {}, adminCookie);
    expect(res.status).toBe(200);

    const [stored] = await database.db
      .select()
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.id, authorization.authorizationId));
    expect(stored?.status).toBe("revoked");
    expect(stored?.revokedAt).not.toBeNull();
    await expectProblem(
      await postJson("/api/transfers/accept", { token: authorization.token }, adminCookie),
      404,
      "transfer_invalid",
    );
  });

  it("revokes the human's installation-wide Runner hosts and their Runners (#195)", async () => {
    const member = await createHuman(
      "deactivation-runner-hosts@example.com",
      "deactivation-runner-password",
    );
    const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const workspace = await insertSharedWorkspace("Runner Host Workspace", member.humanId);
    const project = await insertProject(workspace.id, member.humanId);
    const agent = one(
      await database.db
        .insert(agents)
        .values({ id: randomUUID(), humanId: member.humanId, name: `agent-${randomUUID()}` })
        .returning(),
    );
    const host = one(
      await database.db
        .insert(runnerHosts)
        .values({
          id: randomUUID(),
          humanId: member.humanId,
          displayName: "member-laptop",
          platform: "linux-x64",
          credentialHash: tokenHash(randomBytes(32).toString("hex")),
        })
        .returning(),
    );
    const runner = one(
      await database.db
        .insert(runners)
        .values({
          id: randomUUID(),
          hostId: host.id,
          workspaceId: workspace.id,
          projectId: project.id,
          agentId: agent.id,
          displayName: "member-laptop",
          repoFingerprint: createHash("sha256").update("repo").digest("hex"),
        })
        .returning(),
    );

    const res = await postJson(`/api/admin/accounts/${member.humanId}/deactivate`, {}, adminCookie);
    expect(res.status).toBe(200);

    const [storedHost] = await database.db
      .select()
      .from(runnerHosts)
      .where(eq(runnerHosts.id, host.id));
    const [storedRunner] = await database.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id));
    expect(storedHost?.revokedAt).not.toBeNull();
    expect(storedRunner?.revokedAt).not.toBeNull();
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { HumanSuggestionsResponse, Problem, Workspace } from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserSessions, humans, workspaceMemberships } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createWorkspacesFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

let databaseForHelpers: Database;
const currentDatabase = () => databaseForHelpers;

async function insertHuman(input: {
  email: string;
  displayName?: string;
  isSystemAdministrator?: boolean;
  deactivated?: boolean;
}) {
  const [human] = await currentDatabase()
    .db.insert(humans)
    .values({
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash: "scrypt$anything",
      emailVerifiedAt: sql`now()`,
      isSystemAdministrator: input.isSystemAdministrator ?? false,
      ...(input.deactivated === true ? { deactivatedAt: sql`now()` } : {}),
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

async function addMembership(
  workspaceId: string,
  humanId: string,
  capabilities: {
    isOwner?: boolean;
    canManageMemberPermissions?: boolean;
    canInviteMembers?: boolean;
    suspended?: boolean;
  } = {},
) {
  await currentDatabase()
    .db.insert(workspaceMemberships)
    .values({
      id: randomUUID(),
      workspaceId,
      humanId,
      isOwner: capabilities.isOwner ?? false,
      canManageMemberPermissions: capabilities.canManageMemberPermissions ?? false,
      canInviteMembers: capabilities.canInviteMembers ?? false,
      ...(capabilities.suspended === true ? { suspendedAt: sql`now()` } : {}),
    });
}

async function suggestionsFor(app: Hono, workspaceId: string, query: string, cookie?: string) {
  const res = await getJson(
    app,
    `/api/workspaces/${workspaceId}/human-suggestions?q=${encodeURIComponent(query)}`,
    cookie,
  );
  expect(res.status).toBe(200);
  return HumanSuggestionsResponse.parse(await res.json());
}

describe("workspace human suggestions", () => {
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
    const setup = await postJson(app, "/api/setup/admin", {
      secret: SECRET,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(setup.status).toBe(201);
    const login = await postJson(app, "/api/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const cookie = login.headers
      .getSetCookie()
      .find((candidate) => candidate.startsWith("orrery_session="))
      ?.split(";")[0];
    if (cookie === undefined) throw new Error("the session cookie was not set");
    const [admin] = await currentDatabase()
      .db.select({ id: humans.id })
      .from(humans)
      .where(eq(humans.email, ADMIN_EMAIL));
    if (admin === undefined) throw new Error("the administrator was not found");
    const created = await postJson(app, "/api/workspaces", { name: "Access Lab" }, cookie);
    expect(created.status).toBe(201);
    return { app, admin, cookie, workspace: Workspace.parse(await created.json()) };
  }

  it("lets a system administrator see active Humans outside the workspace, but never members or deactivated accounts", async () => {
    const { app, workspace, cookie } = await readyApp();
    const member = await insertHuman({ email: "member@example.com", displayName: "Member One" });
    await addMembership(workspace.id, member.id, { canManageMemberPermissions: true });
    const suspended = await insertHuman({ email: "suspended@example.com" });
    await addMembership(workspace.id, suspended.id, { suspended: true });
    await insertHuman({ email: "stranger@example.com", displayName: "Stranger Person" });
    await insertHuman({ email: "deactivated@example.com", deactivated: true });

    const suggestions = await suggestionsFor(app, workspace.id, "example.com", cookie);
    const emails = suggestions.map((suggestion) => suggestion.email);
    expect(emails).toContain("stranger@example.com");
    expect(emails).not.toContain("member@example.com");
    expect(emails).not.toContain("suspended@example.com");
    expect(emails).not.toContain("deactivated@example.com");
    expect(
      suggestions.find((suggestion) => suggestion.email === "stranger@example.com"),
    ).toMatchObject({ displayName: "Stranger Person", avatarUrl: null });
  });

  it("restricts a non-admin owner to Humans they already share another workspace with", async () => {
    const { app, workspace, cookie: adminCookie } = await readyApp();
    const owner = await insertHuman({ email: "owner@example.com" });
    await addMembership(workspace.id, owner.id, { isOwner: true });
    const ownerCookie = await sessionFor(owner.id);

    const second = await postJson(app, "/api/workspaces", { name: "Other Team" }, adminCookie);
    expect(second.status).toBe(201);
    const other = Workspace.parse(await second.json());
    await addMembership(other.id, owner.id, { isOwner: true });
    const friend = await insertHuman({ email: "friend@example.com" });
    await addMembership(other.id, friend.id);
    await insertHuman({ email: "stranger@example.com" });

    const visible = await suggestionsFor(app, workspace.id, "friend@example.com", ownerCookie);
    expect(visible.map((suggestion) => suggestion.email)).toEqual(["friend@example.com"]);
    const hidden = await suggestionsFor(app, workspace.id, "stranger@example.com", ownerCookie);
    expect(hidden).toEqual([]);
    // The same stranger is visible to a system administrator, so the empty list is
    // authorization, not a query mismatch.
    const adminView = await suggestionsFor(app, workspace.id, "stranger@example.com", adminCookie);
    expect(adminView.map((suggestion) => suggestion.email)).toEqual(["stranger@example.com"]);
  });

  it("restricts a permission manager to co-workspace Humans and hides deactivated ones", async () => {
    const { app, workspace, cookie: adminCookie } = await readyApp();
    const manager = await insertHuman({ email: "manager@example.com" });
    await addMembership(workspace.id, manager.id, { canManageMemberPermissions: true });
    const managerCookie = await sessionFor(manager.id);

    const second = await postJson(
      app,
      "/api/workspaces",
      { name: "Shared Elsewhere" },
      adminCookie,
    );
    expect(second.status).toBe(201);
    const other = Workspace.parse(await second.json());
    await addMembership(other.id, manager.id);
    const friend = await insertHuman({ email: "colleague@example.com" });
    await addMembership(other.id, friend.id);
    const inactive = await insertHuman({ email: "inactive@example.com", deactivated: true });
    await addMembership(other.id, inactive.id);
    await insertHuman({ email: "outsider@example.com" });

    expect(
      (await suggestionsFor(app, workspace.id, "colleague@example.com", managerCookie)).map(
        (suggestion) => suggestion.email,
      ),
    ).toEqual(["colleague@example.com"]);
    expect(await suggestionsFor(app, workspace.id, "inactive@example.com", managerCookie)).toEqual(
      [],
    );
    expect(await suggestionsFor(app, workspace.id, "outsider@example.com", managerCookie)).toEqual(
      [],
    );
  });

  it("masks the workspace from non-members and anonymous callers, and refuses plain members", async () => {
    const { app, workspace } = await readyApp();
    const outsider = await insertHuman({ email: "outsider@example.com" });
    const outsiderCookie = await sessionFor(outsider.id);
    const plainMember = await insertHuman({ email: "plain@example.com" });
    await addMembership(workspace.id, plainMember.id);
    const memberCookie = await sessionFor(plainMember.id);

    const existing = await getJson(
      app,
      `/api/workspaces/${workspace.id}/human-suggestions?q=a`,
      outsiderCookie,
    );
    const missing = await getJson(
      app,
      `/api/workspaces/${randomUUID()}/human-suggestions?q=a`,
      outsiderCookie,
    );
    const existingBody = Problem.parse(await existing.clone().json());
    const missingBody = Problem.parse(await missing.clone().json());
    await expectProblem(existing, 404, "workspace_not_found");
    await expectProblem(missing, 404, "workspace_not_found");
    expect(existingBody).toEqual(missingBody);
    await expectProblem(
      await getJson(app, `/api/workspaces/${workspace.id}/human-suggestions?q=a`),
      401,
      "not_signed_in",
    );
    await expectProblem(
      await getJson(app, `/api/workspaces/${workspace.id}/human-suggestions?q=a`, memberCookie),
      403,
      "not_workspace_owner",
    );
  });

  it("requires a search query", async () => {
    const { app, workspace, cookie } = await readyApp();
    const res = await getJson(app, `/api/workspaces/${workspace.id}/human-suggestions`, cookie);
    expect(res.status).toBe(400);
  });
});

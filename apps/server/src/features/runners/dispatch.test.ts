import { randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Attachment,
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
  type ExecutionDefaults,
  type HarnessCatalog,
  HostCredentialResponse,
  Issue,
  KnowledgeEntry,
  Problem,
  Runner,
} from "@orrery/contract";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  browserSessions,
  dispatchTokens,
  humans,
  issues,
  projectAccessGrants,
  projects,
  runnerCommands,
  runnerDispatches,
  runners,
  runs,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createFeatures } from "../index.ts";

const SECRET = "dispatch-test-bootstrap-secret-123456";
const ADMIN_EMAIL = "dispatch-admin@example.com";
const ADMIN_PASSWORD = "dispatch-admin-password";
const PUBLIC_URL = "http://orrery.test";
const fingerprint = tokenHash("/home/secret/repo");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let features: ReturnType<typeof createFeatures>;
let adminCookie: string;
let adminHumanId: string;
let workspaceId: string;
let projectId: string;
let defaultAgentId: string;

function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const request = (
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; token?: string } = {},
) =>
  app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

async function multipart() {
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 30, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "dispatch.png", { type: "image/png" }));
  return form;
}

const bearerForm = (path: string, token: string, form: FormData) =>
  app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

async function createKnowledge(project: string, title: string) {
  const res = await request(`/api/projects/${project}/knowledge`, {
    method: "POST",
    cookie: adminCookie,
    body: { title, body: "knowledge body" },
  });
  expect(res.status).toBe(201);
  return KnowledgeEntry.parse(await res.json());
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await res.json())).toMatchObject({ status, code });
}

async function login(email: string, password: string): Promise<string> {
  const res = await request("/api/auth/login", { method: "POST", body: { email, password } });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("session cookie was not set");
  return cookie;
}

async function insertHuman(email: string) {
  return one(
    await database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email,
        passwordHash: "scrypt$anything",
        emailVerifiedAt: sql`statement_timestamp()`,
      })
      .returning(),
  );
}

async function browserCookie(humanId: string) {
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    expiresAt: sql`statement_timestamp() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

async function enrollHost(cookie: string, name = "dispatch-laptop") {
  const verifier = randomBytes(32).toString("hex");
  const created = await request("/api/runners/device-codes", {
    method: "POST",
    body: { hostDisplayName: name, platform: "linux-x64", verifierHash: tokenHash(verifier) },
  });
  expect(created.status).toBe(201);
  const device = DeviceCodeResponse.parse(await created.json());
  const approved = await request(`/api/runners/device-codes/${device.userCode}/approve`, {
    method: "POST",
    cookie,
  });
  expect(approved.status).toBe(200);
  const exchanged = await request("/api/runners/device-codes/token", {
    method: "POST",
    body: { deviceCode: device.deviceCode, verifier },
  });
  expect(exchanged.status).toBe(200);
  return HostCredentialResponse.parse(await exchanged.json());
}

async function registerRunner(
  credential: string,
  agent = defaultAgentId,
  harnessCatalog?: HarnessCatalog,
  defaults?: ExecutionDefaults,
) {
  const res = await request("/api/runners/register", {
    method: "POST",
    body: {
      workspaceId,
      projectId,
      agentId: agent,
      repoFingerprint: fingerprint,
      ...(harnessCatalog === undefined ? {} : { harnessCatalog }),
      ...(defaults === undefined ? {} : { defaults }),
    },
    token: credential,
  });
  expect(res.status).toBe(201);
  return Runner.parse(await res.json());
}

async function createIssue(title: string) {
  const res = await request(`/api/projects/${projectId}/issues`, {
    method: "POST",
    body: { title },
    cookie: adminCookie,
  });
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

function createDispatch(
  issueId: string,
  runnerId: string,
  cookie: string,
  overrideAgentId?: string,
  prompt?: string,
) {
  return request(`/api/issues/${issueId}/dispatches`, {
    method: "POST",
    body: {
      runnerId,
      ...(overrideAgentId === undefined ? {} : { agentId: overrideAgentId }),
      ...(prompt === undefined ? {} : { prompt }),
    },
    cookie,
  });
}

function createDispatchWithOptions(
  issueId: string,
  runnerId: string,
  cookie: string,
  options: { harness?: string; model?: string; effort?: string } = {},
) {
  return request(`/api/issues/${issueId}/dispatches`, {
    method: "POST",
    body: {
      runnerId,
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    },
    cookie,
  });
}

const testCatalog: HarnessCatalog = {
  probedAt: "2026-01-01T00:00:00.000Z",
  harnesses: [
    {
      id: "opencode",
      displayName: "OpenCode",
      defaultModel: "stub-model-1",
      models: [
        {
          id: "stub-model-1",
          reasoningDiscovery: "known",
          supportedEfforts: ["low", "high"],
          defaultEffort: "low",
        },
      ],
      probedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

async function dispatchCommand(dispatchId: string) {
  const [command] = await database.db
    .select()
    .from(runnerCommands)
    .where(and(eq(runnerCommands.dispatchId, dispatchId), eq(runnerCommands.kind, "dispatch")));
  if (command === undefined) throw new Error("no dispatch command in the outbox");
  return command;
}

async function acceptedFixture() {
  const host = await enrollHost(adminCookie);
  const runner = await registerRunner(host.credential);
  const issue = await createIssue(`accepted-${randomUUID()}`);
  const created = await createDispatch(issue.id, runner.id, adminCookie);
  expect(created.status).toBe(201);
  const dispatch = Dispatch.parse(await created.json());
  const accepted = await request(`/api/runners/${runner.id}/dispatches/${dispatch.id}/accept`, {
    method: "POST",
    token: host.credential,
  });
  expect(accepted.status).toBe(200);
  return {
    host,
    runner,
    issue,
    dispatch,
    acceptance: DispatchAcceptance.parse(await accepted.json()),
  };
}

type ToolResult = { structuredContent?: unknown; isError?: boolean };
async function mcpTools(token: string) {
  const handlers = new Map<string, (args: unknown) => Promise<ToolResult>>();
  // The MCP SDK's registerTool signature is the only seam we need to observe.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP SDK seam
  const server = {
    registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<ToolResult>) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const bearerRequest = new Request(`${PUBLIC_URL}/mcp`, {
    headers: { authorization: `Bearer ${token}` },
  });
  for (const feature of features) feature.registerTools?.(server, bearerRequest);
  return handlers;
}

const toolCode = (result: ToolResult) => field(result.structuredContent, "code");

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
  features = createFeatures(database, config, createLogger("error"));
  app = createApp({ features, publicUrl: PUBLIC_URL, log: createLogger("error") });

  const setup = await request("/api/setup/admin", {
    method: "POST",
    body: { secret: SECRET, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (setup.status !== 201) throw new Error(`bootstrap failed with ${setup.status}`);
  const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
  adminHumanId = admin!.id;
}, 120_000);

beforeEach(async () => {
  adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  await database.db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ id: randomUUID(), kind: "shared", name: "Dispatch workspace" })
      .returning();
    workspaceId = workspace!.id;
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: adminHumanId,
      isOwner: true,
    });
  });
  const [project] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name: "Dispatch repo",
      key: `D${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
      createdByHumanId: adminHumanId,
    })
    .returning();
  projectId = project!.id;
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: adminHumanId, name: `dispatch-agent-${randomUUID()}` })
    .returning();
  defaultAgentId = agent!.id;
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    for (const table of [
      "runner_commands",
      "dispatch_tokens",
      "runner_dispatches",
      "notifications",
      "work_session_activities",
      "questions",
      "project_activity",
      "work_sessions",
      "runs",
      "runners",
      "runner_device_codes",
      "runner_device_code_attempts",
      "runner_hosts",
      "attachment_references",
      "attachments",
      "knowledge_entries",
      "issues",
      "project_access_grants",
      "projects",
      "workspace_memberships",
      "browser_sessions",
      "agents",
    ]) {
      await tx.execute(sql.raw(`delete from ${table}`));
    }
    if (workspaceId !== undefined) {
      await tx.execute(sql`delete from workspaces where id = ${workspaceId}`);
    }
    await tx.execute(sql`delete from humans where id <> ${adminHumanId}`);
  });
});

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

describe("manual dispatch creation (#196)", () => {
  it("is owner-only across a shared workspace and non-enumerating for outsiders", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("owner-only issue");

    const teammate = await insertHuman(`teammate-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: teammate.id,
      isOwner: false,
    });
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId,
      humanId: teammate.id,
      level: "contribute",
      grantedByHumanId: adminHumanId,
    });
    const teammateCookie = await browserCookie(teammate.id);
    await expectProblem(
      await createDispatch(issue.id, runner.id, teammateCookie),
      403,
      "runner_forbidden",
    );

    const outsider = await insertHuman(`outsider-${randomUUID()}@example.com`);
    const outsiderCookie = await browserCookie(outsider.id);
    await expectProblem(
      await createDispatch(issue.id, runner.id, outsiderCookie),
      404,
      "issue_not_found",
    );

    const owned = await createDispatch(issue.id, runner.id, adminCookie);
    expect(owned.status).toBe(201);
    expect(Dispatch.parse(await owned.json())).toMatchObject({
      runnerId: runner.id,
      issueId: issue.id,
      agentId: defaultAgentId,
      state: "pending",
      runId: null,
      workSessionId: null,
    });
  });

  it("validates assignee compatibility without changing issues.assignee", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("assignee compatibility");
    const [otherAgent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId: adminHumanId, name: `other-${randomUUID()}` })
      .returning();
    await database.db
      .update(issues)
      .set({ assigneeType: "agent", assigneeId: otherAgent!.id })
      .where(eq(issues.id, issue.id));
    expect(issue.id.length).toBeGreaterThan(0);
    await expectProblem(
      await createDispatch(issue.id, runner.id, adminCookie),
      409,
      "issue_not_claimable",
    );
    const compatible = await createDispatch(issue.id, runner.id, adminCookie, otherAgent!.id);
    expect(compatible.status).toBe(201);
    const [after] = await database.db
      .select({ assigneeType: issues.assigneeType, assigneeId: issues.assigneeId })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(after).toMatchObject({ assigneeType: "agent", assigneeId: otherAgent!.id });

    const unassignedIssue = await createIssue("unassigned compatibility");
    const reset = await request(`/api/issues/${unassignedIssue.id}`, {
      method: "PATCH",
      body: { assignee: null },
      cookie: adminCookie,
    });
    expect(reset.status).toBe(200);
    expect((await createDispatch(unassignedIssue.id, runner.id, adminCookie)).status).toBe(201);
  });
});

describe("custom dispatch prompt (#239)", () => {
  it("persists the prompt and carries it in the outbox dispatch command", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("prompted dispatch");
    const created = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: "  Use the additive migration strategy.  " },
      cookie: adminCookie,
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.prompt).toBe("Use the additive migration strategy.");

    const command = await dispatchCommand(dispatch.id);
    expect(field(command.payload, "prompt")).toBe("Use the additive migration strategy.");

    // The one-shot `orrery-runner work` path shares the same persistence.
    const oneShotIssue = await createIssue("one-shot prompted dispatch");
    const oneShot = await request(`/api/runners/${runner.id}/dispatches`, {
      method: "POST",
      body: { issueId: oneShotIssue.id, prompt: "Work only inside the worktree." },
      token: host.credential,
    });
    expect(oneShot.status).toBe(201);
    const oneShotDispatch = Dispatch.parse(await oneShot.json());
    expect(oneShotDispatch.prompt).toBe("Work only inside the worktree.");
    expect(field((await dispatchCommand(oneShotDispatch.id)).payload, "prompt")).toBe(
      "Work only inside the worktree.",
    );
  });

  it("treats a whitespace-only prompt as omitted and rejects an over-limit prompt", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("blank prompt dispatch");
    const created = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: "   \n\t " },
      cookie: adminCookie,
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.prompt).toBeNull();
    const command = await dispatchCommand(dispatch.id);
    expect(field(command.payload, "prompt")).toBeUndefined();

    await expectProblem(
      await request(`/api/issues/${issue.id}/dispatches`, {
        method: "POST",
        body: { runnerId: runner.id, prompt: "x".repeat(16001) },
        cookie: adminCookie,
      }),
      400,
      "validation_failed",
    );
    expect(
      (
        await database.db
          .select({ prompt: runnerDispatches.prompt })
          .from(runnerDispatches)
          .where(eq(runnerDispatches.issueId, issue.id))
      ).every((row) => row.prompt === null),
    ).toBe(true);
  });

  it("serves the prompt to project readers through the single-dispatch endpoint", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("reader prompt dispatch");
    const created = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: "Focus on the migration first." },
      cookie: adminCookie,
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());

    const reader = await insertHuman(`reader-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: reader.id,
      isOwner: false,
    });
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId,
      humanId: reader.id,
      level: "read",
      grantedByHumanId: adminHumanId,
    });
    const readerRead = await request(`/api/runners/dispatches/${dispatch.id}`, {
      cookie: await browserCookie(reader.id),
    });
    expect(readerRead.status).toBe(200);
    expect(Dispatch.parse(await readerRead.json()).prompt).toBe("Focus on the migration first.");

    const member = await insertHuman(`no-grant-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: member.id,
      isOwner: false,
    });
    await expectProblem(
      await request(`/api/runners/dispatches/${dispatch.id}`, {
        cookie: await browserCookie(member.id),
      }),
      404,
      "dispatch_not_found",
    );
  });

  it("rechecks the host owner's live project and workspace access on every host read", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("host bearer live ACL");
    const created = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: "Read only while access is live." },
      cookie: adminCookie,
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    const path = `/api/runners/dispatches/${dispatch.id}`;

    // The host credential stays valid; it reads only its own Dispatch.
    const live = await request(path, { token: host.credential });
    expect(live.status).toBe(200);
    expect(Dispatch.parse(await live.json()).prompt).toBe("Read only while access is live.");
    const otherHost = await enrollHost(adminCookie, "unrelated-host");
    await expectProblem(
      await request(path, { token: otherHost.credential }),
      404,
      "dispatch_not_found",
    );
    await expectProblem(
      await request(`/api/runners/dispatches/${randomUUID()}`, { token: host.credential }),
      404,
      "dispatch_not_found",
    );
    await expectProblem(await request(path), 401, "invalid_credential");

    // The credential is never revoked here: only the owner's live access
    // changes. Another owner keeps the shared workspace valid while dropping
    // the host owner's implicit Manage ceiling leaves the project private.
    const anotherOwner = await insertHuman(`another-owner-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: anotherOwner.id,
      isOwner: true,
    });
    await database.db
      .update(workspaceMemberships)
      .set({ isOwner: false })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, adminHumanId),
        ),
      );
    await expectProblem(await request(path, { token: host.credential }), 404, "dispatch_not_found");

    // Losing workspace membership entirely is equally non-enumerating.
    await database.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, adminHumanId),
        ),
      );
    await expectProblem(await request(path, { token: host.credential }), 404, "dispatch_not_found");
  });
});

describe("atomic acceptance and fenced token", () => {
  it("registers the Run, claims the session and hashes the token in one transaction", async () => {
    const { dispatch, acceptance } = await acceptedFixture();
    expect(acceptance.dispatchToken).toMatch(/^orr_dt_[0-9a-f]{64}$/);
    expect(acceptance.dispatch).toMatchObject({ state: "active" });
    expect(acceptance.run.nativeSessionId).toBe(dispatch.dispatchAttemptId);
    expect(acceptance.session).toMatchObject({
      issueId: dispatch.issueId,
      runId: acceptance.run.id,
      status: "active",
    });

    const [tokenRow] = await database.db
      .select()
      .from(dispatchTokens)
      .where(eq(dispatchTokens.dispatchId, dispatch.id));
    expect(tokenRow?.tokenHash).toBe(tokenHash(acceptance.dispatchToken));
    expect(JSON.stringify(tokenRow)).not.toContain(acceptance.dispatchToken);
    expect(tokenRow).toMatchObject({
      runnerHostId: acceptance.dispatch.hostId,
      runnerId: dispatch.runnerId,
      dispatchAttemptId: dispatch.dispatchAttemptId,
      agentId: dispatch.agentId,
      workspaceId,
      projectId,
      issueId: dispatch.issueId,
      runId: acceptance.run.id,
      workSessionId: acceptance.session.id,
      revokedAt: null,
    });
    const [storedRun] = await database.db.select().from(runs).where(eq(runs.id, acceptance.run.id));
    expect(storedRun?.nativeSessionId).toBe(dispatch.dispatchAttemptId);
    const [storedSession] = await database.db
      .select()
      .from(workSessions)
      .where(eq(workSessions.id, acceptance.session.id));
    expect(storedSession?.status).toBe("active");
  });

  it("resolves the token scope through agent authentication", async () => {
    const { acceptance } = await acceptedFixture();
    const identity = await request("/api/agents/me", { token: acceptance.dispatchToken });
    expect(identity.status).toBe(200);
    const body = await identity.json();
    expect(field(body, "dispatchScope")).toMatchObject({
      runnerHostId: acceptance.dispatch.hostId,
      runnerId: acceptance.dispatch.runnerId,
      dispatchId: acceptance.dispatch.id,
      dispatchAttemptId: acceptance.dispatch.dispatchAttemptId,
      agentId: acceptance.dispatch.agentId,
      workspaceId,
      projectId,
      issueId: acceptance.dispatch.issueId,
      runId: acceptance.run.id,
      workSessionId: acceptance.session.id,
    });
  });

  it("allows only the dispatched issue over REST and MCP, including fenced lease renewal", async () => {
    const { issue, acceptance, dispatch } = await acceptedFixture();
    const other = await createIssue("other dispatched issue");
    const token = acceptance.dispatchToken;

    expect((await request(`/api/issues/${issue.id}`, { token })).status).toBe(200);
    expect(
      (
        await request(`/api/issues/${issue.id}`, {
          method: "PATCH",
          body: { title: "dispatched edit" },
          token,
        })
      ).status,
    ).toBe(200);
    await expectProblem(
      await request(`/api/issues/${other.id}`, { token }),
      403,
      "dispatch_forbidden",
    );
    await expectProblem(
      await request(`/api/projects/${projectId}/issues`, {
        method: "POST",
        body: { title: "forbidden creation" },
        token,
      }),
      403,
      "dispatch_forbidden",
    );
    // The Runner's lease watchdog renews the bound session over REST.
    const renewed = await request(`/api/issues/${issue.id}/work-sessions/renew`, {
      method: "POST",
      body: { sessionId: acceptance.session.id },
      token,
    });
    expect(renewed.status).toBe(200);
    expect(field(await renewed.json(), "status")).toBe("active");
    await expectProblem(
      await request(`/api/issues/${other.id}/work-sessions/renew`, {
        method: "POST",
        body: {},
        token,
      }),
      403,
      "dispatch_forbidden",
    );

    const tools = await mcpTools(token);
    const get = tools.get("get_issue");
    if (get === undefined) throw new Error("get_issue tool missing");
    expect((await get({ issueId: issue.id })).isError).not.toBe(true);
    for (const [name, args] of [
      ["get_issue", { issueId: other.id }],
      ["create_issue", { projectId, title: "nope" }],
      ["claim_issue", { issueId: issue.id, runId: "other-run" }],
      ["renew_claim", { issueId: issue.id }],
      ["reacquire_issue", { issueId: issue.id, runId: acceptance.run.id }],
      ["orrery_run_checkin", { runKey: { harness: "opencode", nativeSessionId: "x" } }],
      ["report_progress", { issueId: issue.id, summary: "x", sessionId: "other-session" }],
      [
        "ask_for_input",
        { issueId: issue.id, runId: "other-run", question: "q", proposedFallback: "f" },
      ],
    ] as const) {
      const handler = tools.get(name);
      if (handler === undefined) throw new Error(`${name} tool missing`);
      const result = await handler(args);
      expect(result.isError, `${name} should refuse`).toBe(true);
      expect(toolCode(result), `${name} refusal code`).toBe("dispatch_forbidden");
    }
    const comments = tools.get("list_comments");
    if (comments === undefined) throw new Error("list_comments tool missing");
    expect((await comments({ issueId: issue.id })).isError).not.toBe(true);
    const log = tools.get("log_session_activity");
    if (log === undefined) throw new Error("log_session_activity tool missing");
    expect(
      (
        await log({
          issueId: issue.id,
          kind: "thought",
          summary: "working",
          sessionId: acceptance.session.id,
        })
      ).isError,
    ).not.toBe(true);
    const [row] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row?.state).toBe("active");
  });

  it("allows a fenced stop_session('released') but refuses another issue or session", async () => {
    const { issue, acceptance } = await acceptedFixture();
    const other = await createIssue("other released issue");
    const token = acceptance.dispatchToken;
    const tools = await mcpTools(token);
    const stop = tools.get("stop_session");
    if (stop === undefined) throw new Error("stop_session tool missing");

    for (const args of [
      { issueId: other.id, outcome: "released", sessionId: acceptance.session.id },
      { issueId: issue.id, outcome: "released", sessionId: "other-session" },
      { issueId: issue.id, outcome: "done", sessionId: acceptance.session.id },
    ]) {
      const result = await stop(args);
      expect(result.isError, `stop_session should refuse ${JSON.stringify(args)}`).toBe(true);
      expect(toolCode(result)).toBe("dispatch_forbidden");
    }

    const released = await stop({
      issueId: issue.id,
      outcome: "released",
      sessionId: acceptance.session.id,
    });
    expect(released.isError).not.toBe(true);
    const [stored] = await database.db
      .select()
      .from(workSessions)
      .where(eq(workSessions.id, acceptance.session.id));
    expect(stored?.status).toBe("released");
  });

  it("invalidates immediately when the work session ends", async () => {
    const { issue, acceptance } = await acceptedFixture();
    const stopped = await request(`/api/issues/${issue.id}/work-sessions/stop`, {
      method: "POST",
      body: { outcome: "review", sessionId: acceptance.session.id },
      token: acceptance.dispatchToken,
    });
    expect(stopped.status).toBe(200);
    await expectProblem(
      await request(`/api/issues/${issue.id}`, { token: acceptance.dispatchToken }),
      401,
      "dispatch_token_invalid",
    );
  });

  it("invalidates when the lease lapses in database time", async () => {
    const { issue, acceptance } = await acceptedFixture();
    expect(acceptance.dispatchToken).toMatch(/^orr_dt_/);
    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: sql`statement_timestamp() - interval '1 second'` })
      .where(eq(workSessions.id, acceptance.session.id));
    await expectProblem(
      await request(`/api/issues/${issue.id}`, { token: acceptance.dispatchToken }),
      401,
      "dispatch_token_invalid",
    );
  });

  it("invalidates on host revocation, runner revocation and human deactivation", async () => {
    const { host, runner, issue, acceptance } = await acceptedFixture();
    const token = acceptance.dispatchToken;
    const revoked = await request(`/api/runner-hosts/${acceptance.dispatch.hostId}/revoke`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(revoked.status).toBe(200);
    await expectProblem(
      await request(`/api/issues/${issue.id}`, { token }),
      401,
      "dispatch_token_invalid",
    );
    const [tokenRow] = await database.db
      .select()
      .from(dispatchTokens)
      .where(eq(dispatchTokens.dispatchId, acceptance.dispatch.id));
    expect(tokenRow?.revokedAt).not.toBeNull();

    await database.db
      .update(runners)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(runners.id, runner.id));
    await expectProblem(
      await request(`/api/issues/${issue.id}`, { token }),
      401,
      "dispatch_token_invalid",
    );
    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`statement_timestamp()` })
      .where(eq(humans.id, adminHumanId));
    await expectProblem(
      await request(`/api/issues/${issue.id}`, { token }),
      401,
      "dispatch_token_invalid",
    );
    await database.db
      .update(humans)
      .set({ deactivatedAt: null })
      .where(eq(humans.id, adminHumanId));
    expect(host.hostId).toBe(acceptance.dispatch.hostId);
  });

  it("invalidates when workspace access or runner access is withdrawn", async () => {
    const { issue, acceptance } = await acceptedFixture();
    expect(acceptance.dispatch.state).toBe("active");
    const newOwner = await insertHuman(`new-owner-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: newOwner.id,
      isOwner: true,
    });
    await database.db
      .update(workspaceMemberships)
      .set({ suspendedAt: sql`statement_timestamp()` })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, adminHumanId),
        ),
      );
    await expectProblem(
      await request(`/api/issues/${issue.id}`, { token: acceptance.dispatchToken }),
      401,
      "dispatch_token_invalid",
    );
  });
});

describe("#196 review regressions", () => {
  it("resolves a Dispatch token identity inside agentProjectAccessInTransaction for attachments", async () => {
    const { issue, acceptance } = await acceptedFixture();
    const token = acceptance.dispatchToken;

    const uploaded = await bearerForm(
      `/api/projects/${projectId}/attachments`,
      token,
      await multipart(),
    );
    expect(uploaded.status).toBe(201);
    const attachment = Attachment.parse(await uploaded.json());
    const downloaded = await request(`/api/projects/${projectId}/attachments/${attachment.id}`, {
      token,
    });
    expect(downloaded.status).toBe(200);

    const [other] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId,
        name: "Another project",
        key: `X${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        createdByHumanId: adminHumanId,
      })
      .returning();
    await expectProblem(
      await bearerForm(`/api/projects/${other!.id}/attachments`, token, await multipart()),
      403,
      "dispatch_forbidden",
    );
    await expectProblem(
      await request(`/api/projects/${other!.id}/attachments/${attachment.id}`, { token }),
      403,
      "dispatch_forbidden",
    );
    expect(issue.id.length).toBeGreaterThan(0);
  });

  it("fences REST questions and work-session activities to the dispatched run and session", async () => {
    const { issue, acceptance } = await acceptedFixture();
    const token = acceptance.dispatchToken;
    const ask = (body: Record<string, unknown>) =>
      request("/api/questions", { method: "POST", token, body });
    const allowed = await ask({
      issueId: issue.id,
      runId: acceptance.run.id,
      question: "Need a decision",
      proposedFallback: "Continue with the plan",
    });
    expect(allowed.status).toBe(201);
    await expectProblem(
      await ask({
        issueId: issue.id,
        runId: "another-run",
        question: "Need a decision",
        proposedFallback: "Continue",
      }),
      403,
      "dispatch_forbidden",
    );

    const activityPath = `/api/issues/${issue.id}/work-sessions/activities`;
    const log = (body: Record<string, unknown>) =>
      request(activityPath, { method: "POST", token, body });
    expect(
      (
        await log({
          kind: "thought",
          summary: "working",
          sessionId: acceptance.session.id,
        })
      ).status,
    ).toBe(201);
    await expectProblem(
      await log({ kind: "thought", summary: "working", sessionId: "other-session" }),
      403,
      "dispatch_forbidden",
    );
  });

  it("fences knowledge reads and edits by the entry's project", async () => {
    const { acceptance } = await acceptedFixture();
    const token = acceptance.dispatchToken;
    const entry = await createKnowledge(projectId, "Dispatch knowledge");
    expect((await request(`/api/knowledge/${entry.id}`, { token })).status).toBe(200);
    expect(
      (
        await request(`/api/knowledge/${entry.id}`, {
          method: "PATCH",
          token,
          body: { title: "Edited by dispatch" },
        })
      ).status,
    ).toBe(200);

    const [other] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId,
        name: "Foreign project",
        key: `Y${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        createdByHumanId: adminHumanId,
      })
      .returning();
    const foreign = await createKnowledge(other!.id, "Foreign knowledge");
    await expectProblem(
      await request(`/api/knowledge/${foreign.id}`, { token }),
      403,
      "dispatch_forbidden",
    );
    await expectProblem(
      await request(`/api/knowledge/${foreign.id}`, {
        method: "PATCH",
        token,
        body: { title: "nope" },
      }),
      403,
      "dispatch_forbidden",
    );
    expect(acceptance.dispatch.state).toBe("active");
  });

  it("returns 404 for a workspace member with no project read access when listing dispatches", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("no read access");
    expect((await createDispatch(issue.id, runner.id, adminCookie)).status).toBe(201);

    const member = await insertHuman(`no-grant-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: member.id,
      isOwner: false,
    });
    await expectProblem(
      await request(`/api/issues/${issue.id}/dispatches`, {
        cookie: await browserCookie(member.id),
      }),
      404,
      "issue_not_found",
    );
  });

  it("expires a lapsed claim at dispatch creation and translates a failed claim on accept", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("lapsed claim issue");
    const [run] = await database.db
      .insert(runs)
      .values({ id: randomUUID(), agentId: defaultAgentId, workspaceId })
      .returning();
    await database.db.insert(workSessions).values({
      id: randomUUID(),
      agentId: defaultAgentId,
      runId: run!.id,
      workspaceId,
      issueId: issue.id,
      status: "active",
      leaseExpiresAt: sql`statement_timestamp() - interval '1 second'`,
    });
    await database.db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issue.id));

    const created = await createDispatch(issue.id, runner.id, adminCookie);
    expect(created.status).toBe(201);
    const [afterExpiry] = await database.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(afterExpiry?.status).toBe("todo");

    // Make the issue unclaimable after creation: accept must be a clean 409,
    // never an unhandled 500 from the claim service, and must settle the
    // pending dispatch to `ended` (never leaving it stranded in `pending`).
    await database.db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issue.id));
    const dispatch = Dispatch.parse(await created.json());
    const accepted = await request(`/api/runners/${runner.id}/dispatches/${dispatch.id}/accept`, {
      method: "POST",
      token: host.credential,
    });
    await expectProblem(accepted, 409, "issue_not_dispatchable");

    const [settled] = await database.db
      .select({ state: runnerDispatches.state })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(settled?.state).toBe("ended");

    // Once the issue returns to `todo`, a fresh dispatch succeeds.
    await database.db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue.id));
    const retried = await createDispatch(issue.id, runner.id, adminCookie);
    expect(retried.status).toBe(201);
  });

  it("rejects a second manual dispatch while a pending dispatch is already in flight", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("no duplicate pending dispatch");

    const first = await createDispatch(issue.id, runner.id, adminCookie);
    expect(first.status).toBe(201);

    const second = await createDispatch(issue.id, runner.id, adminCookie);
    await expectProblem(second, 409, "issue_not_claimable");
  });

  it("reports a dispatch as ended once its work session stops", async () => {
    const { issue, acceptance } = await acceptedFixture();
    const stopped = await request(`/api/issues/${issue.id}/work-sessions/stop`, {
      method: "POST",
      token: acceptance.dispatchToken,
      body: { outcome: "review", sessionId: acceptance.session.id },
    });
    expect(stopped.status).toBe(200);
    const list = await request(`/api/issues/${issue.id}/dispatches`, { cookie: adminCookie });
    expect(list.status).toBe(200);
    const dispatches = field(await list.json(), "dispatches");
    const first = Array.isArray(dispatches) ? dispatches[0] : undefined;
    expect(field(first, "state")).toBe("ended");
  });
});

describe("custom dispatch prompt (#239)", () => {
  it("trims and persists a prompt, then returns it to project readers", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("custom prompt issue");
    const prompt = "  Use an additive migration and add a regression test.  ";

    const created = await createDispatch(issue.id, runner.id, adminCookie, undefined, prompt);
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.prompt).toBe("Use an additive migration and add a regression test.");

    const [row] = await database.db
      .select({ prompt: runnerDispatches.prompt })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row?.prompt).toBe("Use an additive migration and add a regression test.");

    const reader = await insertHuman(`reader-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: reader.id,
      isOwner: false,
    });
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId,
      humanId: reader.id,
      level: "read",
      grantedByHumanId: adminHumanId,
    });
    const list = await request(`/api/issues/${issue.id}/dispatches`, {
      cookie: await browserCookie(reader.id),
    });
    expect(list.status).toBe(200);
    expect(one(Dispatch.array().parse(field(await list.json(), "dispatches"))).prompt).toBe(
      "Use an additive migration and add a regression test.",
    );

    const outsider = await insertHuman(`outsider-${randomUUID()}@example.com`);
    await expectProblem(
      await request(`/api/issues/${issue.id}/dispatches`, {
        cookie: await browserCookie(outsider.id),
      }),
      404,
      "issue_not_found",
    );
  });

  it("treats a blank prompt as omitted", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("blank prompt issue");

    const created = await createDispatch(issue.id, runner.id, adminCookie, undefined, "   \n  ");
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    // The published API keeps prompt required-nullable: omitted becomes null.
    expect(dispatch.prompt).toBeNull();
    const [row] = await database.db
      .select({ prompt: runnerDispatches.prompt })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row?.prompt).toBeNull();
  });

  it("persists and delivers a prompt on a one-shot Runner dispatch", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("one-shot prompt issue");
    const prompt = "  Keep the change additive and add a rollback note.  ";

    const created = await request(`/api/runners/${runner.id}/dispatches`, {
      method: "POST",
      token: host.credential,
      body: { issueId: issue.id, prompt },
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.prompt).toBe("Keep the change additive and add a rollback note.");

    const [row] = await database.db
      .select({ prompt: runnerDispatches.prompt })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row?.prompt).toBe("Keep the change additive and add a rollback note.");
    const [command] = await database.db
      .select({ payload: runnerCommands.payload })
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, runner.id));
    expect(command?.payload).toMatchObject({
      dispatchId: dispatch.id,
      prompt: "Keep the change additive and add a rollback note.",
    });
  });

  it("rejects a prompt longer than 16,000 characters with a Problem Details error", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("oversized prompt issue");

    const rejected = await createDispatch(
      issue.id,
      runner.id,
      adminCookie,
      undefined,
      "x".repeat(16_001),
    );
    const rejectedCopy = rejected.clone();
    await expectProblem(rejected, 400, "validation_failed");
    expect(Problem.parse(await rejectedCopy.json()).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer: "/prompt" })]),
    );
    expect(await dispatchRowsCount(runner.id)).toBe(0);
  });
});

describe("per-dispatch harness, model and effort (#241)", () => {
  it("trims, persists and exposes the options to readers and the outbox", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("dispatch options issue");

    const created = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {
      harness: "  opencode  ",
      model: "  stub-model-1  ",
      effort: "  high  ",
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch).toMatchObject({ harness: "opencode", model: "stub-model-1", effort: "high" });

    const [row] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row).toMatchObject({ harness: "opencode", model: "stub-model-1", effort: "high" });

    const [command] = await database.db
      .select({ payload: runnerCommands.payload })
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, runner.id));
    expect(command?.payload).toMatchObject({
      dispatchId: dispatch.id,
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });

    const reader = await insertHuman(`reader-${randomUUID()}@example.com`);
    await database.db.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId,
      humanId: reader.id,
      isOwner: false,
    });
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId,
      humanId: reader.id,
      level: "read",
      grantedByHumanId: adminHumanId,
    });
    const list = await request(`/api/issues/${issue.id}/dispatches`, {
      cookie: await browserCookie(reader.id),
    });
    expect(list.status).toBe(200);
    expect(one(Dispatch.array().parse(field(await list.json(), "dispatches")))).toMatchObject({
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });
  });

  it("treats blank options as omitted", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("blank options issue");

    const created = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {
      harness: "  ",
      model: "\n",
      effort: "",
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.harness).toBeUndefined();
    expect(dispatch.model).toBeUndefined();
    expect(dispatch.effort).toBeUndefined();
    const [row] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row?.harness).toBeNull();
    expect(row?.model).toBeNull();
    expect(row?.effort).toBeNull();
  });

  it("rejects a harness absent from a non-empty published catalog", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential, defaultAgentId, testCatalog);
    const issue = await createIssue("unknown harness issue");

    await expectProblem(
      await createDispatchWithOptions(issue.id, runner.id, adminCookie, { harness: "cursor" }),
      400,
      "unknown_harness",
    );
    expect(await dispatchRowsCount(runner.id)).toBe(0);

    const accepted = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {
      harness: "opencode",
    });
    expect(accepted.status).toBe(201);
  });

  it("allows any harness while the published catalog is empty", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("uncatalogued harness issue");

    const created = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {
      harness: "a-future-harness",
    });
    expect(created.status).toBe(201);
    expect(Dispatch.parse(await created.json()).harness).toBe("a-future-harness");
  });

  it("records the chosen harness and model on the Run, falling back when omitted", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const chosenIssue = await createIssue("chosen run issue");
    const created = await createDispatchWithOptions(chosenIssue.id, runner.id, adminCookie, {
      harness: "codex",
      model: "stub-model-2",
      effort: "high",
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    const accepted = await request(`/api/runners/${runner.id}/dispatches/${dispatch.id}/accept`, {
      method: "POST",
      token: host.credential,
    });
    expect(accepted.status).toBe(200);
    const acceptance = DispatchAcceptance.parse(await accepted.json());
    expect(acceptance.run).toMatchObject({ harness: "codex", model: "stub-model-2" });
    const [runRow] = await database.db.select().from(runs).where(eq(runs.id, acceptance.run.id));
    expect(runRow).toMatchObject({ harness: "codex", model: "stub-model-2" });

    const fallbackIssue = await createIssue("fallback run issue");
    const fallbackCreated = await createDispatchWithOptions(
      fallbackIssue.id,
      runner.id,
      adminCookie,
      {},
    );
    expect(fallbackCreated.status).toBe(201);
    const fallbackDispatch = Dispatch.parse(await fallbackCreated.json());
    const fallbackAccepted = await request(
      `/api/runners/${runner.id}/dispatches/${fallbackDispatch.id}/accept`,
      { method: "POST", token: host.credential },
    );
    expect(fallbackAccepted.status).toBe(200);
    expect(DispatchAcceptance.parse(await fallbackAccepted.json()).run).toMatchObject({
      harness: "opencode",
      model: null,
    });
  });

  it("records registered CLI defaults on UI dispatches without explicit choices", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential, defaultAgentId, undefined, {
      harness: "  opencode  ",
      model: "stub-model-1",
      effort: "high",
    });
    const issue = await createIssue("UI dispatch with runner defaults");

    const created = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {});
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch).toMatchObject({
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });
    const [row] = await database.db
      .select()
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row).toMatchObject({ harness: "opencode", model: "stub-model-1", effort: "high" });
    const [command] = await database.db
      .select({ payload: runnerCommands.payload })
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, runner.id));
    expect(command?.payload).toMatchObject({
      dispatchId: dispatch.id,
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });

    // The Run is created from the Dispatch, so it records the same effective
    // choices instead of a fallback harness and a null model.
    const accepted = await request(`/api/runners/${runner.id}/dispatches/${dispatch.id}/accept`, {
      method: "POST",
      token: host.credential,
    });
    expect(accepted.status).toBe(200);
    const acceptance = DispatchAcceptance.parse(await accepted.json());
    expect(acceptance.run).toMatchObject({ harness: "opencode", model: "stub-model-1" });
    const [runRow] = await database.db.select().from(runs).where(eq(runs.id, acceptance.run.id));
    expect(runRow).toMatchObject({ harness: "opencode", model: "stub-model-1" });

    // An explicit per-field choice wins; the other fields still come from the
    // Runner's registered defaults.
    const overrideIssue = await createIssue("UI dispatch with an explicit model");
    const overridden = await createDispatchWithOptions(overrideIssue.id, runner.id, adminCookie, {
      model: "stub-model-2",
    });
    expect(Dispatch.parse(await overridden.json())).toMatchObject({
      harness: "opencode",
      model: "stub-model-2",
      effort: "high",
    });
  });

  it("never inherits another Harness's model and effort across a harness boundary", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential, defaultAgentId, undefined, {
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });
    const issue = await createIssue("cross-harness defaults");
    const created = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {
      harness: "codex",
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.harness).toBe("codex");
    expect(dispatch.model).toBeUndefined();
    expect(dispatch.effort).toBeUndefined();
    const [row] = await database.db
      .select({
        harness: runnerDispatches.harness,
        model: runnerDispatches.model,
        effort: runnerDispatches.effort,
      })
      .from(runnerDispatches)
      .where(eq(runnerDispatches.id, dispatch.id));
    expect(row).toMatchObject({ harness: "codex", model: null, effort: null });
    const [command] = await database.db
      .select({ payload: runnerCommands.payload })
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, runner.id));
    expect(command?.payload).toMatchObject({ dispatchId: dispatch.id, harness: "codex" });
    expect(field(command?.payload, "model")).toBeUndefined();
    expect(field(command?.payload, "effort")).toBeUndefined();

    // Defaults without a harness belong to no Harness: an explicit Harness
    // still must not inherit their model.
    const other = await registerRunner(host.credential, defaultAgentId, undefined, {
      model: "stub-model-1",
    });
    const otherIssue = await createIssue("explicit harness without default harness");
    const otherCreated = await createDispatchWithOptions(otherIssue.id, other.id, adminCookie, {
      harness: "codex",
    });
    expect(otherCreated.status).toBe(201);
    const otherDispatch = Dispatch.parse(await otherCreated.json());
    expect(otherDispatch.harness).toBe("codex");
    expect(otherDispatch.model).toBeUndefined();
  });

  it("ignores execution choices supplied by a human instead of the Runner host", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential, defaultAgentId, undefined, {
      harness: "opencode",
      model: "stub-model-1",
    });
    const issue = await createIssue("human cannot set runner defaults");
    const created = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      cookie: adminCookie,
      body: {
        runnerId: runner.id,
        defaults: { harness: "unauthorised", model: "unauthorised" },
      },
    });
    expect(created.status).toBe(201);
    expect(Dispatch.parse(await created.json())).toMatchObject({
      harness: "opencode",
      model: "stub-model-1",
    });
    expect(await dispatchRowsCount(runner.id)).toBe(1);
  });

  it("records registered defaults on an auto-claimed dispatch", async () => {
    const host = await enrollHost(adminCookie);
    // A dedicated project keeps the claim deterministic (the shared project
    // has issues from earlier cases in this suite).
    const [autoProject] = await database.db
      .insert(projects)
      .values({
        id: randomUUID(),
        workspaceId,
        name: "Auto-claim defaults",
        key: `AD${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        createdByHumanId: adminHumanId,
      })
      .returning();
    const autoProjectId = autoProject!.id;
    const runnerResponse = await request("/api/runners/register", {
      method: "POST",
      token: host.credential,
      body: {
        workspaceId,
        projectId: autoProjectId,
        agentId: defaultAgentId,
        repoFingerprint: fingerprint,
        defaults: { harness: "opencode", model: "stub-model-1", effort: "high" },
      },
    });
    expect(runnerResponse.status).toBe(201);
    const runner = Runner.parse(await runnerResponse.json());
    expect(runner.defaults).toEqual({
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });
    const issue = await request(`/api/projects/${autoProjectId}/issues`, {
      method: "POST",
      cookie: adminCookie,
      body: { title: "auto-claimed with defaults" },
    });
    expect(issue.status).toBe(201);
    const issueId = Issue.parse(await issue.json()).id;

    const claimed = await request(`/api/runners/${runner.id}/auto-claim`, {
      method: "POST",
      token: host.credential,
      body: { filter: "all" },
    });
    expect(claimed.status).toBe(200);
    const dispatch = Dispatch.parse(field(await claimed.json(), "dispatch"));
    expect(dispatch.issueId).toBe(issueId);
    expect(dispatch).toMatchObject({
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });
    const [command] = await database.db
      .select({ payload: runnerCommands.payload })
      .from(runnerCommands)
      .where(eq(runnerCommands.runnerId, runner.id));
    expect(command?.payload).toMatchObject({
      dispatchId: dispatch.id,
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
    });
  });

  it("clears stale defaults when a Runner re-registers without CLI flags", async () => {
    const host = await enrollHost(adminCookie);
    await registerRunner(host.credential, defaultAgentId, undefined, {
      harness: "opencode",
      model: "stub-model-1",
    });
    const runner = await registerRunner(host.credential);
    expect(runner.defaults).toEqual({});
    const issue = await createIssue("no stale defaults");
    const created = await createDispatchWithOptions(issue.id, runner.id, adminCookie, {});
    const dispatch = Dispatch.parse(await created.json());
    expect(dispatch.harness).toBeUndefined();
    expect(dispatch.model).toBeUndefined();
  });
});

async function dispatchRowsCount(runnerId: string) {
  const rows = await database.db
    .select({ id: runnerDispatches.id })
    .from(runnerDispatches)
    .where(and(eq(runnerDispatches.runnerId, runnerId)));
  return rows.length;
}

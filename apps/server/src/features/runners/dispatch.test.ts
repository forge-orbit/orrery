import { randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Attachment,
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
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

async function registerRunner(credential: string, agent = defaultAgentId) {
  const res = await request("/api/runners/register", {
    method: "POST",
    body: { workspaceId, projectId, agentId: agent, repoFingerprint: fingerprint },
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
) {
  return request(`/api/issues/${issueId}/dispatches`, {
    method: "POST",
    body: { runnerId, ...(overrideAgentId === undefined ? {} : { agentId: overrideAgentId }) },
    cookie,
  });
}

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

  it("bounds prompts in Unicode code points, matching Postgres char_length", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("emoji prompt boundary");
    const emoji = "🙂"; // one code point, two UTF-16 units
    const atLimit = emoji.repeat(16_000);

    const accepted = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: `  ${atLimit}  ` },
      cookie: adminCookie,
    });
    expect(accepted.status).toBe(201);
    expect(Dispatch.parse(await accepted.json()).prompt).toBe(atLimit);

    const over = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: emoji.repeat(16_001) },
      cookie: adminCookie,
    });
    await expectProblem(over, 400, "validation_failed");
  });

  it("hides a trashed issue's prompt from the single-Dispatch endpoint", async () => {
    const host = await enrollHost(adminCookie);
    const runner = await registerRunner(host.credential);
    const issue = await createIssue("trashed prompt issue");
    const created = await request(`/api/issues/${issue.id}/dispatches`, {
      method: "POST",
      body: { runnerId: runner.id, prompt: "secret prompt" },
      cookie: adminCookie,
    });
    expect(created.status).toBe(201);
    const dispatch = Dispatch.parse(await created.json());

    const readable = await request(`/api/runners/dispatches/${dispatch.id}`, {
      cookie: adminCookie,
    });
    expect(readable.status).toBe(200);
    expect(Dispatch.parse(await readable.json()).prompt).toBe("secret prompt");

    await database.db
      .update(issues)
      .set({ deletedAt: sql`statement_timestamp()`, deletedByHumanId: adminHumanId })
      .where(eq(issues.id, issue.id));

    await expectProblem(
      await request(`/api/runners/dispatches/${dispatch.id}`, { cookie: adminCookie }),
      404,
      "dispatch_not_found",
    );
    const list = await request(`/api/issues/${issue.id}/dispatches`, { cookie: adminCookie });
    expect(list.status).toBe(404);
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

async function promptedFixture() {
  const host = await enrollHost(adminCookie);
  const runner = await registerRunner(host.credential);
  const issue = await createIssue(`single-dispatch-acl-${randomUUID()}`);
  const created = await request(`/api/issues/${issue.id}/dispatches`, {
    method: "POST",
    body: { runnerId: runner.id, prompt: "restricted prompt" },
    cookie: adminCookie,
  });
  expect(created.status).toBe(201);
  return { host, runner, issue, dispatch: Dispatch.parse(await created.json()) };
}

const readAsHost = (credential: string, dispatchId: string) =>
  request(`/api/runners/dispatches/${dispatchId}`, { token: credential });

const readAsOwner = (dispatchId: string) =>
  request(`/api/runners/dispatches/${dispatchId}`, { cookie: adminCookie });

async function addSecondOwner() {
  const other = await insertHuman(`second-owner-${randomUUID()}@example.com`);
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId: other.id,
    isOwner: true,
  });
  return other;
}

describe("single-Dispatch live access boundary (#239/#257)", () => {
  it("answers an anonymous read with 401 while the owner still sees the prompt", async () => {
    const { dispatch } = await promptedFixture();
    await expectProblem(
      await request(`/api/runners/dispatches/${dispatch.id}`),
      401,
      "invalid_credential",
    );
    const owner = await readAsOwner(dispatch.id);
    expect(owner.status).toBe(200);
    expect(Dispatch.parse(await owner.json()).prompt).toBe("restricted prompt");
  });

  it("refuses a revoked Runner's host credential with a non-enumerating 404", async () => {
    const { host, runner, dispatch } = await promptedFixture();
    expect((await readAsHost(host.credential, dispatch.id)).status).toBe(200);
    await database.db
      .update(runners)
      .set({ revokedAt: sql`statement_timestamp()` })
      .where(eq(runners.id, runner.id));
    await expectProblem(await readAsHost(host.credential, dispatch.id), 404, "dispatch_not_found");
    expect((await readAsOwner(dispatch.id)).status).toBe(200);
  });

  it("refuses a host whose owner lost workspace membership", async () => {
    const { host, dispatch } = await promptedFixture();
    expect((await readAsHost(host.credential, dispatch.id)).status).toBe(200);
    await addSecondOwner();
    await database.db
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, adminHumanId),
        ),
      );
    await expectProblem(await readAsHost(host.credential, dispatch.id), 404, "dispatch_not_found");
    await expectProblem(await readAsOwner(dispatch.id), 404, "dispatch_not_found");
  });

  it("refuses a host whose owner lost project Read", async () => {
    const { host, dispatch } = await promptedFixture();
    expect((await readAsHost(host.credential, dispatch.id)).status).toBe(200);
    // A demoted member without an explicit grant has no project access.
    await addSecondOwner();
    await database.db
      .update(workspaceMemberships)
      .set({ isOwner: false })
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, adminHumanId),
        ),
      );
    await expectProblem(await readAsHost(host.credential, dispatch.id), 404, "dispatch_not_found");
    await expectProblem(await readAsOwner(dispatch.id), 404, "dispatch_not_found");
  });

  it("hides a trashed project's Dispatch prompt from both host and owner", async () => {
    const { host, dispatch } = await promptedFixture();
    expect((await readAsHost(host.credential, dispatch.id)).status).toBe(200);
    await database.db
      .update(projects)
      .set({ deletedAt: sql`statement_timestamp()`, deletedByHumanId: adminHumanId })
      .where(eq(projects.id, projectId));
    await expectProblem(await readAsHost(host.credential, dispatch.id), 404, "dispatch_not_found");
    await expectProblem(await readAsOwner(dispatch.id), 404, "dispatch_not_found");
  });
});

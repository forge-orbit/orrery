import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const ids = (data: Record<string, unknown>) =>
  asArray(field(data, "issues")).map((item) => field(item, "id"));

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const personal = asArray(await res.json()).find(
    (workspace) => field(workspace, "kind") === "personal",
  );
  return requiredText(field(personal, "id"), "the personal workspace id");
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name } });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the agent id");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(res.status()).toBe(201);
  const secret = requiredText(field(await res.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

async function project(client: APIRequestContext, workspaceId: string): Promise<string> {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Session project ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return requiredText(field(await res.json(), "id"), "the project id");
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: `orrery-sessions-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

type CallResult = { isError: boolean; data: Record<string, unknown> };

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
}

async function newRun(client: Client): Promise<string> {
  const result = await call(client, "orrery_run_checkin", {
    event: "run_started",
    runKey: { harness: "codex", nativeSessionId: randomUUID() },
  });
  expect(result.isError).toBe(false);
  return requiredText(field(result.data, "runId"), "the run id");
}

const bearer = (secret: string) => ({
  patch: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  post: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  get: (path: string) =>
    fetch(new URL(path, baseUrl), { headers: { authorization: `Bearer ${secret}` } }),
  del: (path: string) =>
    fetch(new URL(path, baseUrl), {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    }),
});

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

test("fenced writes need a live session; reads, creation, comments and knowledge do not", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-writer-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Fenced issue" });
    expect(created.isError).toBe(false);
    const issue = asRecord(created.data.issue);
    const issueId = requiredText(field(issue, "id"), "the issue id");

    expect((await call(client, "get_issue", { issueId })).isError).toBe(false);
    expect((await call(client, "list_issues", { projectId })).isError).toBe(false);
    expect(
      (await call(client, "create_comment", { issueId, body: "No claim needed" })).isError,
    ).toBe(false);
    const knowledge = await call(client, "create_knowledge", { projectId, title: "Free note" });
    const entryId = requiredText(field(knowledge.data.entry, "id"), "the knowledge id");
    expect((await call(client, "update_knowledge", { entryId, body: "Still free" })).isError).toBe(
      false,
    );
    expect((await call(client, "ready_work", { projectId })).isError).toBe(false);

    const unfencedMcp = await call(client, "update_issue", { issueId, title: "No session" });
    expect(unfencedMcp.isError).toBe(true);
    expect(unfencedMcp.data).toMatchObject({ code: "session_required" });
    const unfencedRest = await http.patch(`/api/issues/${issueId}`, { title: "No session" });
    expect(unfencedRest.status).toBe(409);
    expect(asRecord(await unfencedRest.json())).toMatchObject({ code: "session_required" });

    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    expect(field(claim.data.session, "status")).toBe("active");
    expect((await call(client, "update_issue", { issueId, title: "With a session" })).isError).toBe(
      false,
    );
    expect((await call(client, "renew_claim", { issueId })).isError).toBe(false);
    const progress = await call(client, "report_progress", { issueId, summary: "Halfway" });
    expect(progress.isError).toBe(false);
    expect(field(progress.data.session, "progress")).toBe("Halfway");
    const stopped = await call(client, "stop_session", { issueId, outcome: "completed" });
    expect(stopped.isError).toBe(false);
    expect(field(stopped.data.session, "status")).toBe("completed");

    const readBack = await call(client, "get_work_session", { issueId });
    expect(field(readBack.data.session, "progress")).toBe("Halfway");
    const afterStop = await call(client, "update_issue", { issueId, title: "After stop" });
    expect(afterStop.isError).toBe(true);
    expect(afterStop.data).toMatchObject({ code: "session_required" });

    const restIssue = await call(client, "create_issue", { projectId, title: "REST session" });
    const restIssueId = requiredText(field(restIssue.data.issue, "id"), "the REST issue id");
    const restRun = await newRun(client);
    const restClaim = await http.post(`/api/issues/${restIssueId}/work-sessions`, {
      runId: restRun,
    });
    expect(restClaim.status).toBe(201);

    expect(asRecord(await restClaim.json())).toMatchObject({ status: "active" });
    const restProgress = await http.post(`/api/issues/${restIssueId}/work-sessions/progress`, {
      summary: "REST progress",
    });
    expect(restProgress.status).toBe(200);
    expect(asRecord(await restProgress.json())).toMatchObject({ progress: "REST progress" });
    const restEdit = await http.patch(`/api/issues/${restIssueId}`, { title: "REST edit" });
    expect(restEdit.status).toBe(200);
    const restStop = await http.post(`/api/issues/${restIssueId}/work-sessions/stop`, {
      outcome: "released",
    });
    expect(restStop.status).toBe(200);
    expect(asRecord(await restStop.json())).toMatchObject({ status: "released" });
    const restReady = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReady.status).toBe(200);
    const readyRows = await restReady.json();
    expect(Array.isArray(readyRows)).toBe(true);
  } finally {
    await client.close();
  }
});

test("a human stop request reaches the agent on renew and progress and is recorded in history", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-stop-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Stop me" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    expect(field(claim.data.session, "stopRequested")).toBe(false);

    const denied = await http.post(`/api/issues/${issueId}/work-sessions/stop-request`, {
      reason: "self",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain("application/problem+json");
    expect(asRecord(await denied.json())).toMatchObject({
      code: "agents_cannot_request_stop",
      status: 403,
    });

    const requested = await api.post(`/api/issues/${issueId}/work-sessions/stop-request`, {
      data: { reason: "Wrong direction" },
    });
    expect(requested.status()).toBe(200);
    expect(asRecord(await requested.json())).toMatchObject({
      status: "active",
      stopRequested: true,
      stopReason: "Wrong direction",
    });

    const renewed = await call(client, "renew_claim", { issueId });
    expect(renewed.isError).toBe(false);
    expect(field(renewed.data.session, "stopRequested")).toBe(true);
    expect(field(renewed.data.session, "stopReason")).toBe("Wrong direction");
    const progressed = await call(client, "report_progress", {
      issueId,
      summary: "Handoff written",
    });
    expect(progressed.isError).toBe(false);
    expect(field(progressed.data.session, "stopRequested")).toBe(true);

    const current = await api.get(`/api/issues/${issueId}/work-sessions`);
    expect(current.status()).toBe(200);
    expect(asRecord(await current.json())).toMatchObject({ stopRequested: true });
    const activity = await api.get(`/api/projects/${projectId}/activity`);
    expect(activity.status()).toBe(200);
    expect(
      asArray(await activity.json()).some(
        (event) =>
          field(event, "type") === "issue_stop_requested" &&
          field(event, "summary") === "Wrong direction",
      ),
    ).toBe(true);

    const stopped = await call(client, "stop_session", { issueId, outcome: "released" });
    expect(stopped.isError).toBe(false);
    expect(field(stopped.data.session, "status")).toBe("released");
    expect(field(stopped.data.session, "stopRequested")).toBe(true);
  } finally {
    await client.close();
  }
});

test("clicking Stop agent in the browser transitions the session badge to stopping", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-browser-stop-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  let context;
  try {
    const created = await call(client, "create_issue", { projectId, title: "Browser stop issue" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const runId = await newRun(client);
    expect((await call(client, "claim_issue", { issueId, runId })).isError).toBe(false);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
    await page.goto(`/issues/${issueId}`);

    const badge = page.locator("[data-session-status]");
    await expect(badge).toHaveText("active");
    await page.getByLabel("Reason (optional)").fill("Browser reason");
    await page.getByRole("button", { name: "Stop agent" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Stop agent" }).click();
    await expect(badge).toHaveText("stopping");

    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    const agentsBadge = page.locator(
      `[data-agent-session-id][data-issue-id="${issueId}"] [data-session-status]`,
    );
    await expect(agentsBadge).toHaveText("stopping");

    const current = await api.get(`/api/issues/${issueId}/work-sessions`);
    expect(asRecord(await current.json())).toMatchObject({
      stopRequested: true,
      stopReason: "Browser reason",
    });
  } finally {
    if (context !== undefined) {
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      await context.close();
    }
    await client.close();
  }
});

test("ready work omits claimed issues and two claims yield one winner", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-racer-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const rival = await connect(secret);
  try {
    const first = await call(client, "create_issue", { projectId, title: "Raced issue" });
    const second = await call(client, "create_issue", { projectId, title: "Other issue" });
    const issueId = requiredText(field(first.data.issue, "id"), "the raced issue id");
    const otherId = requiredText(field(second.data.issue, "id"), "the other issue id");

    const before = await call(client, "ready_work", { projectId });
    expect(asArray(field(before.data, "issues")).map((item) => field(item, "id"))).toEqual(
      expect.arrayContaining([issueId, otherId]),
    );

    const runA = await newRun(client);
    const runB = await newRun(rival);
    const [claimA, claimB] = await Promise.all([
      call(client, "claim_issue", { issueId, runId: runA }),
      call(rival, "claim_issue", { issueId, runId: runB }),
    ]);
    expect([claimA.isError, claimB.isError].filter((failed) => !failed)).toHaveLength(1);
    const refused = claimA.isError ? claimA : claimB;
    expect(refused.data).toMatchObject({ code: "issue_claimed" });

    const after = await call(client, "ready_work", { projectId });
    expect(asArray(field(after.data, "issues")).map((item) => field(item, "id"))).not.toContain(
      issueId,
    );
    expect(asArray(field(after.data, "issues")).map((item) => field(item, "id"))).toContain(
      otherId,
    );
  } finally {
    await client.close();
    await rival.close();
  }
});

test("an open blocker hides ready work until it closes (REST and MCP)", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-deps-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const blocker = await call(client, "create_issue", { projectId, title: "Blocker A" });
    const blocked = await call(client, "create_issue", { projectId, title: "Blocked B" });
    const blockerId = requiredText(field(blocker.data.issue, "id"), "the blocker id");
    const blockedId = requiredText(field(blocked.data.issue, "id"), "the blocked issue id");

    const added = await call(client, "add_blocked_by", {
      issueId: blockedId,
      blockedByIssueId: blockerId,
    });
    expect(added.isError).toBe(false);
    expect(field(added.data.dependency, "blockedByIssueId")).toBe(blockerId);
    expect(ids((await call(client, "list_blocked_by", { issueId: blockedId })).data)).toContain(
      blockerId,
    );
    expect(ids((await call(client, "list_blocking", { issueId: blockerId })).data)).toContain(
      blockedId,
    );

    const restAdd = await http.post(`/api/issues/${blockedId}/blocked-by`, {
      blockedByIssueId: blockerId,
    });
    expect(restAdd.status).toBe(201);
    expect(asRecord(await restAdd.json())).toMatchObject({
      issueId: blockedId,
      blockedByIssueId: blockerId,
    });

    expect(ids((await call(client, "ready_work", { projectId })).data)).not.toContain(blockedId);
    const restReadyBlocked = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReadyBlocked.status).toBe(200);
    expect(asArray(await restReadyBlocked.json()).map((issue) => field(issue, "id"))).not.toContain(
      blockedId,
    );

    const closed = await api.patch(`/api/issues/${blockerId}`, { data: { status: "done" } });
    expect(closed.status()).toBe(200);
    expect(ids((await call(client, "ready_work", { projectId })).data)).toContain(blockedId);

    const restReady = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReady.status).toBe(200);
    expect(asArray(await restReady.json()).map((issue) => field(issue, "id"))).toContain(blockedId);

    const removed = await http.del(`/api/issues/${blockedId}/blocked-by/${blockerId}`);
    expect(removed.status).toBe(204);
    expect(ids((await call(client, "list_blocked_by", { issueId: blockedId })).data)).toEqual([]);
  } finally {
    await client.close();
  }
});

test("session activities stream into the issue sidecar without touching comments", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-activity-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  let context;
  try {
    const created = await call(client, "create_issue", { projectId, title: "Activity issue" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    expect(
      asArray(field((await call(client, "list_comments", { issueId })).data, "comments")),
    ).toEqual([]);

    const runId = await newRun(client);
    const claim = await call(client, "claim_issue", { issueId, runId });
    expect(claim.isError).toBe(false);
    const sessionId = requiredText(field(claim.data.session, "id"), "the session id");

    const thought = await call(client, "log_session_activity", {
      issueId,
      kind: "thought",
      summary: "Planning the fix",
      detail: { step: 1 },
    });
    expect(thought.isError).toBe(false);
    expect(field(thought.data.activity, "workSessionId")).toBe(sessionId);
    expect(field(thought.data.activity, "runId")).toBe(runId);
    expect(field(thought.data.activity, "detail")).toMatchObject({ step: 1 });
    const action = await call(client, "log_session_activity", {
      issueId,
      kind: "action",
      summary: "Edited service.ts",
    });
    expect(action.isError).toBe(false);

    const listed = await call(client, "list_session_activities", { issueId, sessionId });
    expect(listed.isError).toBe(false);
    expect(asArray(field(listed.data, "activities")).map((entry) => field(entry, "kind"))).toEqual([
      "action",
      "thought",
    ]);
    const restList = await http.get(`/api/issues/${issueId}/work-sessions/${sessionId}/activities`);
    expect(restList.status).toBe(200);
    expect(asArray(await restList.json()).map((entry) => field(entry, "summary"))).toEqual([
      "Edited service.ts",
      "Planning the fix",
    ]);
    expect(
      asArray(field((await call(client, "list_comments", { issueId })).data, "comments")),
    ).toEqual([]);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
    await page.goto(`/issues/${issueId}`);
    await page.getByRole("button", { name: "Show session inspector" }).click();
    const timeline = page.locator("[data-activity-timeline]");
    await expect(
      timeline.locator('[data-activity-kind="thought"] [data-activity-summary]'),
    ).toHaveText("Planning the fix", { timeout: 10_000 });
    await expect(
      timeline.locator('[data-activity-kind="action"] [data-activity-summary]'),
    ).toHaveText("Edited service.ts", { timeout: 10_000 });
    await expect(
      timeline.locator('[data-activity-kind="thought"] [data-activity-detail]'),
    ).toContainText('"step": 1', { timeout: 10_000 });

    const stopped = await call(client, "stop_session", { issueId, outcome: "completed" });
    expect(stopped.isError).toBe(false);
    const refused = await call(client, "log_session_activity", {
      issueId,
      kind: "status",
      summary: "After stop",
    });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ code: "session_required" });
    const afterStop = await call(client, "list_session_activities", { issueId, sessionId });
    expect(asArray(field(afterStop.data, "activities"))).toHaveLength(2);
  } finally {
    if (context !== undefined) {
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      await context.close();
    }
    await client.close();
  }
});

test("ready work is ordered by priority over REST and MCP", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-priority-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const low = await call(client, "create_issue", { projectId, title: "Low", priority: "low" });
    const urgent = await call(client, "create_issue", {
      projectId,
      title: "Urgent",
      priority: "urgent",
    });
    const plain = await call(client, "create_issue", { projectId, title: "None" });
    const highRest = await api.post(`/api/projects/${projectId}/issues`, {
      data: { title: "High", priority: "high" },
    });
    expect(highRest.status()).toBe(201);

    const lowId = requiredText(field(low.data.issue, "id"), "the low issue id");
    const urgentId = requiredText(field(urgent.data.issue, "id"), "the urgent issue id");
    const plainId = requiredText(field(plain.data.issue, "id"), "the plain issue id");
    const highId = requiredText(field(await highRest.json(), "id"), "the high issue id");

    const expected = [urgentId, highId, lowId, plainId];
    expect(ids((await call(client, "ready_work", { projectId })).data)).toEqual(expected);
    const restReady = await http.get(`/api/projects/${projectId}/ready-work`);
    expect(restReady.status).toBe(200);
    expect(asArray(await restReady.json()).map((issue) => field(issue, "id"))).toEqual(expected);

    const moved = await api.patch(`/api/issues/${lowId}`, { data: { priority: "urgent" } });
    expect(moved.status()).toBe(200);
    expect(ids((await call(client, "ready_work", { projectId })).data)).toEqual([
      lowId,
      urgentId,
      highId,
      plainId,
    ]);
  } finally {
    await client.close();
  }
});

test("assignment reserves work for the owner's agents across REST and MCP", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const projectRes = await api.get(`/api/projects/${projectId}`);
  expect(projectRes.status()).toBe(200);
  const humanId = requiredText(
    field(field(await projectRes.json(), "createdBy"), "humanId"),
    "the human id",
  );
  const agentA = await createAgent(api, `owner-agent-a-${randomUUID()}`);
  const agentB = await createAgent(api, `owner-agent-b-${randomUUID()}`);
  const secretA = await issueKey(api, agentA, workspaceId, projectId);
  const secretB = await issueKey(api, agentB, workspaceId, projectId);
  const clientA = await connect(secretA);
  const clientB = await connect(secretB);
  try {
    const created = await call(clientA, "create_issue", { projectId, title: "Reserved work" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const plain = await call(clientA, "create_issue", { projectId, title: "Free work" });
    const plainId = requiredText(field(plain.data.issue, "id"), "the free issue id");
    const assigned = await api.patch(`/api/issues/${issueId}`, {
      data: { assigneeHumanId: humanId },
    });
    expect(assigned.status()).toBe(200);
    // The assignee is a human summary only; no polymorphic agent shape survives.
    expect(field(await assigned.json(), "assignee")).toMatchObject({ humanId });

    // Both agents belong to the assigned human, so both may see and claim the issue.
    for (const client of [clientA, clientB]) {
      expect(ids((await call(client, "ready_work", { projectId })).data)).toEqual([
        issueId,
        plainId,
      ]);
      expect(
        ids((await call(client, "ready_work", { projectId, filter: "assignedToMe" })).data),
      ).toEqual([issueId]);
      expect(
        ids((await call(client, "ready_work", { projectId, filter: "unassigned" })).data),
      ).toEqual([plainId]);
    }

    expect(
      (await call(clientA, "claim_issue", { issueId, runId: await newRun(clientA) })).isError,
    ).toBe(false);
    const restRejected = await bearer(secretB).post(`/api/issues/${issueId}/work-sessions`, {
      runId: await newRun(clientB),
    });
    expect(restRejected.status).toBe(409);
    expect(asRecord(restRejected.body)).toMatchObject({ code: "issue_claimed" });
    const race = await call(clientB, "claim_issue", { issueId, runId: await newRun(clientB) });
    expect(race.isError).toBe(true);
    expect(race.data.code).toBe("issue_claimed");
  } finally {
    await clientA.close();
    await clientB.close();
  }
});

test("ready work narrows by every requested label, case-insensitively", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `label-agent-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  try {
    const makeLabel = async (name: string) => {
      const res = await api.post(`/api/projects/${projectId}/labels`, {
        data: { name, color: "#3366aa" },
      });
      expect(res.status()).toBe(201);
      return requiredText(field(await res.json(), "id"), "the label id");
    };
    const frontend = await makeLabel("Frontend");
    const urgent = await makeLabel("Urgent");

    const create = async (title: string, labelIds: string[]) => {
      const res = await api.post(`/api/projects/${projectId}/issues`, {
        data: { title, labelIds },
      });
      expect(res.status()).toBe(201);
      return requiredText(field(await res.json(), "id"), "the issue id");
    };
    const both = await create("Frontend and urgent", [frontend, urgent]);
    const frontendOnly = await create("Frontend only", [frontend]);
    await create("No labels", []);

    expect(
      ids((await call(client, "ready_work", { projectId, labels: ["frontend"] })).data),
    ).toEqual([both, frontendOnly]);
    expect(
      ids((await call(client, "ready_work", { projectId, labels: ["FRONTEND", "urgent"] })).data),
    ).toEqual([both]);

    const rest = await bearer(secret).get(
      `/api/projects/${projectId}/ready-work?labels=frontend&labels=URGENT`,
    );
    expect(rest.status).toBe(200);
    expect(asArray(await rest.json()).map((issue) => field(issue, "id"))).toEqual([both]);
  } finally {
    await client.close();
  }
});

test("an agent claims its owner's assigned issue and the human assignee survives", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `human-assignee-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Human owned" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    const projectRes = await api.get(`/api/projects/${projectId}`);
    expect(projectRes.status()).toBe(200);
    const humanId = requiredText(
      field(field(await projectRes.json(), "createdBy"), "humanId"),
      "the human id",
    );
    const assigned = await api.patch(`/api/issues/${issueId}`, {
      data: { assigneeHumanId: humanId },
    });
    expect(assigned.status()).toBe(200);
    const claimed = await call(client, "claim_issue", { issueId, runId: await newRun(client) });
    expect(claimed.isError).toBe(false);
    const detail = await call(client, "get_issue", { issueId });
    expect(field(detail.data.issue, "status")).toBe("in_progress");
    expect(field(detail.data.issue, "assignee")).toMatchObject({ humanId });
  } finally {
    await client.close();
  }
});

test("the board and agents panel show assignment, live session state and the sidecar", async ({
  browser,
}) => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentName = `board-agent-${randomUUID()}`;
  const agentId = await createAgent(api, agentName);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const projectRes = await api.get(`/api/projects/${projectId}`);
  expect(projectRes.status()).toBe(200);
  const adminHumanId = requiredText(
    field(field(await projectRes.json(), "createdBy"), "humanId"),
    "the admin human id",
  );
  const client = await connect(secret);
  let context;
  try {
    const created = await call(client, "create_issue", { projectId, title: "Board card" });
    const issueId = requiredText(field(created.data.issue, "id"), "the issue id");
    expect(
      (await call(client, "claim_issue", { issueId, runId: await newRun(client) })).isError,
    ).toBe(false);

    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    await page.goto(`/issues/${issueId}`);
    await page.getByRole("combobox", { name: "Assignee" }).click();
    // Human-only picker: the Agent that holds the live session is not an option.
    await expect(page.getByRole("option", { name: new RegExp(`^Agent ·`) })).toHaveCount(0);
    await page.getByRole("option", { name: `Human · ${ADMIN_EMAIL}`, exact: true }).click();
    await expect
      .poll(async () => {
        const res = await api.get(`/api/issues/${issueId}`);
        return field(await res.json(), "assignee");
      })
      .toMatchObject({ humanId: adminHumanId });

    await page.goto(`/board/${projectId}`);
    const card = page.locator(`[data-board-issue-id="${issueId}"]`);
    await expect(card).toHaveAttribute("data-assignee-type", "human");
    await expect(card.locator("[data-session-state]")).toHaveText("active");
    await expect(card).toContainText(agentName);
    await expect(card).toContainText(ADMIN_EMAIL);

    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    const sessionRow = page.locator(`[data-agent-session-id][data-issue-id="${issueId}"]`);
    await expect(sessionRow).toHaveAttribute("data-session-harness", "codex");
    await expect(sessionRow.locator("[data-sidecar-link]")).toBeVisible();
    await sessionRow.locator("[data-sidecar-link]").click();
    await expect(page.locator("[data-session-inspector]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide session inspector" })).toBeVisible();
  } finally {
    if (context !== undefined) {
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      await context.close();
    }
    await client.close();
  }
});

test("session transitions drive the six-state workflow over MCP and REST", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const projectId = await project(api, workspaceId);
  const agentId = await createAgent(api, `sessions-workflow-${randomUUID()}`);
  const secret = await issueKey(api, agentId, workspaceId, projectId);
  const client = await connect(secret);
  const http = bearer(secret);
  try {
    const created = await call(client, "create_issue", { projectId, title: "Workflow issue" });
    expect(created.isError).toBe(false);
    const issue = asRecord(created.data.issue);
    const issueId = requiredText(field(issue, "id"), "the issue id");
    expect(field(issue, "status")).toBe("todo");

    expect(ids((await call(client, "ready_work", { projectId })).data)).toContain(issueId);
    const claim = await call(client, "claim_issue", {
      issueId,
      runId: await newRun(client),
    });
    expect(claim.isError).toBe(false);
    expect(field((await call(client, "get_issue", { issueId })).data.issue, "status")).toBe(
      "in_progress",
    );

    const review = await call(client, "stop_session", { issueId });
    expect(review.isError).toBe(false);
    const reviewed = asRecord((await call(client, "get_issue", { issueId })).data.issue);
    expect(field(reviewed, "status")).toBe("review");
    expect(field(reviewed, "closedAt")).toBeNull();
    expect(ids((await call(client, "ready_work", { projectId })).data)).not.toContain(issueId);

    const dependent = await call(client, "create_issue", { projectId, title: "Dependent" });
    const dependentId = requiredText(field(dependent.data.issue, "id"), "the dependent id");
    const blocker = await call(client, "create_issue", { projectId, title: "Blocker" });
    const blockerId = requiredText(field(blocker.data.issue, "id"), "the blocker id");
    expect(
      (await call(client, "add_blocked_by", { issueId: dependentId, blockedByIssueId: blockerId }))
        .isError,
    ).toBe(false);
    const blockerRun = await newRun(client);
    expect(
      (await call(client, "claim_issue", { issueId: blockerId, runId: blockerRun })).isError,
    ).toBe(false);
    const done = await http.post(`/api/issues/${blockerId}/work-sessions/stop`, {
      outcome: "done",
    });
    expect(done.status).toBe(200);
    const closed = asRecord(await (await api.get(`/api/issues/${blockerId}`)).json());
    expect(field(closed, "status")).toBe("done");
    expect(field(closed, "closedAt")).not.toBeNull();
    expect(ids((await call(client, "ready_work", { projectId })).data)).toContain(dependentId);
  } finally {
    await client.close();
  }
});

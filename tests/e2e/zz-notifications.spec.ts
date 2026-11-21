import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

function requiredNumber(value: unknown, what: string): number {
  if (typeof value !== "number") throw new Error(`missing ${what}`);
  return value;
}

function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
}

function nullableText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, what);
}

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

interface NotificationFeed {
  items: { id: string; kind: string }[];
  unreadCount: number;
  nextCursor: string | null;
}

async function feed(client: APIRequestContext): Promise<NotificationFeed> {
  const res = await client.get("/api/notifications");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  const items = field(body, "items");
  if (!Array.isArray(items)) throw new Error("the notification feed has no items array");
  return {
    items: items.map((item) => ({
      id: idOf(item, "notification"),
      kind: requiredText(field(item, "kind"), "notification kind"),
    })),
    unreadCount: requiredNumber(field(body, "unreadCount"), "unread count"),
    nextCursor: nullableText(field(body, "nextCursor"), "next cursor"),
  };
}

let api: APIRequestContext;
let agentApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  agentApi = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await api?.dispose();
  await agentApi?.dispose();
});

test("notification creation, unread count, mark-read and mark-all-read", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Notifications e2e ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const issueRes = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Needs attention" },
  });
  expect(issueRes.status()).toBe(201);
  const issueId = idOf(await issueRes.json(), "issue");

  const agentRes = await api.post("/api/agents", {
    data: { name: `notifications-bot-${randomUUID()}` },
  });
  expect(agentRes.status()).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const keyBody: unknown = await keyRes.json();
  const secret = requiredText(field(keyBody, "secret"), "key secret");
  await recordSecret(secret);
  const bearer = { Authorization: `Bearer ${secret}` };

  const runRes = await agentApi.post("/api/runs/hook", {
    headers: bearer,
    data: {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "e2e", nativeSessionId: randomUUID() },
    },
  });
  expect(runRes.status()).toBe(200);
  const runId = requiredText(field(await runRes.json(), "runId"), "run id");

  const claim = await agentApi.post(`/api/issues/${issueId}/work-sessions`, {
    headers: bearer,
    data: { runId },
  });
  expect(claim.status()).toBe(201);

  const asked = await agentApi.post("/api/questions", {
    headers: bearer,
    data: { issueId, runId, question: "Which endpoint?", proposedFallback: "Use v1" },
  });
  expect(asked.status()).toBe(201);
  const questionId = idOf(await asked.json(), "question");

  await expect
    .poll(async () => (await feed(api)).unreadCount, { timeout: 15_000 })
    .toBeGreaterThan(0);
  let current = await feed(api);
  expect(current.items.some((item) => item.kind === "needs_input")).toBe(true);
  const countAfterQuestion = current.unreadCount;

  const answered = await api.post(`/api/questions/${questionId}/answer`, {
    data: { answer: "Use v2" },
  });
  expect(answered.status()).toBe(200);

  const stop = await agentApi.post(`/api/issues/${issueId}/work-sessions/stop`, {
    headers: bearer,
    data: { outcome: "review" },
  });
  expect(stop.status()).toBe(200);

  await expect
    .poll(async () => (await feed(api)).unreadCount, { timeout: 15_000 })
    .toBeGreaterThan(countAfterQuestion);
  current = await feed(api);
  expect(current.items.some((item) => item.kind === "handoff")).toBe(true);

  const unread = await api.get("/api/notifications?unreadOnly=true");
  expect(unread.status()).toBe(200);
  const unreadBody: unknown = await unread.json();
  expect(requiredNumber(field(unreadBody, "unreadCount"), "unread count")).toBe(
    current.unreadCount,
  );

  const target = current.items[0]!.id;
  const mark = await api.post(`/api/notifications/${target}/read`, { data: {} });
  expect(mark.status()).toBe(204);
  const markAgain = await api.post(`/api/notifications/${target}/read`, { data: {} });
  expect(markAgain.status()).toBe(204);
  expect((await feed(api)).unreadCount).toBe(current.unreadCount - 1);

  const readAll = await api.post("/api/notifications/read-all", { data: {} });
  expect(readAll.status()).toBe(200);
  const readAllBody: unknown = await readAll.json();
  expect(requiredNumber(field(readAllBody, "markedCount"), "marked count")).toBeGreaterThan(0);
  expect((await feed(api)).unreadCount).toBe(0);
});

test("agent keys receive 403 on every notification endpoint", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Notifications denied ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentRes = await api.post("/api/agents", {
    data: { name: `notifications-denied-${randomUUID()}` },
  });
  expect(agentRes.status()).toBe(201);
  const agentId = idOf(await agentRes.json(), "agent");
  const keyRes = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "read" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const keyBody: unknown = await keyRes.json();
  const secret = requiredText(field(keyBody, "secret"), "key secret");
  await recordSecret(secret);
  const headers = { Authorization: `Bearer ${secret}` };

  // agentApi has no human session cookie, proving the bearer key alone decides the answer.
  const listed = await agentApi.get("/api/notifications", { headers });
  expect(listed.status()).toBe(403);
  expect(await listed.json()).toMatchObject({
    status: 403,
    code: "agents_cannot_use_notifications",
  });

  const read = await agentApi.post(`/api/notifications/${randomUUID()}/read`, {
    headers,
    data: {},
  });
  expect(read.status()).toBe(403);
  const readAll = await agentApi.post("/api/notifications/read-all", { headers, data: {} });
  expect(readAll.status()).toBe(403);

  const invalid = await agentApi.get("/api/notifications", {
    headers: { Authorization: "Bearer not-a-real-key" },
  });
  expect(invalid.status()).toBe(401);
});

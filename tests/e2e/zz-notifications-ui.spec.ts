import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
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

function requiredNullableText(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, what);
}

function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
}

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

interface FeedItem {
  id: string;
  kind: string;
  summary: string;
  issueId: string;
  identifier: string;
  readAt: string | null;
}

async function feed(
  client: APIRequestContext,
): Promise<{ items: FeedItem[]; unreadCount: number }> {
  const res = await client.get("/api/notifications?limit=100");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  const items = field(body, "items");
  if (!Array.isArray(items)) throw new Error("the notification feed has no items array");
  return {
    items: items.map((item) => {
      const issue = field(item, "issue");
      return {
        id: idOf(item, "notification"),
        kind: requiredText(field(item, "kind"), "notification kind"),
        summary: requiredText(field(item, "summary"), "notification summary"),
        issueId: idOf(issue, "notification issue"),
        identifier: requiredText(field(issue, "identifier"), "issue identifier"),
        readAt: requiredNullableText(field(item, "readAt"), "notification read time"),
      };
    }),
    unreadCount: requiredNumber(field(body, "unreadCount"), "unread count"),
  };
}

function notificationsNav(page: Page) {
  return page.locator("aside.app-sidebar [data-notifications-link]");
}

async function badgeCount(page: Page): Promise<number> {
  const text = (await notificationsNav(page).innerText()).replace("Notifications", "");
  const digits = text.match(/\d+/);
  return digits === null ? 0 : Number(digits[0] ?? 0);
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

test("sidebar badge, notification rows, mark-read, and mark-all-read", async ({ browser }) => {
  test.setTimeout(90_000);
  // Other e2e specs use the same administrator, so begin from a known unread count.
  expect((await api.post("/api/notifications/read-all", { data: {} })).status()).toBe(200);

  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Notifications UI ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");

  const issueRes = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: `Needs attention ${randomUUID()}` },
  });
  expect(issueRes.status()).toBe(201);
  const issueBody: unknown = await issueRes.json();
  const issueId = idOf(issueBody, "issue");
  const identifier = requiredText(field(issueBody, "identifier"), "issue identifier");
  const title = requiredText(field(issueBody, "title"), "issue title");

  const agentRes = await api.post("/api/agents", {
    data: { name: `notifications-ui-${randomUUID()}` },
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
  const secret = requiredText(field(await keyRes.json(), "secret"), "key secret");
  await recordSecret(secret);
  const headers = { Authorization: `Bearer ${secret}` };

  const runRes = await agentApi.post("/api/runs/hook", {
    headers,
    data: {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "e2e", nativeSessionId: randomUUID() },
    },
  });
  expect(runRes.status()).toBe(200);
  const runId = requiredText(field(await runRes.json(), "runId"), "run id");

  expect(
    (
      await agentApi.post(`/api/issues/${issueId}/work-sessions`, { headers, data: { runId } })
    ).status(),
  ).toBe(201);

  const question = `Which endpoint should we use ${randomUUID()}?`;
  const asked = await agentApi.post("/api/questions", {
    headers,
    data: { issueId, runId, question, proposedFallback: "Use v1" },
  });
  expect(asked.status()).toBe(201);
  const questionId = idOf(await asked.json(), "question");
  expect(
    (
      await api.post(`/api/questions/${questionId}/answer`, { data: { answer: "Use v2" } })
    ).status(),
  ).toBe(200);
  expect(
    (
      await agentApi.post(`/api/issues/${issueId}/work-sessions/stop`, {
        headers,
        data: { outcome: "review" },
      })
    ).status(),
  ).toBe(200);

  await expect
    .poll(
      async () => {
        const current = await feed(api);
        return current.items.filter((item) => item.issueId === issueId && item.readAt === null)
          .length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);
  const initial = await feed(api);
  const needsInput = initial.items.find(
    (item) => item.issueId === issueId && item.kind === "needs_input",
  );
  const handoff = initial.items.find((item) => item.issueId === issueId && item.kind === "handoff");
  if (needsInput === undefined || handoff === undefined)
    throw new Error("the expected needs_input and handoff notifications were not created");
  expect(needsInput.summary).toContain(question);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    const nav = notificationsNav(page);
    await expect(nav).toBeVisible();
    expect(await badgeCount(page)).toBeGreaterThan(0);

    await nav.click();
    await expect(page).toHaveURL(/\/notifications/);
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    const needsInputRow = page.locator(`[data-notification-id="${needsInput.id}"]`);
    const handoffRow = page.locator(`[data-notification-id="${handoff.id}"]`);
    await expect(needsInputRow).toContainText("Needs input");
    await expect(needsInputRow).toContainText(identifier);
    await expect(needsInputRow).toContainText(question);
    await expect(needsInputRow).toHaveAttribute("data-unread", "true");
    await expect(handoffRow).toContainText("Handoff");
    await expect(handoffRow).toContainText(identifier);

    await page.getByRole("link", { name: "Unread", exact: true }).click();
    await expect(page).toHaveURL(/unreadOnly=true/);
    await expect(needsInputRow).toBeVisible();

    const unreadBeforeClick = await badgeCount(page);
    await needsInputRow.click();
    await expect(page).toHaveURL(`/issues/${issueId}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect.poll(() => badgeCount(page)).toBeLessThan(unreadBeforeClick);
    await expect
      .poll(async () => (await feed(api)).items.find((item) => item.id === needsInput.id)?.readAt)
      .not.toBeNull();

    await nav.click();
    await expect(page).toHaveURL(/\/notifications/);
    await expect(needsInputRow).toHaveAttribute("data-unread", "false");
    await expect(handoffRow).toHaveAttribute("data-unread", "true");

    const markAll = page.getByRole("button", { name: "Mark all read" });
    await expect(markAll).toBeEnabled();
    await markAll.click();
    await expect(handoffRow).toHaveAttribute("data-unread", "false", { timeout: 15_000 });
    await expect(nav).toHaveText("Notifications", { timeout: 15_000 });
    await expect(markAll).toBeDisabled();

    await page.getByRole("link", { name: "Unread", exact: true }).click();
    await expect(page.getByRole("heading", { name: "You're all caught up" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Show all notifications" })).toBeVisible();
  } finally {
    for (const cookie of await context.cookies()) await recordSecret(cookie.value);
    await context.close();
  }
});

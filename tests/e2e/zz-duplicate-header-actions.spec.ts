import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = requiredText(process.env.ORRERY_URL, "ORRERY_URL");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SMTP_SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none" as const,
  username: null,
  password: null,
  from: "orrery@orrery.test",
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  // The invitation flow below sends real mail, so the catcher must be configured
  // before this file runs, not left to another spec in the same suite.
  expect((await api.put("/api/settings/smtp", { data: SMTP_SETTINGS })).status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

test.afterEach(async ({ page }) => {
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
  for (const cookie of (await api.storageState()).cookies) await recordSecret(cookie.value);
});

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
}

async function createWorkspace(name: string): Promise<string> {
  const created = await api.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "workspace");
}

async function createProject(
  client: APIRequestContext,
  workspaceId: string,
  name: string,
): Promise<string> {
  const created = await client.post(`/api/workspaces/${workspaceId}/projects`, { data: { name } });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "project");
}

async function createIssue(projectId: string, title: string): Promise<void> {
  const created = await api.post(`/api/projects/${projectId}/issues`, { data: { title } });
  expect(created.status()).toBe(201);
}

async function createKnowledge(projectId: string, title: string): Promise<string> {
  const created = await api.post(`/api/projects/${projectId}/knowledge`, { data: { title } });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "knowledge entry");
}

test("workspace Projects keeps one creation action only while its empty state is rendered", async ({
  page,
}) => {
  const workspaceId = await createWorkspace(`Duplicate CTA projects ${randomUUID()}`);
  await signIn(page);
  await page.goto(`/workspaces/${workspaceId}`);

  const projectsPanel = page.locator("#panel-projects");
  await expect(projectsPanel.getByText("No projects yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create project", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New project", exact: true })).toHaveCount(0);

  await projectsPanel.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Project name")).toHaveCount(0);

  await page.getByRole("tab", { name: /Agents/ }).click();
  await expect(page.getByRole("button", { name: "New project", exact: true })).toHaveCount(1);
  await page.getByRole("tab", { name: /Projects/ }).click();
  await expect(page.getByRole("button", { name: "New project", exact: true })).toHaveCount(0);

  const projectId = await createProject(api, workspaceId, `Populated CTA project ${randomUUID()}`);
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.locator(`[data-project-id="${projectId}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: "New project", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Create project", exact: true })).toHaveCount(0);
});

test("project Issues keeps one New issue action and preserves the global action on other tabs", async ({
  page,
}) => {
  const workspaceId = await createWorkspace(`Duplicate CTA issues ${randomUUID()}`);
  const projectId = await createProject(api, workspaceId, `Duplicate CTA issues ${randomUUID()}`);
  await signIn(page);
  await page.goto(`/projects/${projectId}`);

  await expect(page.getByText("No issues yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "New issue", exact: true }).first().click();
  await expect(page).toHaveURL(`/projects/${projectId}/issues/new`);
  await expect(page.getByRole("heading", { name: "New issue", level: 1 })).toBeVisible();

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);
  await page.getByRole("tab", { name: /Issues/ }).click();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);

  await createIssue(projectId, `Populated CTA issue ${randomUUID()}`);
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("table", { name: "Project issues" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);
  await expect(page.getByText("No issues yet", { exact: true })).toHaveCount(0);
});

test("project Knowledge keeps one New document action in empty and populated states", async ({
  page,
}) => {
  const workspaceId = await createWorkspace(`Duplicate CTA knowledge ${randomUUID()}`);
  const projectId = await createProject(
    api,
    workspaceId,
    `Duplicate CTA knowledge ${randomUUID()}`,
  );
  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: /Knowledge/ }).click();

  await expect(page.getByText("No knowledge entries yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "New document", exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "New document", exact: true }).first().click();
  await expect(page).toHaveURL(`/projects/${projectId}/knowledge/new`);
  await expect(
    page.getByRole("heading", { name: "New knowledge document", level: 1 }),
  ).toBeVisible();

  await createKnowledge(projectId, `Populated CTA knowledge ${randomUUID()}`);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await expect(page.getByRole("table", { name: "Knowledge documents" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New document", exact: true })).toHaveCount(1);
  await expect(page.getByText("No knowledge entries yet", { exact: true })).toHaveCount(0);
});

test("knowledge detail keeps one editing action when its body is empty", async ({ page }) => {
  const workspaceId = await createWorkspace(`Duplicate CTA knowledge detail ${randomUUID()}`);
  const projectId = await createProject(
    api,
    workspaceId,
    `Duplicate CTA knowledge detail ${randomUUID()}`,
  );
  const entryId = await createKnowledge(projectId, `Empty CTA knowledge ${randomUUID()}`);
  await signIn(page);
  await page.goto(`/knowledge/${entryId}`);

  await expect(page.getByText("No content yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add content", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Add content", exact: true }).click();
  await expect(page.locator("[data-knowledge-editor]")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-knowledge-editor]")).toHaveCount(0);

  const updated = await api.patch(`/api/knowledge/${entryId}`, {
    data: { body: "Populated knowledge body." },
  });
  expect(updated.status()).toBe(200);
  await page.goto(`/knowledge/${entryId}`);
  await expect(page.locator("[data-knowledge-body]")).toContainText("Populated knowledge body.");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add content", exact: true })).toHaveCount(0);
});

test("Board keeps one New issue action in empty and populated states", async ({ page }) => {
  const workspaceId = await createWorkspace(`Duplicate CTA board ${randomUUID()}`);
  const projectId = await createProject(api, workspaceId, `Duplicate CTA board ${randomUUID()}`);
  await signIn(page);
  await page.goto(`/board/${projectId}`);

  await expect(page.getByText("No issues yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "New issue", exact: true }).first().click();
  await expect(page).toHaveURL(`/projects/${projectId}/issues/new`);
  await expect(page.getByRole("heading", { name: "New issue", level: 1 })).toBeVisible();

  await createIssue(projectId, `Populated CTA board issue ${randomUUID()}`);
  await page.goto(`/board/${projectId}`);
  await expect(page.locator("[data-board-page]")).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);
  await expect(page.getByText("No issues yet", { exact: true })).toHaveCount(0);

  // A filter that matches nothing keeps the header action: the guard counts every
  // issue, and the filtered state shows its own banner with "Show all issues".
  await page.getByLabel("Search issues").fill(`no-such-issue-${randomUUID()}`);
  await expect(page.getByText("No matching issues", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue", exact: true })).toHaveCount(1);
});

async function installationToken(email: string): Promise<string | undefined> {
  const list = await api.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const messages = field(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await api.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    const to = field(caught, "To");
    const addresses = Array.isArray(to)
      ? to.flatMap((entry) => {
          const address = field(entry, "Address");
          return typeof address === "string" ? [address] : [];
        })
      : [];
    if (!addresses.includes(email)) continue;
    return /\/register\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  }
  return undefined;
}

async function freshAccount(): Promise<{
  email: string;
  password: string;
  workspaceId: string;
  client: APIRequestContext;
}> {
  const email = `duplicate-cta-${randomUUID()}@orrery.test`;
  const password = `duplicate-cta-${randomUUID()}`;
  await recordSecret(password);
  const invited = await api.post("/api/invitations/installation", { data: { email } });
  expect(invited.status()).toBe(201);
  await expect.poll(() => installationToken(email), { timeout: 15_000 }).toBeTruthy();
  const token = await installationToken(email);
  if (token === undefined)
    throw new Error("the catcher never received the installation invitation");
  await recordSecret(token);
  const registered = await api.post("/api/invitations/installation/registration", {
    data: { token, password },
  });
  expect(registered.status()).toBe(200);

  const client = await request.newContext({ baseURL: baseUrl });
  const login = await client.post("/api/auth/login", { data: { email, password } });
  expect(login.status()).toBe(200);
  for (const cookie of (await client.storageState()).cookies) await recordSecret(cookie.value);
  const workspaces = await client.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const list: unknown = await workspaces.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return { email, password, workspaceId: idOf(personal, "personal workspace"), client };
}

test("agents keep one Register agent action in empty and populated states", async ({ page }) => {
  test.setTimeout(60_000);
  const account = await freshAccount();
  try {
    await signIn(page, account.email, account.password);
    await page.goto(`/workspaces/${account.workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();

    await expect(page.getByText("No agents registered yet", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Register agent", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Issue key", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Register agent", exact: true }).first().click();
    await expect(page.getByLabel("Agent name")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Agent name")).toHaveCount(0);

    const agentResponse = await account.client.post("/api/agents", {
      data: { name: `duplicate-cta-agent-${randomUUID()}` },
    });
    expect(agentResponse.status()).toBe(201);
    await page.goto(`/workspaces/${account.workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    await expect(page.getByRole("table", { name: "Registered agents" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Register agent", exact: true })).toHaveCount(1);
    await expect(page.getByText("No agents registered yet", { exact: true })).toHaveCount(0);
  } finally {
    await account.client.dispose();
  }
});

test("workspace keys keep one Issue key action across empty, populated, and filtered states", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const account = await freshAccount();
  try {
    const projectId = await createProject(
      account.client,
      account.workspaceId,
      `Duplicate CTA agent project ${randomUUID()}`,
    );
    const agentResponse = await account.client.post("/api/agents", {
      data: { name: `duplicate-cta-key-agent-${randomUUID()}` },
    });
    expect(agentResponse.status()).toBe(201);
    const agentId = idOf(await agentResponse.json(), "agent");
    await signIn(page, account.email, account.password);
    await page.goto(`/workspaces/${account.workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();

    const headerIssueKey = page.locator("[data-workspace-keys-action]");
    const emptyIssueKey = page.locator("[data-workspace-keys-empty-action]");

    await expect(page.getByText("No API keys in this workspace", { exact: true })).toBeVisible();
    await expect(headerIssueKey).toHaveCount(0);
    await expect(emptyIssueKey).toHaveCount(1);
    await emptyIssueKey.click();
    await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveCount(0);

    const keyResponse = await account.client.post("/api/agents/keys", {
      data: {
        agentId,
        workspaceId: account.workspaceId,
        validity: "90",
        projects: [{ projectId, level: "read" }],
      },
    });
    expect(keyResponse.status()).toBe(201);
    const keyBody: unknown = await keyResponse.json();
    const keyId = idOf(field(keyBody, "key"), "key");
    await recordSecret(requiredText(field(keyBody, "secret"), "the key secret"));
    await page.goto(`/workspaces/${account.workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    await expect(page.getByRole("table", { name: "Workspace API keys" })).toBeVisible();
    await expect(headerIssueKey).toHaveCount(1);
    await expect(emptyIssueKey).toHaveCount(0);

    const revoked = await account.client.delete(`/api/agents/keys/${keyId}`);
    expect(revoked.status()).toBe(204);
    await page.goto(`/workspaces/${account.workspaceId}`);
    await page.getByRole("tab", { name: /Agents/ }).click();
    await expect(page.getByText("No active keys", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show all keys", exact: true })).toHaveCount(1);
    await expect(headerIssueKey).toHaveCount(1);
    await page.getByRole("button", { name: "Show all keys", exact: true }).click();
    await expect(page.getByRole("table", { name: "Workspace API keys" })).toBeVisible();
    await expect(page.locator(`[data-agent-key-id="${keyId}"]`)).toContainText("Revoked");
    await expect(headerIssueKey).toHaveCount(1);
  } finally {
    await account.client.dispose();
  }
});

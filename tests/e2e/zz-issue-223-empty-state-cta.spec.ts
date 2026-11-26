import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL ?? "";
if (baseUrl === "") {
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
}

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_PASSWORD = "empty-cta-member-password";
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

const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};

const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

let admin: APIRequestContext;

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect((await admin.put("/api/settings/smtp", { data: SMTP_SETTINGS })).status()).toBe(200);
  await ensureAdminVerified();
});

test.afterAll(async () => {
  await admin?.dispose();
});

async function verificationText(): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Verify your Orrery email") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    const recipients = asArray(field(caught, "To")).flatMap((entry) => {
      const address = field(entry, "Address");
      return typeof address === "string" ? [address] : [];
    });
    if (recipients.includes(ADMIN_EMAIL)) return text;
  }
  return undefined;
}

async function ensureAdminVerified(): Promise<void> {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await session.json(), "emailVerified") === true) return;

  const sent = await admin.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);

  let text: string | undefined;
  await expect
    .poll(
      async () => {
        text = await verificationText();
        return text;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  if (text === undefined) throw new Error("the catcher never received the verification email");
  const token = text.match(/\/settings\/smtp\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("the verification email carried no token");
  await recordSecret(token);

  const verified = await admin.post("/api/settings/email-verification", { data: { token } });
  expect(verified.status()).toBe(200);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
}

async function createWorkspace(name: string): Promise<string> {
  const created = await admin.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "workspace");
}

async function createProject(workspaceId: string, name: string): Promise<string> {
  const created = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name },
  });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "project");
}

async function createIssue(projectId: string, title: string): Promise<void> {
  const created = await admin.post(`/api/projects/${projectId}/issues`, { data: { title } });
  expect(created.status()).toBe(201);
}

async function createKnowledge(projectId: string, title: string): Promise<void> {
  const created = await admin.post(`/api/projects/${projectId}/knowledge`, {
    data: { title, body: "Notes for the empty-state CTA test." },
  });
  expect(created.status()).toBe(201);
}

async function caughtWorkspaceToken(
  to: string,
  workspaceName: string,
): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    const recipients = asArray(field(caught, "To")).flatMap((entry) => {
      const address = field(entry, "Address");
      return typeof address === "string" ? [address] : [];
    });
    if (!recipients.includes(to)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

async function joinNewMember(
  workspaceId: string,
  workspaceName: string,
): Promise<{ email: string; password: string }> {
  const email = `empty-cta-${randomUUID().slice(0, 8)}@orrery.test`;
  await recordSecret(MEMBER_PASSWORD);
  const invited = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email, projectGrants: [] },
  });
  expect(invited.status()).toBe(201);

  let token: string | undefined;
  await expect
    .poll(
      async () => {
        token = await caughtWorkspaceToken(email, workspaceName);
        return token;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);

  const guest = await request.newContext({ baseURL: baseUrl });
  try {
    const registered = await guest.post("/api/workspace-invitations/registration", {
      data: { token, password: MEMBER_PASSWORD },
    });
    expect(registered.status()).toBe(200);
  } finally {
    await guest.dispose();
  }
  return { email, password: MEMBER_PASSWORD };
}

test("list sections show one CTA when empty and the header action when populated", async ({
  page,
}) => {
  const workspaceName = `Empty CTA ${randomUUID().slice(0, 8)}`;
  const workspaceId = await createWorkspace(workspaceName);
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  // Projects tab: the centered Create project CTA is the only primary action.
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.getByRole("heading", { name: "No projects yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(1);

  const projectId = await createProject(
    workspaceId,
    `Empty CTA project ${randomUUID().slice(0, 8)}`,
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "No projects yet" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New project" })).toHaveCount(1);

  // Project issues tab: empty state owns the only New issue CTA.
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("heading", { name: "No issues yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue" })).toHaveCount(1);

  await createIssue(projectId, "Empty CTA issue");
  await page.reload();
  await expect(page.getByRole("heading", { name: "No issues yet" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New issue" })).toHaveCount(1);

  // Board: populated boards keep the header action; empty boards use the centered CTA.
  await page.goto(`/board/${projectId}`);
  await expect(page.getByRole("button", { name: "New issue" })).toHaveCount(1);

  const emptyBoardProjectId = await createProject(
    workspaceId,
    `Empty board ${randomUUID().slice(0, 8)}`,
  );
  await page.goto(`/board/${emptyBoardProjectId}`);
  await expect(page.getByRole("heading", { name: "No issues yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New issue" })).toHaveCount(1);

  // Knowledge tab: empty state owns the only New document CTA.
  await page.goto(`/projects/${emptyBoardProjectId}`);
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await expect(page.getByRole("heading", { name: "No knowledge entries yet" })).toBeVisible();
  await expect(page.locator("[data-new-knowledge]")).toHaveCount(1);

  await createKnowledge(emptyBoardProjectId, "Empty CTA knowledge");
  await page.reload();
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await expect(page.getByRole("heading", { name: "No knowledge entries yet" })).toHaveCount(0);
  await expect(page.locator("[data-new-knowledge]")).toHaveCount(1);

  // Webhooks tab: the centered CTA creates the first webhook, then the header action returns.
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: /Webhooks/ }).click();
  await expect(page.getByRole("heading", { name: "No outgoing webhooks yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add webhook" })).toHaveCount(1);

  await page.getByRole("button", { name: "Add webhook" }).click();
  await page.getByLabel(/Endpoint URL/).fill("https://example.com/orrery-empty-cta");
  await page.getByRole("button", { name: "Create webhook" }).click();
  await expect(page.locator("[data-webhook-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "No outgoing webhooks yet" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add webhook" })).toHaveCount(1);
});

test("agents and workspace keys show one CTA in each state", async ({ page }) => {
  const workspaceName = `Empty CTA agents ${randomUUID().slice(0, 8)}`;
  const workspaceId = await createWorkspace(workspaceName);
  const member = await joinNewMember(workspaceId, workspaceName);
  await signIn(page, member.email, member.password);

  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: /Agents/ }).click();
  const agentsSection = page.locator("[data-registered-agents]");
  const keysSection = page.locator("[data-workspace-keys]");

  // Registered agents: empty state owns the only Register agent CTA.
  await expect(page.getByRole("heading", { name: "No agents registered yet" })).toBeVisible();
  await expect(agentsSection.getByRole("button", { name: "Register agent" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "No API keys in this workspace" })).toBeVisible();
  await expect(keysSection.getByRole("button", { name: "Issue key" })).toHaveCount(0);

  await page.getByRole("button", { name: "Register agent" }).click();
  const registerDialog = page.getByRole("dialog");
  await registerDialog.getByLabel("Agent name").fill("Empty CTA agent");
  await registerDialog.getByRole("button", { name: "Register agent" }).click();
  await expect(page.locator("[data-agent-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "No agents registered yet" })).toHaveCount(0);
  await expect(agentsSection.getByRole("button", { name: "Register agent" })).toHaveCount(1);

  // Keys: empty state owns the only Issue key CTA until the first key exists.
  await expect(page.getByRole("heading", { name: "No API keys in this workspace" })).toBeVisible();
  await expect(keysSection.getByRole("button", { name: "Issue key" })).toHaveCount(1);

  await keysSection.getByRole("button", { name: "Issue key" }).click();
  const keyDialog = page.getByRole("dialog");
  await keyDialog.getByRole("button", { name: "Issue key" }).click();
  await expect(page.locator("[data-agent-key-id]")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "No API keys in this workspace" })).toHaveCount(0);
  await expect(keysSection.getByRole("button", { name: "Issue key" })).toHaveCount(0);
});

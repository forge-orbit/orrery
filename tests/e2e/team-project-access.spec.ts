import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const baseUrl: string = configuredUrl;

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

const RUN_ID = randomUUID().slice(0, 8);
const WORKSPACE_NAME = `Access Lab ${RUN_ID}`;
const MEMBER_EMAIL = `access.member.${RUN_ID}@orrery.test`;
const MEMBER_PASSWORD = "access-member-password";
const COLLEAGUE_EMAIL = `access.colleague.${RUN_ID}@orrery.test`;
const COLLEAGUE_PASSWORD = "access-colleague-password";
const OUTSIDER_EMAIL = `access.outsider.${RUN_ID}@orrery.test`;
const OUTSIDER_PASSWORD = "access-outsider-password";

let adminApi: APIRequestContext;
let memberApi: APIRequestContext;
let colleagueApi: APIRequestContext;
let outsiderApi: APIRequestContext;

let workspaceId = "";
let memberHumanId = "";
let projectId = "";
let memberProjectId = "";
let colleagueHumanId = "";
let adminPersonalProjectId = "";
let adminPersonalWorkspaceId = "";
let outsiderPersonalProjectId = "";

test.beforeAll(async () => {
  for (const value of [MEMBER_PASSWORD, COLLEAGUE_PASSWORD, OUTSIDER_PASSWORD]) {
    await recordSecret(value);
  }

  adminApi = await newContext();
  await signIn(adminApi, ADMIN_EMAIL, ADMIN_PASSWORD);
  const saved = await adminApi.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);

  await ensureAdminVerified();

  const created = await adminApi.post("/api/workspaces", { data: { name: WORKSPACE_NAME } });
  expect(created.status()).toBe(201);
  workspaceId = requiredText(field(await created.json(), "id"), "the workspace id");

  memberApi = await registeredMember(MEMBER_EMAIL, MEMBER_PASSWORD, WORKSPACE_NAME);
  colleagueApi = await registeredMember(COLLEAGUE_EMAIL, COLLEAGUE_PASSWORD, WORKSPACE_NAME);
  outsiderApi = await installedOutsider();

  const members = await adminApi.get(`/api/workspaces/${workspaceId}/members`);
  expect(members.status()).toBe(200);
  memberHumanId = humanIdFor(await members.json(), MEMBER_EMAIL);
  colleagueHumanId = humanIdFor(await members.json(), COLLEAGUE_EMAIL);

  projectId = await createProjectAs(adminApi, workspaceId, "Access Lab Project");
  const adminWorkspaces = await adminApi.get("/api/workspaces");
  adminPersonalWorkspaceId = personalWorkspaceOf(await adminWorkspaces.json());
  adminPersonalProjectId = await createProjectAs(
    adminApi,
    adminPersonalWorkspaceId,
    "Private Admin Project",
  );
  const outsiderWorkspaces = await outsiderApi.get("/api/workspaces");
  outsiderPersonalProjectId = await createProjectAs(
    outsiderApi,
    personalWorkspaceOf(await outsiderWorkspaces.json()),
    "Private Outsider Project",
  );

  const capability = await adminApi.patch(
    `/api/workspaces/${workspaceId}/members/${memberHumanId}`,
    {
      data: { canCreateProjects: true },
    },
  );
  expect(capability.status()).toBe(200);
  memberProjectId = await createProjectAs(memberApi, workspaceId, "Member Project");

  await createIssueAs(adminApi, projectId, "Seed issue");
  await grant(adminApi, projectId, MEMBER_EMAIL, "read");
});

test.afterAll(async () => {
  for (const client of [adminApi, memberApi, colleagueApi, outsiderApi]) await client?.dispose();
});

test("enforces the direct-request matrix for every level", async () => {
  const issue = await createIssueAs(adminApi, projectId, "Owner issue");
  const knowledge = await createKnowledgeAs(adminApi, projectId, "Owner knowledge");

  for (const path of [
    `/api/projects/${projectId}`,
    `/api/projects/${projectId}/issues`,
    `/api/issues/${requiredText(field(issue, "id"), "the issue id")}`,
    `/api/issues/${requiredText(field(issue, "id"), "the issue id")}/comments`,
    `/api/projects/${projectId}/activity`,
    `/api/projects/${projectId}/knowledge`,
    `/api/knowledge/${requiredText(field(knowledge, "id"), "the knowledge id")}`,
  ]) {
    expect((await memberApi.get(path)).status(), path).toBe(200);
  }

  const readDenials = [
    await memberApi.post(`/api/projects/${projectId}/issues`, { data: { title: "No" } }),
    await memberApi.patch(`/api/issues/${requiredText(field(issue, "id"), "the issue id")}`, {
      data: { status: "done" },
    }),
    await memberApi.post(
      `/api/issues/${requiredText(field(issue, "id"), "the issue id")}/comments`,
      {
        data: { body: "No" },
      },
    ),
    await memberApi.post(`/api/projects/${projectId}/knowledge`, { data: { title: "No" } }),
    await memberApi.patch(
      `/api/knowledge/${requiredText(field(knowledge, "id"), "the knowledge id")}`,
      { data: { title: "No" } },
    ),
    await memberApi.patch(`/api/projects/${projectId}`, { data: { name: "No" } }),
    await memberApi.get(`/api/projects/${projectId}/access`),
    await memberApi.patch(`/api/projects/${projectId}/access`, {
      data: { email: COLLEAGUE_EMAIL, level: "read" },
    }),
  ];
  for (const res of readDenials) {
    expect(res.status()).toBe(403);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 403, code: "insufficient_project_access" });
  }

  await grant(adminApi, projectId, MEMBER_EMAIL, "contribute");
  const memberIssue = await createIssueAs(memberApi, projectId, "Member issue");
  const memberIssueId = requiredText(field(memberIssue, "id"), "the member issue id");
  expect(
    (
      await memberApi.patch(`/api/issues/${memberIssueId}`, {
        data: { title: "Member issue edited" },
      })
    ).status(),
  ).toBe(200);
  expect(
    (await memberApi.patch(`/api/issues/${memberIssueId}`, { data: { status: "done" } })).status(),
  ).toBe(200);
  expect(
    (await memberApi.patch(`/api/issues/${memberIssueId}`, { data: { status: "todo" } })).status(),
  ).toBe(200);
  expect(
    (
      await memberApi.post(`/api/issues/${memberIssueId}/comments`, {
        data: { body: "A member comment." },
      })
    ).status(),
  ).toBe(201);
  const memberKnowledge = await createKnowledgeAs(memberApi, projectId, "Member knowledge");
  expect(
    (
      await memberApi.patch(
        `/api/knowledge/${requiredText(field(memberKnowledge, "id"), "the member knowledge id")}`,
        { data: { body: "Updated in the matrix." } },
      )
    ).status(),
  ).toBe(200);
  expect(
    (await memberApi.patch(`/api/projects/${projectId}`, { data: { name: "No" } })).status(),
  ).toBe(403);
  expect((await memberApi.get(`/api/projects/${projectId}/access`)).status()).toBe(403);

  await grant(adminApi, projectId, MEMBER_EMAIL, "manage");
  const renamed = await memberApi.patch(`/api/projects/${projectId}`, {
    data: { name: "Access Lab Project Renamed" },
  });
  expect(renamed.status()).toBe(200);
  expect(await renamed.json()).toMatchObject({
    name: "Access Lab Project Renamed",
    accessLevel: "manage",
  });
  expect(
    (
      await memberApi.patch(`/api/projects/${projectId}`, { data: { name: "Access Lab Project" } })
    ).status(),
  ).toBe(200);
  expect((await memberApi.get(`/api/projects/${projectId}/access`)).status()).toBe(200);

  const colleagueGrant = await grant(memberApi, projectId, COLLEAGUE_EMAIL, "read");
  expect(colleagueGrant).toMatchObject({ email: COLLEAGUE_EMAIL, level: "read" });
  expect((await colleagueApi.get(`/api/projects/${projectId}`)).status()).toBe(200);
  const revoked = await memberApi.delete(`/api/projects/${projectId}/access/${colleagueHumanId}`);
  expect(revoked.status()).toBe(204);
  expect((await colleagueApi.get(`/api/projects/${projectId}`)).status()).toBe(404);

  expect(
    (
      await memberApi.patch(`/api/projects/${projectId}/access`, {
        data: { email: OUTSIDER_EMAIL, level: "read" },
      })
    ).status(),
  ).toBe(404);

  const colleagueList = await colleagueApi.get(`/api/workspaces/${workspaceId}/projects`);
  expect(colleagueList.status()).toBe(200);
  expect(await colleagueList.json()).toEqual([]);
  expect((await colleagueApi.get(`/api/projects/${projectId}`)).status()).toBe(404);

  expect(await (await memberApi.get(`/api/projects/${memberProjectId}`)).json()).toMatchObject({
    id: memberProjectId,
    accessLevel: "manage",
    workspaceKind: "shared",
  });
  expect((await colleagueApi.get(`/api/projects/${memberProjectId}`)).status()).toBe(404);

  const ownerRename = await adminApi.patch(`/api/projects/${memberProjectId}`, {
    data: { name: "Member Project Renamed" },
  });
  expect(ownerRename.status()).toBe(200);
  expect(await ownerRename.json()).toMatchObject({
    id: memberProjectId,
    name: "Member Project Renamed",
    accessLevel: "manage",
  });

  expect((await outsiderApi.get(`/api/projects/${projectId}`)).status()).toBe(404);
  expect((await outsiderApi.get(`/api/workspaces/${workspaceId}/projects`)).status()).toBe(404);
  expect((await outsiderApi.get(`/api/projects/${adminPersonalProjectId}`)).status()).toBe(404);
  expect((await memberApi.get(`/api/projects/${adminPersonalProjectId}`)).status()).toBe(404);

  expect((await adminApi.get(`/api/projects/${outsiderPersonalProjectId}`)).status()).toBe(404);
  expect(
    (
      await adminApi.get(`/api/workspaces/${await personalWorkspaceOfApi(outsiderApi)}/projects`)
    ).status(),
  ).toBe(404);

  const outsiderSharedWs = await outsiderApi.post("/api/workspaces", {
    data: { name: "Outsider Team" },
  });
  expect(outsiderSharedWs.status()).toBe(201);
  const outsiderSharedId = field(await outsiderSharedWs.json(), "id");
  if (typeof outsiderSharedId !== "string") throw new Error("missing outsider shared workspace id");
  const outsiderSharedProj = await outsiderApi.post(
    `/api/workspaces/${outsiderSharedId}/projects`,
    { data: { name: "Outsider Shared Project" } },
  );
  expect(outsiderSharedProj.status()).toBe(201);
  const outsiderSharedProjId = field(await outsiderSharedProj.json(), "id");
  if (typeof outsiderSharedProjId !== "string")
    throw new Error("missing outsider shared project id");
  expect((await adminApi.get(`/api/workspaces/${outsiderSharedId}/projects`)).status()).toBe(404);
  expect((await adminApi.get(`/api/projects/${outsiderSharedProjId}`)).status()).toBe(404);
});

test("grants access in the browser and shows Read without mutation controls", async ({
  page,
  browser,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Member/ }).click();
  await page.getByRole("option", { name: new RegExp(COLLEAGUE_EMAIL) }).click();
  await page.getByRole("combobox", { name: "Access level" }).click();
  await page.getByRole("option", { name: "Contribute", exact: true }).click();
  await page.getByRole("button", { name: "Grant access" }).click();
  const grantRow = page.locator(`[data-project-access-for="${COLLEAGUE_EMAIL}"]`);
  await expect(grantRow).toContainText("contribute");
  await expect(grantRow).toContainText(ADMIN_EMAIL);

  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: "Members" }).click();
  const memberRow = page.locator(`[data-member-id="${memberHumanId}"]`);
  await expect(memberRow.locator('[data-capability="canCreateProjects"]')).toBeVisible();
  await memberRow.getByRole("button", { name: "Permissions" }).click();
  const permissionsDialog = page.getByRole("dialog");
  const createProjectsCheckbox = permissionsDialog.getByRole("checkbox", {
    name: "Create projects",
  });
  const savePermissions = permissionsDialog.getByRole("button", { name: "Save permissions" });
  await expect(createProjectsCheckbox).toBeChecked();
  await expect(savePermissions).toBeDisabled();

  await createProjectsCheckbox.click();
  await expect(createProjectsCheckbox).not.toBeChecked();
  await expect(savePermissions).toBeEnabled();
  // The draft stays local until Save permissions is submitted.
  await expect(memberRow.locator('[data-capability="canCreateProjects"]')).toBeVisible();
  await savePermissions.click();
  await expect(memberRow.locator('[data-capability="canCreateProjects"]')).toHaveCount(0);

  await memberRow.getByRole("button", { name: "Permissions" }).click();
  const reopenedDialog = page.getByRole("dialog");
  const reopenedCheckbox = reopenedDialog.getByRole("checkbox", { name: "Create projects" });
  await reopenedCheckbox.click();
  await expect(reopenedCheckbox).toBeChecked();
  await reopenedDialog.getByRole("button", { name: "Save permissions" }).click();
  await expect(memberRow.locator('[data-capability="canCreateProjects"]')).toBeVisible();

  const colleagueContext = await browser.newContext();
  const colleaguePage = await colleagueContext.newPage();
  try {
    await colleaguePage.goto("/signin");
    await colleaguePage.getByLabel("Email").fill(COLLEAGUE_EMAIL);
    await colleaguePage.getByLabel("Password").fill(COLLEAGUE_PASSWORD);
    await colleaguePage.getByRole("button", { name: "Sign in" }).click();
    await expect(colleaguePage.getByText(`Signed in as ${COLLEAGUE_EMAIL}.`)).toBeVisible();

    await grant(adminApi, projectId, COLLEAGUE_EMAIL, "read");
    await colleaguePage.goto(`/projects/${projectId}`);
    await expect(colleaguePage.getByRole("heading", { name: "Access Lab Project" })).toBeVisible();
    await expect(colleaguePage.locator('[data-project-access-level="read"]').first()).toBeVisible();
    await expect(colleaguePage.getByRole("button", { name: "Create issue" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("button", { name: "Create knowledge" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("heading", { name: "Project settings" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("heading", { name: "Project access" })).toHaveCount(0);

    const firstIssue = colleaguePage.locator("[data-issue-id] a").first();
    await firstIssue.click();
    await expect(colleaguePage.getByRole("button", { name: "Close issue" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("button", { name: "Save issue" })).toHaveCount(0);
    await expect(colleaguePage.getByRole("button", { name: "Add comment" })).toHaveCount(0);
  } finally {
    for (const cookie of await colleagueContext.cookies()) await recordSecret(cookie.value);
    await colleagueContext.close();
  }

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("a project manager without member-directory access gets a picker and an empty state", async ({
  page,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(MEMBER_EMAIL);
  await page.getByLabel("Password").fill(MEMBER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${MEMBER_EMAIL}.`)).toBeVisible();

  await page.goto(`/projects/${memberProjectId}`);
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  const member = page.getByRole("button", { name: /Member/ });
  await expect(member).toBeVisible();
  await member.click();
  await page.getByRole("option", { name: new RegExp(COLLEAGUE_EMAIL) }).click();
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.locator(`[data-project-access-for="${COLLEAGUE_EMAIL}"]`)).toContainText(
    "read",
  );

  await expect(
    page.getByRole("heading", {
      name: "All workspace members already have access to this project.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Grant access" })).toHaveCount(0);
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

async function newContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: baseUrl });
}

async function signIn(client: APIRequestContext, email: string, password: string) {
  const login = await client.post("/api/auth/login", { data: { email, password } });
  expect(login.status()).toBe(200);
}

async function ensureAdminVerified() {
  const session = await adminApi.get("/api/auth/session");
  expect(session.status()).toBe(200);
  const state = (await session.json()) as unknown;
  if (field(state, "emailVerified") === true) return;

  const sent = await adminApi.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
  await expect.poll(async () => verificationMessageText(), { timeout: 15_000 }).toBeTruthy();
  const text = await verificationMessageText();
  if (text === undefined) throw new Error("the catcher never received the verification email");
  const token = text.match(/\/settings\/smtp\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("the verification email carried no token");
  await recordSecret(token);

  const verified = await adminApi.post("/api/settings/email-verification", {
    data: { token },
  });
  expect(verified.status()).toBe(200);
  // #183 adds handle and displayName to the session; keep checking the fields this
  // test cares about without pinning the whole response shape.
  expect(await verified.json()).toMatchObject({
    email: ADMIN_EMAIL,
    emailVerified: true,
    avatarUrl: null,
  });
}

async function verificationMessageText(): Promise<string | undefined> {
  const list = await adminApi.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== "Verify your Orrery email") continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await adminApi.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(ADMIN_EMAIL)) continue;
    return text;
  }
  return undefined;
}

async function registeredMember(
  email: string,
  password: string,
  workspaceName: string,
): Promise<APIRequestContext> {
  const invited = await adminApi.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(email, "workspace", workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtToken(email, "workspace", workspaceName);
  if (token === undefined) throw new Error(`the catcher never received ${email}'s invitation`);
  await recordSecret(token);
  const registered = await request.newContext({ baseURL: baseUrl });
  const accepted = await registered.post("/api/workspace-invitations/registration", {
    data: { token, password },
  });
  expect(accepted.status()).toBe(200);
  await registered.dispose();

  const client = await newContext();
  await signIn(client, email, password);
  return client;
}

async function installedOutsider(): Promise<APIRequestContext> {
  const invited = await adminApi.post("/api/invitations/installation", {
    data: { email: OUTSIDER_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(OUTSIDER_EMAIL, "installation"), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtToken(OUTSIDER_EMAIL, "installation");
  if (token === undefined) throw new Error("the catcher never received the outsider invitation");
  await recordSecret(token);
  const registered = await request.newContext({ baseURL: baseUrl });
  const accepted = await registered.post("/api/invitations/installation/registration", {
    data: { token, password: OUTSIDER_PASSWORD },
  });
  expect(accepted.status()).toBe(200);
  await registered.dispose();

  const client = await newContext();
  await signIn(client, OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
  return client;
}

async function createProjectAs(
  client: APIRequestContext,
  targetWorkspaceId: string,
  name: string,
): Promise<string> {
  const created = await client.post(`/api/workspaces/${targetWorkspaceId}/projects`, {
    data: { name },
  });
  expect(created.status()).toBe(201);
  return requiredText(field(await created.json(), "id"), "the project id");
}

async function createIssueAs(client: APIRequestContext, targetProjectId: string, title: string) {
  const created = await client.post(`/api/projects/${targetProjectId}/issues`, {
    data: { title },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as unknown;
}

async function createKnowledgeAs(
  client: APIRequestContext,
  targetProjectId: string,
  title: string,
) {
  const created = await client.post(`/api/projects/${targetProjectId}/knowledge`, {
    data: { title },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as unknown;
}

async function grant(
  client: APIRequestContext,
  targetProjectId: string,
  email: string,
  level: "read" | "contribute" | "manage",
) {
  const res = await client.patch(`/api/projects/${targetProjectId}/access`, {
    data: { email, level },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as unknown;
}

async function personalWorkspaceOfApi(client: APIRequestContext): Promise<string> {
  return personalWorkspaceOf(await (await client.get("/api/workspaces")).json());
}

function personalWorkspaceOf(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("the workspaces listing is not a list");
  for (const workspace of value) {
    if (field(workspace, "kind") !== "personal") continue;
    const id = field(workspace, "id");
    if (typeof id === "string") return id;
  }
  throw new Error("the account has no personal workspace");
}

function humanIdFor(value: unknown, email: string): string {
  if (!Array.isArray(value)) throw new Error("the members listing is not a list");
  for (const member of value) {
    if (field(member, "email") !== email) continue;
    const id = field(member, "humanId");
    if (typeof id === "string") return id;
  }
  throw new Error(`the workspace has no member ${email}`);
}

async function caughtToken(
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string | undefined> {
  const list = await adminApi.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  const subject =
    kind === "installation" ? "Your Orrery invitation" : "Your Orrery workspace invitation";
  const pattern =
    kind === "installation"
      ? /\/register\?token=([A-Za-z0-9_-]+)/
      : /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== subject) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await adminApi.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(to)) continue;
    if (workspaceName !== undefined && !text.includes(`"${workspaceName}"`)) continue;
    const token = text.match(pattern)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

function caughtRecipients(detail: object): string[] {
  const to: unknown = Reflect.get(detail, "To");
  if (!Array.isArray(to)) return [];
  return to.flatMap((entry): string[] => {
    const address: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
    return typeof address === "string" ? [address] : [];
  });
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

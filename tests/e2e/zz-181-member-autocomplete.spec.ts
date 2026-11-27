import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
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
const PASSWORD = "autocomplete-person-password";

const suffix = randomUUID().slice(0, 8);
const WORKSPACE = `Autocomplete Lab ${suffix}`;
const OWNER_EMAIL = `autocomplete.owner.${suffix}@orrery.test`;
const PEER_EMAIL = `autocomplete.peer.${suffix}@orrery.test`;
const TEAMMATE_EMAIL = `autocomplete.teammate.${suffix}@orrery.test`;
const STRANGER_EMAIL = `autocomplete.stranger.${suffix}@orrery.test`;
const BRAND_NEW_EMAIL = `autocomplete.brand.new.${suffix}@orrery.test`;

let api: APIRequestContext;
let ownerApi: APIRequestContext;
let strangerApi: APIRequestContext;
let workspaceId = "";
let otherWorkspaceId = "";
let projectId = "";
let ownerHumanId = "";

test.setTimeout(180_000);

test.beforeAll(async () => {
  await recordSecret(PASSWORD);
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const smtp = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(smtp.status()).toBe(200);
  await ensureAdminVerified();

  const created = await api.post("/api/workspaces", { data: { name: WORKSPACE } });
  expect(created.status()).toBe(201);
  workspaceId = asText(field(await created.json(), "id"), "workspace id");
  const project = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Autocomplete Project" },
  });
  expect(project.status()).toBe(201);
  projectId = asText(field(await project.json(), "id"), "project id");

  // The owner and peer share another workspace; the teammate shares only this
  // one; the stranger is registered on the installation but shares nothing.
  const other = await api.post("/api/workspaces", { data: { name: `${WORKSPACE} Other` } });
  expect(other.status()).toBe(201);
  otherWorkspaceId = asText(field(await other.json(), "id"), "other workspace id");

  for (const email of [OWNER_EMAIL, PEER_EMAIL, TEAMMATE_EMAIL, STRANGER_EMAIL]) {
    await registerInstallation(email);
  }
  await joinWorkspace(OWNER_EMAIL, workspaceId, WORKSPACE);
  await joinWorkspace(OWNER_EMAIL, otherWorkspaceId, `${WORKSPACE} Other`);
  await joinWorkspace(PEER_EMAIL, otherWorkspaceId, `${WORKSPACE} Other`);
  await joinWorkspace(TEAMMATE_EMAIL, workspaceId, WORKSPACE);
  ownerHumanId = await memberIdFor(workspaceId, OWNER_EMAIL);

  const appointed = await api.post(`/api/workspaces/${workspaceId}/owners`, {
    data: { humanId: ownerHumanId },
  });
  expect(appointed.status()).toBe(200);
  ownerApi = await signInApi(OWNER_EMAIL);
  strangerApi = await signInApi(STRANGER_EMAIL);
});

test.afterAll(async () => {
  await api?.dispose();
  await ownerApi?.dispose();
  await strangerApi?.dispose();
});

test("a non-admin owner never learns about Humans outside their shared workspaces", async () => {
  const adminSuggestions = await api.get(
    `/api/workspaces/${workspaceId}/human-suggestions?q=${encodeURIComponent(STRANGER_EMAIL)}`,
  );
  expect(adminSuggestions.status()).toBe(200);
  expect(asArray(await adminSuggestions.json()).map((item) => field(item, "email"))).toContain(
    STRANGER_EMAIL,
  );

  const strangerFromOwner = await ownerApi.get(
    `/api/workspaces/${workspaceId}/human-suggestions?q=${encodeURIComponent(STRANGER_EMAIL)}`,
  );
  expect(strangerFromOwner.status()).toBe(200);
  expect(asArray(await strangerFromOwner.json())).toEqual([]);

  const peerFromOwner = await ownerApi.get(
    `/api/workspaces/${workspaceId}/human-suggestions?q=${encodeURIComponent(PEER_EMAIL)}`,
  );
  expect(peerFromOwner.status()).toBe(200);
  expect(asArray(await peerFromOwner.json()).map((item) => field(item, "email"))).toContain(
    PEER_EMAIL,
  );

  const existing = await strangerApi.get(`/api/workspaces/${workspaceId}/human-suggestions?q=a`);
  const missing = await strangerApi.get(`/api/workspaces/${randomUUID()}/human-suggestions?q=a`);
  for (const res of [existing, missing]) {
    expect(res.status()).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404, code: "workspace_not_found" });
  }
  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const unauthenticated = await anonymous.get(
      `/api/workspaces/${workspaceId}/human-suggestions?q=a`,
    );
    expect(unauthenticated.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test("the assignee picker omits a Member without project access", async ({ page }) => {
  await signInPage(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/projects/${projectId}/issues/new`);
  await page.getByRole("combobox", { name: "Assignee" }).click();
  await expect(
    page.getByRole("option", { name: `Human · ${OWNER_EMAIL}`, exact: true }),
  ).toHaveCount(1);
  // Only Humans with project access are offered; the flagging "No project access"
  // option is gone with the human-only cutover.
  await expect(page.getByRole("option", { name: new RegExp(TEAMMATE_EMAIL) })).toHaveCount(0);
});

test("Project Access uses a searchable member selector instead of typing an email", async ({
  page,
}) => {
  await signInPage(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: "Settings" }).click();
  const member = page.getByRole("button", { name: /Member/ });
  await expect(member).toBeVisible();
  await member.click();
  const option = page.getByRole("option", { name: new RegExp(TEAMMATE_EMAIL) });
  await expect(option).toBeVisible();
  await option.click();
  await page.getByRole("combobox", { name: "Access level" }).click();
  await page.getByRole("option", { name: "Contribute", exact: true }).click();
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.locator(`[data-project-access-for="${TEAMMATE_EMAIL}"]`)).toContainText(
    "contribute",
  );
});

test("the invitation form suggests known Humans but still accepts a brand-new address", async ({
  page,
}) => {
  await signInPage(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("button", { name: "Invite member" }).click();
  const email = page.getByLabel("Email");
  await email.fill("autocomplete.stranger." + suffix);
  const suggestion = page.getByRole("button", { name: new RegExp(STRANGER_EMAIL) });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(email).toHaveValue(STRANGER_EMAIL);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${STRANGER_EMAIL}.`).first()).toBeVisible();

  await email.fill(BRAND_NEW_EMAIL);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${BRAND_NEW_EMAIL}.`).first()).toBeVisible();
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("assignee pickers and board filters offer Humans only, never Agents", async ({ page }) => {
  const agent = await api.post("/api/agents", { data: { name: `picker-agent-${suffix}` } });
  expect(agent.status()).toBe(201);
  const issue = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Picker issue" },
  });
  expect(issue.status()).toBe(201);
  const issueId = asText(field(await issue.json(), "id"), "issue id");

  await signInPage(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/issues/${issueId}`);
  await page.getByRole("combobox", { name: "Assignee" }).click();
  await expect(
    page.getByRole("option", { name: `Human · ${OWNER_EMAIL}`, exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole("option", { name: /^Agent · / })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/board/${projectId}`);
  await page.getByRole("combobox", { name: "Assignee" }).click();
  await expect(page.getByRole("option", { name: "Any assignee", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Unassigned", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Human", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Any agent", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText("Any agent")).toHaveCount(0);
});

test("delegation on another Human's issue is disabled with an explanation", async ({ page }) => {
  const issue = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Owned by the workspace owner", assigneeHumanId: ownerHumanId },
  });
  expect(issue.status()).toBe(201);
  const issueId = asText(field(await issue.json(), "id"), "issue id");

  await signInPage(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto(`/issues/${issueId}`);
  await expect(page.getByRole("heading", { name: "Delegate to Runner" })).toBeVisible();
  await expect(page.locator("[data-delegate-trigger]")).toBeDisabled();
  await expect(
    page.getByText(/that human can delegate it\. Reassign the issue to delegate it yourself\./),
  ).toBeVisible();
});

test("another Human's Agent cannot claim an issue assigned to someone else", async () => {
  const agent = await api.post("/api/agents", { data: { name: `foreign-agent-${suffix}` } });
  expect(agent.status()).toBe(201);
  const agentId = asText(field(await agent.json(), "id"), "agent id");
  const key = await api.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(key.status()).toBe(201);
  const secret = asText(field(await key.json(), "secret"), "agent key");
  await recordSecret(secret);

  const issue = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Claimed by another human", assigneeHumanId: ownerHumanId },
  });
  expect(issue.status()).toBe(201);
  const issueId = asText(field(await issue.json(), "id"), "issue id");

  const agentApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });
  try {
    const run = await agentApi.post("/api/runs/hook", {
      data: {
        schema: "orrery.run.hook.v1",
        event: "run_started",
        runKey: { harness: "member-autocomplete-e2e", nativeSessionId: randomUUID() },
      },
    });
    expect(run.status()).toBe(200);
    const runId = asText(field(await run.json(), "runId"), "run id");
    const claim = await agentApi.post(`/api/issues/${issueId}/work-sessions`, { data: { runId } });
    expect(claim.status()).toBe(409);
    expect(claim.headers()["content-type"]).toContain("application/problem+json");
    expect(await claim.json()).toMatchObject({ code: "issue_assigned_to_other_human" });
  } finally {
    await agentApi.dispose();
  }
});

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function asText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function signInApi(email: string): Promise<APIRequestContext> {
  const client = await request.newContext({ baseURL: baseUrl });
  const res = await client.post("/api/auth/login", { data: { email, password: PASSWORD } });
  expect(res.status()).toBe(200);
  return client;
}

async function signInPage(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
}

async function ensureAdminVerified() {
  const session = await api.get("/api/auth/session");
  const state: unknown = await session.json();
  if (field(state, "emailVerified") === true) return;
  const sent = await api.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
  await expect
    .poll(async () => (await verificationToken()) ?? "", { timeout: 20_000 })
    .toBeTruthy();
  const token = await verificationToken();
  if (token === undefined) throw new Error("the catcher never received a verification email");
  await recordSecret(token);
  const verified = await api.post("/api/settings/email-verification", { data: { token } });
  expect(verified.status()).toBe(200);
}

async function verificationToken(): Promise<string | undefined> {
  const list = await api.get(`${mailpit}/api/v1/messages`);
  const messages = asArray(field(await list.json(), "messages"));
  for (const message of messages) {
    if (field(message, "Subject") !== "Verify your Orrery email") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await api.get(`${mailpit}/api/v1/message/${id}`);
    const text = field(await detail.json(), "Text");
    if (typeof text !== "string") continue;
    const token = text.match(/\/settings\/smtp\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

async function registerInstallation(email: string) {
  const invited = await api.post("/api/invitations/installation", { data: { email } });
  expect(invited.status()).toBe(201);
  const token = await caughtToken(email, "installation");
  const registration = await request.newContext({ baseURL: baseUrl });
  const res = await registration.post("/api/invitations/installation/registration", {
    data: { token, password: PASSWORD },
  });
  expect(res.status()).toBe(200);
  await registration.dispose();
}

async function joinWorkspace(email: string, targetWorkspaceId: string, name: string) {
  const invited = await api.post(`/api/workspaces/${targetWorkspaceId}/invitations`, {
    data: { email },
  });
  expect(invited.status()).toBe(201);
  const token = await caughtToken(email, "workspace", name);
  const client = await signInApi(email);
  const accepted = await client.post("/api/workspace-invitations/acceptance", { data: { token } });
  expect(accepted.status()).toBe(200);
  await client.dispose();
}

async function memberIdFor(targetWorkspaceId: string, email: string): Promise<string> {
  const members = await api.get(`/api/workspaces/${targetWorkspaceId}/members`);
  const member = asArray(await members.json()).find((item) => field(item, "email") === email);
  return asText(field(member, "humanId"), "member id");
}

async function caughtToken(
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string> {
  const subject =
    kind === "installation" ? "Your Orrery invitation" : "Your Orrery workspace invitation";
  const pattern =
    kind === "installation"
      ? /\/register\?token=([A-Za-z0-9_-]+)/
      : /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/;
  await expect
    .poll(async () => (await findToken(to, subject, pattern, workspaceName)) ?? "", {
      timeout: 20_000,
    })
    .toBeTruthy();
  const token = await findToken(to, subject, pattern, workspaceName);
  if (token === undefined) throw new Error(`the catcher never received ${to}'s invitation`);
  await recordSecret(token);
  return token;
}

async function findToken(
  to: string,
  subject: string,
  pattern: RegExp,
  workspaceName?: string,
): Promise<string | undefined> {
  const list = await api.get(`${mailpit}/api/v1/messages`);
  const messages = asArray(field(await list.json(), "messages"));
  for (const message of messages) {
    if (field(message, "Subject") !== subject) continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await api.get(`${mailpit}/api/v1/message/${id}`);
    const body: unknown = await detail.json();
    const text = field(body, "Text");
    if (typeof text !== "string") continue;
    const recipients = asArray(field(body, "To")).map((entry) => field(entry, "Address"));
    if (!recipients.includes(to)) continue;
    if (workspaceName !== undefined && !text.includes(`"${workspaceName}"`)) continue;
    const token = text.match(pattern)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

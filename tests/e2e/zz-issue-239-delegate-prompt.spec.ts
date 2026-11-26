import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const smtpHost = process.env.MAILPIT_SMTP_HOST ?? "mailpit";
const TEAMMATE_PASSWORD = "delegate-prompt-teammate-password";
const PROMPT =
  "Use an additive migration, keep the old column readable during rollout, and add a regression test that covers both the legacy and new paths before opening a pull request. Document the rollback steps in the runbook, keep the feature flag wired through both API handlers until staging verifies the migration, and call out any remaining follow-up work in the final summary.";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Fixture {
  workspaceId: string;
  projectId: string;
  issueId: string;
  secondIssueId: string;
  runnerId: string;
  runnerDisplayName: string;
  hostCredential: string;
  agentId: string;
  agentName: string;
  teammateEmail: string;
}

let admin: APIRequestContext;
let fixture: Fixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const smtp = await admin.put("/api/settings/smtp", {
    data: {
      host: smtpHost,
      port: 1025,
      security: "none",
      username: null,
      password: null,
      from: "orrery@orrery.test",
    },
  });
  expect(smtp.status()).toBe(200);
  fixture = await seedFixture();
});

test.afterAll(async () => {
  await admin?.dispose();
});

async function mailToken(to: string, subject: string, pattern: RegExp): Promise<string> {
  const matcher = async (): Promise<string | undefined> => {
    const list = await admin.get(`${mailpit}/api/v1/messages`);
    const messages = field(await list.json(), "messages");
    if (!Array.isArray(messages)) return undefined;
    for (const message of messages) {
      if (field(message, "Subject") !== subject) continue;
      const id = field(message, "ID");
      if (typeof id !== "string") continue;
      const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
      const body: unknown = await detail.json();
      const recipients = field(body, "To");
      if (
        !Array.isArray(recipients) ||
        !recipients.some((entry) => field(entry, "Address") === to)
      ) {
        continue;
      }
      const content = field(body, "Text");
      if (typeof content !== "string") continue;
      const match = pattern.exec(content);
      if (match?.[1] !== undefined) return match[1];
    }
    return undefined;
  };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const token = await matcher();
    if (token !== undefined) return token;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No ${subject} email for ${to}`);
}

async function ensureAdminVerified() {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await session.json(), "emailVerified") === true) return;
  const sent = await admin.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
  const token = await mailToken(
    ADMIN_EMAIL,
    "Verify your Orrery email",
    /\/settings\/smtp\?token=([A-Za-z0-9_-]+)/,
  );
  const verified = await admin.post("/api/settings/email-verification", { data: { token } });
  expect(verified.status()).toBe(200);
}

async function seedFixture(): Promise<Fixture> {
  await ensureAdminVerified();
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Delegate prompt ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Delegate prompt repo" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");
  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Delegate with instructions" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");
  const second = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Delegate again with remembered choices" },
  });
  expect(second.status()).toBe(201);
  const secondIssueId = text(field(await second.json(), "id"), "second issue id");

  const agentName = `prompt-agent-${randomUUID().slice(0, 6)}`;
  const agent = await admin.post("/api/agents", { data: { name: agentName } });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");

  const verifier = randomBytes(32).toString("hex");
  const device = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: "e2e-delegate-prompt-laptop",
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(device.status()).toBe(201);
  const deviceBody = await device.json();
  const approval = await admin.post(
    `/api/runners/device-codes/${text(field(deviceBody, "userCode"), "user code")}/approve`,
    { data: {} },
  );
  expect(approval.status()).toBe(200);
  const exchanged = await admin.post("/api/runners/device-codes/token", {
    data: { deviceCode: text(field(deviceBody, "deviceCode"), "device code"), verifier },
  });
  expect(exchanged.status()).toBe(200);
  const credential = text(field(await exchanged.json(), "credential"), "host credential");
  await recordSecret(credential);

  const runnerDisplayName = `e2e-prompt-runner-${randomUUID().slice(0, 6)}`;
  const runnerApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  let runnerId = "";
  try {
    const registered = await runnerApi.post("/api/runners/register", {
      data: {
        workspaceId,
        projectId,
        agentId,
        displayName: runnerDisplayName,
        repoFingerprint: sha256("/private/local/delegate-prompt-repo"),
        capabilities: ["opencode"],
      },
    });
    expect(registered.status()).toBe(201);
    runnerId = text(field(await registered.json(), "id"), "runner id");
  } finally {
    await runnerApi.dispose();
  }

  const teammateEmail = `delegate-prompt-teammate.${randomUUID()}@orrery.test`;
  await recordSecret(TEAMMATE_PASSWORD);
  const invited = await admin.post("/api/invitations/installation", {
    data: { email: teammateEmail },
  });
  expect(invited.status()).toBe(201);
  const registrationToken = await mailToken(
    teammateEmail,
    "Your Orrery invitation",
    /\/register\?token=([A-Za-z0-9_-]+)/,
  );
  const teammateApi = await request.newContext({ baseURL: baseUrl });
  try {
    const registered = await admin.post("/api/invitations/installation/registration", {
      data: { token: registrationToken, password: TEAMMATE_PASSWORD },
    });
    expect(registered.status()).toBe(200);
    const signedIn = await teammateApi.post("/api/auth/login", {
      data: { email: teammateEmail, password: TEAMMATE_PASSWORD },
    });
    expect(signedIn.status()).toBe(200);
    const workspaceInvite = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
      data: { email: teammateEmail },
    });
    expect(workspaceInvite.status()).toBe(201);
    const workspaceToken = await mailToken(
      teammateEmail,
      "Your Orrery workspace invitation",
      /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/,
    );
    const accepted = await teammateApi.post("/api/workspace-invitations/acceptance", {
      data: { token: workspaceToken },
    });
    expect(accepted.status()).toBe(200);
  } finally {
    await teammateApi.dispose();
  }
  const grant = await admin.patch(`/api/projects/${projectId}/access`, {
    data: { email: teammateEmail, level: "read" },
  });
  expect(grant.status()).toBe(200);

  return {
    workspaceId,
    projectId,
    issueId,
    secondIssueId,
    runnerId,
    runnerDisplayName,
    hostCredential: credential,
    agentId,
    agentName,
    teammateEmail,
  };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
}

async function openDelegateDialog(page: Page) {
  await page.locator("[data-delegate-trigger]").click();
  const dialog = page.getByRole("dialog", { name: "Delegate to Runner" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the modal saves a custom prompt and remembers Runner and Agent but never the prompt", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/issues/${fixture.issueId}`);
    const dialog = await openDelegateDialog(page);
    await dialog.getByRole("combobox", { name: "Runner" }).click();
    await dialog.getByRole("option", { name: new RegExp(fixture.runnerDisplayName) }).click();
    await dialog.getByRole("combobox", { name: /^Agent/ }).click();
    await dialog.getByRole("option", { name: new RegExp(fixture.agentName) }).click();
    const promptField = dialog.getByRole("textbox", { name: /Prompt/ });
    await expect(promptField).toHaveAttribute("maxlength", "16000");
    await promptField.fill(`  ${PROMPT}  `);
    await dialog.locator("[data-delegate-dispatch]").click();
    await expect(page.getByText(/Delegated to/).first()).toBeVisible();

    const list = await admin.get(`/api/issues/${fixture.issueId}/dispatches`);
    expect(list.status()).toBe(200);
    const dispatches = field(await list.json(), "dispatches");
    expect(dispatches).toHaveLength(1);
    const first = Array.isArray(dispatches) ? dispatches[0] : undefined;
    expect(field(first, "prompt")).toBe(PROMPT);

    const stored = await page.evaluate(
      (projectId) => window.localStorage.getItem(`orrery.delegate.${projectId}`),
      fixture.projectId,
    );
    expect(JSON.parse(stored ?? "{}")).toMatchObject({
      runnerId: fixture.runnerId,
      agentId: fixture.agentId,
    });
    expect(stored).not.toContain(PROMPT);

    await page.goto(`/issues/${fixture.secondIssueId}`);
    const secondDialog = await openDelegateDialog(page);
    await expect(secondDialog.getByRole("combobox", { name: "Runner" })).toContainText(
      fixture.runnerDisplayName,
    );
    await expect(secondDialog.getByRole("combobox", { name: /^Agent/ })).toContainText(
      fixture.agentName,
    );
    await expect(secondDialog.getByRole("textbox", { name: /Prompt/ })).toHaveValue("");
  } finally {
    await context.close();
  }
});

test("a project reader can expand the custom prompt in Live Session Studio", async ({
  browser,
}) => {
  const list = await admin.get(`/api/issues/${fixture.issueId}/dispatches`);
  expect(list.status()).toBe(200);
  const dispatches = field(await list.json(), "dispatches");
  const first = Array.isArray(dispatches) ? dispatches[0] : undefined;
  const dispatchId = text(field(first, "id"), "dispatch id");

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page, fixture.teammateEmail, TEAMMATE_PASSWORD);
    await page.goto(
      `/live/${fixture.runnerId}/${dispatchId}?issueId=${fixture.issueId}&workspaceId=${fixture.workspaceId}`,
    );
    const promptSection = page.locator("[data-dispatch-prompt]");
    await expect(promptSection).toBeVisible();
    await promptSection.getByText("Show the full prompt").click();
    await expect(promptSection.getByText(PROMPT)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a mismatched issue binding never shows another issue's dispatch prompt", async ({
  browser,
}) => {
  // A fresh issue keeps this binding check independent of earlier dispatches.
  const bound = await admin.post(`/api/projects/${fixture.projectId}/issues`, {
    data: { title: "Bound dispatch issue" },
  });
  expect(bound.status()).toBe(201);
  const boundIssueId = text(field(await bound.json(), "id"), "bound issue id");
  const created = await admin.post(`/api/issues/${boundIssueId}/dispatches`, {
    data: { runnerId: fixture.runnerId, prompt: PROMPT },
  });
  expect(created.status()).toBe(201);
  const dispatchId = text(field(await created.json(), "id"), "dispatch id");

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(
      `/live/${fixture.runnerId}/${dispatchId}?issueId=${fixture.secondIssueId}&workspaceId=${fixture.workspaceId}`,
    );
    await expect(page.locator("[data-studio-branch]")).toContainText("branch unknown");
    await expect(page.locator("[data-dispatch-prompt]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("an uncertain dispatch is visible to a reader but only resolvable by its owner", async ({
  browser,
}) => {
  const created = await admin.post(`/api/runners/${fixture.runnerId}/dispatches`, {
    headers: { authorization: `Bearer ${fixture.hostCredential}` },
    data: { issueId: fixture.secondIssueId },
  });
  expect(created.status()).toBe(201);
  const dispatchId = text(field(await created.json(), "id"), "dispatch id");
  const accepted = await admin.post(
    `/api/runners/${fixture.runnerId}/dispatches/${dispatchId}/accept`,
    { headers: { authorization: `Bearer ${fixture.hostCredential}` }, data: {} },
  );
  expect(accepted.status()).toBe(200);
  const reconnected = await admin.post(`/api/runners/${fixture.runnerId}/reconnect`, {
    headers: { authorization: `Bearer ${fixture.hostCredential}` },
    data: { activeAttempts: [] },
  });
  expect(reconnected.status()).toBe(200);

  const studio = `/live/${fixture.runnerId}/${dispatchId}?issueId=${fixture.secondIssueId}&workspaceId=${fixture.workspaceId}`;
  const readerContext = await browser.newContext({ baseURL: baseUrl });
  try {
    const readerPage = await readerContext.newPage();
    await signIn(readerPage, fixture.teammateEmail, TEAMMATE_PASSWORD);
    await readerPage.goto(studio);
    await expect(readerPage.locator("[data-uncertain-dispatch]")).toBeVisible();
    await expect(readerPage.locator("[data-resolve-dispatch]")).toHaveCount(0);
  } finally {
    await readerContext.close();
  }

  const ownerContext = await browser.newContext({ baseURL: baseUrl });
  try {
    const ownerPage = await ownerContext.newPage();
    await signIn(ownerPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await ownerPage.goto(studio);
    await expect(ownerPage.locator("[data-uncertain-dispatch]")).toBeVisible();
    await expect(ownerPage.locator("[data-resolve-dispatch]")).toHaveCount(2);
  } finally {
    await ownerContext.close();
  }
});

test("a project reader sees Recent dispatches with execution metadata on the issue page", async ({
  browser,
}) => {
  const createdIssue = await admin.post(`/api/projects/${fixture.projectId}/issues`, {
    data: { title: "Reader visibility fixture" },
  });
  expect(createdIssue.status()).toBe(201);
  const issueId = text(field(await createdIssue.json(), "id"), "issue id");
  const created = await admin.post(`/api/issues/${issueId}/dispatches`, {
    data: {
      runnerId: fixture.runnerId,
      prompt: "Reader-visible issue instructions.",
      harness: "opencode",
      model: "stub-model-2",
      effort: "high",
    },
  });
  expect(created.status()).toBe(201);

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page, fixture.teammateEmail, TEAMMATE_PASSWORD);
    await page.goto(`/issues/${issueId}`);
    await expect(page.getByText("Recent dispatches", { exact: true })).toBeVisible();
    await expect(page.getByText("Waiting for the Runner")).toBeVisible();
    const options = page.locator("[data-dispatch-options]").first();
    await expect(options).toContainText("opencode");
    await expect(options).toContainText("stub-model-2");
    await expect(options).toContainText("high");
    // Reader visibility must not expose owner-only delegation controls.
    await expect(page.locator("[data-delegate-trigger]")).toHaveCount(0);
    await expect(page.locator("[data-delegate-dialog]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

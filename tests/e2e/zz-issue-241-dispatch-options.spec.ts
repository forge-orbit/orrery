import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;
const smtpHost = process.env.MAILPIT_SMTP_HOST ?? "mailpit";

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
  agentId: string;
  agentName: string;
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

async function ensureAdminVerified() {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await session.json(), "emailVerified") === true) return;
  const sent = await admin.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
}

async function seedFixture(): Promise<Fixture> {
  await ensureAdminVerified();
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Dispatch options ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Dispatch options repo" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");

  const agentName = `options-agent-${randomUUID().slice(0, 6)}`;
  const agent = await admin.post("/api/agents", { data: { name: agentName } });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");

  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Delegate with a Harness and model" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");
  const second = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Delegate again with a different model" },
  });
  expect(second.status()).toBe(201);
  const secondIssueId = text(field(await second.json(), "id"), "second issue id");

  const verifier = randomBytes(32).toString("hex");
  const device = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: "e2e-options-laptop",
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

  const runnerDisplayName = `e2e-options-runner-${randomUUID().slice(0, 6)}`;
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
        repoFingerprint: sha256("/private/local/dispatch-options-repo"),
        capabilities: ["opencode"],
        harnessCatalog: {
          probedAt: "2026-01-01T00:00:00.000Z",
          harnesses: [
            {
              id: "opencode",
              displayName: "OpenCode",
              defaultModel: "stub-model-1",
              models: [
                {
                  id: "stub-model-1",
                  label: "Stub Model 1",
                  reasoningDiscovery: "known",
                  supportedEfforts: ["low", "high"],
                  defaultEffort: "low",
                },
                { id: "stub-model-2", label: "Stub Model 2", reasoningDiscovery: "unknown" },
              ],
              probedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(registered.status()).toBe(201);
    runnerId = text(field(await registered.json(), "id"), "runner id");
  } finally {
    await runnerApi.dispose();
  }

  return {
    workspaceId,
    projectId,
    issueId,
    secondIssueId,
    runnerId,
    runnerDisplayName,
    agentId,
    agentName,
  };
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
}

async function openDelegateDialog(page: Page) {
  await page.locator("[data-delegate-trigger]").click();
  const dialog = page.getByRole("dialog", { name: "Delegate to Runner" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseRunner(dialog: Locator) {
  await dialog.getByRole("combobox", { name: "Runner" }).click();
  await dialog.getByRole("option", { name: new RegExp(fixture.runnerDisplayName) }).click();
}

test("the modal dispatches the selected Harness, Model and Effort and remembers them", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/issues/${fixture.issueId}`);
    const dialog = await openDelegateDialog(page);
    await chooseRunner(dialog);
    await expect(dialog.locator("[data-delegate-harness]")).toBeVisible();
    await dialog.getByRole("combobox", { name: /^Harness/ }).click();
    await dialog.getByRole("option", { name: /OpenCode/ }).click();
    await expect(dialog.locator("[data-harness-logo]").first()).toBeVisible();
    await dialog.getByRole("combobox", { name: /^Agent/ }).click();
    await dialog.getByRole("option", { name: new RegExp(fixture.agentName) }).click();
    await dialog.getByRole("combobox", { name: /^Model/ }).click();
    await dialog.getByRole("option", { name: /Stub Model 1/ }).click();
    await dialog.getByRole("combobox", { name: /^Effort/ }).click();
    await dialog.getByRole("option", { name: /high/ }).click();
    await dialog.locator("[data-delegate-dispatch]").click();
    await expect(page.getByText(/Delegated to/).first()).toBeVisible();

    const list = await admin.get(`/api/issues/${fixture.issueId}/dispatches`);
    expect(list.status()).toBe(200);
    const dispatches = field(await list.json(), "dispatches");
    const first = Array.isArray(dispatches) ? dispatches[0] : undefined;
    expect(field(first, "harness")).toBe("opencode");
    expect(field(first, "model")).toBe("stub-model-1");
    expect(field(first, "effort")).toBe("high");
    await expect(page.locator("[data-dispatch-options]").first()).toContainText("high");

    const stored = await page.evaluate(
      (projectId) => window.localStorage.getItem(`orrery.delegate.${projectId}`),
      fixture.projectId,
    );
    expect(JSON.parse(stored ?? "{}")).toMatchObject({
      runnerId: fixture.runnerId,
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
      agentId: fixture.agentId,
    });

    const dispatchId = text(field(first, "id"), "dispatch id");
    await page.goto(
      `/live/${fixture.runnerId}/${dispatchId}?issueId=${fixture.issueId}&workspaceId=${fixture.workspaceId}`,
    );
    await expect(page.locator("[data-studio-options]")).toContainText("stub-model-1");
    await expect(page.locator("[data-studio-options]")).toContainText("effort high");
    await expect(page.locator("[data-studio-options] [data-harness-logo]").first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("switching Model immediately clears stale Effort and hides it for unprobed models", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/issues/${fixture.secondIssueId}`);
    const dialog = await openDelegateDialog(page);
    await chooseRunner(dialog);
    await dialog.getByRole("combobox", { name: /^Harness/ }).click();
    await dialog.getByRole("option", { name: /OpenCode/ }).click();
    await dialog.getByRole("combobox", { name: /^Model/ }).click();
    await dialog.getByRole("option", { name: /Stub Model 1/ }).click();
    await dialog.getByRole("combobox", { name: /^Effort/ }).click();
    await dialog.getByRole("option", { name: /high/ }).click();

    // A model without selectable reasoning levels hides Effort entirely.
    await dialog.getByRole("combobox", { name: /^Model/ }).click();
    await dialog.getByRole("option", { name: /Stub Model 2/ }).click();
    await expect(dialog.locator("[data-delegate-effort]")).toHaveCount(0);

    // Switching back must not resurrect the previously chosen effort.
    await dialog.getByRole("combobox", { name: /^Model/ }).click();
    await dialog.getByRole("option", { name: /Stub Model 1/ }).click();
    await expect(dialog.locator("[data-delegate-effort]")).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: /^Effort/ })).toContainText(
      /Choose a reasoning effort/,
    );

    await dialog.locator("[data-delegate-dispatch]").click();
    await expect(page.getByText(/Delegated to/).first()).toBeVisible();
    const list = await admin.get(`/api/issues/${fixture.secondIssueId}/dispatches`);
    const dispatches = field(await list.json(), "dispatches");
    const first = Array.isArray(dispatches) ? dispatches[0] : undefined;
    expect(field(first, "model")).toBe("stub-model-1");
    expect(field(first, "effort")).toBeUndefined();
  } finally {
    await context.close();
  }
});

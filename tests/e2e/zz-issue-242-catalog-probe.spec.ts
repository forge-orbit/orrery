import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
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
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

interface Fixture {
  workspaceId: string;
  projectId: string;
  issueId: string;
  runnerId: string;
  runnerDisplayName: string;
  agentName: string;
  credential: string;
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

async function seedFixture(): Promise<Fixture> {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await session.json(), "emailVerified") !== true) {
    const sent = await admin.post("/api/settings/smtp/test");
    expect(sent.status()).toBe(200);
  }
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Catalog probe ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Catalog probe repo" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");
  const agentName = `probe-agent-${randomUUID().slice(0, 6)}`;
  const agent = await admin.post("/api/agents", { data: { name: agentName } });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");
  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Probe a model before delegating" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");

  const verifier = randomBytes(32).toString("hex");
  const device = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: "e2e-probe-laptop",
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(device.status()).toBe(201);
  const deviceBody = await device.json();
  const userCode = text(field(deviceBody, "userCode"), "user code");
  const approval = await admin.post(`/api/runners/device-codes/${userCode}/approve`, { data: {} });
  expect(approval.status()).toBe(200);
  const exchanged = await admin.post("/api/runners/device-codes/token", {
    data: { deviceCode: text(field(deviceBody, "deviceCode"), "device code"), verifier },
  });
  expect(exchanged.status()).toBe(200);
  const credential = text(field(await exchanged.json(), "credential"), "host credential");
  await recordSecret(credential);

  const runnerDisplayName = `e2e-probe-runner-${randomUUID().slice(0, 6)}`;
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
        repoFingerprint: sha256("/private/local/catalog-probe-repo"),
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
  return { workspaceId, projectId, issueId, runnerId, runnerDisplayName, agentName, credential };
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
}

async function openDialog(page: Page) {
  await page.goto(`/issues/${fixture.issueId}`);
  await page.locator("[data-delegate-trigger]").click();
  const dialog = page.getByRole("dialog", { name: "Delegate to Runner" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Runner" }).click();
  await dialog.getByRole("option", { name: new RegExp(fixture.runnerDisplayName) }).click();
  await dialog.getByRole("combobox", { name: /^Harness/ }).click();
  await dialog.getByRole("option", { name: /OpenCode/ }).click();
  return dialog;
}

test("an unprobed model clears stale effort, probes non-blockingly, and updates live", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  const probes: Array<Record<string, unknown>> = [];
  // Keep the request pending briefly so the loading state is observable and
  // the server-side cooldown does not affect other tests in this spec.
  await page.route("**/api/runners/*/catalog/probe", async (route) => {
    const body = record(route.request().postDataJSON());
    probes.push(body);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commandId: `probe-${randomUUID()}`,
        kind: body.kind === "catalog" ? "probe_catalog" : "probe_model",
        cooldownSeconds: 30,
      }),
    });
  });
  try {
    await signIn(page);
    const dialog = await openDialog(page);
    await dialog.getByRole("combobox", { name: /^Model/ }).click();
    await dialog.getByRole("option", { name: /Stub Model 1/ }).click();
    await dialog.getByRole("combobox", { name: /^Effort/ }).click();
    await dialog.getByRole("option", { name: /high/i }).click();

    await dialog.getByRole("combobox", { name: /^Model/ }).click();
    await dialog.getByRole("option", { name: /Stub Model 2/ }).click();
    await expect(dialog.getByRole("combobox", { name: /^Effort/ })).toContainText(
      /Use the model default effort/,
    );
    await expect(dialog.locator("[data-delegate-dispatch]")).toBeEnabled();
    await expect
      .poll(() => probes)
      .toEqual([{ kind: "model", harness: "opencode", model: "stub-model-2" }]);
    // The enqueue reply is not the probe result: the pending indicator must
    // survive it while the catalog is still stale.
    await expect(dialog.getByText("Discovering reasoning levels…")).toBeVisible();
    await expect(dialog.locator("[data-delegate-effort]")).toBeVisible();

    // The Runner publishes the discovered efforts; the open dialog picks them
    // up through the live catalog query without a reload or a click.
    const runnerApi = await request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders: { authorization: `Bearer ${fixture.credential}` },
    });
    try {
      const stamp = new Date().toISOString();
      const published = await runnerApi.put(`/api/runners/${fixture.runnerId}/catalog`, {
        data: {
          probedAt: stamp,
          harnesses: [
            {
              id: "opencode",
              displayName: "OpenCode",
              defaultModel: "stub-model-1",
              probedAt: stamp,
              models: [
                {
                  id: "stub-model-1",
                  label: "Stub Model 1",
                  reasoningDiscovery: "known",
                  supportedEfforts: ["low", "high"],
                  defaultEffort: "low",
                },
                {
                  id: "stub-model-2",
                  label: "Stub Model 2",
                  reasoningDiscovery: "known",
                  supportedEfforts: ["balanced", "fast"],
                  defaultEffort: "balanced",
                },
              ],
            },
          ],
        },
      });
      expect(published.status()).toBe(200);
    } finally {
      await runnerApi.dispose();
    }
    const effortSelector = dialog.getByRole("combobox", { name: /^Effort/ });
    await expect(effortSelector).not.toHaveAttribute("aria-busy", "true", { timeout: 12_000 });
    await effortSelector.click();
    await expect(dialog.getByRole("option", { name: /balanced/i })).toBeVisible();
    await effortSelector.press("Escape");
    await expect(dialog.getByText("Discovering reasoning levels…")).toHaveCount(0);
    await expect(dialog.locator("[data-delegate-dispatch]")).toBeEnabled();
  } finally {
    await context.close();
  }
});

test("Refresh catalog is available for a Runner with an empty catalog", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  const probes: Array<Record<string, unknown>> = [];
  await page.route("**/api/runners/*/catalog/probe", async (route) => {
    probes.push(record(route.request().postDataJSON()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commandId: `empty-refresh-${randomUUID()}`,
        kind: "probe_catalog",
        cooldownSeconds: 30,
      }),
    });
  });
  const emptyDisplayName = `e2e-empty-catalog-${randomUUID().slice(0, 6)}`;
  const runnerApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${fixture.credential}` },
  });
  try {
    // A never-probed Runner publishes no harnesses at all — exactly the case
    // where a manual refresh must still be reachable.
    const registered = await runnerApi.post("/api/runners/register", {
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        displayName: emptyDisplayName,
        repoFingerprint: sha256("/private/local/empty-catalog-repo"),
        capabilities: [],
      },
    });
    expect(registered.status()).toBe(201);
    await signIn(page);
    await page.goto(`/issues/${fixture.issueId}`);
    await page.locator("[data-delegate-trigger]").click();
    const dialog = page.getByRole("dialog", { name: "Delegate to Runner" });
    await dialog.getByRole("combobox", { name: "Runner" }).click();
    await dialog.getByRole("option", { name: new RegExp(emptyDisplayName) }).click();
    await expect(dialog.getByRole("combobox", { name: /^Harness/ })).toContainText(
      /Use the Runner's default Harness/,
    );
    const refresh = dialog.locator("[data-delegate-refresh-catalog]");
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect.poll(() => probes).toEqual([{ kind: "catalog" }]);
    await expect(dialog.locator("[data-delegate-dispatch]")).toBeEnabled();
  } finally {
    await runnerApi.dispose();
    await context.close();
  }
});

test("Refresh catalog requests a runner-level catalog probe", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  const probes: Array<Record<string, unknown>> = [];
  await page.route("**/api/runners/*/catalog/probe", async (route) => {
    probes.push(record(route.request().postDataJSON()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commandId: `refresh-${randomUUID()}`,
        kind: "probe_catalog",
        cooldownSeconds: 30,
      }),
    });
  });
  try {
    await signIn(page);
    const dialog = await openDialog(page);
    const refresh = dialog.locator("[data-delegate-refresh-catalog]");
    await refresh.click();
    await expect.poll(() => probes).toEqual([{ kind: "catalog" }]);
    // Same lifetime rule as the Effort indicator: the enqueue reply is not the
    // probe result, so the button stays busy until a catalog update or the cap.
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(dialog.locator("[data-delegate-dispatch]")).toBeEnabled();
    await expect(refresh).not.toHaveAttribute("aria-busy", "true", { timeout: 12_000 });
  } finally {
    await context.close();
  }
});

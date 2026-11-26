import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (baseUrl === undefined || baseUrl === "") {
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const at = new Date().toISOString();

/** Two Harnesses with different models and effort levels (issue #241). */
const harnessCatalog = {
  harnesses: [
    {
      id: "opencode",
      displayName: "OpenCode",
      source: "preset",
      defaultModel: "stub-fast",
      models: [
        {
          id: "stub-fast",
          label: "Stub Fast",
          reasoningDiscovery: "known",
          effortLevels: ["low", "medium", "high"],
          defaultEffort: "medium",
          probedAt: at,
        },
        {
          id: "stub-deep",
          label: "Stub Deep",
          reasoningDiscovery: "known",
          effortLevels: ["low"],
          defaultEffort: "low",
          probedAt: at,
        },
      ],
      probedAt: at,
    },
    {
      id: "codex",
      displayName: "Codex",
      source: "preset",
      defaultModel: "codex-mini",
      models: [
        {
          id: "codex-mini",
          label: "Codex Mini",
          reasoningDiscovery: "unknown",
          effortLevels: [],
          defaultEffort: null,
          probedAt: null,
        },
      ],
      probedAt: at,
    },
  ],
  updatedAt: at,
};

let admin: APIRequestContext;

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await admin?.dispose();
});

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  issueId: string;
  runnerId: string;
  runnerName: string;
}

const seedFixture = async (runnerName: string): Promise<Fixture> => {
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Dispatch options ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Dispatch options project" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");
  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Dispatch with execution options" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");
  const agent = await admin.post("/api/agents", {
    data: { name: `options-agent-${randomUUID().slice(0, 6)}` },
  });
  expect(agent.status()).toBe(201);

  const verifier = randomBytes(32).toString("hex");
  const created = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: `options-laptop-${randomUUID().slice(0, 6)}`,
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(created.status()).toBe(201);
  const device = await created.json();
  await admin.post(
    `/api/runners/device-codes/${text(field(device, "userCode"), "user code")}/approve`,
    { data: {} },
  );
  const exchanged = await admin.post("/api/runners/device-codes/token", {
    data: { deviceCode: text(field(device, "deviceCode"), "device code"), verifier },
  });
  expect(exchanged.status()).toBe(200);
  const hostCredential = text(field(await exchanged.json(), "credential"), "host credential");
  await recordSecret(hostCredential);

  const hostApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${hostCredential}` },
  });
  let runnerId = "";
  try {
    const registered = await hostApi.post("/api/runners/register", {
      data: {
        workspaceId,
        projectId,
        agentId: text(field(await agent.json(), "id"), "agent id"),
        displayName: runnerName,
        repoFingerprint: sha256(`/private/local/${runnerName}`),
        capabilities: ["opencode"],
        maxConcurrency: 1,
        harnessCatalog,
      },
    });
    expect(registered.status()).toBe(201);
    runnerId = text(field(await registered.json(), "id"), "runner id");
  } finally {
    await hostApi.dispose();
  }

  return { workspaceId, projectId, issueId, runnerId, runnerName };
};

const openDelegate = async (page: Page, fixture: Fixture) => {
  await page.goto(`/issues/${fixture.issueId}`);
  await page.locator("[data-delegate-trigger]").click();
  await expect(page.locator("[data-delegate-dialog]")).toBeVisible();
  await page.getByRole("combobox", { name: "Runner" }).click();
  await page.getByRole("option", { name: new RegExp(fixture.runnerName) }).click();
};

const latestDispatch = async (issueId: string) => {
  const listed = await admin.get(`/api/issues/${issueId}/dispatches`);
  expect(listed.status()).toBe(200);
  const body: unknown = await listed.json();
  const dispatches = field(body, "dispatches");
  if (!Array.isArray(dispatches) || dispatches.length === 0)
    throw new Error("no dispatch was created");
  const first: unknown = dispatches[0];
  if (typeof first !== "object" || first === null) throw new Error("malformed dispatch");
  return Object.fromEntries(Object.entries(first));
};

test("the modal selects Harness, Model and Effort from the Runner catalog", async ({ browser }) => {
  const fixture = await seedFixture(`options-runner-${randomUUID().slice(0, 6)}`);
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await openDelegate(page, fixture);

    // Selecting the Runner fills the Harness from its catalog and picks the
    // Harness's default model.
    await expect(page.getByRole("combobox", { name: "Harness" })).toContainText("OpenCode");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText("Stub Fast");

    // Effort levels come from the selected model.
    await page.getByRole("combobox", { name: "Effort" }).click();
    await page.getByRole("option", { name: "High" }).click();
    await expect(page.getByRole("combobox", { name: "Effort" })).toContainText("High");

    // Switching the model clears the stale effort immediately: Stub Deep only
    // supports low, so a lingering "High" must never be submitted.
    await page.getByRole("combobox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Stub Deep" }).click();
    await expect(page.getByRole("combobox", { name: "Effort" })).toContainText(
      "Use the model default effort",
    );

    await page.locator("[data-delegate-dispatch]").click();
    await expect(page.getByText("Waiting for the Runner")).toBeVisible();

    const dispatch = await latestDispatch(fixture.issueId);
    expect(dispatch).toMatchObject({ harness: "opencode", model: "stub-deep", effort: null });
  } finally {
    await context.close();
  }
});

test("the modal remembers choices and falls back when a Harness disappears", async ({
  browser,
}) => {
  const fixture = await seedFixture(`remember-runner-${randomUUID().slice(0, 6)}`);
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await openDelegate(page, fixture);
    await page.getByRole("combobox", { name: "Model" }).click();
    await page.getByRole("option", { name: "Stub Deep" }).click();
    await page.getByRole("combobox", { name: "Effort" }).click();
    await page.getByRole("option", { name: "Low" }).click();
    await page.locator("[data-delegate-dispatch]").click();
    await expect(page.getByText("Waiting for the Runner")).toBeVisible();

    const memory = await page.evaluate(
      (projectId) =>
        JSON.parse(window.localStorage.getItem(`orrery.delegate.${projectId}`) ?? "{}"),
      fixture.projectId,
    );
    expect(memory).toMatchObject({
      runnerId: fixture.runnerId,
      harness: "opencode",
      model: "stub-deep",
      effort: "low",
    });

    // Reopening restores the remembered execution options.
    await page.locator("[data-delegate-trigger]").click();
    await expect(page.getByRole("combobox", { name: "Harness" })).toContainText("OpenCode");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText("Stub Deep");
    await expect(page.getByRole("combobox", { name: "Effort" })).toContainText("Low");

    // Switching Harness clears effort and hides the Effort selector when the
    // new model advertises no levels.
    await page.getByRole("combobox", { name: "Harness" }).click();
    await page.getByRole("option", { name: "Codex" }).click();
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText("Codex Mini");
    await expect(page.getByRole("combobox", { name: "Effort" })).toHaveCount(0);

    // A remembered Harness that no longer exists falls back to the first one.
    await page.evaluate(
      (projectId) =>
        window.localStorage.setItem(
          `orrery.delegate.${projectId}`,
          JSON.stringify({ runnerId: "", harness: "gone", model: "gone", effort: "high" }),
        ),
      fixture.projectId,
    );
    await page.reload();
    await openDelegate(page, fixture);
    await expect(page.getByRole("combobox", { name: "Harness" })).toContainText("OpenCode");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText("Stub Fast");
  } finally {
    await context.close();
  }
});

test("Recent dispatches and Live Session Studio show Harness, model and effort", async ({
  browser,
}) => {
  const fixture = await seedFixture(`studio-runner-${randomUUID().slice(0, 6)}`);
  const created = await admin.post(`/api/issues/${fixture.issueId}/dispatches`, {
    data: {
      runnerId: fixture.runnerId,
      harness: "opencode",
      model: "stub-deep",
      effort: "low",
    },
  });
  expect(created.status()).toBe(201);
  const dispatch = await created.json();
  expect(dispatch).toMatchObject({ harness: "opencode", model: "stub-deep", effort: "low" });

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/issues/${fixture.issueId}`);
    const recent = page.locator("[data-dispatch-options]").first();
    await expect(recent).toContainText("OpenCode");
    await expect(recent).toContainText("stub-deep");
    await expect(recent).toContainText("low effort");
    await expect(recent.locator('[data-harness-logo="opencode"]')).toBeVisible();

    await page.getByRole("link", { name: "Open Live Studio" }).click();
    const studio = page.locator("[data-studio-options]");
    await expect(studio).toContainText("OpenCode");
    await expect(studio).toContainText("stub-deep");
    await expect(studio).toContainText("low effort");
    await expect(studio.locator('[data-harness-logo="opencode"]')).toBeVisible();
  } finally {
    await context.close();
  }
});

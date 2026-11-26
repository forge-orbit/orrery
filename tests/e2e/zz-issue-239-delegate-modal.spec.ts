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
  hostId: string;
  hostCredential: string;
}

const seedFixture = async (runnerName: string): Promise<Fixture> => {
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Delegate modal ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Delegate project" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");
  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Delegate me through the modal" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");
  const agent = await admin.post("/api/agents", {
    data: { name: `delegate-agent-${randomUUID().slice(0, 6)}` },
  });
  expect(agent.status()).toBe(201);

  const verifier = randomBytes(32).toString("hex");
  const created = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: "delegate-laptop",
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(created.status()).toBe(201);
  const device = await created.json();
  await admin.post(
    `/api/runners/device-codes/${text(field(device, "userCode"), "user code")}/approve`,
    {
      data: {},
    },
  );
  const exchanged = await admin.post("/api/runners/device-codes/token", {
    data: { deviceCode: text(field(device, "deviceCode"), "device code"), verifier },
  });
  expect(exchanged.status()).toBe(200);
  const hostCredential = text(field(await exchanged.json(), "credential"), "host credential");
  const hostId = text(field(await exchanged.json(), "hostId"), "host id");
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
        repoFingerprint: sha256("/private/local/delegate-repo"),
        capabilities: ["opencode"],
        maxConcurrency: 1,
      },
    });
    expect(registered.status()).toBe(201);
    runnerId = text(field(await registered.json(), "id"), "runner id");
  } finally {
    await hostApi.dispose();
  }

  return { workspaceId, projectId, issueId, runnerId, runnerName, hostId, hostCredential };
};

const dispatchFromModal = async (page: Page, fixture: Fixture, prompt: string) => {
  await page.goto(`/issues/${fixture.issueId}`);
  await page.locator("[data-delegate-trigger]").click();
  const dialog = page.locator("[data-delegate-dialog]");
  await expect(dialog).toBeVisible();

  await page.getByRole("combobox", { name: "Runner" }).click();
  await page.getByRole("option", { name: new RegExp(fixture.runnerName) }).click();
  if (prompt !== "") {
    await dialog.locator("textarea").fill(prompt);
  }
  await page.locator("[data-delegate-dispatch]").click();

  await expect(page.getByText("Waiting for the Runner")).toBeVisible();
};

test("the modal dispatches with a custom prompt and remembers the last-used Runner", async ({
  browser,
}) => {
  const fixture = await seedFixture(`modal-runner-${randomUUID().slice(0, 6)}`);
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await dispatchFromModal(page, fixture, "Keep the change additive and small.");

    // The next modal opens with the remembered Runner preselected (submit is
    // enabled immediately) and a blank prompt.
    await page.locator("[data-delegate-trigger]").click();
    await expect(page.locator("[data-delegate-dialog]")).toBeVisible();
    await expect(page.locator("[data-delegate-dialog] textarea")).toHaveValue("");
    await expect(page.locator("[data-delegate-dispatch]")).toBeEnabled();
    const memory = await page.evaluate(
      (projectId) => window.localStorage.getItem(`orrery.delegate.${projectId}`),
      fixture.projectId,
    );
    expect(memory).not.toBeNull();
    expect(String(memory)).toContain(fixture.runnerId);
  } finally {
    await context.close();
  }
});

test("a remembered Runner that is no longer owned or online falls back cleanly", async ({
  browser,
}) => {
  const fixture = await seedFixture(`offline-runner-${randomUUID().slice(0, 6)}`);
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await dispatchFromModal(page, fixture, "");
    const revoked = await admin.post(`/api/runner-hosts/${fixture.hostId}/revoke`, { data: {} });
    expect(revoked.status()).toBe(200);

    // Fresh navigation, so the fleet query no longer serves the pre-revoke cache.
    await page.goto(`/issues/${fixture.issueId}`);
    await page.locator("[data-delegate-trigger]").click();
    await expect(page.locator("[data-delegate-dialog]")).toBeVisible();
    await expect(page.getByText("No online Runners")).toBeVisible();
    await expect(page.locator("[data-delegate-dispatch]")).toBeDisabled();
  } finally {
    await context.close();
  }
});

test("Live Session Studio shows the custom dispatch prompt, collapsed when long", async ({
  browser,
}) => {
  const short = await seedFixture(`studio-short-${randomUUID().slice(0, 6)}`);
  const created = await admin.post(`/api/issues/${short.issueId}/dispatches`, {
    data: { runnerId: short.runnerId, prompt: "Use the additive migration strategy." },
  });
  expect(created.status()).toBe(201);

  const long = await seedFixture(`studio-long-${randomUUID().slice(0, 6)}`);
  const longPrompt = `${"Be careful with the migration order. ".repeat(12)}Finish with a summary comment.`;
  const createdLong = await admin.post(`/api/issues/${long.issueId}/dispatches`, {
    data: { runnerId: long.runnerId, prompt: longPrompt },
  });
  expect(createdLong.status()).toBe(201);

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/issues/${short.issueId}`);
    await page.getByRole("link", { name: "Open Live Studio" }).click();
    await expect(page.locator("[data-dispatch-prompt]")).toContainText(
      "Use the additive migration strategy.",
    );

    await page.goto(`/issues/${long.issueId}`);
    await page.getByRole("link", { name: "Open Live Studio" }).click();
    const section = page.locator("[data-dispatch-prompt]");
    await expect(section).toContainText("Show the full prompt");
    await expect(section.getByText("Finish with a summary comment.")).toBeHidden();
    await section.getByText("Show the full prompt").click();
    await expect(section.getByText("Finish with a summary comment.")).toBeVisible();
  } finally {
    await context.close();
  }
});

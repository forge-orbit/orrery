import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Fixture {
  workspaceId: string;
  projectId: string;
  issueId: string;
  runnerId: string;
  dispatchId: string;
  dispatchToken: string;
  runId: string;
}

let api: APIRequestContext;
let fixture: Fixture;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  fixture = await seedFixture();
});

test.afterAll(async () => {
  await api?.dispose();
});

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
}

async function enrolledCredential(): Promise<string> {
  const verifier = randomBytes(32).toString("hex");
  await recordSecret(verifier);
  const created = await api.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: `needs-input-laptop-${randomUUID().slice(0, 6)}`,
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(created.status()).toBe(201);
  const device = await created.json();
  const deviceCode = text(field(device, "deviceCode"), "device code");
  await recordSecret(deviceCode);
  const approved = await api.post(
    `/api/runners/device-codes/${text(field(device, "userCode"), "user code")}/approve`,
    { data: {} },
  );
  expect(approved.status()).toBe(200);
  const exchanged = await api.post("/api/runners/device-codes/token", {
    data: { deviceCode, verifier },
  });
  expect(exchanged.status()).toBe(200);
  const credential = text(field(await exchanged.json(), "credential"), "host credential");
  await recordSecret(credential);
  return credential;
}

async function createIssue(title: string): Promise<string> {
  const response = await api.post(`/api/projects/${fixture.projectId}/issues`, {
    data: { title },
  });
  expect(response.status()).toBe(201);
  return text(field(await response.json(), "id"), "issue id");
}

async function seedFixture(): Promise<Fixture> {
  const workspace = await api.post("/api/workspaces", {
    data: { name: `Needs Input ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Needs Input project" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");
  const issue = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Ask the human which migration to use" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");
  const agent = await api.post("/api/agents", {
    data: { name: `needs-input-agent-${randomUUID().slice(0, 6)}` },
  });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");

  const credential = await enrolledCredential();
  const hostApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  try {
    const registered = await hostApi.post("/api/runners/register", {
      data: {
        workspaceId,
        projectId,
        agentId,
        displayName: "needs-input-runner",
        repoFingerprint: sha256("/private/local/needs-input-repo"),
        capabilities: ["opencode"],
        maxConcurrency: 2,
      },
    });
    expect(registered.status()).toBe(201);
    const runnerId = text(field(await registered.json(), "id"), "runner id");
    const dispatched = await api.post(`/api/issues/${issueId}/dispatches`, {
      data: { runnerId },
    });
    expect(dispatched.status()).toBe(201);
    const dispatchId = text(field(await dispatched.json(), "id"), "dispatch id");
    const accepted = await hostApi.post(
      `/api/runners/${runnerId}/dispatches/${dispatchId}/accept`,
      { data: {} },
    );
    expect(accepted.status()).toBe(200);
    const acceptance = await accepted.json();
    const dispatchToken = text(field(acceptance, "dispatchToken"), "dispatch token");
    await recordSecret(dispatchToken);
    const runId = text(field(field(acceptance, "run"), "id"), "run id");
    return { workspaceId, projectId, issueId, runnerId, dispatchId, dispatchToken, runId };
  } finally {
    await hostApi.dispose();
  }
}

async function askQuestion(question: string, fallback: string): Promise<Record<string, unknown>> {
  const client = new Client({ name: `needs-input-e2e-${randomUUID()}`, version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => fixture.dispatchToken },
    }),
  );
  try {
    const result = await client.callTool({
      name: "ask_for_input",
      arguments: {
        issueId: fixture.issueId,
        runId: fixture.runId,
        question,
        proposedFallback: fallback,
      },
    });
    expect(result.isError).not.toBe(true);
    const created = field(result.structuredContent, "question");
    if (typeof created !== "object" || created === null) throw new Error("no question returned");
    return Object.fromEntries(Object.entries(created));
  } finally {
    await client.close();
  }
}

function studioUrl(issueId = fixture.issueId): string {
  return `/live/${fixture.runnerId}/${fixture.dispatchId}?issueId=${issueId}&workspaceId=${fixture.workspaceId}`;
}

async function questionById(questionId: string): Promise<Record<string, unknown>> {
  const response = await api.get(`/api/issues/${fixture.issueId}/questions`);
  expect(response.status()).toBe(200);
  const found = listOf(await response.json()).find((item) => field(item, "id") === questionId);
  if (typeof found !== "object" || found === null) throw new Error("question not found");
  return Object.fromEntries(Object.entries(found));
}

async function questionStatus(questionId: string): Promise<string> {
  return text(field(await questionById(questionId), "status"), "question status");
}

test.describe("Live Session Studio inline Needs Input composer (#201)", () => {
  test.describe.configure({ mode: "serial" });

  test("renders the question, proposed fallback and live deadline countdown", async ({
    browser,
  }) => {
    const questionText = "Which migration strategy should we use?";
    await askQuestion(questionText, "Use the additive migration");
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto(studioUrl());
      const card = page.locator("[data-needs-input-card]");
      await expect(card).toBeVisible();
      await expect(card.locator("[data-needs-input-question]")).toContainText(questionText);
      await expect(card.locator("[data-needs-input-fallback]")).toContainText(
        "Use the additive migration",
      );
      await expect(card.locator("[data-needs-input-deadline]")).toBeVisible();
      await expect(card.locator("[data-needs-input-answer]")).toBeVisible();
      await expect(page.locator("[data-studio-needs-input]")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("submits an inline human answer", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto(studioUrl());
      const card = page.locator("[data-needs-input-card]");
      await expect(card).toBeVisible();
      const questionId = text(await card.getAttribute("data-question-id"), "question id");
      await card.locator("[data-needs-input-answer]").fill("Use the backfill migration");
      await card.locator("[data-needs-input-submit]").click();
      await expect(page.locator("[data-needs-input-card]")).toHaveCount(0);
      expect(await questionStatus(questionId)).toBe("answered");
    } finally {
      await context.close();
    }
  });

  test("submits the proposed fallback with one click", async ({ browser }) => {
    const policy = await api.patch(`/api/projects/${fixture.projectId}/fallback-policy`, {
      data: { fallbackPolicy: "fallback_allowed" },
    });
    expect(policy.status()).toBe(200);
    const asked = await askQuestion("Which migration now?", "Take the safe fallback");
    const questionId = text(field(asked, "id"), "question id");
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page);
      await page.goto(studioUrl());
      const card = page.locator("[data-needs-input-card]");
      await expect(card).toBeVisible();
      await card.locator("[data-needs-input-fallback-submit]").click();
      await expect(page.locator("[data-needs-input-card]")).toHaveCount(0);
      const recorded = await questionById(questionId);
      expect(field(recorded, "status")).toBe("answered");
      expect(field(recorded, "answer")).toBe("Take the safe fallback");
    } finally {
      await context.close();
    }
  });

  test("a paused question needs confirmation, then answers and re-dispatches for real", async ({
    browser,
  }) => {
    // A real question on the seeded issue is answerable through the Inbox API;
    // only the question-list response is presented as `paused` so the Studio
    // renders the require_human state without waiting an actual hour.
    const asked = await askQuestion(
      "The require_human deadline passed. How should I proceed?",
      "Use the additive migration",
    );
    const questionId = text(field(asked, "id"), "question id");
    const issueId = await createIssue("Paused question needs a new dispatch");
    const pausedQuestion = {
      ...asked,
      issueId,
      issueNumber: 99,
      issueTitle: "Paused question needs a new dispatch",
      status: "paused",
      authorizedFallback: null,
      responseDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
      resolvedAt: new Date(Date.now() - 60_000).toISOString(),
      canAnswer: true,
    };
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    const dispatchRequests: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/issues\/[^/]+\/dispatches$/.test(req.url())) {
        dispatchRequests.push(req.url());
      }
    });
    await page.route(`**/api/issues/${issueId}/questions`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([pausedQuestion]),
      });
    });
    try {
      await signIn(page);
      await page.goto(studioUrl(issueId));
      const paused = page.locator("[data-needs-input-paused]");
      await expect(paused).toBeVisible();
      await expect(paused.locator("[data-needs-input-question]")).toContainText(
        "require_human deadline passed",
      );
      await expect(page.locator("[data-studio-paused]")).toBeVisible();
      expect(dispatchRequests).toEqual([]);

      // The action is disabled until a human supplies an answer (or prefills
      // the proposed fallback), so no read-only or empty confirm can dispatch.
      await expect(paused.locator("[data-needs-input-redispatch]")).toBeDisabled();
      await paused
        .locator("[data-needs-input-paused-answer]")
        .fill("Resume with the additive migration");
      await paused.locator("[data-needs-input-redispatch]").click();
      const dialog = page.getByRole("alertdialog", { name: "Re-dispatch this issue?" });
      await expect(dialog).toBeVisible();
      expect(dispatchRequests).toEqual([]);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(dispatchRequests).toEqual([]);

      const answerResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/questions/${questionId}/answer`) &&
          response.request().method() === "POST",
      );
      const dispatchResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/issues/${issueId}/dispatches`) &&
          response.request().method() === "POST",
      );
      await paused.locator("[data-needs-input-redispatch]").click();
      await page
        .getByRole("alertdialog", { name: "Re-dispatch this issue?" })
        .getByRole("button", { name: "Re-dispatch" })
        .click();
      expect((await answerResponse).status()).toBe(200);
      const created = await dispatchResponse;
      expect(created.status()).toBe(201);
      const dispatchId = text(field(await created.json(), "id"), "new dispatch id");
      expect(dispatchRequests).toEqual([`${baseUrl}/api/issues/${issueId}/dispatches`]);
      await expect(page).toHaveURL(
        new RegExp(`/live/${fixture.runnerId}/${dispatchId}\\?issueId=${issueId}`),
      );
    } finally {
      await context.close();
    }
  });
});

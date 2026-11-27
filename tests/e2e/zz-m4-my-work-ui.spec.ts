import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const personal = asArray(await res.json()).find(
    (workspace) => field(workspace, "kind") === "personal",
  );
  return idOf(personal, "personal workspace");
}

async function createProject(client: APIRequestContext, workspaceId: string, label: string) {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `${label} ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  return { id: idOf(body, "project") };
}

async function createIssue(
  client: APIRequestContext,
  projectId: string,
  title: string,
  assigneeHumanId?: string,
) {
  const res = await client.post(`/api/projects/${projectId}/issues`, { data: { title } });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const issue = {
    id: idOf(body, "issue"),
    identifier: requiredText(field(body, "identifier"), "the issue identifier"),
    title,
  };
  if (assigneeHumanId !== undefined) {
    const assigned = await client.patch(`/api/issues/${issue.id}`, {
      data: { assigneeHumanId },
    });
    expect(assigned.status()).toBe(200);
  }
  return issue;
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name: `${name}-${randomUUID()}` } });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(res.status()).toBe(201);
  const secret = requiredText(field(await res.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

async function newRun(client: APIRequestContext, secret: string): Promise<string> {
  const res = await client.post("/api/runs/hook", {
    headers: { Authorization: `Bearer ${secret}` },
    data: {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "my-work-ui-e2e", nativeSessionId: randomUUID() },
      model: "my-work-ui-model",
    },
  });
  expect(res.status()).toBe(200);
  return requiredText(field(await res.json(), "runId"), "the run id");
}

async function claim(
  client: APIRequestContext,
  secret: string,
  issueId: string,
  runId: string,
): Promise<string> {
  const res = await client.post(`/api/issues/${issueId}/work-sessions`, {
    headers: { Authorization: `Bearer ${secret}` },
    data: { runId },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "work session");
}

async function ask(
  client: APIRequestContext,
  secret: string,
  issueId: string,
  runId: string,
  question: string,
): Promise<string> {
  const res = await client.post("/api/questions", {
    headers: { Authorization: `Bearer ${secret}` },
    data: { issueId, runId, question, proposedFallback: "Use the safe default" },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "question");
}

let api: APIRequestContext;
let agentApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);

  agentApi = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await api?.dispose();
  await agentApi?.dispose();
});

test("renders the three sections across workspaces, links work and excludes stale items", async ({
  browser,
}) => {
  const personalWorkspaceId = await personalWorkspaceOf(api);
  const personalProject = await createProject(api, personalWorkspaceId, "UI my work personal");
  const shared = await api.post("/api/workspaces", {
    data: { name: `UI my work shared ${randomUUID()}` },
  });
  expect(shared.status()).toBe(201);
  const sharedWorkspaceId = idOf(await shared.json(), "shared workspace");
  const sharedProject = await createProject(api, sharedWorkspaceId, "UI my work shared");

  const projectView = await api.get(`/api/projects/${personalProject.id}`);
  expect(projectView.status()).toBe(200);
  const humanId = requiredText(
    field(field(await projectView.json(), "createdBy"), "humanId"),
    "the signed-in human id",
  );

  const personalAssigned = await createIssue(
    api,
    personalProject.id,
    `Personal assignment ${randomUUID()}`,
    humanId,
  );
  const sharedAssigned = await createIssue(
    api,
    sharedProject.id,
    `Shared assignment ${randomUUID()}`,
    humanId,
  );
  const doneIssue = await createIssue(api, personalProject.id, `Finished ${randomUUID()}`, humanId);
  const trashedIssue = await createIssue(
    api,
    personalProject.id,
    `Trashed ${randomUUID()}`,
    humanId,
  );
  expect(
    (await api.patch(`/api/issues/${doneIssue.id}`, { data: { status: "done" } })).status(),
  ).toBe(200);
  expect((await api.delete(`/api/issues/${trashedIssue.id}`)).status()).toBe(204);

  const personalSession = await createIssue(
    api,
    personalProject.id,
    `Personal agent work ${randomUUID()}`,
  );
  const sharedSession = await createIssue(
    api,
    sharedProject.id,
    `Shared agent work ${randomUUID()}`,
  );
  const personalQuestionIssue = await createIssue(
    api,
    personalProject.id,
    `Personal question ${randomUUID()}`,
  );
  const sharedQuestionIssue = await createIssue(
    api,
    sharedProject.id,
    `Shared question ${randomUUID()}`,
  );
  const answeredIssue = await createIssue(api, sharedProject.id, `Answered on ${randomUUID()}`);

  const agentId = await createAgent(api, "my-work-ui-agent");
  const personalKey = await issueKey(api, agentId, personalWorkspaceId, personalProject.id);
  const sharedKey = await issueKey(api, agentId, sharedWorkspaceId, sharedProject.id);

  const personalRunId = await newRun(agentApi, personalKey);
  const personalSessionId = await claim(agentApi, personalKey, personalSession.id, personalRunId);
  const renewed = await agentApi.post(`/api/issues/${personalSession.id}/work-sessions/renew`, {
    headers: { Authorization: `Bearer ${personalKey}` },
    data: { inputTokens: 250, outputTokens: 20, costUsdMicros: 750 },
  });
  expect(renewed.status()).toBe(200);

  const sharedRunId = await newRun(agentApi, sharedKey);
  const sharedSessionId = await claim(agentApi, sharedKey, sharedSession.id, sharedRunId);
  const stopped = await api.post(`/api/issues/${sharedSession.id}/work-sessions/stop-request`, {
    data: { reason: "Reprioritised" },
  });
  expect(stopped.status()).toBe(200);

  const personalQuestion = `Personal decision ${randomUUID()}?`;
  const personalQuestionRunId = await newRun(agentApi, personalKey);
  await claim(agentApi, personalKey, personalQuestionIssue.id, personalQuestionRunId);
  const personalQuestionId = await ask(
    agentApi,
    personalKey,
    personalQuestionIssue.id,
    personalQuestionRunId,
    personalQuestion,
  );
  const sharedQuestion = `Shared decision ${randomUUID()}?`;
  const sharedQuestionRunId = await newRun(agentApi, sharedKey);
  await claim(agentApi, sharedKey, sharedQuestionIssue.id, sharedQuestionRunId);
  const sharedQuestionId = await ask(
    agentApi,
    sharedKey,
    sharedQuestionIssue.id,
    sharedQuestionRunId,
    sharedQuestion,
  );

  const answeredRunId = await newRun(agentApi, sharedKey);
  await claim(agentApi, sharedKey, answeredIssue.id, answeredRunId);
  const answeredQuestion = `Already answered ${randomUUID()}?`;
  const answeredQuestionId = await ask(
    agentApi,
    sharedKey,
    answeredIssue.id,
    answeredRunId,
    answeredQuestion,
  );
  expect(
    (
      await api.post(`/api/questions/${answeredQuestionId}/answer`, {
        data: { answer: "Already decided" },
      })
    ).status(),
  ).toBe(200);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    await page.goto("/my-work");
    await expect(page.getByRole("heading", { level: 1, name: "My work" })).toBeVisible();
    const assignedSection = page.locator('[data-my-work-section="assigned-issues"]');
    const sessionsSection = page.locator('[data-my-work-section="active-sessions"]');
    const questionsSection = page.locator('[data-my-work-section="needs-input"]');
    await expect(page.getByRole("heading", { level: 2, name: "Assigned to me" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "My active agent sessions" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Needs input" })).toBeVisible();

    const personalAssignedRow = assignedSection.locator(
      `[data-my-work-issue-id="${personalAssigned.id}"]`,
    );
    const sharedAssignedRow = assignedSection.locator(
      `[data-my-work-issue-id="${sharedAssigned.id}"]`,
    );
    await expect(personalAssignedRow).toContainText(personalAssigned.identifier);
    await expect(personalAssignedRow).toContainText(personalAssigned.title);
    await expect(sharedAssignedRow).toContainText(sharedAssigned.identifier);
    await expect(sharedAssignedRow).toContainText(sharedAssigned.title);

    const personalSessionRow = sessionsSection.locator(
      `[data-my-work-session-id="${personalSessionId}"]`,
    );
    const sharedSessionRow = sessionsSection.locator(
      `[data-my-work-session-id="${sharedSessionId}"]`,
    );
    await expect(personalSessionRow).toContainText(personalSession.identifier);
    await expect(personalSessionRow).toContainText("Harness my-work-ui-e2e");
    await expect(personalSessionRow).toContainText("Model my-work-ui-model");
    await expect(personalSessionRow).toContainText("250 input tokens");
    await expect(personalSessionRow).toContainText("20 output tokens");
    await expect(personalSessionRow).toContainText("$0.00075 cost");
    await expect(sharedSessionRow).toContainText(sharedSession.identifier);
    await expect(sharedSessionRow).toContainText("Stop requested");

    await expect(sharedSessionRow).not.toContainText("tokens");

    await expect(
      questionsSection.locator(`[data-my-work-question-id="${personalQuestionId}"]`),
    ).toContainText(personalQuestion);
    await expect(
      questionsSection.locator(`[data-my-work-question-id="${sharedQuestionId}"]`),
    ).toContainText(sharedQuestion);

    await expect(page.getByText(doneIssue.identifier)).toHaveCount(0);
    await expect(page.getByText(trashedIssue.identifier)).toHaveCount(0);
    await expect(page.getByText(answeredQuestion)).toHaveCount(0);

    await sharedAssignedRow
      .getByRole("link", { name: new RegExp(sharedAssigned.identifier) })
      .click();
    await expect(page).toHaveURL(`/issues/${sharedAssigned.id}`);
    await expect(page.getByRole("heading", { level: 1, name: sharedAssigned.title })).toBeVisible();

    await page.goto("/my-work");
    await questionsSection
      .locator(`[data-my-work-question-id="${sharedQuestionId}"]`)
      .getByRole("link", { name: "Answer in Inbox" })
      .click();
    await expect(page).toHaveURL(`/inbox?issue=${sharedQuestionIssue.id}`);
    await expect(page.locator(`li[data-question-id="${sharedQuestionId}"]`)).toContainText(
      sharedQuestion,
    );

    await page.goto("/my-work");
    expect(
      (await api.patch(`/api/issues/${sharedAssigned.id}`, { data: { status: "done" } })).status(),
    ).toBe(200);
    expect(
      (
        await api.post(`/api/questions/${sharedQuestionId}/answer`, {
          data: { answer: "Use the v2 endpoint" },
        })
      ).status(),
    ).toBe(200);
    await expect(sharedAssignedRow).toHaveCount(0, { timeout: 15_000 });
    await expect(
      questionsSection.locator(`[data-my-work-question-id="${sharedQuestionId}"]`),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    for (const cookie of await context.cookies()) await recordSecret(cookie.value);
    await context.close();
  }
});

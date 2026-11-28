import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

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

async function workspaceAndProject(): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Dispatch ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Dispatch repo" },
  });
  expect(project.status()).toBe(201);
  return { workspaceId, projectId: text(field(await project.json(), "id"), "project id") };
}

async function createIssue(
  projectId: string,
  title: string,
  options?: { labelIds?: string[]; assigneeHumanId?: string },
): Promise<string> {
  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: {
      title,
      ...(options?.labelIds === undefined ? {} : { labelIds: options.labelIds }),
      ...(options?.assigneeHumanId === undefined
        ? {}
        : { assigneeHumanId: options.assigneeHumanId }),
    },
  });
  expect(issue.status()).toBe(201);
  return text(field(await issue.json(), "id"), "issue id");
}

async function createLabel(projectId: string, name: string): Promise<string> {
  const label = await admin.post(`/api/projects/${projectId}/labels`, {
    data: { name, color: "#3366aa" },
  });
  expect(label.status()).toBe(201);
  return text(field(await label.json(), "id"), "label id");
}

async function adminHumanId(projectId: string): Promise<string> {
  const project = await admin.get(`/api/projects/${projectId}`);
  expect(project.status()).toBe(200);
  return text(field(field(await project.json(), "createdBy"), "humanId"), "the human id");
}

async function enrollHost(): Promise<string> {
  const verifier = randomBytes(32).toString("hex");
  const device = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: `e2e-dispatch-laptop-${randomUUID().slice(0, 6)}`,
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
    data: {
      deviceCode: text(field(deviceBody, "deviceCode"), "device code"),
      verifier,
    },
  });
  expect(exchanged.status()).toBe(200);
  const credential = text(field(await exchanged.json(), "credential"), "host credential");
  await recordSecret(credential);
  return credential;
}

async function registerRunner(
  credential: string,
  target: { workspaceId: string; projectId: string; agentId: string; maxConcurrency?: number },
): Promise<{ runnerId: string; displayName: string }> {
  const displayName = `e2e-dispatch-runner-${randomUUID().slice(0, 6)}`;
  const runnerApi = await request.newContext({
    ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  try {
    const registered = await runnerApi.post("/api/runners/register", {
      data: {
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        agentId: target.agentId,
        displayName,
        repoFingerprint: sha256(`/private/local/dispatch-repo-${randomUUID()}`),
        capabilities: ["opencode"],
        ...(target.maxConcurrency === undefined ? {} : { maxConcurrency: target.maxConcurrency }),
      },
    });
    expect(registered.status()).toBe(201);
    return { runnerId: text(field(await registered.json(), "id"), "runner id"), displayName };
  } finally {
    await runnerApi.dispose();
  }
}

test("the issue page delegates a self-assigned issue to an owned Runner and keeps the assignee", async ({
  browser,
}) => {
  const { workspaceId, projectId } = await workspaceAndProject();
  const humanId = await adminHumanId(projectId);
  const issueId = await createIssue(projectId, "Delegate me to a Runner");
  const assigned = await admin.patch(`/api/issues/${issueId}`, {
    data: { assigneeHumanId: humanId },
  });
  expect(assigned.status()).toBe(200);

  const agentName = `dispatch-agent-${randomUUID().slice(0, 6)}`;
  const agent = await admin.post("/api/agents", { data: { name: agentName } });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");

  const credential = await enrollHost();
  const { displayName: runnerDisplayName } = await registerRunner(credential, {
    workspaceId,
    projectId,
    agentId,
  });

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/issues/${issueId}`);
    await expect(page.getByRole("heading", { name: "Delegate to Runner" })).toBeVisible();
    // Your own issue stays delegatable: the human assignee is not a blocker.
    await expect(page.locator("[data-delegate-trigger]")).toBeEnabled();
    await page.locator("[data-delegate-trigger]").click();
    await expect(page.locator("[data-delegate-dialog]")).toBeVisible();
    await page.getByRole("combobox", { name: "Runner" }).click();
    await page.getByRole("option", { name: new RegExp(runnerDisplayName) }).click();
    await page.getByRole("combobox", { name: /^Agent/ }).click();
    await page.getByRole("option", { name: new RegExp(agentName) }).click();
    await page.locator("[data-delegate-dispatch]").click();
    await expect(page.getByText(/Delegated to/).first()).toBeVisible();
    await expect(page.getByText("Waiting for the Runner")).toBeVisible();

    const list = await admin.get(`/api/issues/${issueId}/dispatches`);
    expect(list.status()).toBe(200);
    const dispatches = field(await list.json(), "dispatches");
    expect(Array.isArray(dispatches)).toBe(true);
    expect(dispatches).toHaveLength(1);
    const first = Array.isArray(dispatches) ? dispatches[0] : undefined;
    expect(field(first, "state")).toBe("pending");

    // Delegation is execution only: the human assignee is untouched.
    const after = await admin.get(`/api/issues/${issueId}`);
    expect(after.status()).toBe(200);
    expect(field(await after.json(), "assignee")).toMatchObject({ humanId });
  } finally {
    await context.close();
  }
});

test("auto-claim honors the label gate and the owner-human filter", async () => {
  const { workspaceId, projectId } = await workspaceAndProject();
  const agent = await admin.post("/api/agents", {
    data: { name: `auto-claim-agent-${randomUUID().slice(0, 6)}` },
  });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");
  const credential = await enrollHost();
  const { runnerId } = await registerRunner(credential, {
    workspaceId,
    projectId,
    agentId,
    maxConcurrency: 4,
  });

  const humanId = await adminHumanId(projectId);
  const readyForAgent = await createLabel(projectId, "ready-for-agent");
  const labelled = await createIssue(projectId, "Labelled ready work", {
    labelIds: [readyForAgent],
    assigneeHumanId: humanId,
  });
  const unlabelled = await createIssue(projectId, "Unlabelled personal work", {
    assigneeHumanId: humanId,
  });

  const runnerApi = await request.newContext({
    ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  try {
    const claim = async (body: Record<string, unknown>) => {
      const res = await runnerApi.post(`/api/runners/${runnerId}/auto-claim`, { data: body });
      expect(res.status()).toBe(200);
      return field(field(await res.json(), "dispatch"), "issueId");
    };

    // The label gate matches case-insensitively and only labelled work is eligible.
    expect(await claim({ filter: "assignedToMe", labels: ["READY-FOR-AGENT"] })).toBe(labelled);
    // Nothing else carries the label.
    expect(await claim({ filter: "assignedToMe", labels: ["ready-for-agent"] })).toBeUndefined();
    // Without a label filter the remaining ready issue is claimed.
    expect(await claim({ filter: "assignedToMe" })).toBe(unlabelled);
  } finally {
    await runnerApi.dispose();
  }
});

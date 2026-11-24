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

test("the issue page delegates to an owned online Runner with an optional Agent", async ({
  browser,
}) => {
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Dispatch ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Dispatch repo" },
  });
  expect(project.status()).toBe(201);
  const projectId = text(field(await project.json(), "id"), "project id");
  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Delegate me to a Runner" },
  });
  expect(issue.status()).toBe(201);
  const issueId = text(field(await issue.json(), "id"), "issue id");
  const agentName = `dispatch-agent-${randomUUID().slice(0, 6)}`;
  const agent = await admin.post("/api/agents", {
    data: { name: agentName },
  });
  expect(agent.status()).toBe(201);
  const agentId = text(field(await agent.json(), "id"), "agent id");

  const verifier = randomBytes(32).toString("hex");
  const device = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: "e2e-dispatch-laptop",
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

  const runnerDisplayName = `e2e-dispatch-runner-${randomUUID().slice(0, 6)}`;
  const runnerApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  try {
    const registered = await runnerApi.post("/api/runners/register", {
      data: {
        workspaceId,
        projectId,
        agentId,
        displayName: runnerDisplayName,
        repoFingerprint: sha256("/private/local/dispatch-repo"),
        capabilities: ["opencode"],
      },
    });
    expect(registered.status()).toBe(201);
  } finally {
    await runnerApi.dispose();
  }

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/issues/${issueId}`);
    await expect(page.getByRole("heading", { name: "Delegate to Runner" })).toBeVisible();
    await page.getByRole("combobox", { name: "Runner" }).click();
    await page.getByRole("option", { name: new RegExp(runnerDisplayName) }).click();
    await page.getByRole("combobox", { name: /Agent \(optional\)/ }).click();
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
  } finally {
    await context.close();
  }
});

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) {
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

test("browser approval binds a Runner host, then the fleet shows live presence and revocation", async ({
  browser,
}) => {
  const verifier = randomBytes(32).toString("hex");
  const displayName = `e2e-laptop-${randomUUID().slice(0, 6)}`;
  const created = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: displayName,
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(created.status()).toBe(201);
  const device = await created.json();
  const userCode = text(field(device, "userCode"), "user code");
  const deviceCode = text(field(device, "deviceCode"), "device code");
  await recordSecret(userCode);

  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();
  try {
    await signIn(page);
    await page.goto(`/device?code=${encodeURIComponent(userCode)}`);
    await expect(page.getByText(displayName)).toBeVisible();
    await expect(page.getByText("linux-x64")).toBeVisible();
    await page.getByRole("button", { name: "Approve this Runner host" }).click();
    await expect(page.getByText("Runner host approved")).toBeVisible();

    const exchanged = await admin.post("/api/runners/device-codes/token", {
      data: { deviceCode, verifier },
    });
    expect(exchanged.status()).toBe(200);
    const credential = text(field(await exchanged.json(), "credential"), "host credential");

    const workspace = await admin.post("/api/workspaces", {
      data: { name: `Runners Fleet ${randomUUID().slice(0, 6)}` },
    });
    expect(workspace.status()).toBe(201);
    const workspaceId = text(field(await workspace.json(), "id"), "workspace id");
    const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
      data: { name: "Runner repo" },
    });
    expect(project.status()).toBe(201);
    const projectId = text(field(await project.json(), "id"), "project id");
    const agent = await admin.post("/api/agents", {
      data: { name: `runner-agent-${randomUUID().slice(0, 6)}` },
    });
    expect(agent.status()).toBe(201);

    const fingerprint = sha256("/private/local/checkout");
    const runnerDisplayName = `e2e-runner-${randomUUID().slice(0, 6)}`;
    const api = await request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders: { authorization: `Bearer ${credential}` },
    });
    try {
      const registered = await api.post("/api/runners/register", {
        data: {
          workspaceId,
          projectId,
          displayName: runnerDisplayName,
          repoFingerprint: fingerprint,
          capabilities: ["opencode"],
          maxConcurrency: 2,
        },
      });
      expect(registered.status()).toBe(201);
    } finally {
      await api.dispose();
    }

    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("tab", { name: "Runners" }).click();
    await expect(page.locator("[data-runner-host-id]")).toHaveCount(1);
    await expect(page.locator("[data-runner-presence='online']")).toHaveCount(1);
    await expect(page.getByText(displayName).first()).toBeVisible();
    await expect(page.getByText(runnerDisplayName)).toBeVisible();

    await page.getByRole("button", { name: "Revoke this laptop" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke this laptop" }).click();
    await expect(page.getByText("No Runners here yet")).toBeVisible();
  } finally {
    await context.close();
  }
});

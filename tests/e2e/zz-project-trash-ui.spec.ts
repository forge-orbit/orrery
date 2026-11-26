import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function idOf(value: unknown, what: string): string {
  const id = field(value, "id");
  if (typeof id !== "string" || id === "") throw new Error(`missing ${what} id`);
  return id;
}

async function personalWorkspaceId(client: APIRequestContext): Promise<string> {
  const response = await client.get("/api/workspaces");
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
  const personal = body.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

test("workspace owner moves a project to Trash and restores its data", async ({ browser }) => {
  test.setTimeout(90_000);

  const workspaceId = await personalWorkspaceId(api);
  const projectName = `Trash UI ${randomUUID()}`;
  const projectResponse = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: projectName },
  });
  expect(projectResponse.status()).toBe(201);
  const projectId = idOf(await projectResponse.json(), "project");

  const issueTitle = `Retained issue ${randomUUID()}`;
  const issueResponse = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: issueTitle },
  });
  expect(issueResponse.status()).toBe(201);

  const knowledgeTitle = `Retained knowledge ${randomUUID()}`;
  const knowledgeResponse = await api.post(`/api/projects/${projectId}/knowledge`, {
    data: { title: knowledgeTitle, body: "This entry must survive project Trash." },
  });
  expect(knowledgeResponse.status()).toBe(201);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Danger Zone" })).toBeVisible();
    await page.getByRole("button", { name: "Move to Trash", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: `Move "${projectName}" to Trash?` }),
    ).toBeVisible();
    const nameInput = dialog.getByLabel("Type the project name to confirm");
    const confirm = dialog.getByRole("button", { name: "Move to Trash", exact: true });
    await expect(confirm).toBeDisabled();
    await nameInput.fill(`${projectName} typo`);
    await expect(confirm).toBeDisabled();
    await nameInput.fill(projectName);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));
    await expect(page.locator(`[data-project-id="${projectId}"]`)).toHaveCount(0);
    await page.getByRole("tab", { name: "Trash" }).click();

    const trashedRow = page.locator(`[data-trashed-project-id="${projectId}"]`);
    await expect(trashedRow).toBeVisible();
    await expect(trashedRow).toContainText(projectName);
    await expect(trashedRow).toContainText(/\d+ days? remaining/);
    await expect(trashedRow.locator("time")).toBeVisible();
    await trashedRow.getByRole("button", { name: "Restore" }).click();
    await expect(trashedRow).toHaveCount(0);

    await page.getByRole("tab", { name: "Projects" }).click();
    await page.getByRole("link", { name: projectName, exact: true }).click();
    await expect(page.getByText(issueTitle, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Knowledge" }).click();
    await expect(page.getByText(knowledgeTitle, { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.locator('[data-activity-type="project_deleted"]')).toContainText(
      "moved the project to Trash",
    );
    await expect(page.locator('[data-activity-type="project_restored"]')).toContainText(
      "restored the project from Trash",
    );

    await page.getByRole("link", { name: "Back to workspace" }).click();
    await page.getByRole("link", { name: "Access history" }).click();
    await expect(page.getByText(/moved the project to Trash/).first()).toBeVisible();
    await expect(page.getByText(/restored the project from Trash/).first()).toBeVisible();

    await page.goto(`/workspaces/${workspaceId}`);
    await page.getByRole("tab", { name: "Webhooks" }).click();
    await page.getByRole("button", { name: "Add webhook" }).click();
    await page.getByLabel("All project activity events").uncheck();
    await expect(page.getByLabel("Project moved to Trash")).toBeVisible();
    await expect(page.getByLabel("Project restored from Trash")).toBeVisible();
  } finally {
    await context.close();
  }
});

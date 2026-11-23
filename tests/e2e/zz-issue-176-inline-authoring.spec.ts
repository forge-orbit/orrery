import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

let api: APIRequestContext;
let workspaceId = "";

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const workspaces = await api.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const body: unknown = await workspaces.json();
  if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
  for (const workspace of body) {
    if (field(workspace, "kind") !== "personal") continue;
    const id = field(workspace, "id");
    if (typeof id === "string") {
      workspaceId = id;
      return;
    }
  }
  throw new Error("the administrator has no personal workspace");
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
}

async function newProject(name: string): Promise<string> {
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name },
  });
  expect(created.status()).toBe(201);
  return requiredText(field(await created.json(), "id"), "the project id");
}

async function newIssue(projectId: string, title: string, body: string): Promise<string> {
  const created = await api.post(`/api/projects/${projectId}/issues`, { data: { title, body } });
  expect(created.status()).toBe(201);
  return requiredText(field(await created.json(), "id"), "the issue id");
}

async function newKnowledge(projectId: string, title: string, body: string): Promise<string> {
  const created = await api.post(`/api/projects/${projectId}/knowledge`, {
    data: { title, body },
  });
  expect(created.status()).toBe(201);
  return requiredText(field(await created.json(), "id"), "the knowledge id");
}

test("navigates to a dedicated knowledge page with Create more", async ({ page }) => {
  const projectId = await newProject("Knowledge authoring");
  await signIn(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await page.locator("[data-new-knowledge]").first().click();

  await expect(page).toHaveURL(/\/knowledge\/new$/);
  await expect(page.getByRole("heading", { name: "New knowledge document" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New knowledge document" })).toHaveCount(0);
  await expect(page.locator("#new-knowledge-body")).toHaveAttribute("rows", "15");
  await expect(page.locator("#new-knowledge-body")).toHaveCSS("resize", "vertical");
  await expect(page.getByLabel("Create more")).not.toBeChecked();

  await page.getByLabel("Knowledge title").fill("Created from the page");
  await page.getByLabel("Markdown").fill("# A full-width document");
  await page.getByLabel("Create more").check();
  await page.getByRole("button", { name: "Create knowledge" }).click();

  await expect(page).toHaveURL(/\/knowledge\/new$/);
  await expect(page.getByLabel("Knowledge title")).toHaveValue("");
  await expect(page.getByLabel("Markdown")).toHaveValue("");
  await expect(page.getByLabel("Create more")).toBeChecked();
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast).toContainText("Knowledge document created.");
  await expect(toast.getByRole("link", { name: "View knowledge" })).toBeVisible();

  await toast.getByRole("link", { name: "View knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Created from the page" })).toBeVisible();
  await expect(page.locator("[data-knowledge-body]")).toContainText("A full-width document");

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("edits an issue inline without a drawer", async ({ page }) => {
  const projectId = await newProject("Inline issue editing");
  const issueId = await newIssue(projectId, "Original title", "Original body");
  await signIn(page);
  await page.goto(`/issues/${issueId}`);

  await expect(page.getByRole("dialog", { name: "Edit issue" })).toHaveCount(0);
  await expect(page.locator("[data-issue-editor]")).toHaveCount(0);

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("[data-issue-editor]")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit issue" })).toHaveCount(0);
  await expect(page.locator("#edit-issue-body")).toHaveAttribute("rows", "15");
  await expect(page.locator("#edit-issue-body")).toHaveCSS("resize", "vertical");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-issue-editor]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Original title" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("Inline edited title");
  await page.getByLabel("Body").fill("Inline edited body");
  await page.getByRole("button", { name: "Save issue" }).click();
  await expect(page.locator("[data-issue-editor]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Inline edited title" })).toBeVisible();
  await expect(page.locator("[data-issue-body]")).toHaveText("Inline edited body");
  await expect(page.getByRole("dialog", { name: "Edit issue" })).toHaveCount(0);

  await expect(page.locator("#issue-comment")).toHaveAttribute("rows", "7");
  await expect(page.locator("#issue-comment")).toHaveCSS("resize", "vertical");

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("edits knowledge inline without a drawer", async ({ page }) => {
  const projectId = await newProject("Inline knowledge editing");
  const entryId = await newKnowledge(projectId, "Original document", "Original content");
  await signIn(page);
  await page.goto(`/knowledge/${entryId}`);

  await expect(page.getByRole("dialog", { name: "Edit knowledge" })).toHaveCount(0);
  await expect(page.locator("[data-knowledge-editor]")).toHaveCount(0);

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("[data-knowledge-editor]")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit knowledge" })).toHaveCount(0);
  await expect(page.locator("#edit-knowledge-body")).toHaveAttribute("rows", "15");
  await expect(page.locator("#edit-knowledge-body")).toHaveCSS("resize", "vertical");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-knowledge-editor]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Original document" })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("Inline edited document");
  await page.getByLabel("Markdown").fill("## Inline edited content");
  await page.getByRole("button", { name: "Save knowledge" }).click();
  await expect(page.locator("[data-knowledge-editor]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Inline edited document" })).toBeVisible();
  await expect(page.locator("[data-knowledge-body]")).toContainText("Inline edited content");
  await expect(page.getByRole("dialog", { name: "Edit knowledge" })).toHaveCount(0);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

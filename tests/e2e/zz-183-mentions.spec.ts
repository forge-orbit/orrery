import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

let api: APIRequestContext;
let workspaceId = "";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new Error(`${what} is not text`);
  return value;
};

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
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
}

async function newProject(name: string): Promise<string> {
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, { data: { name } });
  expect(created.status()).toBe(201);
  return requiredText(field(await created.json(), "id"), "the project id");
}

async function currentHandle(): Promise<string> {
  const response = await api.get("/api/auth/session");
  expect(response.status()).toBe(200);
  return requiredText(field(await response.json(), "handle"), "the session handle");
}

test("derives a handle and lets the account page edit it", async ({ page }) => {
  const original = await currentHandle();
  expect(original).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/);

  await signIn(page);
  await page.goto("/account");
  const input = page.getByLabel("Handle");
  await expect(input).toHaveValue(original);
  const proposed = `${original}-renamed`;
  await input.fill(proposed);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.").first()).toBeVisible();
  await expect.poll(async () => currentHandle()).toBe(proposed);

  // Restore the handle for the other browser tests that share this instance.
  await input.fill(original);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect.poll(async () => currentHandle()).toBe(original);
});

test("autocompletes @mentions and renders them as badges outside code and emails", async ({
  page,
}) => {
  const projectId = await newProject("Mentions authoring #183");
  const handle = await currentHandle();
  await signIn(page);
  await page.goto(`/projects/${projectId}/issues/new`);

  const editor = page.locator("#new-issue-body");
  const attachBar = page.locator("[data-attach-bar]");
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  await editor.fill("Hello @");
  const listbox = page.getByRole("listbox", { name: "Mention a teammate" });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toContainText(`@${handle}`);

  // The menu floats over the composer near the textarea instead of growing the
  // page below the attachment bar, and it leaves that layout where it was.
  const menuBox = await listbox.boundingBox();
  const attachBox = await attachBar.boundingBox();
  if (menuBox === null || attachBox === null)
    throw new Error("the mention menu or attach bar has no box");
  expect(menuBox.y).toBeLessThan(attachBox.y);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(pageHeight);

  await editor.press("ArrowDown");
  await editor.press("Enter");
  await expect(editor).toHaveValue(new RegExp(`@${handle}\\s`));

  await editor.fill("Hello @");
  await expect(listbox).toBeVisible();
  await listbox.getByRole("option").first().click();
  await expect(editor).toHaveValue(new RegExp(`@${handle}\\s`));

  await editor.fill("Hello @");
  await expect(listbox).toBeVisible();
  await editor.press("Escape");
  await expect(listbox).toBeHidden();

  await page.getByLabel("Issue title").fill("A mention");
  await editor.fill(
    `Hello @${handle}, mail admin@example.com and \`@${handle}\` and [link](https://example.com/@${handle})`,
  );
  await page.getByRole("button", { name: "Create issue" }).click();

  await expect(page).toHaveURL(/\/issues\//);
  const body = page.locator("[data-issue-body] [data-markdown]");
  await expect(body.locator(`[data-mention][data-mention-kind="human"]`)).toHaveCount(1);
  await expect(body.locator(`[data-mention][data-mention-kind="human"]`)).toContainText(
    `@${handle}`,
  );
  await expect(body).toContainText("admin@example.com");
});

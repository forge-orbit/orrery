import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

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

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
}

async function newProject() {
  const workspaces = await api.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const personal = asArray(await workspaces.json()).find((w) => field(w, "kind") === "personal");
  const workspaceId = idOf(personal, "personal workspace");
  const key = `AC${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Atomic create ${key}`, key },
  });
  expect(created.status()).toBe(201);
  return { projectId: idOf(await created.json(), "project"), key };
}

async function newLabel(projectId: string, name: string) {
  const res = await api.post(`/api/projects/${projectId}/labels`, {
    data: { name, color: "#123abc" },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "label");
}

test("the dedicated new-issue page triages atomically and honours query pre-fills", async ({
  page,
}) => {
  const { projectId, key } = await newProject();
  await newLabel(projectId, "Atomic label");
  const parentRes = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Parent issue" },
  });
  expect(parentRes.status()).toBe(201);
  const parentId = idOf(await parentRes.json(), "issue");
  await signIn(page);

  await page.goto(`/projects/${projectId}/issues/new?status=backlog&parentIssueId=${parentId}`);
  await expect(page.locator("[data-new-issue-page]")).toBeVisible();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await expect(page.getByLabel("Issue title")).toBeVisible();
  const body = page.locator("[data-new-issue-body] textarea");
  await expect(body).toBeVisible();
  expect(Number(await body.getAttribute("rows"))).toBeGreaterThanOrEqual(14);
  expect(
    await body.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).resize),
  ).toBe("vertical");
  await expect(page.getByRole("combobox", { name: "Status" })).toContainText("Backlog");
  await expect(page.getByRole("combobox", { name: "Parent issue" })).toContainText(
    `${key}-1 Parent issue`,
  );
  for (const name of ["Priority", "Assignee", "Labels"]) {
    await expect(page.getByRole("combobox", { name })).toBeVisible();
  }
  await expect(page.getByLabel("Create more", { exact: true })).toBeVisible();

  await page.getByLabel("Issue title").fill("Fully triaged issue");
  await body.fill("Body written on the dedicated page.");
  await page.getByRole("combobox", { name: "Priority" }).click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await page.getByRole("combobox", { name: "Assignee" }).click();
  await page.getByRole("option", { name: `Human · ${ADMIN_EMAIL}`, exact: true }).click();
  await page.getByRole("combobox", { name: "Labels" }).click();
  await page.getByRole("option", { name: "Atomic label", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create issue" }).click();

  await expect(page).toHaveURL(/\/issues\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "Fully triaged issue" })).toBeVisible();
  await expect(page.locator("[data-issue-status]").first()).toHaveAttribute(
    "data-issue-status",
    "backlog",
  );
  await expect(
    page.locator("[data-issue-label-id] [data-label-name='Atomic label']"),
  ).toBeVisible();
  const issues = await api.get(`/api/projects/${projectId}/issues`);
  const created = asArray(await issues.json()).find(
    (issue) => field(issue, "title") === "Fully triaged issue",
  );
  expect(field(created, "parentIssueId")).toBe(parentId);
  expect(field(created, "priority")).toBe("high");
  expect(field(field(created, "assignee"), "humanId")).toBeTruthy();
  expect(asArray(field(created, "labels"))).toHaveLength(1);
});

test("Create more keeps the triage fields and toasts a link to each created issue", async ({
  page,
}) => {
  const { projectId } = await newProject();
  await newLabel(projectId, "Batch label");
  await signIn(page);

  await page.goto(`/projects/${projectId}/issues/new`);
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "In progress", exact: true }).click();
  await page.getByRole("combobox", { name: "Priority" }).click();
  await page.getByRole("option", { name: "Urgent", exact: true }).click();
  await page.getByRole("combobox", { name: "Labels" }).click();
  await page.getByRole("option", { name: "Batch label", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Create more").check();

  await page.getByLabel("Issue title").fill("First batch issue");
  await page.locator("[data-new-issue-body] textarea").fill("First body.");
  await page.getByRole("button", { name: "Create issue" }).click();

  await expect(page).toHaveURL(/\/projects\/[^/]+\/issues\/new$/);
  const toastLink = page.locator("[data-new-issue-created-link]");
  await expect(toastLink).toBeVisible();
  const firstIdentifier = await toastLink.textContent();
  expect(firstIdentifier).toMatch(/-1$/);
  await expect(page.getByLabel("Issue title")).toHaveValue("");
  await expect(page.locator("[data-new-issue-body] textarea")).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Status" })).toContainText("In progress");
  await expect(page.getByRole("combobox", { name: "Priority" })).toContainText("Urgent");
  await expect(page.getByLabel("Create more")).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Labels" })).toContainText("Batch label");

  await page.getByLabel("Issue title").fill("Second batch issue");
  await page.locator("[data-new-issue-body] textarea").fill("Second body.");
  await page.getByRole("button", { name: "Create issue" }).click();
  await expect(page.locator("[data-new-issue-created-link]").last()).toHaveText(/-2$/);
  const issues = await api.get(`/api/projects/${projectId}/issues`);
  const titles = asArray(await issues.json()).map((issue) => field(issue, "title"));
  expect(titles).toEqual(expect.arrayContaining(["First batch issue", "Second batch issue"]));
  expect(firstIdentifier).toBeTruthy();
});

test("Project and Board New issue buttons open the page instead of a drawer", async ({ page }) => {
  const { projectId } = await newProject();
  await signIn(page);

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "New issue" }).first().click();
  await expect(page).toHaveURL(`/projects/${projectId}/issues/new`);
  await expect(page.getByRole("dialog", { name: "New issue" })).toHaveCount(0);

  await page.goto(`/board/${projectId}`);
  await page.getByRole("button", { name: "New issue" }).first().click();
  await expect(page).toHaveURL(`/projects/${projectId}/issues/new`);
  await expect(page.getByRole("dialog", { name: "New issue" })).toHaveCount(0);
});

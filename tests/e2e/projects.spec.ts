import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

let personalWorkspaceId = "";
let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  personalWorkspaceId = await personalWorkspaceOf(api);
});

test.afterAll(async () => {
  await api?.dispose();
});

test("runs the full project cycle over REST", async () => {
  const created = await api.post(`/api/workspaces/${personalWorkspaceId}/projects`, {
    data: { name: "REST Project" },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const projectId = requiredText(field(project, "id"), "the project id");
  expect(project).toMatchObject({
    workspaceId: personalWorkspaceId,
    name: "REST Project",
    createdBy: { email: ADMIN_EMAIL },
  });

  const listed = await api.get(`/api/workspaces/${personalWorkspaceId}/projects`);
  expect(listed.status()).toBe(200);
  expect(listIds(await listed.json())).toContain(projectId);

  const fetched = await api.get(`/api/projects/${projectId}`);
  expect(fetched.status()).toBe(200);
  expect(await fetched.json()).toMatchObject({ id: projectId, name: "REST Project" });

  const issueCreated = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "REST issue", body: "The **first** draft." },
  });
  expect(issueCreated.status()).toBe(201);
  const issue = await issueCreated.json();
  const issueId = requiredText(field(issue, "id"), "the issue id");
  expect(issue).toMatchObject({
    projectId,
    number: 1,
    title: "REST issue",
    body: "The **first** draft.",
    status: "todo",
    closedAt: null,
    createdBy: { email: ADMIN_EMAIL },
    updatedBy: { email: ADMIN_EMAIL },
  });

  const edited = await api.patch(`/api/issues/${issueId}`, {
    data: { title: "REST issue edited", body: "The **final** draft." },
  });
  expect(edited.status()).toBe(200);
  expect(await edited.json()).toMatchObject({
    title: "REST issue edited",
    body: "The **final** draft.",
    status: "todo",
    updatedBy: { email: ADMIN_EMAIL },
  });

  const commented = await api.post(`/api/issues/${issueId}/comments`, {
    data: { body: "A REST comment." },
  });
  expect(commented.status()).toBe(201);
  expect(await commented.json()).toMatchObject({
    issueId,
    body: "A REST comment.",
    author: { email: ADMIN_EMAIL },
  });
  const comments = await api.get(`/api/issues/${issueId}/comments`);
  expect(comments.status()).toBe(200);
  expect(await comments.json()).toMatchObject([
    { issueId, body: "A REST comment.", author: { email: ADMIN_EMAIL } },
  ]);

  const closed = await api.patch(`/api/issues/${issueId}`, { data: { status: "done" } });
  expect(closed.status()).toBe(200);
  const closedBody = await closed.json();
  expect(closedBody).toMatchObject({ status: "done" });
  expect(field(closedBody, "closedAt")).toEqual(expect.any(String));

  const reopened = await api.patch(`/api/issues/${issueId}`, { data: { status: "todo" } });
  expect(reopened.status()).toBe(200);
  expect(await reopened.json()).toMatchObject({ status: "todo", closedAt: null });

  const knowledgeCreated = await api.post(`/api/projects/${projectId}/knowledge`, {
    data: { title: "REST knowledge", body: "# Notes\n\nStored **as written**." },
  });
  expect(knowledgeCreated.status()).toBe(201);
  const entry = await knowledgeCreated.json();
  const entryId = requiredText(field(entry, "id"), "the knowledge entry id");
  expect(entry).toMatchObject({
    projectId,
    title: "REST knowledge",
    body: "# Notes\n\nStored **as written**.",
    createdBy: { email: ADMIN_EMAIL },
    updatedBy: { email: ADMIN_EMAIL },
  });

  const knowledgeEdited = await api.patch(`/api/knowledge/${entryId}`, {
    data: { title: "REST knowledge edited", body: "## Edited\n\nStill **Markdown**." },
  });
  expect(knowledgeEdited.status()).toBe(200);
  expect(await knowledgeEdited.json()).toMatchObject({
    title: "REST knowledge edited",
    body: "## Edited\n\nStill **Markdown**.",
    createdBy: { email: ADMIN_EMAIL },
    updatedBy: { email: ADMIN_EMAIL },
  });
  const knowledgeFetched = await api.get(`/api/knowledge/${entryId}`);
  expect(knowledgeFetched.status()).toBe(200);
  expect(await knowledgeFetched.json()).toMatchObject({ title: "REST knowledge edited" });
  const knowledgeListed = await api.get(`/api/projects/${projectId}/knowledge`);
  expect(knowledgeListed.status()).toBe(200);
  expect(listIds(await knowledgeListed.json())).toContain(entryId);

  const activity = await api.get(`/api/projects/${projectId}/activity`);
  expect(activity.status()).toBe(200);
  const activityBody: unknown = await activity.json();
  expect(activityTypes(activityBody)).toEqual([
    "project_created",
    "issue_created",
    "issue_edited",
    "issue_commented",
    "issue_closed",
    "issue_reopened",
    "knowledge_created",
    "knowledge_edited",
  ]);
  expect(new Set(activityActors(activityBody))).toEqual(new Set([ADMIN_EMAIL]));
});

test("refuses unauthenticated listing and fetching of a project", async () => {
  const created = await api.post(`/api/workspaces/${personalWorkspaceId}/projects`, {
    data: { name: "Private Project" },
  });
  expect(created.status()).toBe(201);
  const projectId = requiredText(field(await created.json(), "id"), "the project id");
  const issue = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Private issue" },
  });
  expect(issue.status()).toBe(201);
  const issueId = requiredText(field(await issue.json(), "id"), "the issue id");
  const knowledge = await api.post(`/api/projects/${projectId}/knowledge`, {
    data: { title: "Private knowledge" },
  });
  expect(knowledge.status()).toBe(201);
  const entryId = requiredText(field(await knowledge.json(), "id"), "the knowledge entry id");

  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const attempts = [
      await anonymous.get(`/api/workspaces/${personalWorkspaceId}/projects`),
      await anonymous.get(`/api/projects/${projectId}`),
      await anonymous.get(`/api/projects/${projectId}/issues`),
      await anonymous.get(`/api/issues/${issueId}`),
      await anonymous.get(`/api/issues/${issueId}/comments`),
      await anonymous.get(`/api/projects/${projectId}/activity`),
      await anonymous.get(`/api/projects/${projectId}/knowledge`),
      await anonymous.get(`/api/knowledge/${entryId}`),
      await anonymous.post(`/api/workspaces/${personalWorkspaceId}/projects`, {
        data: { name: "No" },
      }),
      await anonymous.post(`/api/projects/${projectId}/issues`, { data: { title: "No" } }),
      await anonymous.post(`/api/issues/${issueId}/comments`, { data: { body: "No" } }),
      await anonymous.post(`/api/projects/${projectId}/knowledge`, { data: { title: "No" } }),
      await anonymous.patch(`/api/issues/${issueId}`, { data: { status: "done" } }),
      await anonymous.patch(`/api/knowledge/${entryId}`, { data: { title: "No" } }),
    ];
    for (const res of attempts) {
      expect(res.status()).toBe(401);
      expect(res.headers()["content-type"]).toBe("application/problem+json");
      expect(await res.json()).toMatchObject({ status: 401, code: "not_signed_in" });
    }
  } finally {
    await anonymous.dispose();
  }
});

test("runs the complete cycle in the browser", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  await page.goto(`/workspaces/${personalWorkspaceId}`);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Browser Project");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Browser Project" })).toBeVisible();

  await page.getByRole("button", { name: "New issue" }).first().click();
  await page.getByLabel("Issue title").fill("Browser issue");
  await page.getByLabel("Description").fill("Created in the browser.");
  await page.getByRole("button", { name: "Create issue" }).click();
  await expect(page.getByRole("heading", { name: "Browser issue" })).toBeVisible();
  await expect(page.locator("[data-issue-status]")).toHaveAttribute("data-issue-status", "todo");

  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.locator("[data-issue-editor]")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit issue" })).toHaveCount(0);
  await expect(page.locator("#edit-issue-body")).toHaveAttribute("rows", "15");
  await page.getByLabel("Title").fill("Browser issue edited");
  await page.getByLabel("Body").fill("Edited in the browser.");
  await page.getByRole("button", { name: "Save issue" }).click();
  await expect(page.locator("[data-issue-editor]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Browser issue edited" })).toBeVisible();
  await expect(page.locator("[data-issue-body]")).toHaveText("Edited in the browser.");

  await expect(page.locator("#issue-comment")).toHaveAttribute("rows", "7");
  await page.getByLabel("Comment").fill("A browser comment.");
  await page.getByRole("button", { name: "Add comment" }).click();
  // Scope to the comment list: right after submit the composer textarea can still hold the
  // draft text, which makes an unscoped getByText a strict-mode violation (flaky).
  await expect(page.getByRole("list").getByText("A browser comment.")).toBeVisible();

  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(page.locator("[data-issue-status]")).toHaveAttribute("data-issue-status", "done");
  await expect(page.getByRole("button", { name: "Reopen issue" })).toBeVisible();
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect(page.locator("[data-issue-status]")).toHaveAttribute("data-issue-status", "todo");
  await expect(page.getByRole("button", { name: "Close issue" })).toBeVisible();

  await page.getByRole("link", { name: "Back to project" }).click();
  await page.getByRole("tab", { name: /Knowledge/ }).click();
  await page.locator("[data-new-knowledge]").first().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/knowledge\/new$/);
  await expect(page.getByRole("heading", { name: "New knowledge document" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New knowledge document" })).toHaveCount(0);
  await expect(page.locator("#new-knowledge-body")).toHaveAttribute("rows", "15");
  await page.getByLabel("Knowledge title").fill("Browser knowledge");
  await page.getByLabel("Markdown").fill("# Notes\n\nCreated in the browser.");
  await page.getByRole("button", { name: "Create knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Browser knowledge" })).toBeVisible();
  await expect(page.locator("[data-knowledge-body]")).toContainText("Notes");
  await expect(page.locator("[data-knowledge-body]")).toContainText("Created in the browser.");

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("[data-knowledge-editor]")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit knowledge" })).toHaveCount(0);
  await expect(page.locator("#edit-knowledge-body")).toHaveAttribute("rows", "15");
  await page.getByLabel("Title").fill("Browser knowledge edited");
  await page.getByLabel("Markdown").fill("## Edited\n\nStill **Markdown**.");
  await page.getByRole("button", { name: "Save knowledge" }).click();
  await expect(page.locator("[data-knowledge-editor]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Browser knowledge edited" })).toBeVisible();
  await expect(page.locator("[data-knowledge-body]")).toContainText("Edited");
  await expect(page.locator("[data-knowledge-body]")).toContainText("Still Markdown.");

  await page.getByRole("link", { name: "Back to project" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  for (const type of [
    "issue_created",
    "issue_edited",
    "issue_commented",
    "issue_closed",
    "issue_reopened",
    "knowledge_created",
    "knowledge_edited",
  ]) {
    await expect(page.locator(`[data-activity-type="${type}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-activity-type="${type}"]`)).toContainText(ADMIN_EMAIL);
  }

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
  for (const workspace of body) {
    if (field(workspace, "kind") !== "personal") continue;
    const id = field(workspace, "id");
    if (typeof id === "string") return id;
  }
  throw new Error("the administrator has no personal workspace");
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

function listIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    const id = field(item, "id");
    return typeof id === "string" ? [id] : [];
  });
}

function activityTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    const type = field(item, "type");
    return typeof type === "string" ? [type] : [];
  });
}

function activityActors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    const email = field(field(item, "actor"), "email");
    return typeof email === "string" ? [email] : [];
  });
}

import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

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

test("board, badges, labels, subtasks, trash and restore work in the browser", async ({ page }) => {
  const workspaces = await api.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const personal = asArray(await workspaces.json()).find((w) => field(w, "kind") === "personal");
  const workspaceId = idOf(personal, "personal workspace");
  const key = `M4${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `M4 board ${key}`, key },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");

  const issueCreated = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Parent with a subtask" },
  });
  expect(issueCreated.status()).toBe(201);
  const parent = await issueCreated.json();
  const parentId = idOf(parent, "issue");
  const identifier = requiredText(field(parent, "identifier"), "the parent identifier");
  expect(identifier).toBe(`${key}-1`);

  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  await page.goto(`/projects/${projectId}`);
  await expect(page.locator(`[data-issue-id="${parentId}"] [data-issue-identifier]`)).toHaveText(
    identifier,
  );

  await page.getByRole("tab", { name: /Labels/ }).click();
  await page.getByLabel("New label name").fill("UI triage");
  await page.getByLabel("New label color").fill("#123abc");
  await page.getByRole("button", { name: "Create label" }).click();
  await expect(page.locator('[data-label-name="UI triage"]').first()).toBeVisible();

  await page.getByLabel("New label name").fill("Temporary label");
  await page.getByLabel("New label color").fill("#00ff00");
  await page.getByRole("button", { name: "Create label" }).click();
  const temporary = page.locator("[data-project-label-id]").filter({ hasText: "Temporary label" });
  const temporaryId = await temporary.getAttribute("data-project-label-id");
  const temporaryRow = page.locator(`[data-project-label-id="${temporaryId}"]`);
  await temporaryRow.getByRole("button", { name: "Edit" }).click();
  await temporaryRow.getByLabel("Label name").fill("Renamed label");
  await temporaryRow.getByRole("button", { name: "Save label" }).click();
  await expect(page.locator('[data-label-name="Renamed label"]')).toBeVisible();
  await temporaryRow.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete label" }).click();
  await expect(page.locator('[data-label-name="Renamed label"]')).toHaveCount(0);

  await page.getByRole("tab", { name: /Issues/ }).click();
  await page.locator(`[data-issue-id="${parentId}"] a`).first().click();
  await expect(page.locator("[data-issue-identifier]").first()).toHaveText(identifier);
  await page.getByRole("combobox", { name: "Attach label" }).click();
  await page.getByRole("option", { name: "UI triage", exact: true }).click();
  await page.getByRole("button", { name: "Attach label" }).click();
  await expect(page.locator("[data-issue-label-id] [data-label-name='UI triage']")).toBeVisible();

  await page.getByLabel("Subtask name").fill("Finish the subtask");
  await page.getByRole("button", { name: "Create subtask" }).click();
  await expect(page.locator("[data-subtask-count]")).toHaveAttribute("data-subtask-count", "1");
  await expect(page.locator("[data-completed-subtask-count]")).toHaveAttribute(
    "data-completed-subtask-count",
    "0",
  );
  await expect(page.locator("[data-subtasks-section] li")).toHaveCount(1);

  await page.locator("[data-subtasks-section] li a").first().click();
  await expect(page.getByText(`Subtask of ${identifier}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create subtask" })).toHaveCount(0);
  await page
    .getByRole("link", { name: new RegExp(identifier) })
    .first()
    .click();
  await expect(page.locator("[data-issue-identifier]").first()).toHaveText(identifier);

  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(page.locator("[data-open-subtask-warning]")).toContainText("1 open subtask");
  await expect(page.locator("[data-issue-status]").first()).toHaveAttribute(
    "data-issue-status",
    "todo",
  );
  await page.getByRole("button", { name: "Close anyway" }).click();
  await expect(page.locator("[data-issue-status]").first()).toHaveAttribute(
    "data-issue-status",
    "done",
  );
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect(page.locator("[data-issue-status]").first()).toHaveAttribute(
    "data-issue-status",
    "todo",
  );

  await expect(page.locator("[data-trash-button]")).toBeEnabled();
  await page.locator("[data-trash-button]").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}`);
  await expect(page.locator(`[data-issue-id="${parentId}"]`)).toHaveCount(0);

  await page.locator("[data-trash-link]").click();
  await expect(page.locator(`[data-trashed-issue-id="${parentId}"]`)).toContainText(identifier);
  await page.getByRole("button", { name: `Restore ${identifier}` }).click();
  await expect(page.locator(`[data-trashed-issue-id="${parentId}"]`)).toHaveCount(0);

  await page.getByRole("link", { name: "Back to project" }).click();
  await page.locator("[data-board-link]").click();
  await expect(page.locator("[data-board-column]")).toHaveCount(6);
  await expect(page.getByRole("heading", { name: "Backlog", level: 4 })).toContainText("Backlog");
  expect(
    await page
      .locator("[data-board-status]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-board-status"))),
  ).toEqual(["backlog", "todo", "in_progress", "review", "done", "cancelled"]);

  const card = page.locator(`[data-board-issue-id="${parentId}"]`);
  await expect(card.locator("[data-issue-identifier]")).toHaveText(identifier);
  await expect(card.locator("[data-label-name='UI triage']")).toBeVisible();

  await page.getByRole("combobox", { name: "Label" }).click();
  await page.getByRole("option", { name: "UI triage", exact: true }).click();
  await expect(page.locator("[data-board-issue-id]")).toHaveCount(1);

  await page.getByRole("combobox", { name: "Priority" }).click();
  await page.getByRole("option", { name: "None", exact: true }).click();
  await expect(page.locator("[data-board-issue-id]")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Assignee" }).click();
  await page.getByRole("option", { name: "Unassigned", exact: true }).click();
  await expect(page.locator("[data-board-issue-id]")).toHaveCount(1);

  await page.getByRole("combobox", { name: `Move ${identifier}` }).click();
  await page.getByRole("option", { name: "In progress", exact: true }).click();
  await expect(
    page.locator(`[data-board-status="in_progress"] [data-board-issue-id="${parentId}"]`),
  ).toHaveCount(1);

  await page.getByRole("combobox", { name: `Move ${identifier}` }).click();
  await page.getByRole("option", { name: "Cancelled", exact: true }).click();
  await expect(page.locator("[data-board-open-subtask-warning]")).toContainText("1 open subtask");
  await expect(
    page.locator(`[data-board-status="in_progress"] [data-board-issue-id="${parentId}"]`),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Close anyway" }).click();
  await expect(
    page.locator(`[data-board-status="cancelled"] [data-board-issue-id="${parentId}"]`),
  ).toHaveCount(1);

  await page.locator(`[data-board-issue-id="${parentId}"] a`).first().click();
  await page.getByRole("button", { name: "Remove UI triage" }).click();
  await expect(page.locator("[data-issue-label-id] [data-label-name='UI triage']")).toHaveCount(0);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

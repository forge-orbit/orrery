import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const LONG_TITLE =
  "Investigate the intermittent failure of the nightly sync job when the upstream provider returns a partially paginated response for a workspace with more projects than the configured batch size";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}
function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
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

async function personalWorkspaceId(): Promise<string> {
  const res = await api.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const workspaces: unknown = await res.json();
  if (!Array.isArray(workspaces)) throw new Error("the workspaces listing is not a list");
  const personal = workspaces.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function newProject(): Promise<string> {
  const res = await api.post(`/api/workspaces/${await personalWorkspaceId()}/projects`, {
    data: { name: `Header and sidebar ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "project");
}

async function newIssue(projectId: string): Promise<string> {
  const body = Array.from(
    { length: 60 },
    (_, index) => `Paragraph ${index + 1}: enough prose to make the issue description scroll.`,
  ).join("\n\n");
  const res = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: LONG_TITLE, body },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "issue");
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
}

async function openIssue(page: Page): Promise<void> {
  await signIn(page);
  await page.goto(`/issues/${await newIssue(await newProject())}`);
  await expect(page.getByRole("heading", { name: LONG_TITLE, level: 1 })).toBeVisible();
}

test("keeps Edit beside a wrapping long title and puts Move to Trash in the sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await openIssue(page);

  const heading = page.locator("[data-page-header] h1");
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  const headingBox = await heading.boundingBox();
  const editBox = await edit.boundingBox();
  if (headingBox === null || editBox === null) throw new Error("the header did not lay out");

  // A long title wraps on the left rather than pushing the button onto a new row.
  expect(headingBox.height).toBeGreaterThan(50);
  expect(Math.abs(editBox.y - headingBox.y)).toBeLessThan(12);
  expect(editBox.y + editBox.height).toBeLessThan(headingBox.y + headingBox.height);

  await expect(page.locator("[data-page-header] [data-trash-button]")).toHaveCount(0);
  const sidebar = page.getByRole("complementary", { name: "Issue details" });
  const trash = sidebar.locator("[data-trash-button]");
  await expect(trash).toBeVisible();
  const properties = page.locator('[aria-label="Issue properties"]');
  const propertiesBox = await properties.boundingBox();
  const trashBox = await trash.boundingBox();
  if (propertiesBox === null || trashBox === null) throw new Error("the sidebar did not lay out");
  expect(trashBox.y).toBeGreaterThan(propertiesBox.y + propertiesBox.height - 4);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("sticks the right sidebar on desktop and stacks it below the content on narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await openIssue(page);

  const sidebar = page.getByRole("complementary", { name: "Issue details" });
  const description = page.getByRole("heading", { name: "Description", level: 2 });
  await expect(sidebar).toBeVisible();

  async function scrollMainBy(delta: number) {
    // Keep the pointer over the main column: the description heading itself
    // scrolls out of the viewport as the test progresses.
    await page.mouse.move(420, 400);
    await page.mouse.wheel(0, delta);
  }

  // Scroll past the point where the sidebar starts sticking, then scroll again.
  await scrollMainBy(700);
  await expect.poll(async () => (await description.boundingBox())?.y ?? 0).toBeLessThan(500);
  const firstSidebarBox = await sidebar.boundingBox();
  const firstDescriptionBox = await description.boundingBox();

  await scrollMainBy(500);
  await expect
    .poll(async () => (await description.boundingBox())?.y ?? 0)
    .toBeLessThan((firstDescriptionBox?.y ?? 0) - 100);
  const secondSidebarBox = await sidebar.boundingBox();

  if (firstSidebarBox === null || secondSidebarBox === null)
    throw new Error("the sticky sidebar did not lay out");
  expect(Math.abs(secondSidebarBox.y - firstSidebarBox.y)).toBeLessThan(4);

  async function assertNarrowLayout(width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    const stackedProperties = page.locator('[aria-label="Issue properties"]');
    const stackedTrash = page.locator("[data-trash-button]");
    await expect(stackedProperties).toBeVisible();
    await expect(description).toBeVisible();
    await expect(stackedTrash).toBeVisible();
    const stackedSidebarBox = await stackedProperties.boundingBox();
    const stackedDescriptionBox = await description.boundingBox();
    const stackedTrashBox = await stackedTrash.boundingBox();
    if (stackedSidebarBox === null || stackedDescriptionBox === null || stackedTrashBox === null)
      throw new Error("the stacked layout did not lay out");
    expect(stackedDescriptionBox.y).toBeLessThan(stackedSidebarBox.y);
    expect(stackedTrashBox.y).toBeGreaterThan(stackedSidebarBox.y + stackedSidebarBox.height - 4);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  }

  await assertNarrowLayout(800, 900);
  await assertNarrowLayout(390, 844);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("keeps the new issue form full width with Triage stacked below on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`/projects/${await newProject()}/issues/new`);
  await expect(page.getByRole("heading", { name: "New issue", level: 1 })).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  const titleBox = await page.locator("#new-issue-title").boundingBox();
  if (titleBox === null) throw new Error("the new issue title did not lay out");
  expect(titleBox.width).toBeGreaterThan(250);

  const formBox = await page.locator("[data-new-issue-form]").boundingBox();
  const triage = page.getByRole("heading", { name: "Triage" });
  const triageBox = await triage.boundingBox();
  if (formBox === null || triageBox === null)
    throw new Error("the stacked new issue layout did not lay out");
  expect(triageBox.y).toBeGreaterThan(formBox.y + formBox.height);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

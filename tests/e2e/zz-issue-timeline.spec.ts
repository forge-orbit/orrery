import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Browser } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}
function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
  const personal = asArray(await res.json()).find(
    (workspace) => field(workspace, "kind") === "personal",
  );
  return idOf(personal, "personal workspace");
}

async function newProject(): Promise<string> {
  const res = await api.post(`/api/workspaces/${await personalWorkspaceId()}/projects`, {
    data: { name: `Timeline ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "project");
}

async function newIssue(projectId: string): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/issues`, {
    data: { title: `Timeline issue ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "issue");
}

async function signIn(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
  return { context, page };
}

test("exposes issue-scoped activity with structured detail over REST", async () => {
  const projectId = await newProject();
  const issueId = await newIssue(projectId);
  const otherIssueId = await newIssue(projectId);

  const labelRes = await api.post(`/api/projects/${projectId}/labels`, {
    data: { name: `area:ui-${randomUUID()}`, color: "#3b74d6" },
  });
  expect(labelRes.status()).toBe(201);
  const label = await labelRes.json();

  expect((await api.post(`/api/issues/${issueId}/labels/${idOf(label, "label")}`)).status()).toBe(
    201,
  );
  expect((await api.patch(`/api/issues/${issueId}`, { data: { priority: "high" } })).status()).toBe(
    200,
  );
  expect(
    (
      await api.post(`/api/issues/${otherIssueId}/comments`, {
        data: { body: "A comment on the other issue" },
      })
    ).status(),
  ).toBe(201);

  const activity = await api.get(`/api/issues/${issueId}/activity`);
  expect(activity.status()).toBe(200);
  const events = asArray(await activity.json());
  expect(events.map((event) => field(event, "type"))).toEqual([
    "issue_created",
    "issue_label_added",
    "issue_edited",
  ]);
  expect(events.every((event) => field(event, "issueId") === issueId)).toBe(true);
  expect(events[0]).toMatchObject({ detail: null });
  expect(events[1]).toMatchObject({
    detail: {
      kind: "label_added",
      label: { id: idOf(label, "label"), color: "#3b74d6" },
    },
  });
  expect(events[2]).toMatchObject({
    detail: { kind: "issue_edited", changes: [{ kind: "priority", from: "none", to: "high" }] },
  });

  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const denied = await anonymous.get(`/api/issues/${issueId}/activity`);
    expect(denied.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test("renders one chronological timeline with grouped labels and quote reply", async ({
  browser,
}) => {
  const projectId = await newProject();
  const issueId = await newIssue(projectId);

  const firstLabel = await api.post(`/api/projects/${projectId}/labels`, {
    data: { name: `enhancement-${randomUUID()}`, color: "#2f9e66" },
  });
  const secondLabel = await api.post(`/api/projects/${projectId}/labels`, {
    data: { name: `area:ui-${randomUUID()}`, color: "#3b74d6" },
  });
  expect(firstLabel.status()).toBe(201);
  expect(secondLabel.status()).toBe(201);

  expect(
    (
      await api.post(`/api/issues/${issueId}/comments`, {
        data: { body: "First comment for the timeline." },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await api.post(`/api/issues/${issueId}/labels/${idOf(await firstLabel.json(), "label")}`)
    ).status(),
  ).toBe(201);
  expect(
    (
      await api.post(`/api/issues/${issueId}/labels/${idOf(await secondLabel.json(), "label")}`)
    ).status(),
  ).toBe(201);
  expect(
    (await api.patch(`/api/issues/${issueId}`, { data: { status: "in_progress" } })).status(),
  ).toBe(200);
  expect(
    (
      await api.post(`/api/issues/${issueId}/comments`, {
        data: { body: "Second comment for the timeline." },
      })
    ).status(),
  ).toBe(201);

  const { context, page } = await signIn(browser);
  try {
    await page.goto(`/issues/${issueId}`);
    const timeline = page.locator("[data-issue-timeline]");
    await expect(timeline).toBeVisible();

    const kinds = await timeline
      .locator(":scope > li")
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-timeline-kind")));
    expect(kinds).toEqual(["activity", "comment", "label_group", "activity", "comment"]);
    await expect(timeline.locator('[data-timeline-kind="comment"] [data-comment-body]')).toHaveText(
      ["First comment for the timeline.", "Second comment for the timeline."],
    );

    const group = timeline.locator('[data-timeline-kind="label_group"]');
    await expect(group.locator("[data-label-name]")).toHaveCount(2);
    await expect(group).toContainText("added");

    await expect(page.getByRole("complementary", { name: "Issue details" })).toBeVisible();
    await expect(
      timeline.locator('[data-timeline-kind="activity"][data-activity-type="issue_edited"]'),
    ).toContainText("changed status from Todo to In progress");

    await page.locator("[data-quote-comment-id]").first().click();
    const composer = page.locator("#issue-comment");
    await expect(composer).toHaveValue(/> First comment for the timeline\./);
    await expect(composer).toBeFocused();
  } finally {
    for (const cookie of await context.cookies()) await recordSecret(cookie.value);
    await context.close();
  }
});

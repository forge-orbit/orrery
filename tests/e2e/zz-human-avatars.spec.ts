import { randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const baseUrl: string = configuredUrl;
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

const SMTP = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

/** Two distinct, valid PNGs; the server normalizes each to a 256x256 WebP. */
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWO4o6ZGEmIY1aA2Gkp3hmvSAAATqigQlgpyEwAAAABJRU5ErkJggg==",
  "base64",
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWNQC7hDEmIY1RAwGkpqwzVpAAD7TFIQovfuoQAAAABJRU5ErkJggg==",
  "base64",
);

test.describe.configure({ mode: "serial" });

const memberEmail = `avatar.member.${randomUUID()}@orrery.test`;
const memberPassword = "avatar-member-password";

let admin: APIRequestContext;
let member: APIRequestContext;
let workspaceId = "";
let projectId = "";
let issueId = "";
let commentId = "";
let adminHumanId = "";
let memberHumanId = "";
let firstAvatarUrl = "";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}

async function bodyOf(res: APIResponse): Promise<unknown> {
  return (await res.json()) as unknown;
}

function membersOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("the members listing is not a list");
  return value;
}

function humanIdFor(value: unknown, email: string): string {
  for (const entry of membersOf(value)) {
    if (field(entry, "email") !== email) continue;
    return requiredText(field(entry, "humanId"), `the human id for ${email}`);
  }
  throw new Error(`no member ${email}`);
}

async function newContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: baseUrl });
}

async function signInApi(client: APIRequestContext, email: string, password: string) {
  const res = await client.post("/api/auth/login", { data: { email, password } });
  expect(res.status()).toBe(200);
}

async function signInUi(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-app-sidebar]")).toBeVisible();
}

async function verificationToken(): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body = await bodyOf(list);
  const messages = field(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Verify your Orrery email") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught = await bodyOf(detail);
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    const to = field(caught, "To");
    if (!Array.isArray(to) || !to.some((entry) => field(entry, "Address") === ADMIN_EMAIL)) {
      continue;
    }
    return text.match(/\/settings\/smtp\?token=([A-Za-z0-9_-]+)/)?.[1];
  }
  return undefined;
}

async function invitationToken(): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body = await bodyOf(list);
  const messages = field(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught = await bodyOf(detail);
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(memberEmail)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

async function ensureAdminVerified() {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await bodyOf(session), "emailVerified") === true) return;
  expect((await admin.put("/api/settings/smtp", { data: SMTP })).status()).toBe(200);
  expect((await admin.post("/api/settings/smtp/test")).status()).toBe(200);
  await expect.poll(() => verificationToken(), { timeout: 15_000 }).toBeTruthy();
  const token = await verificationToken();
  if (token === undefined) throw new Error("the catcher never received a verification email");
  await recordSecret(token);
  expect((await admin.post("/api/settings/email-verification", { data: { token } })).status()).toBe(
    200,
  );
}

async function sessionAvatarUrl(page: Page): Promise<string | null> {
  const res = await page.request.get("/api/auth/session");
  expect(res.status()).toBe(200);
  const value = field(await bodyOf(res), "avatarUrl");
  return value === undefined || value === null ? null : requiredText(value, "avatarUrl");
}

async function uploadFromAccount(page: Page, bytes: Buffer, filename: string) {
  await page.goto("/account");
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: bytes,
  });
}

async function expectInitials(avatar: Locator) {
  await expect(avatar).toHaveAttribute("data-avatar-state", "initials");
  await expect(avatar.locator("img")).toHaveCount(0);
}

async function expectPhoto(avatar: Locator, avatarUrl: string) {
  await expect(avatar).toHaveAttribute("data-avatar-state", "photo");
  const img = avatar.locator("img");
  await expect(img).toHaveAttribute("src", avatarUrl);
  await expect
    .poll(
      () =>
        img.evaluate((element) => {
          const width: unknown = Reflect.get(element, "naturalWidth");
          return typeof width === "number" ? width : 0;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}

test.beforeAll(async () => {
  admin = await newContext();
  await signInApi(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
  await ensureAdminVerified();

  const created = await admin.post("/api/workspaces", {
    data: { name: `Avatar Team ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  workspaceId = requiredText(field(await bodyOf(created), "id"), "the workspace id");

  const invited = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: memberEmail },
  });
  expect(invited.status()).toBe(201);
  await expect.poll(() => invitationToken(), { timeout: 15_000 }).toBeTruthy();
  const token = await invitationToken();
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);
  await recordSecret(memberPassword);
  const registering = await newContext();
  const accepted = await registering.post("/api/workspace-invitations/registration", {
    data: { token, password: memberPassword },
  });
  expect(accepted.status()).toBe(200);
  await registering.dispose();
  member = await newContext();
  await signInApi(member, memberEmail, memberPassword);

  const members = await bodyOf(await admin.get(`/api/workspaces/${workspaceId}/members`));
  adminHumanId = humanIdFor(members, ADMIN_EMAIL);
  memberHumanId = humanIdFor(members, memberEmail);

  const project = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Avatar Project" },
  });
  expect(project.status()).toBe(201);
  projectId = requiredText(field(await bodyOf(project), "id"), "the project id");

  const issue = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Avatar issue" },
  });
  expect(issue.status()).toBe(201);
  issueId = requiredText(field(await bodyOf(issue), "id"), "the issue id");

  const assigned = await admin.patch(`/api/issues/${issueId}`, {
    data: { assignee: { type: "human", id: adminHumanId } },
  });
  expect(assigned.status()).toBe(200);
  const assignee = field(await bodyOf(assigned), "assignee");
  expect(field(assignee, "humanId")).toBe(adminHumanId);
  expect(field(assignee, "avatarUrl")).not.toBeUndefined();

  const commented = await admin.post(`/api/issues/${issueId}/comments`, {
    data: { body: "An avatar comment." },
  });
  expect(commented.status()).toBe(201);
  const comment = await bodyOf(commented);
  commentId = requiredText(field(comment, "id"), "the comment id");
  expect(field(field(comment, "author"), "avatarUrl")).not.toBeUndefined();

  const grant = await admin.patch(`/api/projects/${projectId}/access`, {
    data: { email: memberEmail, level: "read" },
  });
  expect(grant.status()).toBe(200);

  // Let the member see the workspace Members tab so the initials fallback is
  // observable from an ordinary member's session too.
  const capability = await admin.patch(`/api/workspaces/${workspaceId}/members/${memberHumanId}`, {
    data: { canRemoveMembers: true },
  });
  expect(capability.status()).toBe(200);
});

test.afterAll(async () => {
  await admin?.dispose();
  await member?.dispose();
});

test("falls back to initials for a Human without a profile photo", async ({ page }) => {
  await signInUi(page, memberEmail, memberPassword);
  const sidebar = page.locator(
    "[data-app-sidebar] [data-sidebar-account-link] [data-avatar-state]",
  );
  await expectInitials(sidebar);

  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: /Members/ }).click();
  await expectInitials(page.locator(`[data-member-id="${memberHumanId}"] [data-avatar-state]`));
  await recordCookies(page);
});

test("renders an uploaded photo across sidebar, members, issues, comments and activity", async ({
  page,
}) => {
  await signInUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await uploadFromAccount(page, RED_PNG, "red.png");

  await expect
    .poll(async () => sessionAvatarUrl(page), { timeout: 15_000 })
    .toMatch(/^\/api\/humans\/[^/]+\/avatar\?v=[0-9a-f-]{36}$/);
  firstAvatarUrl = requiredText(await sessionAvatarUrl(page), "the uploaded avatar url");

  await expectPhoto(page.locator("#content [data-avatar-state]").first(), firstAvatarUrl);
  await expectPhoto(
    page.locator("[data-app-sidebar] [data-sidebar-account-link] [data-avatar-state]"),
    firstAvatarUrl,
  );

  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: /Members/ }).click();
  await expectPhoto(
    page.locator(`[data-member-id="${adminHumanId}"] [data-avatar-state]`),
    firstAvatarUrl,
  );
  await expectInitials(page.locator(`[data-member-id="${memberHumanId}"] [data-avatar-state]`));

  await page.goto(`/board/${projectId}`);
  await expectPhoto(
    page.locator(`[data-board-issue-id="${issueId}"] [data-avatar-state]`),
    firstAvatarUrl,
  );

  await page.goto(`/issues/${issueId}`);
  for (const avatar of await page.locator("[data-issue-assignee] [data-avatar-state]").all()) {
    await expectPhoto(avatar, firstAvatarUrl);
  }
  await expectPhoto(
    page.locator(`[data-comment-id="${commentId}"] [data-avatar-state]`),
    firstAvatarUrl,
  );

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("tab", { name: "Activity" }).click();
  await expectPhoto(
    page.locator('[data-activity-type="issue_created"] [data-avatar-state]').first(),
    firstAvatarUrl,
  );
  await expectPhoto(
    page.locator('[data-activity-type="issue_commented"] [data-avatar-state]').first(),
    firstAvatarUrl,
  );

  await page.goto(`/history/project/${projectId}`);
  await expectPhoto(
    page.locator('[data-event-type="issue_commented"] [data-avatar-state]').first(),
    firstAvatarUrl,
  );
  await recordCookies(page);
});

test("replaces the photo with a fresh cache-busted URL and no stale image", async ({ page }) => {
  expect(firstAvatarUrl).not.toBe("");
  await signInUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const before = await page.request.get(firstAvatarUrl);
  expect(before.status()).toBe(200);
  const firstEtag = before.headers()["etag"];
  expect(firstEtag).toBeTruthy();

  await uploadFromAccount(page, BLUE_PNG, "blue.png");
  await expect
    .poll(async () => sessionAvatarUrl(page), { timeout: 15_000 })
    .not.toBe(firstAvatarUrl);
  const secondAvatarUrl = requiredText(await sessionAvatarUrl(page), "the replacement avatar url");
  expect(secondAvatarUrl).toMatch(/^\/api\/humans\/[^/]+\/avatar\?v=[0-9a-f-]{36}$/);
  expect(secondAvatarUrl).not.toBe(firstAvatarUrl);

  const after = await page.request.get(secondAvatarUrl);
  expect(after.status()).toBe(200);
  expect(after.headers()["cache-control"]).toContain("immutable");
  expect(after.headers()["etag"]).not.toBe(firstEtag);
  const oldVersion = await page.request.get(firstAvatarUrl);
  expect(oldVersion.headers()["cache-control"]).toContain("no-cache");

  await expectPhoto(page.locator("#content [data-avatar-state]").first(), secondAvatarUrl);
  await expectPhoto(
    page.locator("[data-app-sidebar] [data-sidebar-account-link] [data-avatar-state]"),
    secondAvatarUrl,
  );
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: /Members/ }).click();
  await expectPhoto(
    page.locator(`[data-member-id="${adminHumanId}"] [data-avatar-state]`),
    secondAvatarUrl,
  );
  await page.goto(`/board/${projectId}`);
  await expectPhoto(
    page.locator(`[data-board-issue-id="${issueId}"] [data-avatar-state]`),
    secondAvatarUrl,
  );
  await recordCookies(page);
});

test("removes the photo and returns to initials across surfaces", async ({ page }) => {
  await signInUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto("/account");

  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect.poll(async () => sessionAvatarUrl(page), { timeout: 15_000 }).toBeNull();

  await expectInitials(page.locator("#content [data-avatar-state]").first());
  await expectInitials(
    page.locator("[data-app-sidebar] [data-sidebar-account-link] [data-avatar-state]"),
  );

  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: /Members/ }).click();
  await expectInitials(page.locator(`[data-member-id="${adminHumanId}"] [data-avatar-state]`));

  await page.goto(`/board/${projectId}`);
  await expectInitials(page.locator(`[data-board-issue-id="${issueId}"] [data-avatar-state]`));
  await recordCookies(page);
});

async function recordCookies(page: Page) {
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
}

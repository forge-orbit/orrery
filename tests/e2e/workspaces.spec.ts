import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

const EXISTING_EMAIL = "workspace.existing@orrery.test";
const EXISTING_PASSWORD = "existing-workspace-password";
const NEW_EMAIL = "workspace.newcomer@orrery.test";
const NEW_PASSWORD = "new-workspace-password";

let invitationToken = "";
let invitationWorkspaceId = "";

let api: APIRequestContext;
test.beforeAll(async () => {
  for (const value of [EXISTING_PASSWORD, NEW_PASSWORD]) await recordSecret(value);
  api = await request.newContext({ baseURL: baseUrl });

  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const saved = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);

  const alreadyExists = await request.newContext({ baseURL: baseUrl });
  let knownAccount = false;
  try {
    const knownLogin = await alreadyExists.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    knownAccount = knownLogin.status() === 200;
  } finally {
    await alreadyExists.dispose();
  }
  if (!knownAccount) {
    const invited = await api.post("/api/invitations/installation", {
      data: { email: EXISTING_EMAIL },
    });
    expect(invited.status()).toBe(201);
    await expect
      .poll(async () => caughtToken(api, EXISTING_EMAIL, "installation"), { timeout: 15_000 })
      .toBeTruthy();
    const token = await caughtToken(api, EXISTING_EMAIL, "installation");
    if (token === undefined)
      throw new Error("the catcher never received the installation invitation");
    await recordSecret(token);
    const registered = await api.post("/api/invitations/installation/registration", {
      data: { token, password: EXISTING_PASSWORD },
    });
    expect(registered.status()).toBe(200);
  }
});
test.afterAll(async () => {
  await api?.dispose();
});

test("creates a shared workspace and refuses removing its last owner", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Solo Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  expect(workspace).toMatchObject({ kind: "shared", name: "Solo Team", isOwner: true });

  const members = await api.get(`/api/workspaces/${workspace.id}/members`);
  expect(members.status()).toBe(200);
  const body: unknown = await members.json();
  if (!Array.isArray(body)) throw new Error("the members listing is not a list");
  const admin = body.find((member) => {
    if (typeof member !== "object" || member === null) return false;
    return Reflect.get(member, "email") === ADMIN_EMAIL;
  });
  if (typeof admin !== "object" || admin === null)
    throw new Error("the administrator is not a member");
  const adminId: unknown = Reflect.get(admin, "humanId");
  if (typeof adminId !== "string") throw new Error("the administrator member has no id");

  const refused = await api.delete(`/api/workspaces/${workspace.id}/members/${adminId}`);
  expect(refused.status()).toBe(409);
  expect(refused.headers()["content-type"]).toBe("application/problem+json");
  expect(await refused.json()).toMatchObject({ status: 409, code: "last_owner" });

  const list = await api.get("/api/workspaces");
  expect(list.status()).toBe(200);
  const listBody: unknown = await list.json();
  if (!Array.isArray(listBody)) throw new Error("the workspaces listing is not a list");
  expect(listBody).toContainEqual(
    expect.objectContaining({ id: workspace.id, name: "Solo Team", isOwner: true }),
  );
});

test("invites an existing account, and a forwarded link is refused", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Rocket Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  invitationWorkspaceId = workspace.id;

  const projectResponse = await api.post(`/api/workspaces/${workspace.id}/projects`, {
    data: { name: "Rocket Guidance" },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const sent = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: {
      email: EXISTING_EMAIL,
      projectGrants: [{ projectId: project.id, level: "contribute" }],
    },
  });
  expect(sent.status()).toBe(201);
  expect(await sent.json()).toEqual({
    workspaceId: workspace.id,
    email: EXISTING_EMAIL,
    status: "pending",
  });

  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Rocket Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const token = await caughtToken(api, EXISTING_EMAIL, "workspace", "Rocket Team");
  if (token === undefined) throw new Error("the catcher never received the workspace invitation");
  await recordSecret(token);
  invitationToken = token;

  const preview = await api.get(`/api/workspace-invitations/preview?token=${token}`);
  expect(preview.status()).toBe(200);
  expect(await preview.json()).toMatchObject({
    workspaceId: workspace.id,
    workspaceName: "Rocket Team",
    email: EXISTING_EMAIL,
    grants: expect.arrayContaining([
      {
        kind: "project_access",
        projectId: project.id,
        projectName: "Rocket Guidance",
        level: "contribute",
      },
    ]),
  });

  const forwarded = await api.post("/api/workspace-invitations/acceptance", {
    data: { token },
  });
  expect(forwarded.status()).toBe(403);
  expect(forwarded.headers()["content-type"]).toBe("application/problem+json");
  expect(await forwarded.json()).toMatchObject({
    status: 403,
    code: "invitation_recipient_mismatch",
  });

  const stillThere = await api.get(`/api/workspace-invitations/preview?token=${token}`);
  expect(stillThere.status()).toBe(200);
});

test("registers a new email into a workspace without a duplicate account", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Newcomer Lab" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const sent = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: NEW_EMAIL },
  });
  expect(sent.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, NEW_EMAIL, "workspace", "Newcomer Lab"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const token = await caughtToken(api, NEW_EMAIL, "workspace", "Newcomer Lab");
  if (token === undefined) throw new Error("the catcher never received the workspace invitation");
  await recordSecret(token);

  const registered = await api.post("/api/workspace-invitations/registration", {
    data: { token, password: NEW_PASSWORD },
  });
  expect(registered.status()).toBe(200);
  expect(await registered.json()).toEqual({
    email: NEW_EMAIL,
    emailVerified: true,
    avatarUrl: null,
  });

  const newcomer = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await newcomer.post("/api/auth/login", {
      data: { email: NEW_EMAIL, password: NEW_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const workspaces = await newcomer.get("/api/workspaces");
    const body: unknown = await workspaces.json();
    if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
    expect(body).toContainEqual(
      expect.objectContaining({ id: workspace.id, kind: "shared", isOwner: false }),
    );
  } finally {
    await newcomer.dispose();
  }
});

test("resends a workspace invitation, and the old link stops working", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Resend Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const sent = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(sent.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Resend Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const oldToken = await caughtToken(api, EXISTING_EMAIL, "workspace", "Resend Team");
  if (oldToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(oldToken);
  const id = await invitationId(api, workspace.id, EXISTING_EMAIL, "pending");

  const resent = await api.post(`/api/workspaces/${workspace.id}/invitations/${id}/resend`);
  expect(resent.status()).toBe(200);
  const fresh: unknown = await resent.json();
  if (typeof fresh !== "object" || fresh === null) throw new Error("the resend returned no body");
  expect(fresh).toMatchObject({
    email: EXISTING_EMAIL,
    status: "pending",
    target: { kind: "workspace", id: workspace.id, name: "Resend Team" },
    grants: [{ kind: "workspace_membership", workspaceId: workspace.id, role: "member" }],
    delivery: { status: "sent" },
  });
  const freshId: unknown = Reflect.get(fresh, "id");
  if (typeof freshId !== "string") throw new Error("the new invitation has no id");

  await expect
    .poll(
      async () => (await caughtTokens(api, EXISTING_EMAIL, "workspace", "Resend Team")).length,
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(1);
  const tokens = await caughtTokens(api, EXISTING_EMAIL, "workspace", "Resend Team");
  const newToken = tokens.find((token) => token !== oldToken);
  if (newToken === undefined) throw new Error("the catcher never received the resent invitation");
  await recordSecret(newToken);

  const historyRes = await api.get(`/api/workspaces/${workspace.id}/invitations`);
  expect(historyRes.status()).toBe(200);
  const history: unknown = await historyRes.json();
  if (!Array.isArray(history)) throw new Error("the invitation history is not a list");
  expect(history).toContainEqual(expect.objectContaining({ id, status: "revoked" }));
  expect(history).toContainEqual(expect.objectContaining({ id: freshId, status: "pending" }));

  const oldPreview = await api.get(`/api/workspace-invitations/preview?token=${oldToken}`);
  expect(oldPreview.status()).toBe(400);
  expect(await oldPreview.json()).toMatchObject({ code: "invitation_invalid" });
  const newPreview = await api.get(`/api/workspace-invitations/preview?token=${newToken}`);
  expect(newPreview.status()).toBe(200);
  expect(await newPreview.json()).toMatchObject({
    workspaceId: workspace.id,
    workspaceName: "Resend Team",
    email: EXISTING_EMAIL,
    invitedByEmail: ADMIN_EMAIL,
    grants: [{ kind: "workspace_membership", workspaceId: workspace.id, role: "member" }],
  });

  const recipient = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await recipient.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const oldAttempt = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: oldToken },
    });
    expect(oldAttempt.status()).toBe(400);
    const accepted = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: newToken },
    });
    expect(accepted.status()).toBe(200);
    expect(await accepted.json()).toMatchObject({ id: workspace.id, name: "Resend Team" });
  } finally {
    await recipient.dispose();
  }
});

test("revokes and declines workspace invitations", async () => {
  const created = await api.post("/api/workspaces", { data: { name: "Lifecycle Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const invited = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Lifecycle Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const revokedToken = await caughtToken(api, EXISTING_EMAIL, "workspace", "Lifecycle Team");
  if (revokedToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(revokedToken);
  const revokedId = await invitationId(api, workspace.id, EXISTING_EMAIL, "pending");

  const revoked = await api.post(`/api/workspaces/${workspace.id}/invitations/${revokedId}/revoke`);
  expect(revoked.status()).toBe(200);
  expect(await revoked.json()).toMatchObject({ id: revokedId, status: "revoked" });
  const revokedPreview = await api.get(`/api/workspace-invitations/preview?token=${revokedToken}`);
  expect(revokedPreview.status()).toBe(400);

  const recipient = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await recipient.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const refused = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: revokedToken },
    });
    expect(refused.status()).toBe(400);

    const reinvited = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
      data: { email: EXISTING_EMAIL },
    });
    expect(reinvited.status()).toBe(201);
    await expect
      .poll(
        async () => {
          const tokens = await caughtTokens(api, EXISTING_EMAIL, "workspace", "Lifecycle Team");
          return tokens.some((token) => token !== revokedToken);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const tokens = await caughtTokens(api, EXISTING_EMAIL, "workspace", "Lifecycle Team");
    const declinedToken = tokens.find((token) => token !== revokedToken);
    if (declinedToken === undefined) throw new Error("the catcher never received the new offer");
    await recordSecret(declinedToken);

    const declined = await recipient.post("/api/workspace-invitations/decline", {
      data: { token: declinedToken },
    });
    expect(declined.status()).toBe(204);
    const again = await recipient.post("/api/workspace-invitations/decline", {
      data: { token: declinedToken },
    });
    expect(again.status()).toBe(400);
    expect(await again.json()).toMatchObject({ code: "invitation_invalid" });
    const declinedPreview = await api.get(
      `/api/workspace-invitations/preview?token=${declinedToken}`,
    );
    expect(declinedPreview.status()).toBe(400);

    const historyRes = await api.get(`/api/workspaces/${workspace.id}/invitations`);
    const history: unknown = await historyRes.json();
    if (!Array.isArray(history)) throw new Error("the invitation history is not a list");
    expect(history).toContainEqual(expect.objectContaining({ id: revokedId, status: "revoked" }));
    expect(history).toContainEqual(
      expect.objectContaining({ email: EXISTING_EMAIL, status: "declined" }),
    );
  } finally {
    await recipient.dispose();
  }
});

test("an inviter removed as owner cannot have their invitation accepted", async () => {
  const RECIPIENT_EMAIL = "authority.recipient@orrery.test";
  const RECIPIENT_PASSWORD = "authority-recipient-password";
  await recordSecret(RECIPIENT_PASSWORD);

  const invited = await api.post("/api/invitations/installation", {
    data: { email: RECIPIENT_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, RECIPIENT_EMAIL, "installation"), { timeout: 15_000 })
    .toBeTruthy();
  const registrationToken = await caughtToken(api, RECIPIENT_EMAIL, "installation");
  if (registrationToken === undefined)
    throw new Error("the catcher never received the installation invitation");
  await recordSecret(registrationToken);
  const registration = await api.post("/api/invitations/installation/registration", {
    data: { token: registrationToken, password: RECIPIENT_PASSWORD },
  });
  expect(registration.status()).toBe(200);

  const created = await api.post("/api/workspaces", { data: { name: "Authority Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  const memberInvite = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: EXISTING_EMAIL },
  });
  expect(memberInvite.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, EXISTING_EMAIL, "workspace", "Authority Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const memberToken = await caughtToken(api, EXISTING_EMAIL, "workspace", "Authority Team");
  if (memberToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(memberToken);
  const member = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await member.post("/api/auth/login", {
      data: { email: EXISTING_EMAIL, password: EXISTING_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const accepted = await member.post("/api/workspace-invitations/acceptance", {
      data: { token: memberToken },
    });
    expect(accepted.status()).toBe(200);
  } finally {
    await member.dispose();
  }

  const membersRes = await api.get(`/api/workspaces/${workspace.id}/members`);
  const members: unknown = await membersRes.json();
  if (!Array.isArray(members)) throw new Error("the member directory is not a list");
  const memberEntry = members.find(
    (entry) =>
      typeof entry === "object" && entry !== null && Reflect.get(entry, "email") === EXISTING_EMAIL,
  );
  if (typeof memberEntry !== "object" || memberEntry === null)
    throw new Error("the member is not in the directory");
  const memberId: unknown = Reflect.get(memberEntry, "humanId");
  if (typeof memberId !== "string") throw new Error("the member has no id");
  const appointed = await api.post(`/api/workspaces/${workspace.id}/owners`, {
    data: { humanId: memberId },
  });
  expect(appointed.status()).toBe(200);

  const recipientInvite = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: RECIPIENT_EMAIL },
  });
  expect(recipientInvite.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, RECIPIENT_EMAIL, "workspace", "Authority Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const pendingToken = await caughtToken(api, RECIPIENT_EMAIL, "workspace", "Authority Team");
  if (pendingToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(pendingToken);

  const adminEntry = members.find(
    (entry) =>
      typeof entry === "object" && entry !== null && Reflect.get(entry, "email") === ADMIN_EMAIL,
  );
  if (typeof adminEntry !== "object" || adminEntry === null)
    throw new Error("the administrator is not in the directory");
  const adminId: unknown = Reflect.get(adminEntry, "humanId");
  if (typeof adminId !== "string") throw new Error("the administrator has no id");
  const left = await api.delete(`/api/workspaces/${workspace.id}/members/${adminId}`);
  expect(left.status()).toBe(204);

  const recipient = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await recipient.post("/api/auth/login", {
      data: { email: RECIPIENT_EMAIL, password: RECIPIENT_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const refused = await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: pendingToken },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "inviter_not_authorized" });
    const stillPending = await api.get(`/api/workspace-invitations/preview?token=${pendingToken}`);
    expect(stillPending.status()).toBe(200);
  } finally {
    await recipient.dispose();
  }
});

test("workspace invite form refreshes failed delivery history without a reload", async ({
  page,
}) => {
  const FAILED_EMAIL = "workspace.smtp.failure@orrery.test";
  const created = await api.post("/api/workspaces", { data: { name: "SMTP Failure Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();

  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
  await page.goto(`/workspaces/${workspace.id}`);
  await page.getByRole("tab", { name: "Members" }).click();

  await api.put("/api/settings/smtp", {
    data: { ...SETTINGS, host: "127.0.0.1", port: 1 },
  });
  try {
    await page.getByRole("button", { name: "Invite member" }).click();
    await page.getByLabel("Email").fill(FAILED_EMAIL);
    await page.getByRole("button", { name: "Send invitation" }).click();

    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "Could not reach the SMTP server",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Invitation history" })).toBeVisible();
    const row = page.locator("[data-invitation-id]").filter({ hasText: FAILED_EMAIL });
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("Email failed");
    await expect(row).toContainText("Created");
    await expect(row.getByRole("button", { name: "Resend" })).toBeVisible();
  } finally {
    const repaired = await api.put("/api/settings/smtp", { data: SETTINGS });
    expect(repaired.status()).toBe(200);
  }

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("owner sees invitation history and delivery separately, and resends from the page", async ({
  page,
}) => {
  const HISTORY_EMAIL = "history.person@orrery.test";
  const created = await api.post("/api/workspaces", { data: { name: "History Team" } });
  expect(created.status()).toBe(201);
  const workspace = await created.json();
  const invited = await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    data: { email: HISTORY_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, HISTORY_EMAIL, "workspace", "History Team"), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const before = await caughtTokens(api, HISTORY_EMAIL, "workspace", "History Team");
  for (const token of before) await recordSecret(token);

  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  await page.goto(`/workspaces/${workspace.id}`);
  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Invitation history" })).toBeVisible();
  const row = page.locator("[data-invitation-id]").filter({ hasText: HISTORY_EMAIL });
  await expect(row).toContainText("Pending");
  await expect(row).toContainText("Email sent");
  await expect(row).toContainText(`Invited by ${ADMIN_EMAIL}`);
  await expect(row).toContainText("Workspace member");
  await expect(row.getByRole("button", { name: "Resend" })).toBeVisible();

  await row.getByRole("button", { name: "Resend" }).click();
  await expect
    .poll(
      async () => (await caughtTokens(api, HISTORY_EMAIL, "workspace", "History Team")).length,
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(before.length);
  for (const token of await caughtTokens(api, HISTORY_EMAIL, "workspace", "History Team")) {
    await recordSecret(token);
  }
  await expect(page.locator("[data-invitation-id]")).toHaveCount(2);
  await expect(page.locator('[data-invitation-status="revoked"]')).toHaveCount(1);
  const pending = page.locator('[data-invitation-status="pending"]');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText("Email sent");

  await pending.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke invitation" }).click();
  await expect(page.locator('[data-invitation-status="revoked"]')).toHaveCount(2);
  await expect(page.locator('[data-invitation-status="pending"]')).toHaveCount(0);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("accepts a workspace invitation through sign-in, then an owner appoints", async ({
  page,
  browser,
}) => {
  expect(invitationToken).not.toBe("");
  expect(invitationWorkspaceId).not.toBe("");

  await page.goto(`/workspace-invitation?token=${invitationToken}`);
  await expect(page.getByRole("heading", { name: "Join Rocket Team" })).toBeVisible();
  await expect(
    page.getByText(`Sign in with ${EXISTING_EMAIL} to join the workspace`),
  ).toBeVisible();

  await expect(page.getByText(`${ADMIN_EMAIL} invited ${EXISTING_EMAIL} to`)).toBeVisible();
  await expect(page.getByText("Offered access: workspace membership.")).toBeVisible();
  await expect(
    page.getByText("Workspace membership alone does not grant project access."),
  ).toBeVisible();
  const projectGrant = page.getByText("Rocket Guidance: contribute", { exact: true });
  await expect(projectGrant).toBeVisible();
  const projectId = await projectGrant.getAttribute("data-project-grant-id");
  if (projectId === null) throw new Error("offered project has no identifier");
  await expect(page.getByText(/This invitation expires/)).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/signin\?next=/);
  await page.getByLabel("Email").fill(EXISTING_EMAIL);
  await page.getByLabel("Password").fill(EXISTING_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(new RegExp(`/workspace-invitation\\?token=${invitationToken}`));
  await expect(page.getByRole("heading", { name: "Join Rocket Team" })).toBeVisible();
  await expect(page.getByText(`You are signed in as ${EXISTING_EMAIL}.`)).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();

  await expect(page.getByRole("heading", { name: "Rocket Team" })).toBeVisible();
  await expect(page.getByText("Shared workspace · Member")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make owner" })).toHaveCount(0);
  const project = await page.request.get(`/api/projects/${projectId}`);
  expect(project.status()).toBe(200);
  expect(await project.json()).toMatchObject({ name: "Rocket Guidance" });

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    await adminPage.goto("/signin");
    await adminPage.getByLabel("Email").fill(ADMIN_EMAIL);
    await adminPage.getByLabel("Password").fill(ADMIN_PASSWORD);
    await adminPage.getByRole("button", { name: "Sign in" }).click();
    await expect(adminPage.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    await adminPage.goto(`/workspaces/${invitationWorkspaceId}`);
    await adminPage.getByRole("tab", { name: "Members" }).click();
    await expect(adminPage.getByRole("heading", { name: "Members" })).toBeVisible();
    const memberRow = adminPage.locator("[data-member-id]").filter({ hasText: EXISTING_EMAIL });
    await expect(memberRow).toContainText("Member");
    await memberRow.getByRole("button", { name: "Make owner" }).click();
    await adminPage.getByRole("alertdialog").getByRole("button", { name: "Appoint owner" }).click();
    await expect(memberRow).toContainText("Owner");
    await expect(memberRow.getByRole("button", { name: "Make owner" })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("Shared workspace · Owner")).toBeVisible();
    await page.getByRole("tab", { name: "Members" }).click();
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  } finally {
    for (const cookie of await adminContext.cookies()) await recordSecret(cookie.value);
    await adminContext.close();
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  const joined = page.locator(`li[data-workspace-id="${invitationWorkspaceId}"]`);
  await expect(joined).toContainText("Rocket Team");
  await expect(joined).toContainText("Owner");

  await expect(
    page.locator("main li[data-workspace-id]").filter({ hasText: "Personal" }),
  ).toHaveCount(1);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("distinguishes an invalid invitation link from a load failure", async ({ page }) => {
  await page.route("**/api/workspace-invitations/preview*", (route) => route.abort());
  await page.goto("/workspace-invitation?token=network-failure");
  await expect(page.getByRole("alert")).toHaveText(
    "Could not load this invitation. Check your connection and try again.",
  );
  await page.unroute("**/api/workspace-invitations/preview*");

  await page.goto("/workspace-invitation?token=not-an-issued-token");
  await expect(page.getByRole("alert")).toHaveText(
    "This invitation is invalid, expired, or already used.",
  );

  let sessionRequests = 0;
  await page.route("**/api/auth/session", (route) => {
    sessionRequests += 1;
    return route.abort();
  });
  for (const token of ["bad token", "a".repeat(1_025)]) {
    await page.goto(`/workspace-invitation?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("alert")).toHaveText(
      "This invitation is invalid, expired, or already used.",
    );
  }
  expect(sessionRequests).toBe(0);
});

test("ignores a sign-in redirect that is not the invitation page", async ({ page }) => {
  await page.goto("/signin?next=https%3A%2F%2Fexample.com%2Fsteal");
  await page.getByLabel("Email").fill(EXISTING_EMAIL);
  await page.getByLabel("Password").fill(EXISTING_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText(`Signed in as ${EXISTING_EMAIL}.`)).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(baseUrl).origin);
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

const DELEGATION_PASSWORD = "delegated-member-password";
const RECIPIENT_PASSWORD = "delegated-recipient-password";

async function freshEmail(label: string): Promise<string> {
  return `${label}.${randomUUID()}@orrery.test`;
}

async function verifiedAccount(email: string, password: string): Promise<APIRequestContext> {
  await recordSecret(password);
  const context = await request.newContext({ baseURL: baseUrl! });
  const known = await context.post("/api/auth/login", {
    data: { email, password },
  });
  if (known.status() !== 200) {
    const invited = await api.post("/api/invitations/installation", { data: { email } });
    expect(invited.status()).toBe(201);
    await expect
      .poll(async () => caughtToken(api, email, "installation"), { timeout: 15_000 })
      .toBeTruthy();
    const token = await caughtToken(api, email, "installation");
    if (token === undefined)
      throw new Error("the catcher never received the installation invitation");
    await recordSecret(token);
    const registered = await api.post("/api/invitations/installation/registration", {
      data: { token, password },
    });
    expect(registered.status()).toBe(200);
    const signedIn = await context.post("/api/auth/login", { data: { email, password } });
    expect(signedIn.status()).toBe(200);
  }
  return context;
}

async function memberIdFor(workspaceId: string, email: string): Promise<string> {
  const res = await api.get(`/api/workspaces/${workspaceId}/members`);
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the member directory is not a list");
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    if (Reflect.get(entry, "email") !== email) continue;
    const id: unknown = Reflect.get(entry, "humanId");
    if (typeof id === "string") return id;
  }
  throw new Error(`${email} is not a member`);
}

async function joinWorkspace(
  workspaceId: string,
  workspaceName: string,
  email: string,
  password: string,
) {
  const sent = await api.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email },
  });
  expect(sent.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, email, "workspace", workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtToken(api, email, "workspace", workspaceName);
  if (token === undefined) throw new Error("the catcher never received the workspace invitation");
  await recordSecret(token);
  const context = await verifiedAccount(email, password);
  const accepted = await context.post("/api/workspace-invitations/acceptance", {
    data: { token },
  });
  expect(accepted.status()).toBe(200);
  return { context, humanId: await memberIdFor(workspaceId, email) };
}

async function setCapabilities(
  workspaceId: string,
  humanId: string,
  capabilities: Record<string, boolean>,
) {
  const res = await api.patch(`/api/workspaces/${workspaceId}/members/${humanId}`, {
    data: capabilities,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function expectRefusal(res: APIResponse, status: number, code: string) {
  expect(res.status()).toBe(status);
  expect(res.headers()["content-type"]).toBe("application/problem+json");
  expect(await res.json()).toMatchObject({ status, code });
}

test("delegates workspace capabilities within their ceilings and protects owners and managers", async () => {
  const name = `Delegation Team ${randomUUIDShort()}`;
  const created = await api.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspace: unknown = await created.json();
  const workspaceId: unknown =
    typeof workspace === "object" && workspace !== null ? Reflect.get(workspace, "id") : undefined;
  if (typeof workspaceId !== "string") throw new Error("the workspace has no id");

  const managerEmail = await freshEmail("delegation-manager");
  const manager = await joinWorkspace(workspaceId, name, managerEmail, DELEGATION_PASSWORD);
  const peerEmail = await freshEmail("delegation-peer");
  const peer = await joinWorkspace(workspaceId, name, peerEmail, DELEGATION_PASSWORD);

  await setCapabilities(workspaceId, manager.humanId, {
    canCreateProjects: true,
    canManageMemberPermissions: true,
  });
  const managerView = await manager.context.get(`/api/workspaces/${workspaceId}`);
  expect(await managerView.json()).toMatchObject({
    isOwner: false,
    canCreateProjects: true,
    canManageMemberPermissions: true,
    canInviteMembers: false,
    canRemoveMembers: false,
  });

  const peerPath = (id: string) => `/api/workspaces/${workspaceId}/members/${id}`;
  const adminId = await memberIdFor(workspaceId, ADMIN_EMAIL);

  expect((await manager.context.get(`/api/workspaces/${workspaceId}/members`)).status()).toBe(200);
  await expectRefusal(
    await manager.context.patch(peerPath(manager.humanId), { data: { canCreateProjects: false } }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await manager.context.patch(peerPath(adminId), { data: { canCreateProjects: true } }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await manager.context.patch(peerPath(peer.humanId), {
      data: { canManageMemberPermissions: true },
    }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await manager.context.patch(peerPath(peer.humanId), { data: { canInviteMembers: true } }),
    403,
    "not_workspace_owner",
  );
  expect(
    (
      await manager.context.patch(peerPath(peer.humanId), { data: { canCreateProjects: true } })
    ).status(),
  ).toBe(200);
  expect(
    (
      await manager.context.patch(peerPath(peer.humanId), { data: { canCreateProjects: false } })
    ).status(),
  ).toBe(200);

  const secondManagerEmail = await freshEmail("delegation-second-manager");
  const secondManager = await joinWorkspace(
    workspaceId,
    name,
    secondManagerEmail,
    DELEGATION_PASSWORD,
  );
  await setCapabilities(workspaceId, secondManager.humanId, {
    canManageMemberPermissions: true,
    canInviteMembers: true,
  });

  await expectRefusal(
    await manager.context.patch(peerPath(secondManager.humanId), {
      data: { canInviteMembers: false },
    }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await manager.context.patch(peerPath(secondManager.humanId), {
      data: { canManageMemberPermissions: false },
    }),
    403,
    "not_workspace_owner",
  );

  const pmEmail = await freshEmail("project-only-manager");
  const projectOnly = await joinWorkspace(workspaceId, name, pmEmail, DELEGATION_PASSWORD);
  const projectCreated = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Project-Only Work" },
  });
  expect(projectCreated.status()).toBe(201);
  const projectIdForPm: unknown = (await projectCreated.json()).id;
  if (typeof projectIdForPm !== "string") throw new Error("the project has no id");
  const pmGrant = await api.patch(`/api/projects/${projectIdForPm}/access`, {
    data: { email: pmEmail, level: "manage" },
  });
  expect(pmGrant.status()).toBe(200);
  const pmView = await projectOnly.context.get(`/api/workspaces/${workspaceId}`);
  expect(await pmView.json()).toMatchObject({
    isOwner: false,
    canCreateProjects: false,
    canInviteMembers: false,
    canRemoveMembers: false,
    canManageMemberPermissions: false,
  });
  await expectRefusal(
    await projectOnly.context.get(`/api/workspaces/${workspaceId}/members`),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await projectOnly.context.patch(peerPath(peer.humanId), { data: { canCreateProjects: true } }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await projectOnly.context.delete(peerPath(peer.humanId)),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await projectOnly.context.get(`/api/workspaces/${workspaceId}/invitations`),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await projectOnly.context.post(`/api/workspaces/${workspaceId}/invitations`, {
      data: { email: await freshEmail("project-only-blocked") },
    }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await projectOnly.context.post(`/api/workspaces/${workspaceId}/projects`, {
      data: { name: "Blocked" },
    }),
    403,
    "project_creation_not_allowed",
  );
  const pmInviteEmail = await freshEmail("project-only-invite");
  expect(
    (
      await api.post(`/api/workspaces/${workspaceId}/invitations`, {
        data: { email: pmInviteEmail },
      })
    ).status(),
  ).toBe(201);
  const pmInvitationId = await invitationId(api, workspaceId, pmInviteEmail, "pending");
  await expectRefusal(
    await projectOnly.context.post(
      `/api/workspaces/${workspaceId}/invitations/${pmInvitationId}/resend`,
    ),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await projectOnly.context.post(
      `/api/workspaces/${workspaceId}/invitations/${pmInvitationId}/revoke`,
    ),
    403,
    "not_workspace_owner",
  );

  const deniedUrl = `/api/workspaces/${workspaceId}/members`;
  await expectRefusal(await peer.context.get(deniedUrl), 403, "not_workspace_owner");
  await expectRefusal(
    await peer.context.patch(peerPath(manager.humanId), { data: { canCreateProjects: true } }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await peer.context.delete(peerPath(manager.humanId)),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await peer.context.get(`/api/workspaces/${workspaceId}/invitations`),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await peer.context.post(`/api/workspaces/${workspaceId}/invitations`, {
      data: { email: await freshEmail("blocked-invite") },
    }),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await peer.context.post(`/api/workspaces/${workspaceId}/projects`, {
      data: { name: "Blocked" },
    }),
    403,
    "project_creation_not_allowed",
  );

  const outsiderEmail = await freshEmail("delegation-outsider");
  const outsider = await verifiedAccount(outsiderEmail, DELEGATION_PASSWORD);
  await expectRefusal(await outsider.get(deniedUrl), 404, "workspace_not_found");
  await expectRefusal(
    await outsider.patch(peerPath(peer.humanId), { data: { canCreateProjects: true } }),
    404,
    "workspace_not_found",
  );
  await expectRefusal(await outsider.delete(peerPath(peer.humanId)), 404, "workspace_not_found");

  const ownerPath = peerPath(adminId);
  expect((await api.patch(ownerPath, { data: { canCreateProjects: true } })).status()).toBe(200);
  await expectRefusal(
    await api.patch(ownerPath, { data: { canInviteMembers: false } }),
    409,
    "workspace_owner_capability",
  );

  const removerEmail = await freshEmail("delegation-remover");
  const remover = await joinWorkspace(workspaceId, name, removerEmail, DELEGATION_PASSWORD);
  await setCapabilities(workspaceId, remover.humanId, { canRemoveMembers: true });
  await expectRefusal(await remover.context.delete(peerPath(adminId)), 403, "not_workspace_owner");
  await expectRefusal(
    await remover.context.delete(peerPath(manager.humanId)),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await remover.context.patch(peerPath(peer.humanId), { data: { canCreateProjects: true } }),
    403,
    "not_workspace_owner",
  );
  expect((await remover.context.delete(peerPath(peer.humanId))).status()).toBe(204);
  expect((await api.delete(peerPath(remover.humanId))).status()).toBe(204);
  expect((await api.delete(peerPath(manager.humanId))).status()).toBe(204);

  for (const context of [
    manager.context,
    peer.context,
    secondManager.context,
    projectOnly.context,
    remover.context,
    outsider,
  ]) {
    for (const cookie of await context.cookies()) await recordSecret(cookie.value);
    await context.dispose();
  }
});

test("a delegated inviter stays inside project scope and pending offers fail when authority is withdrawn", async () => {
  const name = `Scope Team ${randomUUIDShort()}`;
  const created = await api.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspace: unknown = await created.json();
  const workspaceId: unknown =
    typeof workspace === "object" && workspace !== null ? Reflect.get(workspace, "id") : undefined;
  if (typeof workspaceId !== "string") throw new Error("the workspace has no id");

  const projectResponse = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Scoped Project" },
  });
  expect(projectResponse.status()).toBe(201);
  const project: unknown = await projectResponse.json();
  const projectId: unknown =
    typeof project === "object" && project !== null ? Reflect.get(project, "id") : undefined;
  if (typeof projectId !== "string") throw new Error("the project has no id");

  const inviterEmail = await freshEmail("scoped-inviter");
  const inviter = await joinWorkspace(workspaceId, name, inviterEmail, DELEGATION_PASSWORD);
  await setCapabilities(workspaceId, inviter.humanId, { canInviteMembers: true });
  const invitationsUrl = `/api/workspaces/${workspaceId}/invitations`;
  expect((await inviter.context.get(invitationsUrl)).status()).toBe(200);

  const plainEmail = await freshEmail("scoped-plain");
  expect(
    (await inviter.context.post(invitationsUrl, { data: { email: plainEmail } })).status(),
  ).toBe(201);
  const outOfScopeEmail = await freshEmail("scoped-out-of-scope");
  await expectRefusal(
    await inviter.context.post(invitationsUrl, {
      data: { email: outOfScopeEmail, projectGrants: [{ projectId, level: "read" }] },
    }),
    403,
    "not_workspace_owner",
  );

  const ownerOfferEmail = await freshEmail("scoped-owner-offer");
  expect(
    (
      await api.post(invitationsUrl, {
        data: { email: ownerOfferEmail, projectGrants: [{ projectId, level: "read" }] },
      })
    ).status(),
  ).toBe(201);
  const ownerOfferId = await invitationId(api, workspaceId, ownerOfferEmail, "pending");
  const delegateHistoryRes = await inviter.context.get(invitationsUrl);
  expect(delegateHistoryRes.status()).toBe(200);
  const delegateHistory: unknown = await delegateHistoryRes.json();
  if (!Array.isArray(delegateHistory)) throw new Error("the delegate history is not a list");
  expect(delegateHistory.some((row) => Reflect.get(row, "email") === ownerOfferEmail)).toBe(false);
  await expectRefusal(
    await inviter.context.post(`${invitationsUrl}/${ownerOfferId}/resend`),
    403,
    "not_workspace_owner",
  );
  await expectRefusal(
    await inviter.context.post(`${invitationsUrl}/${ownerOfferId}/revoke`),
    403,
    "not_workspace_owner",
  );

  const manageGrant = await api.patch(`/api/projects/${projectId}/access`, {
    data: { email: inviterEmail, level: "manage" },
  });
  expect(manageGrant.status()).toBe(200);
  const offeredEmail = await freshEmail("scoped-offered");
  const offered = await inviter.context.post(invitationsUrl, {
    data: { email: offeredEmail, projectGrants: [{ projectId, level: "contribute" }] },
  });
  expect(offered.status()).toBe(201);
  await expect
    .poll(async () => caughtToken(api, offeredEmail, "workspace", name), { timeout: 15_000 })
    .toBeTruthy();
  const offeredToken = await caughtToken(api, offeredEmail, "workspace", name);
  if (offeredToken === undefined) throw new Error("the catcher never received the scoped offer");
  await recordSecret(offeredToken);

  const recipientEmail = await freshEmail("scoped-recipient");
  const recipient = await verifiedAccount(recipientEmail, RECIPIENT_PASSWORD);

  const registrationEmail = await freshEmail("scoped-registration");
  const registrationPassword = "scoped-registration-password";
  await recordSecret(registrationPassword);
  expect(
    (
      await inviter.context.post(invitationsUrl, {
        data: { email: registrationEmail, projectGrants: [{ projectId, level: "read" }] },
      })
    ).status(),
  ).toBe(201);
  await expect
    .poll(async () => caughtToken(api, registrationEmail, "workspace", name), {
      timeout: 15_000,
    })
    .toBeTruthy();
  const registrationToken = await caughtToken(api, registrationEmail, "workspace", name);
  if (registrationToken === undefined)
    throw new Error("the catcher never received the registration offer");
  await recordSecret(registrationToken);

  const revokedGrant = await api.delete(`/api/projects/${projectId}/access/${inviter.humanId}`);
  expect(revokedGrant.status()).toBe(204);
  await expectRefusal(
    await recipient.post("/api/workspace-invitations/registration", {
      data: { token: registrationToken, password: registrationPassword },
    }),
    403,
    "inviter_not_authorized",
  );
  const afterManageRes = await inviter.context.get(invitationsUrl);
  expect(afterManageRes.status()).toBe(200);
  const afterManage: unknown = await afterManageRes.json();
  if (!Array.isArray(afterManage)) throw new Error("the delegate history is not a list");
  expect(afterManage.some((row) => Reflect.get(row, "email") === registrationEmail)).toBe(false);

  expect(
    (
      await api.post(invitationsUrl, {
        data: { email: registrationEmail },
      })
    ).status(),
  ).toBe(201);
  await expect
    .poll(
      async () =>
        (await caughtTokens(api, registrationEmail, "workspace", name)).some(
          (token) => token !== registrationToken,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  const replacementToken = (await caughtTokens(api, registrationEmail, "workspace", name)).find(
    (token) => token !== registrationToken,
  );
  if (replacementToken === undefined)
    throw new Error("the catcher never received the replacement offer");
  await recordSecret(replacementToken);
  const registered = await recipient.post("/api/workspace-invitations/registration", {
    data: { token: replacementToken, password: registrationPassword },
  });
  expect(registered.status()).toBe(200);

  await expectRefusal(
    await recipient.post("/api/workspace-invitations/acceptance", {
      data: { token: offeredToken },
    }),
    403,
    "inviter_not_authorized",
  );
  expect((await api.get(`/api/workspace-invitations/preview?token=${offeredToken}`)).status()).toBe(
    200,
  );

  const plainToken = await caughtToken(api, plainEmail, "workspace", name);
  if (plainToken === undefined) throw new Error("the catcher never received the plain offer");
  await recordSecret(plainToken);
  await setCapabilities(workspaceId, inviter.humanId, { canInviteMembers: false });
  await expectRefusal(
    await recipient.post("/api/workspace-invitations/acceptance", { data: { token: plainToken } }),
    403,
    "inviter_not_authorized",
  );
  const stillPending = await readInvitationHistory(invitationsUrl);
  expect(stillPending).toContainEqual(
    expect.objectContaining({ email: offeredEmail, status: "pending" }),
  );

  for (const cookie of await recipient.cookies()) await recordSecret(cookie.value);
  await recipient.dispose();
  for (const cookie of await inviter.context.cookies()) await recordSecret(cookie.value);
  await inviter.context.dispose();
});

test("a delegated member sees only the controls within their authority in the browser", async ({
  page,
  browser,
}) => {
  const name = `Browser Delegation Team ${randomUUIDShort()}`;
  const created = await api.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspace: unknown = await created.json();
  const workspaceId: unknown =
    typeof workspace === "object" && workspace !== null ? Reflect.get(workspace, "id") : undefined;
  if (typeof workspaceId !== "string") throw new Error("the workspace has no id");

  const memberEmail = await freshEmail("browser-delegate");
  const member = await joinWorkspace(workspaceId, name, memberEmail, DELEGATION_PASSWORD);
  await setCapabilities(workspaceId, member.humanId, {
    canCreateProjects: true,
    canManageMemberPermissions: true,
  });
  const otherEmail = await freshEmail("browser-peer");
  await joinWorkspace(workspaceId, name, otherEmail, DELEGATION_PASSWORD);

  await page.goto("/signin");
  await page.getByLabel("Email").fill(memberEmail);
  await page.getByLabel("Password").fill(DELEGATION_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${memberEmail}.`)).toBeVisible();
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole("tab", { name: "Members" }).click();

  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();

  const initialPeerRow = page.locator("[data-member-id]").filter({ hasText: otherEmail });
  await initialPeerRow.getByRole("button", { name: "Permissions" }).click();
  const initialDialog = page.getByRole("dialog");
  await expect(initialDialog.getByRole("checkbox", { name: "Create projects" })).toBeVisible();
  await expect(initialDialog.getByRole("checkbox", { name: "Invite members" })).toHaveCount(0);
  await expect(initialDialog.getByRole("checkbox", { name: "Remove members" })).toHaveCount(0);
  await expect(
    initialDialog.getByRole("checkbox", { name: "Manage member permissions" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Make owner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove member" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite member", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Invitation history" })).toHaveCount(0);

  await setCapabilities(workspaceId, member.humanId, {
    canInviteMembers: true,
    canRemoveMembers: true,
  });
  await page.reload();
  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByRole("button", { name: "Invite member", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invitation history" })).toBeVisible();
  const selfRow = page.locator("[data-member-id]").filter({ hasText: memberEmail });
  await expect(selfRow.getByRole("button", { name: "Remove member", exact: true })).toHaveCount(0);
  const peerRow = page.locator("[data-member-id]").filter({ hasText: otherEmail });
  await expect(peerRow.getByRole("button", { name: "Remove member", exact: true })).toBeVisible();
  await peerRow.getByRole("button", { name: "Permissions" }).click();
  const updatedDialog = page.getByRole("dialog");
  await expect(updatedDialog.getByRole("checkbox", { name: "Invite members" })).toBeVisible();
  await expect(updatedDialog.getByRole("checkbox", { name: "Remove members" })).toBeVisible();
  await page.keyboard.press("Escape");

  const adminBrowser = await browser.newContext();
  const adminPage = await adminBrowser.newPage();
  try {
    await adminPage.goto("/signin");
    await adminPage.getByLabel("Email").fill(ADMIN_EMAIL);
    await adminPage.getByLabel("Password").fill(ADMIN_PASSWORD);
    await adminPage.getByRole("button", { name: "Sign in" }).click();
    await expect(adminPage.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
    await adminPage.goto(`/workspaces/${workspaceId}`);
    await adminPage.getByRole("tab", { name: "Members" }).click();
    await expect(adminPage.getByRole("button", { name: "Make owner" }).first()).toBeVisible();
    const adminSelfRow = adminPage.locator("[data-member-id]").filter({ hasText: ADMIN_EMAIL });
    await expect(
      adminSelfRow.getByRole("button", { name: "Remove member", exact: true }),
    ).toHaveCount(0);
    const adminPeerRow = adminPage.locator("[data-member-id]").filter({ hasText: otherEmail });
    await expect(
      adminPeerRow.getByRole("button", { name: "Remove member", exact: true }),
    ).toBeVisible();
  } finally {
    for (const cookie of await adminBrowser.cookies()) await recordSecret(cookie.value);
    await adminBrowser.close();
  }

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
  await member.context.dispose();
});

async function readInvitationHistory(url: string): Promise<unknown[]> {
  const res = await api.get(url);
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the invitation history is not a list");
  return body;
}

function randomUUIDShort(): string {
  return randomUUID().slice(0, 8);
}

async function invitationId(
  client: APIRequestContext,
  workspaceId: string,
  email: string,
  status?: string,
): Promise<string> {
  const res = await client.get(`/api/workspaces/${workspaceId}/invitations`);
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the invitation history is not a list");
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    if (Reflect.get(entry, "email") !== email) continue;
    if (status !== undefined && Reflect.get(entry, "status") !== status) continue;
    const id: unknown = Reflect.get(entry, "id");
    if (typeof id === "string") return id;
  }
  throw new Error(`no ${status ?? "matching"} invitation for ${email}`);
}

async function caughtToken(
  client: APIRequestContext,
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string | undefined> {
  const tokens = await caughtTokens(client, to, kind, workspaceName);
  return tokens[0];
}

async function caughtTokens(
  client: APIRequestContext,
  to: string,
  kind: "installation" | "workspace",
  workspaceName?: string,
): Promise<string[]> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return [];
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return [];
  const subject =
    kind === "installation" ? "Your Orrery invitation" : "Your Orrery workspace invitation";
  const pattern =
    kind === "installation"
      ? /\/register\?token=([A-Za-z0-9_-]+)/
      : /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/;
  const tokens: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== subject) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(to)) continue;
    if (workspaceName !== undefined && !text.includes(`"${workspaceName}"`)) continue;
    const token = text.match(pattern)?.[1];
    if (token !== undefined && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

function caughtRecipients(detail: object): string[] {
  const to: unknown = Reflect.get(detail, "To");
  if (!Array.isArray(to)) return [];
  return to.flatMap((entry): string[] => {
    const address: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
    return typeof address === "string" ? [address] : [];
  });
}

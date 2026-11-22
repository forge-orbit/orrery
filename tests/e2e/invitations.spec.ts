import { expect, request, test, type APIRequestContext } from "@playwright/test";
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
const SUBJECT = "Your Orrery invitation";

const INVITEE_EMAIL = "newcomer@orrery.test";
const INVITEE_PASSWORD = "invited-newcomer-password";
const BROWSER_INVITEE_EMAIL = "browser.person@orrery.test";
const BROWSER_INVITEE_PASSWORD = "browser-checked-invitee-password";
const RESILIENT_INVITEE_EMAIL = "resilient.person@orrery.test";
const RESILIENT_INVITEE_PASSWORD = "resilient-person-password";

let inviteeToken = "";
let browserInviteeToken = "";

let api: APIRequestContext;
test.beforeAll(async () => {
  for (const value of [INVITEE_PASSWORD, BROWSER_INVITEE_PASSWORD, RESILIENT_INVITEE_PASSWORD]) {
    await recordSecret(value);
  }
  api = await request.newContext({ baseURL: baseUrl });

  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const saved = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
});

test("refuses to send an invitation without a session", async () => {
  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const res = await anonymous.post("/api/invitations/installation", {
      data: { email: INVITEE_EMAIL },
    });
    expect(res.status()).toBe(401);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ status: 401, code: "not_signed_in" });
  } finally {
    await anonymous.dispose();
  }
});

test("sends the invitation, and the catcher receives the seven-day link", async () => {
  const res = await api.post("/api/invitations/installation", { data: { email: INVITEE_EMAIL } });
  expect(res.status()).toBe(201);
  expect(await res.json()).toEqual({ email: INVITEE_EMAIL, status: "pending" });

  await expect
    .poll(async () => caughtInvitationToken(api, INVITEE_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtInvitationToken(api, INVITEE_EMAIL);
  if (token === undefined) throw new Error("the catcher never received the invitation");

  await recordSecret(token);
  inviteeToken = token;
});

test("refuses a registered email and a duplicate pending invitation", async () => {
  const registered = await api.post("/api/invitations/installation", {
    data: { email: ADMIN_EMAIL },
  });
  expect(registered.status()).toBe(409);
  expect(await registered.json()).toMatchObject({ status: 409, code: "account_exists" });

  const duplicate = await api.post("/api/invitations/installation", {
    data: { email: INVITEE_EMAIL },
  });
  expect(duplicate.status()).toBe(409);
  expect(await duplicate.json()).toMatchObject({ status: 409, code: "invitation_pending" });
});

test("the link's GET is inert; the POST registers; reuse fails", async () => {
  expect(inviteeToken).not.toBe("");

  const link = await api.get(`/register?token=${inviteeToken}`);
  expect(link.status()).toBe(200);
  expect(link.headers()["content-type"]).toContain("text/html");

  const apiGet = await api.get("/api/invitations/installation/registration");
  expect(apiGet.status()).toBe(200);
  expect(apiGet.headers()["content-type"]).toContain("text/html");

  const res = await api.post("/api/invitations/installation/registration", {
    data: { token: inviteeToken, password: INVITEE_PASSWORD },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ email: INVITEE_EMAIL, emailVerified: true, avatarUrl: null });

  const again = await api.post("/api/invitations/installation/registration", {
    data: { token: inviteeToken, password: INVITEE_PASSWORD },
  });
  expect(again.status()).toBe(400);
  expect(await again.json()).toMatchObject({ code: "invitation_invalid" });

  const newcomer = await request.newContext({ baseURL: baseUrl });
  try {
    const login = await newcomer.post("/api/auth/login", {
      data: { email: INVITEE_EMAIL, password: INVITEE_PASSWORD },
    });
    expect(login.status()).toBe(200);
    const session = await newcomer.get("/api/auth/session");
    expect(await session.json()).toEqual({
      email: INVITEE_EMAIL,
      displayName: null,
      emailVerified: true,
      avatarUrl: null,
    });
  } finally {
    await newcomer.dispose();
  }
});

test("registration is invitation-only: no public sign-up exists", async () => {
  for (const path of ["/api/auth/register", "/api/register", "/api/auth/signup"]) {
    const res = await api.post(path, {
      data: { email: "x@example.com", password: "whatever-password" },
    });
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ code: "not_found" });
  }

  const garbage = await api.post("/api/invitations/installation/registration", {
    data: { token: "not-a-real-token", password: "whatever-password" },
  });
  expect(garbage.status()).toBe(400);
  expect(await garbage.json()).toMatchObject({ code: "invitation_invalid" });
  const login = await api.post("/api/auth/login", {
    data: { email: "uninvited@orrery.test", password: "whatever-password" },
  });
  expect(login.status()).toBe(401);
});

test("accepting an invitation in the browser", async ({ page }) => {
  const invited = await api.post("/api/invitations/installation", {
    data: { email: BROWSER_INVITEE_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, BROWSER_INVITEE_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtInvitationToken(api, BROWSER_INVITEE_EMAIL);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);
  browserInviteeToken = token;

  await page.goto(`/register?token=${browserInviteeToken}`);
  await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();

  await page.getByLabel("Password").fill(BROWSER_INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByText(`Signed in as ${BROWSER_INVITEE_EMAIL}.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();

  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("list")).toContainText("Personal");

  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
});

test("another person cannot access the new personal workspace", async ({ page }) => {
  expect(inviteeToken).not.toBe("");
  expect(browserInviteeToken).not.toBe("");

  const newcomer = await request.newContext({ baseURL: baseUrl });
  const browserPerson = await request.newContext({ baseURL: baseUrl });
  const anonymous = await request.newContext({ baseURL: baseUrl });
  let newcomerWorkspaceId: string | undefined;
  let browserPersonWorkspaceId: string | undefined;
  try {
    for (const [context, email, password] of [
      [newcomer, INVITEE_EMAIL, INVITEE_PASSWORD],
      [browserPerson, BROWSER_INVITEE_EMAIL, BROWSER_INVITEE_PASSWORD],
    ] as const) {
      const login = await context.post("/api/auth/login", {
        data: { email, password },
      });
      expect(login.status()).toBe(200);
    }

    const newcomerList = await workspacesOf(newcomer);
    const browserPersonList = await workspacesOf(browserPerson);
    const adminList = await workspacesOf(api);

    expect(newcomerList).toHaveLength(1);
    expect(browserPersonList).toHaveLength(1);
    expect(adminList).toHaveLength(1);
    newcomerWorkspaceId = newcomerList[0]?.id;
    browserPersonWorkspaceId = browserPersonList[0]?.id;
    const ids = [newcomerWorkspaceId, browserPersonWorkspaceId, adminList[0]?.id];
    expect(new Set(ids).size).toBe(3);
    expect(adminList.map((w) => w.id)).not.toContain(newcomerWorkspaceId);
    expect(adminList.map((w) => w.id)).not.toContain(browserPersonWorkspaceId);
    expect(browserPersonList.map((w) => w.id)).not.toContain(newcomerWorkspaceId);
    expect(newcomerList.map((w) => w.id)).not.toContain(browserPersonWorkspaceId);

    const refused = await anonymous.get("/api/workspaces");
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toMatchObject({ status: 401, code: "not_signed_in" });
  } finally {
    await newcomer.dispose();
    await browserPerson.dispose();
    await anonymous.dispose();
  }

  await page.goto("/signin");
  await page.getByLabel("Email").fill(INVITEE_EMAIL);
  await page.getByLabel("Password").fill(INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${INVITEE_EMAIL}.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(1);

  const shown = await page.locator("main li[data-workspace-id]").getAttribute("data-workspace-id");
  expect(shown).toBe(newcomerWorkspaceId);
  expect(shown).not.toBe(browserPersonWorkspaceId);
  const content = await page.content();
  expect(content).not.toContain(BROWSER_INVITEE_EMAIL);
  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
});

test("registration completes even when the follow-up sign-in fails", async ({ page }) => {
  const invited = await api.post("/api/invitations/installation", {
    data: { email: RESILIENT_INVITEE_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, RESILIENT_INVITEE_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtInvitationToken(api, RESILIENT_INVITEE_EMAIL);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);

  await page.route("**/api/auth/login", (route) => route.abort());
  await page.goto(`/register?token=${token}`);
  await page.getByLabel("Password").fill(RESILIENT_INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Register" }).click();

  await expect(page.getByText("Your account was created")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);

  await page.unroute("**/api/auth/login");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(RESILIENT_INVITEE_EMAIL);
  await page.getByLabel("Password").fill(RESILIENT_INVITEE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${RESILIENT_INVITEE_EMAIL}.`)).toBeVisible();
  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
});

test("tracks installation invitations: resend rotates the link, revoke and decline resolve offers, delivery stays separate", async () => {
  const resendEmail = "installation.resend@orrery.test";
  const resendPassword = "installation-resend-password";
  await recordSecret(resendPassword);
  const invited = await api.post("/api/invitations/installation", { data: { email: resendEmail } });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => (await caughtInvitationTokens(api, resendEmail)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const oldToken = (await caughtInvitationTokens(api, resendEmail))[0];
  if (oldToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(oldToken);
  const id = await installationInvitationId(api, resendEmail, "pending");

  const resent = await api.post(`/api/invitations/installation/${id}/resend`);
  expect(resent.status()).toBe(200);
  const fresh: unknown = await resent.json();
  if (typeof fresh !== "object" || fresh === null) throw new Error("the resend returned no body");
  expect(fresh).toMatchObject({
    email: resendEmail,
    status: "pending",
    target: { kind: "installation" },
    grants: [{ kind: "installation_account" }],
    delivery: { status: "sent" },
  });
  const freshId: unknown = Reflect.get(fresh, "id");
  if (typeof freshId !== "string") throw new Error("the new invitation has no id");
  await expect
    .poll(async () => (await caughtInvitationTokens(api, resendEmail)).length, { timeout: 15_000 })
    .toBeGreaterThan(1);
  const newToken = (await caughtInvitationTokens(api, resendEmail)).find(
    (token) => token !== oldToken,
  );
  if (newToken === undefined) throw new Error("the catcher never received the resent invitation");
  await recordSecret(newToken);

  const oldAttempt = await api.post("/api/invitations/installation/registration", {
    data: { token: oldToken, password: resendPassword },
  });
  expect(oldAttempt.status()).toBe(400);
  expect(await oldAttempt.json()).toMatchObject({ code: "invitation_invalid" });
  const historyRes = await api.get("/api/invitations/installation");
  const history: unknown = await historyRes.json();
  if (!Array.isArray(history)) throw new Error("the invitation history is not a list");
  expect(history).toContainEqual(expect.objectContaining({ id, status: "revoked" }));
  expect(history).toContainEqual(expect.objectContaining({ id: freshId, status: "pending" }));
  const registered = await api.post("/api/invitations/installation/registration", {
    data: { token: newToken, password: resendPassword },
  });
  expect(registered.status()).toBe(200);

  const revokeEmail = "installation.revoke@orrery.test";
  const revokePassword = "installation-revoke-password";
  await recordSecret(revokePassword);
  const revokeInvite = await api.post("/api/invitations/installation", {
    data: { email: revokeEmail },
  });
  expect(revokeInvite.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, revokeEmail), { timeout: 15_000 })
    .toBeTruthy();
  const revokeToken = await caughtInvitationToken(api, revokeEmail);
  if (revokeToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(revokeToken);
  const revokeId = await installationInvitationId(api, revokeEmail, "pending");
  const revoked = await api.post(`/api/invitations/installation/${revokeId}/revoke`);
  expect(revoked.status()).toBe(200);
  expect(await revoked.json()).toMatchObject({ id: revokeId, status: "revoked" });
  const revokedAttempt = await api.post("/api/invitations/installation/registration", {
    data: { token: revokeToken, password: revokePassword },
  });
  expect(revokedAttempt.status()).toBe(400);

  const declineEmail = "installation.decline@orrery.test";
  const declineInvite = await api.post("/api/invitations/installation", {
    data: { email: declineEmail },
  });
  expect(declineInvite.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, declineEmail), { timeout: 15_000 })
    .toBeTruthy();
  const declineToken = await caughtInvitationToken(api, declineEmail);
  if (declineToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(declineToken);
  const declined = await api.post("/api/invitations/installation/decline", {
    data: { token: declineToken },
  });
  expect(declined.status()).toBe(204);
  const declinedAgain = await api.post("/api/invitations/installation/decline", {
    data: { token: declineToken },
  });
  expect(declinedAgain.status()).toBe(400);
  expect(await declinedAgain.json()).toMatchObject({ code: "invitation_invalid" });
  const declinedHistory = await api.get("/api/invitations/installation");
  const declinedRows: unknown = await declinedHistory.json();
  if (!Array.isArray(declinedRows)) throw new Error("the invitation history is not a list");
  expect(declinedRows).toContainEqual(
    expect.objectContaining({ email: declineEmail, status: "declined" }),
  );

  const failedEmail = "installation.delivery@orrery.test";
  await api.put("/api/settings/smtp", {
    data: { ...SETTINGS, host: "127.0.0.1", port: 1 },
  });
  try {
    const failed = await api.post("/api/invitations/installation", {
      data: { email: failedEmail },
    });
    expect(failed.status()).toBe(502);
    expect(await failed.json()).toMatchObject({ status: 502, code: "smtp_unreachable" });
  } finally {
    const repaired = await api.put("/api/settings/smtp", { data: SETTINGS });
    expect(repaired.status()).toBe(200);
  }
  const failedId = await installationInvitationId(api, failedEmail, "pending");
  const failedHistory = await api.get("/api/invitations/installation");
  const failedRows: unknown = await failedHistory.json();
  if (!Array.isArray(failedRows)) throw new Error("the invitation history is not a list");
  expect(failedRows).toContainEqual(
    expect.objectContaining({
      id: failedId,
      status: "pending",
      delivery: expect.objectContaining({ status: "failed" }),
    }),
  );
  const retried = await api.post(`/api/invitations/installation/${failedId}/resend`);
  expect(retried.status()).toBe(200);
  expect(await retried.json()).toMatchObject({
    email: failedEmail,
    status: "pending",
    delivery: { status: "sent" },
  });
  await expect
    .poll(async () => caughtInvitationToken(api, failedEmail), { timeout: 15_000 })
    .toBeTruthy();
  for (const token of await caughtInvitationTokens(api, failedEmail)) await recordSecret(token);
});

test("administrator sees installation invitation history and resends from the page", async ({
  page,
}) => {
  const uiEmail = "installation.ui@orrery.test";
  const invited = await api.post("/api/invitations/installation", { data: { email: uiEmail } });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, uiEmail), { timeout: 15_000 })
    .toBeTruthy();
  for (const token of await caughtInvitationTokens(api, uiEmail)) await recordSecret(token);
  const before = await caughtInvitationTokens(api, uiEmail);

  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  const row = page.locator("[data-invitation-id]").filter({ hasText: uiEmail });
  await expect(row).toContainText("Pending");
  await expect(row).toContainText("Email sent");
  await expect(row).toContainText(`Invited by ${ADMIN_EMAIL}`);
  await expect(row).toContainText("This installation");
  await expect(row).toContainText("Installation account");

  await row.getByRole("button", { name: "Resend" }).click();
  await expect
    .poll(async () => (await caughtInvitationTokens(api, uiEmail)).length, { timeout: 15_000 })
    .toBeGreaterThan(before.length);
  for (const token of await caughtInvitationTokens(api, uiEmail)) await recordSecret(token);
  await expect(page.locator("[data-invitation-id]").filter({ hasText: uiEmail })).toHaveCount(2);
  await expect(
    page.locator('[data-invitation-status="revoked"]').filter({ hasText: uiEmail }),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-invitation-status="pending"]').filter({ hasText: uiEmail }),
  ).toHaveCount(1);

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

test("installation invite form refreshes failed delivery history without a reload", async ({
  page,
}) => {
  const FAILED_EMAIL = "installation.smtp.form@orrery.test";
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installation administration" })).toBeVisible();

  await api.put("/api/settings/smtp", {
    data: { ...SETTINGS, host: "127.0.0.1", port: 1 },
  });
  try {
    await page.getByRole("button", { name: "Invite person" }).click();
    await page.getByLabel("Email").fill(FAILED_EMAIL);
    await page.getByRole("button", { name: "Send installation invitation" }).click();

    await expect(page.getByRole("dialog").getByRole("alert").first()).toContainText(
      "Could not reach the SMTP server",
    );
    await page.keyboard.press("Escape");
    const row = page.locator("[data-invitation-id]").filter({ hasText: FAILED_EMAIL });
    await expect(row).toContainText("Pending");
    await expect(row).toContainText("This installation");
    await expect(row).toContainText("Email failed");
    await expect(row.getByRole("button", { name: "Resend" })).toBeVisible();
    await expect(row).toContainText("Created");
  } finally {
    const repaired = await api.put("/api/settings/smtp", { data: SETTINGS });
    expect(repaired.status()).toBe(200);
  }

  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
});

async function workspacesOf(context: APIRequestContext) {
  const res = await context.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the workspaces listing is not a list");
  return body.flatMap((workspace): { id: string }[] => {
    if (typeof workspace !== "object" || workspace === null) return [];
    const id: unknown = Reflect.get(workspace, "id");
    if (typeof id !== "string") return [];
    return [{ id }];
  });
}

async function caughtInvitationToken(
  client: APIRequestContext,
  to: string,
): Promise<string | undefined> {
  const tokens = await caughtInvitationTokens(client, to);
  return tokens[0];
}

async function caughtInvitationTokens(client: APIRequestContext, to: string): Promise<string[]> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  if (typeof body !== "object" || body === null) return [];
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return [];
  const tokens: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== SUBJECT) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    if (typeof caught !== "object" || caught === null) continue;
    const text: unknown = Reflect.get(caught, "Text");
    if (typeof text !== "string") continue;
    if (!caughtRecipients(caught).includes(to)) continue;
    const token = text.match(/\/register\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

async function installationInvitationId(
  client: APIRequestContext,
  email: string,
  status?: string,
): Promise<string> {
  const res = await client.get("/api/invitations/installation");
  expect(res.status()).toBe(200);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("the installation invitation history is not a list");
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    if (Reflect.get(entry, "email") !== email) continue;
    if (status !== undefined && Reflect.get(entry, "status") !== status) continue;
    const id: unknown = Reflect.get(entry, "id");
    if (typeof id === "string") return id;
  }
  throw new Error(`no ${status ?? "matching"} installation invitation for ${email}`);
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

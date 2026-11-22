import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const exec = promisify(execCallback);

const configuredBaseUrl = process.env.ORRERY_URL;
if (!configuredBaseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const baseUrl: string = configuredBaseUrl;

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const composeFile =
  process.env.ORRERY_COMPOSE_FILE ?? new URL("../../compose.yaml", import.meta.url).pathname;
const composeService = process.env.ORRERY_COMPOSE_SERVICE ?? "orrery";

const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;
const INVITATION_SUBJECT = "Your Orrery invitation";
const RESET_SUBJECT = "Reset your Orrery password";

const RECOVERED_EMAIL = "recoverable@orrery.test";
const INVITED_PASSWORD = "recoverable-invited-password";
const RESET_PASSWORD = "recoverable-reset-password";
const LOCAL_PASSWORD = "recoverable-local-password";

let api: APIRequestContext;
let resetToken = "";
let workspacesBefore: unknown;

test.beforeAll(async () => {
  for (const secret of [INVITED_PASSWORD, RESET_PASSWORD, LOCAL_PASSWORD]) {
    await recordSecret(secret);
  }
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const session = await api.get("/api/auth/session");
  expect(await session.json()).toMatchObject({ email: ADMIN_EMAIL, emailVerified: false });
  const listing = await api.get("/api/workspaces");
  expect(listing.status()).toBe(200);
  workspacesBefore = await listing.json();
});
test.afterAll(async () => {
  await api?.dispose();
});

test("requests for unverified, unknown, and verified addresses answer the same way", async () => {
  const unverified = await api.post("/api/auth/password-reset/request", {
    data: { email: ADMIN_EMAIL },
  });
  const unknown = await api.post("/api/auth/password-reset/request", {
    data: { email: "nobody@orrery.test" },
  });
  expect(unverified.status()).toBe(200);
  expect(await unverified.json()).toEqual(await unknown.json());

  expect(await caughtResetMessage(api, ADMIN_EMAIL)).toBeUndefined();
  expect(await caughtResetMessage(api, "nobody@orrery.test")).toBeUndefined();
});

test("delivers a reset link only to a verified address, and GETting it changes nothing", async () => {
  const invited = await api.post("/api/invitations/installation", {
    data: { email: RECOVERED_EMAIL },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtInvitationToken(api, RECOVERED_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const invitationToken = await caughtInvitationToken(api, RECOVERED_EMAIL);
  if (invitationToken === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(invitationToken);

  const registered = await api.post("/api/invitations/installation/registration", {
    data: { token: invitationToken, password: INVITED_PASSWORD },
  });
  expect(registered.status()).toBe(200);
  expect(await registered.json()).toEqual({
    email: RECOVERED_EMAIL,
    emailVerified: true,
    avatarUrl: null,
  });

  const requested = await api.post("/api/auth/password-reset/request", {
    data: { email: RECOVERED_EMAIL },
  });
  expect(requested.status()).toBe(200);
  expect(await requested.json()).toEqual(await unverifiedAnswer(api));

  await expect
    .poll(async () => caughtResetMessage(api, RECOVERED_EMAIL), { timeout: 15_000 })
    .toBeTruthy();
  const messageId = await caughtResetMessage(api, RECOVERED_EMAIL);
  if (messageId === undefined) throw new Error("the catcher never received the reset email");
  const detail = await api.get(`${mailpit}/api/v1/message/${messageId}`);
  const text = messageText(await detail.json());
  const token = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await recordSecret(token ?? "");
  resetToken = token ?? "";

  const page = await api.get(`/reset-password?token=${resetToken}`);
  expect(page.status()).toBe(200);
  expect(page.headers()["content-type"]).toContain("text/html");
  expect(await loginStatus(INVITED_PASSWORD)).toBe(200);
});

test("redeems once, signs out old browser sessions, and refuses reuse", async () => {
  expect(resetToken).not.toBe("");
  const first = await request.newContext({ baseURL: baseUrl });
  const second = await request.newContext({ baseURL: baseUrl });
  try {
    for (const context of [first, second]) {
      const login = await context.post("/api/auth/login", {
        data: { email: RECOVERED_EMAIL, password: INVITED_PASSWORD },
      });
      expect(login.status()).toBe(200);
      for (const cookie of await context.cookies()) await recordSecret(cookie.value);
      expect((await context.get("/api/auth/session")).status()).toBe(200);
    }

    const confirmed = await api.post("/api/auth/password-reset/confirm", {
      data: { token: resetToken, password: RESET_PASSWORD },
    });
    expect(confirmed.status()).toBe(200);

    for (const context of [first, second]) {
      expect((await context.get("/api/auth/session")).status()).toBe(401);
    }

    const again = await api.post("/api/auth/password-reset/confirm", {
      data: { token: resetToken, password: LOCAL_PASSWORD },
    });
    expect(again.status()).toBe(400);
    expect(await again.json()).toMatchObject({ code: "reset_token_invalid" });

    expect(await loginStatus(INVITED_PASSWORD)).toBe(401);
    expect(await loginStatus(RESET_PASSWORD)).toBe(200);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("administrator local recovery signs out sessions, works with broken SMTP, and refuses ordinary accounts", async () => {
  await recordSecret(LOCAL_PASSWORD);
  const broken = await api.put("/api/settings/smtp", {
    data: { ...SETTINGS, port: 9265 },
  });
  expect(broken.status()).toBe(200);

  const adminSession = await request.newContext({ baseURL: baseUrl });
  let signedOut = false;
  try {
    const login = await adminSession.post("/api/auth/login", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.status()).toBe(200);
    for (const cookie of await adminSession.cookies()) await recordSecret(cookie.value);
    expect((await adminSession.get("/api/auth/session")).status()).toBe(200);

    const { stdout } = await exec(localRecoveryCommand(ADMIN_EMAIL, ADMIN_PASSWORD), {
      timeout: 60_000,
    });
    expect(stdout).toContain(ADMIN_EMAIL);
    expect((await adminSession.get("/api/auth/session")).status()).toBe(401);
    signedOut = true;

    type ExecFailure = Error & { code?: number; stderr?: string };
    const refused = await exec(localRecoveryCommand(RECOVERED_EMAIL, LOCAL_PASSWORD), {
      timeout: 60_000,
    }).then(
      () => undefined,
      (error: ExecFailure) => error,
    );
    expect(refused).toBeDefined();
    expect(refused?.code).not.toBe(0);
    expect(refused?.stderr).toContain("system administrators only");

    expect(await loginStatus(RESET_PASSWORD)).toBe(200);
  } finally {
    await adminSession.dispose();
  }

  expect(signedOut).toBe(true);
  const relogin = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(relogin.status()).toBe(200);

  const status = await api.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: true });

  const secondSetup = await api.post("/api/setup/admin", {
    data: {
      secret: process.env.ORRERY_SETUP_SECRET ?? "",
      email: "other@orrery.test",
      password: LOCAL_PASSWORD,
    },
  });
  expect(secondSetup.status()).toBe(409);
  expect(await secondSetup.json()).toMatchObject({ code: "setup_complete" });
  const workspacesAfter = await api.get("/api/workspaces");
  expect(await workspacesAfter.json()).toEqual(workspacesBefore);

  const repaired = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(repaired.status()).toBe(200);
});

test("serves the request and reset forms", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.goto("/reset-password?token=not-a-real-token");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(page.getByLabel("New password")).toBeVisible();
});

function localRecoveryCommand(email: string, password: string): string {
  return (
    `docker compose -f "${composeFile}" exec -T ` +
    `-e ORRERY_RECOVERY_EMAIL="${email}" ` +
    `-e ORRERY_RECOVERY_PASSWORD="${password}" ` +
    `${composeService} node apps/server/src/recovery-cli.ts`
  );
}

async function loginStatus(password: string): Promise<number> {
  const context = await request.newContext({ baseURL: baseUrl });
  try {
    const res = await context.post("/api/auth/login", {
      data: { email: RECOVERED_EMAIL, password },
    });
    return res.status();
  } finally {
    await context.dispose();
  }
}

async function unverifiedAnswer(context: APIRequestContext): Promise<unknown> {
  const res = await context.post("/api/auth/password-reset/request", {
    data: { email: "another-unknown@orrery.test" },
  });
  return res.json();
}

async function caughtMessage(
  context: APIRequestContext,
  subject: string,
  to: string,
): Promise<string | undefined> {
  const res = await context.get(`${mailpit}/api/v1/messages`);
  return caughtMessageId(res, subject, to);
}

async function caughtResetMessage(
  context: APIRequestContext,
  to: string,
): Promise<string | undefined> {
  return caughtMessage(context, RESET_SUBJECT, to);
}

async function caughtInvitationToken(
  context: APIRequestContext,
  to: string,
): Promise<string | undefined> {
  const id = await caughtMessage(context, INVITATION_SUBJECT, to);
  if (id === undefined) return undefined;
  const detail = await context.get(`${mailpit}/api/v1/message/${id}`);
  const token = /\/register\?token=([A-Za-z0-9_-]+)/.exec(messageText(await detail.json()))?.[1];
  return token;
}

async function caughtMessageId(
  res: APIResponse,
  subject: string,
  to: string,
): Promise<string | undefined> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== subject) continue;
    const recipients: unknown = Reflect.get(message, "To");
    if (!Array.isArray(recipients)) continue;
    const addresses = recipients.flatMap((entry: unknown): string[] => {
      const address: unknown =
        typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
      return typeof address === "string" ? [address] : [];
    });
    if (!addresses.includes(to)) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id === "string") return id;
  }
  return undefined;
}

function messageText(detail: unknown): string {
  if (typeof detail !== "object" || detail === null) throw new Error("no message detail");
  const text: unknown = Reflect.get(detail, "Text");
  if (typeof text !== "string") throw new Error("the caught message has no text body");
  return text;
}

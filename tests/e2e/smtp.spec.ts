import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const exec = promisify(execCallback);

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const restartCommand = process.env.ORRERY_RESTART_CMD;

const SMTP_PASSWORD = "catcher-relay-passphrase-for-tests";

const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

const SETTINGS_WITH_PASSWORD = {
  host: "mailpit",
  port: 465,
  security: "tls",
  username: "postmaster",
  password: SMTP_PASSWORD,
  from: "orrery@orrery.test",
} as const;
const SUBJECT = "Verify your Orrery email";

let verificationToken = "";

let api: APIRequestContext;
test.beforeAll(async () => {
  await recordSecret(SMTP_PASSWORD);
  const encryptionKey = process.env.ORRERY_ENCRYPTION_KEY;
  if (encryptionKey !== undefined) await recordSecret(encryptionKey);
  api = await request.newContext({ baseURL: baseUrl });

  const res = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
});

test("refuses every settings operation without a session", async () => {
  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const attempts = [
      await anonymous.get("/api/settings/smtp"),
      await anonymous.put("/api/settings/smtp", { data: SETTINGS }),
      await anonymous.post("/api/settings/smtp/test"),
      await anonymous.post("/api/settings/email-verification", { data: { token: "x" } }),
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

test("saves the SMTP settings without ever echoing the password", async () => {
  const withPassword = await api.put("/api/settings/smtp", {
    data: SETTINGS_WITH_PASSWORD,
  });
  expect(withPassword.status()).toBe(200);
  const stored = await withPassword.json();
  expect(stored).toMatchObject({ security: "tls", username: "postmaster", hasPassword: true });

  expect(JSON.stringify(stored)).not.toContain(SMTP_PASSWORD);

  const saved = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(saved.status()).toBe(200);
  const body = await saved.json();
  expect(body).toEqual({
    host: "mailpit",
    port: 1025,
    security: "none",
    username: null,
    hasPassword: false,
    from: "orrery@orrery.test",
  });

  const got = await api.get("/api/settings/smtp");
  expect(await got.json()).toEqual(body);
});

test("sends the test email, and the catcher receives it with a fresh token", async () => {
  const res = await api.post("/api/settings/smtp/test");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ sentTo: ADMIN_EMAIL });

  let messageId: string | undefined;
  await expect
    .poll(
      async () => {
        const list = await api.get(`${mailpit}/api/v1/messages`);
        messageId = await caughtMessageId(list);
        return messageId !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  if (messageId === undefined) throw new Error("the catcher never received the email");

  const detail = await api.get(`${mailpit}/api/v1/message/${messageId}`);
  const { text, to } = caughtTextAndTo(await detail.json());
  expect(text).toContain(ADMIN_EMAIL);
  expect(to).toContain(ADMIN_EMAIL);

  expect(text).toContain("/api/settings/email-verification");
  expect(text).not.toContain("verify-email?token=");
  const token = text.match(/Single-use token, valid for 24 hours:\r?\n\r?\n([A-Za-z0-9_-]+)/)?.[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(text).toContain(`/settings/smtp?token=${token}`);

  await recordSecret(token ?? "");
  verificationToken = token ?? "";
});

test("completes email verification by POSTing the token, exactly once", async () => {
  const before = await api.get("/api/auth/session");
  expect(await before.json()).toEqual({
    email: ADMIN_EMAIL,
    displayName: null,
    emailVerified: false,
    avatarUrl: null,
  });

  const res = await api.post("/api/settings/email-verification", {
    data: { token: verificationToken },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ email: ADMIN_EMAIL, emailVerified: true, avatarUrl: null });

  const after = await api.get("/api/auth/session");
  expect(await after.json()).toEqual({
    email: ADMIN_EMAIL,
    displayName: null,
    emailVerified: true,
    avatarUrl: null,
  });

  const again = await api.post("/api/settings/email-verification", {
    data: { token: verificationToken },
  });
  expect(again.status()).toBe(400);
  expect(await again.json()).toMatchObject({ code: "verification_token_invalid" });
});

test("answers a broken relay with an actionable Problem, and keeps sign-in working", async () => {
  const broken = await api.put("/api/settings/smtp", {
    data: { ...SETTINGS, port: 9265 },
  });
  expect(broken.status()).toBe(200);

  const send = await api.post("/api/settings/smtp/test");
  expect(send.status()).toBe(502);
  expect(send.headers()["content-type"]).toBe("application/problem+json");
  expect(await send.json()).toMatchObject({ status: 502, code: "smtp_unreachable" });

  const relogin = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(relogin.status()).toBe(200);

  const repaired = await api.put("/api/settings/smtp", { data: SETTINGS });
  expect(repaired.status()).toBe(200);
  const sendAgain = await api.post("/api/settings/smtp/test");
  expect(sendAgain.status()).toBe(200);
});

test("keeps the settings and the verified email across a restart", async () => {
  test.skip(
    !restartCommand,
    "Set ORRERY_RESTART_CMD to a command that restarts the server, for example " +
      "'docker compose -f <repo>/compose.yaml restart orrery'.",
  );

  await exec(restartCommand ?? "", { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        try {
          return (await api.get("/readyz")).ok();
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();

  const got = await api.get("/api/settings/smtp");
  expect(await got.json()).toMatchObject({
    host: "mailpit",
    port: 1025,
    security: "none",
    hasPassword: false,
    from: "orrery@orrery.test",
  });

  const session = await api.get("/api/auth/session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toEqual({
    email: ADMIN_EMAIL,
    displayName: null,
    emailVerified: true,
    avatarUrl: null,
  });

  const send = await api.post("/api/settings/smtp/test");
  expect(send.status()).toBe(200);
});

async function caughtMessageId(res: APIResponse) {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) return undefined;
  const messages: unknown = Reflect.get(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (Reflect.get(message, "Subject") !== SUBJECT) continue;
    const id: unknown = Reflect.get(message, "ID");
    if (typeof id === "string") return id;
  }
  return undefined;
}

function caughtTextAndTo(detail: unknown): { text: string; to: string[] } {
  if (typeof detail !== "object" || detail === null) throw new Error("no message detail");
  const text: unknown = Reflect.get(detail, "Text");
  const to: unknown = Reflect.get(detail, "To");
  if (typeof text !== "string") throw new Error("the caught message has no text body");
  if (!Array.isArray(to)) throw new Error("the caught message has no recipients");
  const addresses = to.flatMap((entry): string[] => {
    const address: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "Address") : undefined;
    return typeof address === "string" ? [address] : [];
  });
  return { text, to: addresses };
}

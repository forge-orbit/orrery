import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Problem,
  SmtpSettingsResponse,
  TestEmailResponse,
  type SmtpSettings,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountsFeature } from "../accounts/index.ts";
import {
  browserSessions,
  emailVerificationTokens,
  humans,
  instanceSettings,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { type Logger, createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createSettingsFeature, startupWarnings } from "./index.ts";
import { createSettingsService } from "./service.ts";
import type { SmtpMail, SmtpSender } from "./service.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const SMTP_PASSWORD = "the-mail-relay-passphrase";
const SETTINGS: SmtpSettings = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: "postmaster",
  password: SMTP_PASSWORD,
  from: "  Orrery@Example.TEST ",
};

const FROM = "orrery@example.test";

const SETTINGS_RESPONSE = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: "postmaster",
  hasPassword: true,
  from: FROM,
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const TEST_KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const putJson = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const getJson = (app: Hono, path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { cookie } } : undefined);

const problemBody = async (res: Response) => Problem.parse(await res.json());

const tokenFrom = (text: string) => text.match(/\/settings\/smtp\?token=([A-Za-z0-9_-]+)/)?.[1];

interface SentMail {
  settings: SmtpSettings;
  mail: SmtpMail;
}
function createFakeSender() {
  const sent: SentMail[] = [];
  let failure: ((attempt: SentMail) => Error) | undefined;
  const sender: SmtpSender = async (settings, mail) => {
    const attempt = { settings, mail };
    if (failure) throw failure(attempt);
    sent.push(attempt);
  };
  return {
    sent,
    failWith(errorFactory: (attempt: SentMail) => Error) {
      failure = errorFactory;
    },
    sender,
  };
}

const codedError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

async function bootstrapAdmin(app: Hono) {
  const res = await postJson(app, "/api/setup/admin", {
    secret: SECRET,
    email: EMAIL,
    password: PASSWORD,
  });
  expect(res.status).toBe(201);
}

async function adminCookie(app: Hono): Promise<string> {
  const res = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("orrery_session="))
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("the session cookie was not set");
  return cookie;
}

async function saveSettings(app: Hono, cookie: string, settings: SmtpSettings = SETTINGS) {
  const res = await putJson(app, "/api/settings/smtp", settings, cookie);
  expect(res.status).toBe(200);
  return res;
}

async function issuedToken(app: Hono, fake: { sent: SentMail[] }) {
  const cookie = await adminCookie(app);
  await saveSettings(app, cookie);
  const res = await postJson(app, "/api/settings/smtp/test", {}, cookie);
  expect(res.status).toBe(200);
  const token = tokenFrom(fake.sent[0]?.mail.text ?? "");
  expect(token).not.toBe("");
  return { cookie, token: token ?? "" };
}

function deliverService(
  db: Database["db"],
  fake: ReturnType<typeof createFakeSender>,
  key: Buffer = TEST_KEY,
) {
  return createSettingsService({
    db,
    publicUrl: PUBLIC_URL,
    encryptionKey: key,
    markEmailVerified: async () => {},
    sendMail: fake.sender,
  });
}

describe("settings", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  afterEach(async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from workspace_events`);
      await tx.execute(sql`delete from workspace_invitations`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from invitations`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from instance_settings`);
      await tx.execute(sql`delete from email_verification_tokens`);
      await tx.execute(sql`delete from humans`);
    });
  });

  function makeApp(
    setupSecret: string | undefined = SECRET,
    opts: { sendMail?: SmtpSender; log?: Logger; encryptionKey?: Buffer | null } = {},
  ) {
    const log = opts.log ?? silentLogger;
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret,
      publicUrl: PUBLIC_URL,
    });
    const settings = createSettingsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      encryptionKey: opts.encryptionKey === null ? undefined : (opts.encryptionKey ?? TEST_KEY),
      sessionReader: accounts.sessionReader,
      markEmailVerified: accounts.markEmailVerified,

      ...(opts.sendMail === undefined ? {} : { sendMail: opts.sendMail }),
      log,
    });
    return createApp({ features: [accounts, settings], publicUrl: PUBLIC_URL, log });
  }

  async function ordinaryCookie(email = "member@example.com") {
    const [account] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email, passwordHash: "scrypt$anything" })
      .returning();
    if (account === undefined) throw new Error("the ordinary account was not created");
    const token = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: account.id,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    return `orrery_session=${token}`;
  }

  describe("authorization", () => {
    it("refuses every settings operation without a signed-in account", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const get = await getJson(app, "/api/settings/smtp");
      const put = await putJson(app, "/api/settings/smtp", SETTINGS);
      const test = await postJson(app, "/api/settings/smtp/test", {});
      const verify = await postJson(app, "/api/settings/email-verification", {
        token: "anything",
      });
      for (const res of [get, put, test, verify]) {
        expect(res.status).toBe(401);
        expect(res.headers.get("content-type")).toBe("application/problem+json");
        expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
      }
      expect(await database.db.select().from(instanceSettings)).toHaveLength(0);
    });

    it("refuses settings operations for a signed-in ordinary account", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await ordinaryCookie();

      const get = await getJson(app, "/api/settings/smtp", cookie);
      const put = await putJson(app, "/api/settings/smtp", SETTINGS, cookie);
      const test = await postJson(app, "/api/settings/smtp/test", {}, cookie);
      expect(get.status).toBe(403);
      expect(put.status).toBe(403);
      expect(test.status).toBe(403);

      const bodies = await Promise.all([get, put, test].map((r) => r.text()));
      for (const text of bodies) {
        const body = Problem.parse(JSON.parse(text));
        expect(body.code).toBe("not_admin");
        expect(body.title).toContain("administrator");
      }
      expect(bodies.join("\n")).not.toContain(SMTP_PASSWORD);
      expect(await database.db.select().from(instanceSettings)).toHaveLength(0);

      const verify = await postJson(
        app,
        "/api/settings/email-verification",
        {
          token: "no-such-token",
        },
        cookie,
      );
      expect(verify.status).toBe(400);
      expect(await problemBody(verify)).toMatchObject({ code: "verification_token_invalid" });
    });
  });

  describe("SMTP settings", () => {
    it("reports every field as unset before SMTP is configured", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const res = await getJson(app, "/api/settings/smtp", await adminCookie(app));
      expect(res.status).toBe(200);
      expect(SmtpSettingsResponse.parse(await res.json())).toEqual({
        host: null,
        port: null,
        security: null,
        username: null,
        hasPassword: false,
        from: null,
      });
    });

    it("saves settings, answers them without the password, and stores only ciphertext", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const res = await saveSettings(app, await adminCookie(app));

      const text = await res.text();
      expect(JSON.parse(text)).toEqual(SETTINGS_RESPONSE);
      expect(text).not.toContain(SMTP_PASSWORD);

      const [row] = await database.db.select().from(instanceSettings);
      expect(row?.smtpPasswordEncrypted).toMatch(
        /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
      );
      expect(row?.smtpPasswordEncrypted).not.toBe(SMTP_PASSWORD);
      expect(row?.smtpPasswordEncrypted ?? "").not.toContain(SMTP_PASSWORD);
      expect(row).toMatchObject({
        id: true,
        smtpHost: "smtp.example.test",
        smtpPort: 587,
        smtpSecurity: "starttls",
        smtpUsername: "postmaster",
        smtpFrom: FROM,
      });
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      expect(row?.updatedByHumanId).toBe(admin?.id);
    });

    it("replaces settings wholesale, clearing the stored password when none is supplied", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const second: SmtpSettings = {
        host: "relay.example.test",
        port: 25,
        security: "none",
        username: null,
        password: null,
        from: "orrery@relay.example.test",
      };
      const res = await putJson(app, "/api/settings/smtp", second, cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        host: "relay.example.test",
        port: 25,
        security: "none",
        username: null,
        hasPassword: false,
        from: "orrery@relay.example.test",
      });

      const [row] = await database.db.select().from(instanceSettings);
      expect(row?.smtpPasswordEncrypted).toBeNull();
      expect(row?.smtpHost).toBe("relay.example.test");
    });

    it("refuses security none together with credentials, in either field", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);

      const withPassword = await putJson(
        app,
        "/api/settings/smtp",
        { ...SETTINGS, security: "none", username: null },
        cookie,
      );
      expect(withPassword.status).toBe(400);
      expect(await problemBody(withPassword)).toMatchObject({
        code: "insecure_smtp_credentials",
        title: expect.stringContaining("clear text"),
      });

      const withUsername = await putJson(
        app,
        "/api/settings/smtp",
        { ...SETTINGS, security: "none", password: null },
        cookie,
      );
      expect(withUsername.status).toBe(400);
      expect(await problemBody(withUsername)).toMatchObject({ code: "insecure_smtp_credentials" });

      const plain = await putJson(
        app,
        "/api/settings/smtp",
        { ...SETTINGS, security: "none", username: null, password: null },
        cookie,
      );
      expect(plain.status).toBe(200);
      expect(await plain.json()).toMatchObject({ security: "none", hasPassword: false });
      expect(await database.db.select().from(instanceSettings)).toHaveLength(1);
    });

    it("refuses to store a password when no encryption key is set, and still saves without one", async () => {
      const app = makeApp(SECRET, { encryptionKey: null });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);

      const withPassword = await putJson(app, "/api/settings/smtp", SETTINGS, cookie);
      expect(withPassword.status).toBe(409);
      const refused = await problemBody(withPassword);
      expect(refused).toMatchObject({ code: "encryption_key_missing" });
      expect(refused.title).toContain("ORRERY_ENCRYPTION_KEY");
      expect(await database.db.select().from(instanceSettings)).toHaveLength(0);

      const withoutPassword = await putJson(
        app,
        "/api/settings/smtp",
        { ...SETTINGS, username: null, password: null },
        cookie,
      );
      expect(withoutPassword.status).toBe(200);
      expect(await withoutPassword.json()).toMatchObject({ hasPassword: false });
    });

    it("refuses invalid settings with a validation Problem, and saves nothing", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);

      for (const body of [
        { ...SETTINGS, host: "" },
        { ...SETTINGS, port: 0 },
        { ...SETTINGS, port: 65536 },
        { ...SETTINGS, security: "ssl" },
        { ...SETTINGS, from: "not-an-email" },
        { ...SETTINGS, username: 5 },
      ]) {
        const res = await putJson(app, "/api/settings/smtp", body, cookie);
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toBe("application/problem+json");
        expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });
      }

      const port = await putJson(app, "/api/settings/smtp", { ...SETTINGS, port: 0 }, cookie);
      expect((await problemBody(port)).errors).toEqual([
        { pointer: "/port", detail: expect.any(String) },
      ]);

      const missing = { ...SETTINGS } as Partial<SmtpSettings>;
      delete missing.password;
      const res = await putJson(app, "/api/settings/smtp", missing, cookie);
      expect(res.status).toBe(400);
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });

      expect(await database.db.select().from(instanceSettings)).toHaveLength(0);
    });

    it("persists settings for a fresh service instance over the same database", async () => {
      const first = makeApp();
      await bootstrapAdmin(first);
      const cookie = await adminCookie(first);
      await saveSettings(first, cookie);

      const second = makeApp();
      const res = await getJson(second, "/api/settings/smtp", cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(SETTINGS_RESPONSE);
    });

    it("settles concurrent saves on one row", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      const saves = await Promise.all([
        putJson(app, "/api/settings/smtp", SETTINGS, cookie),
        putJson(app, "/api/settings/smtp", { ...SETTINGS, host: "other.example.test" }, cookie),
      ]);
      for (const res of saves) expect(res.status).toBe(200);
      expect(await database.db.select().from(instanceSettings)).toHaveLength(1);
    });
  });

  describe("encryption at rest (ADR-0004)", () => {
    it("round-trips the password: saved encrypted, decrypted only to be sent", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const res = await postJson(app, "/api/settings/smtp/test", {}, cookie);
      expect(res.status).toBe(200);

      expect(fake.sent[0]?.settings.password).toBe(SMTP_PASSWORD);

      const [row] = await database.db.select().from(instanceSettings);
      expect(row?.smtpPasswordEncrypted).not.toContain(SMTP_PASSWORD);
    });

    it("answers smtp_password_unreadable when the key changed or is gone", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const rekeyed = makeApp(SECRET, { sendMail: fake.sender, encryptionKey: OTHER_KEY });
      const wrongKey = await postJson(rekeyed, "/api/settings/smtp/test", {}, cookie);
      expect(wrongKey.status).toBe(409);
      const unreadable = await problemBody(wrongKey);
      expect(unreadable).toMatchObject({ code: "smtp_password_unreadable" });
      expect(unreadable.title).toContain("Re-enter the password");

      const keyless = makeApp(SECRET, { sendMail: fake.sender, encryptionKey: null });
      const noKey = await postJson(keyless, "/api/settings/smtp/test", {}, cookie);
      expect(noKey.status).toBe(409);
      expect(await problemBody(noKey)).toMatchObject({ code: "smtp_password_unreadable" });
      expect(fake.sent).toHaveLength(0);
    });

    it("warns at startup when a password is stored but no key is set", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));

      const withoutKey = await startupWarnings({ db: database.db, encryptionKey: undefined });
      expect(withoutKey).toHaveLength(1);
      expect(withoutKey[0]).toContain("ORRERY_ENCRYPTION_KEY");

      const withKey = await startupWarnings({ db: database.db, encryptionKey: TEST_KEY });
      expect(withKey).toEqual([]);
      expect(admin?.id).not.toBe("");
    });
  });

  describe("test email", () => {
    it("refuses to send before SMTP is configured", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const fake = createFakeSender();

      const res = await postJson(app, "/api/settings/smtp/test", {}, await adminCookie(app));
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      const body = await problemBody(res);
      expect(body).toMatchObject({ status: 409, code: "smtp_unconfigured" });
      expect(body.title).toContain("SMTP is not configured");
      expect(fake.sent).toHaveLength(0);
    });

    it("sends the test email to the administrator's own address with a fresh token", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const res = await postJson(app, "/api/settings/smtp/test", {}, cookie);
      expect(res.status).toBe(200);
      const body = TestEmailResponse.parse(await res.json());
      expect(body.sentTo).toBe(EMAIL);
      expect(body.message).toContain("token");

      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.settings).toEqual({ ...SETTINGS, from: FROM });
      const mail = fake.sent[0]?.mail;
      expect(mail?.to).toBe(EMAIL);
      expect(mail?.from).toBe(FROM);

      expect(mail?.text).toContain(PUBLIC_URL);
      expect(mail?.text).not.toContain("/api/settings/email-verification");
      expect(mail?.text).not.toContain("verify-email?token");

      const token = tokenFrom(mail?.text ?? "");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(mail?.text).toContain(`${PUBLIC_URL}/settings/smtp?token=${token}`);
      expect(mail?.text).toContain(EMAIL);
      const [row] = await database.db.select().from(emailVerificationTokens);
      if (row === undefined) throw new Error("the token was not stored");
      expect(row.tokenHash).toBe(tokenHash(token ?? ""));
      expect(row.tokenHash).not.toBe(token);
      expect(row.usedAt).toBeNull();
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(TOKEN_TTL_MS);
    });

    it("answers a delivery failure as a Problem whose code names the reason", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const cases = [
        {
          error: () => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"),
          code: "smtp_unreachable",
        },
        {
          error: () => codedError("ESOCKET", "connect ECONNREFUSED 172.20.0.2:9265"),
          code: "smtp_unreachable",
        },
        {
          error: () => codedError("EAUTH", "535 5.7.8 Authentication failed"),
          code: "smtp_auth_failed",
        },
        {
          error: () => codedError("ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"),
          code: "smtp_tls_failed",
        },
        {
          error: () => codedError("ESOCKET", "unable to verify the first certificate"),
          code: "smtp_tls_failed",
        },
        {
          error: () => codedError("ESOCKET", "some other socket quirk"),
          code: "smtp_send_failed",
        },
        {
          error: () => new Error("some unclassified relay quirk"),
          code: "smtp_send_failed",
        },
      ];
      for (const { error, code } of cases) {
        fake.failWith(() => error());
        const res = await postJson(app, "/api/settings/smtp/test", {}, cookie);
        expect(res.status).toBe(502);
        expect(res.headers.get("content-type")).toBe("application/problem+json");
        const body = await problemBody(res);
        expect(body).toMatchObject({ status: 502, code, type: `urn:orrery:problem:${code}` });

        expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
        expect(JSON.stringify(body)).not.toContain("Authentication failed");
        expect(JSON.stringify(body)).not.toContain("relay quirk");
      }
    });

    it("leaves no live token behind when the send fails", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      fake.failWith(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
      const res = await postJson(app, "/api/settings/smtp/test", {}, cookie);
      expect(res.status).toBe(502);

      const unused = await database.db
        .select()
        .from(emailVerificationTokens)
        .where(isNull(emailVerificationTokens.usedAt));
      expect(unused).toHaveLength(0);

      const token = tokenFrom(fake.sent[0]?.mail.text ?? "");
      const redeem = await postJson(app, "/api/settings/email-verification", { token }, cookie);
      expect(redeem.status).toBe(400);
    });

    it("still answers the delivery Problem when the token cleanup itself fails", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      try {
        const failingCleanup = new Proxy(database.db, {
          get(target, property) {
            if (property === "delete") {
              return () => ({
                where: () => Promise.reject(new Error("cleanup exploded with a secret detail")),
              });
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const fake = createFakeSender();
        const log = createLogger("info");
        const app = makeApp();
        await bootstrapAdmin(app);
        await saveSettings(app, await adminCookie(app));
        const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
        if (admin === undefined) throw new Error("the administrator was not found");
        const service = createSettingsService({
          db: failingCleanup,
          publicUrl: PUBLIC_URL,
          encryptionKey: TEST_KEY,
          markEmailVerified: () => Promise.resolve(),
          sendMail: fake.sender,
          log,
        });

        fake.failWith(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
        await expect(
          service.sendTestEmail({
            humanId: admin.id,
            email: admin.email,
            isSystemAdministrator: true,
            emailVerifiedAt: admin.emailVerifiedAt,
          }),
        ).rejects.toMatchObject({ kind: "smtp_unreachable" });

        const captured = lines.join("\n");

        expect(captured).toContain("test email failed");
        expect(captured).toContain("token cleanup");

        expect(captured).not.toContain("exploded");
        expect(captured).not.toContain("secret detail");
      } finally {
        spy.mockRestore();
      }
    });

    it("invalidates the account's earlier unused tokens when a new one is issued", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      await saveSettings(app, cookie);

      const first = await postJson(app, "/api/settings/smtp/test", {}, cookie);
      expect(first.status).toBe(200);
      const firstToken = tokenFrom(fake.sent[0]?.mail.text ?? "");
      expect(firstToken).not.toBe("");

      const second = await postJson(app, "/api/settings/smtp/test", {}, cookie);
      expect(second.status).toBe(200);
      const secondToken = tokenFrom(fake.sent[1]?.mail.text ?? "");
      expect(secondToken).not.toBe("");
      expect(secondToken).not.toBe(firstToken);

      const older = await postJson(
        app,
        "/api/settings/email-verification",
        { token: firstToken },
        cookie,
      );
      expect(older.status).toBe(400);
      expect(await problemBody(older)).toMatchObject({ code: "verification_token_invalid" });

      const newer = await postJson(
        app,
        "/api/settings/email-verification",
        { token: secondToken },
        cookie,
      );
      expect(newer.status).toBe(200);
    });

    it("records requests without the SMTP password or the verification token", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      try {
        const fake = createFakeSender();
        const log = createLogger("info");
        const app = makeApp(SECRET, { sendMail: fake.sender, log });
        await bootstrapAdmin(app);
        const cookie = await adminCookie(app);
        await saveSettings(app, cookie);
        await postJson(app, "/api/settings/smtp/test", {}, cookie);
        const token = tokenFrom(fake.sent[0]?.mail.text ?? "") ?? "";
        expect(token).not.toBe("");
        await postJson(app, "/api/settings/email-verification", { token }, cookie);

        const captured = lines.join("\n");

        expect(captured).toContain("/api/settings/smtp");
        expect(captured).toContain("/api/settings/email-verification");
        expect(captured).not.toContain(SMTP_PASSWORD);
        expect(captured).not.toContain(token);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("email verification", () => {
    it("completes verification by POSTing the token, exactly once", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      const { cookie, token } = await issuedToken(app, fake);
      expect(token).not.toBe("");

      const before = await getJson(app, "/api/auth/session", cookie);
      expect(await before.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: false,
        avatarUrl: null,
      });

      const res = await postJson(app, "/api/settings/email-verification", { token }, cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });

      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      expect(admin?.emailVerifiedAt).not.toBeNull();
      const [row] = await database.db.select().from(emailVerificationTokens);
      expect(row?.usedAt).not.toBeNull();

      const after = await getJson(app, "/api/auth/session", cookie);
      expect(await after.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });

      const again = await postJson(app, "/api/settings/email-verification", { token }, cookie);
      expect(again.status).toBe(400);
      expect(await problemBody(again)).toMatchObject({ code: "verification_token_invalid" });
    });

    it("refuses a token that was never issued", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const res = await postJson(
        app,
        "/api/settings/email-verification",
        { token: "never-issued" },
        await adminCookie(app),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ code: "verification_token_invalid" });
    });

    it("refuses an expired token and accepts one still valid", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(emailVerificationTokens).values([
        {
          id: randomUUID(),
          humanId: admin.id,
          tokenHash: tokenHash("just-expired"),
          expiresAt: sql`now() - interval '1 second'`,
        },
        {
          id: randomUUID(),
          humanId: admin.id,
          tokenHash: tokenHash("still-valid"),
          expiresAt: sql`now() + interval '1 hour'`,
        },
      ]);

      const expired = await postJson(
        app,
        "/api/settings/email-verification",
        { token: "just-expired" },
        cookie,
      );
      expect(expired.status).toBe(400);
      expect(expired.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(expired)).toMatchObject({ code: "verification_token_invalid" });

      const valid = await postJson(
        app,
        "/api/settings/email-verification",
        { token: "still-valid" },
        cookie,
      );
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });
    });

    it("refuses another account's token without consuming it, and its owner can still redeem it", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const adminCookieValue = await adminCookie(app);
      const memberCookie = await ordinaryCookie();
      const [member] = await database.db
        .select()
        .from(humans)
        .where(eq(humans.email, "member@example.com"));
      if (member === undefined) throw new Error("the ordinary account was not found");

      await database.db.insert(emailVerificationTokens).values({
        id: randomUUID(),
        humanId: member.id,
        tokenHash: tokenHash("members-own-token"),
        expiresAt: sql`now() + interval '1 hour'`,
      });

      const stolen = await postJson(
        app,
        "/api/settings/email-verification",
        { token: "members-own-token" },
        adminCookieValue,
      );
      expect(stolen.status).toBe(400);
      expect(await problemBody(stolen)).toMatchObject({ code: "verification_token_invalid" });

      const [notConsumed] = await database.db.select().from(emailVerificationTokens);
      expect(notConsumed?.usedAt).toBeNull();
      const own = await postJson(
        app,
        "/api/settings/email-verification",
        { token: "members-own-token" },
        memberCookie,
      );
      expect(own.status).toBe(200);
      expect(await own.json()).toEqual({
        email: "member@example.com",
        handle: "member",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });
    });
  });

  describe("deliver", () => {
    it("refuses to deliver before SMTP is configured", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const service = deliverService(database.db, createFakeSender());

      await expect(
        service.deliver({ to: "member@example.com", subject: "s", text: "t" }),
      ).rejects.toMatchObject({ kind: "smtp_unconfigured" });
    });

    it("delivers through the configured relay, with the stored From and password", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      await saveSettings(app, await adminCookie(app));
      const service = deliverService(database.db, fake);

      await service.deliver({
        to: "member@example.com",
        subject: "Your Orrery invitation",
        text: "Follow the link.",
      });

      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.mail).toEqual({
        from: FROM,
        to: "member@example.com",
        subject: "Your Orrery invitation",
        text: "Follow the link.",
      });

      expect(fake.sent[0]?.settings).toEqual({ ...SETTINGS, from: FROM });
    });

    it("classifies a relay failure the way sendTestEmail does", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      await saveSettings(app, await adminCookie(app));
      const service = deliverService(database.db, fake);

      fake.failWith(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
      await expect(
        service.deliver({ to: "member@example.com", subject: "s", text: "t" }),
      ).rejects.toMatchObject({ kind: "smtp_unreachable" });
    });

    it("refuses to deliver when the stored password cannot be read", async () => {
      const fake = createFakeSender();
      const app = makeApp(SECRET, { sendMail: fake.sender });
      await bootstrapAdmin(app);
      await saveSettings(app, await adminCookie(app));

      const service = deliverService(database.db, fake, OTHER_KEY);

      await expect(
        service.deliver({ to: "member@example.com", subject: "s", text: "t" }),
      ).rejects.toMatchObject({ kind: "smtp_password_unreadable" });
      expect(fake.sent).toHaveLength(0);
    });
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  InstallationInvitation,
  InvitationSummaries,
  InvitationSummary,
  Problem,
  SessionResponse,
  type SmtpSettings,
} from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAccountsFeature } from "../accounts/index.ts";
import { createSettingsFeature } from "../settings/index.ts";
import { browserSessions, humans, invitations, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { type Logger, createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createInvitationsFeature } from "./index.ts";
import {
  createInvitationsService,
  InvitationsError,
  UNKNOWN_DELIVERY_GRACE_SECONDS,
} from "./service.ts";
import type { SmtpMail, SmtpSender } from "../settings/index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";

const INVITEE_INPUT = "  Member@Example.COM ";
const INVITEE = "member@example.com";
const INVITEE_PASSWORD = "invited-person-password";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const silentLogger: Logger = createLogger("error");

const SETTINGS: SmtpSettings = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls",
  username: null,
  password: null,
  from: "orrery@example.test",
};

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

const tokenFrom = (text: string) => text.match(/\/register\?token=([A-Za-z0-9_-]+)/)?.[1];

function createFakeTransport() {
  const sent: SmtpMail[] = [];
  let failure: (() => Error) | undefined;
  const sender: SmtpSender = async (_settings, mail) => {
    sent.push(mail);
    if (failure) throw failure();
  };
  return {
    sent,
    failWith(errorFactory: () => Error) {
      failure = errorFactory;
    },

    repair() {
      failure = undefined;
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

describe("invitations", () => {
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

  async function ordinaryCookie(email = "other@example.com") {
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

  function makeApp(opts: { smtp?: SmtpSender; log?: Logger } = {}) {
    const log = opts.log ?? silentLogger;
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const settings = createSettingsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      encryptionKey: undefined,
      sessionReader: accounts.sessionReader,
      markEmailVerified: accounts.markEmailVerified,

      ...(opts.smtp === undefined ? {} : { sendMail: opts.smtp }),
      log,
    });
    const invitationsFeature = createInvitationsFeature({
      db: database.db,
      publicUrl: PUBLIC_URL,
      sessionReader: accounts.sessionReader,
      emailRegistered: accounts.emailRegistered,
      createInvitedHuman: accounts.createInvitedHuman,
      markEmailVerified: accounts.markEmailVerified,
      deliver: settings.deliver,
      log,
    });
    return createApp({
      features: [accounts, settings, invitationsFeature],
      publicUrl: PUBLIC_URL,
      log,
    });
  }

  async function armedApp() {
    const fake = createFakeTransport();
    const app = makeApp({ smtp: fake.sender });
    await bootstrapAdmin(app);
    const cookie = await adminCookie(app);
    const saved = await putJson(app, "/api/settings/smtp", SETTINGS, cookie);
    expect(saved.status).toBe(200);
    return { app, cookie, fake };
  }

  async function invitedApp() {
    const armed = await armedApp();
    const res = await postJson(
      armed.app,
      "/api/invitations/installation",
      { email: INVITEE_INPUT },
      armed.cookie,
    );
    expect(res.status).toBe(201);
    const token = tokenFrom(armed.fake.sent[0]?.text ?? "");
    expect(token).not.toBe("");
    return { ...armed, token: token ?? "" };
  }

  describe("sending an installation invitation", () => {
    it("refuses to send without a signed-in account", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);
      await putJson(app, "/api/settings/smtp", SETTINGS, await adminCookie(app));

      const res = await postJson(app, "/api/invitations/installation", { email: INVITEE_INPUT });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 401, code: "not_signed_in" });
      expect(await database.db.select().from(invitations)).toHaveLength(0);
      expect(fake.sent).toHaveLength(0);
    });

    it("refuses to send for a signed-in ordinary account", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);
      await putJson(app, "/api/settings/smtp", SETTINGS, await adminCookie(app));

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        await ordinaryCookie(),
      );
      expect(res.status).toBe(403);
      const body = await problemBody(res);
      expect(body).toMatchObject({ status: 403, code: "not_admin" });
      expect(body.title).toContain("system administrator");
      expect(await database.db.select().from(invitations)).toHaveLength(0);
      expect(fake.sent).toHaveLength(0);
    });

    it("refuses to send before SMTP is configured, recording the failed delivery", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        await adminCookie(app),
      );
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "smtp_unconfigured" });

      const [row] = await database.db.select().from(invitations);
      expect(row).toMatchObject({ email: INVITEE, status: "pending", deliveryStatus: "failed" });
      expect(fake.sent).toHaveLength(0);
    });

    it("sends the invitation with a seven-day single-use link", async () => {
      const { app, cookie, fake } = await armedApp();
      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(201);
      const invitation = InstallationInvitation.parse(await res.json());
      expect(invitation).toEqual({ email: INVITEE, status: "pending" });

      expect(fake.sent).toHaveLength(1);
      const mail = fake.sent[0];
      const token = tokenFrom(mail?.text ?? "");
      expect(token).not.toBe("");
      expect(mail?.to).toBe(INVITEE);
      expect(mail?.from).toBe(SETTINGS.from);
      expect(mail?.text).toContain(`${PUBLIC_URL}/register?token=${token}`);
      expect(mail?.text).toContain(INVITEE);

      const [row] = await database.db.select().from(invitations);
      if (row === undefined) throw new Error("the invitation was not stored");
      expect(row.email).toBe(INVITEE);
      expect(row.tokenHash).toBe(tokenHash(token ?? ""));
      expect(row.tokenHash).not.toBe(token);
      expect(row.status).toBe("pending");
      expect(row.acceptedAt).toBeNull();
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(INVITATION_TTL_MS);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      expect(row.invitedByHumanId).toBe(admin?.id);

      expect(row.deliveryStatus).toBe("sent");
      expect(row.deliveryAttemptedAt).not.toBeNull();
    });

    it("refuses an invalid email with a validation Problem, and sends nothing", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);

      const res = await postJson(app, "/api/invitations/installation", { email: "nope" }, cookie);
      expect(res.status).toBe(400);
      const body = await problemBody(res);
      expect(body).toMatchObject({ code: "validation_failed" });
      expect(body.errors).toEqual([{ pointer: "/email", detail: expect.any(String) }]);
      expect(await database.db.select().from(invitations)).toHaveLength(0);
    });

    it("refuses an email that already has an account", async () => {
      const { app, cookie, fake } = await invitedApp();

      const res = await postJson(app, "/api/invitations/installation", { email: EMAIL }, cookie);
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "account_exists" });
      expect(await database.db.select().from(invitations)).toHaveLength(1);
      expect(fake.sent).toHaveLength(1);
    });

    it("refuses a second pending invitation for the same email, superseding nothing", async () => {
      const { app, cookie, fake } = await invitedApp();

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "invitation_pending" });
      expect(await database.db.select().from(invitations)).toHaveLength(1);
      expect(fake.sent).toHaveLength(1);

      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("pending");
      expect(row?.deliveryStatus).toBe("sent");
    });

    it("re-invites in place of an expired invitation, and the old token never redeems", async () => {
      const { app, cookie, fake } = await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: INVITEE,
        status: "pending",
        tokenHash: tokenHash("stale-token"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() - interval '1 second'`,
        deliveryStatus: "sent",
        deliveryAttemptedAt: sql`now() - interval '8 days'`,
      });

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(201);

      const rows = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.email, INVITEE));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.status === "expired")).toHaveLength(1);
      const live = rows.filter((r) => r.status === "pending");
      expect(live).toHaveLength(1);
      expect(live[0]?.tokenHash).not.toBe(tokenHash("stale-token"));

      const stale = await postJson(app, "/api/invitations/installation/registration", {
        token: "stale-token",
        password: INVITEE_PASSWORD,
      });
      expect(stale.status).toBe(400);
      expect(await problemBody(stale)).toMatchObject({ code: "invitation_invalid" });

      const fresh = tokenFrom(fake.sent[0]?.text ?? "");
      expect(fresh).not.toBe("");
      const ok = await postJson(app, "/api/invitations/installation/registration", {
        token: fresh,
        password: INVITEE_PASSWORD,
      });
      expect(ok.status).toBe(200);
    });

    it("still blocks a fresh invitation while an unknown delivery is inside the grace window", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: INVITEE,
        status: "pending",
        tokenHash: tokenHash("unknown-delivery"),
        invitedByHumanId: admin.id,
        createdAt: sql`now() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS - 1})`,
        expiresAt: sql`now() + interval '1 hour'`,
      });

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "invitation_pending" });
      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("pending");
    });

    it("re-invites in place once an unknown delivery is past the grace window, and the old token never redeems", async () => {
      const { app, cookie, fake } = await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: INVITEE,
        status: "pending",
        tokenHash: tokenHash("unknown-delivery-stale"),
        invitedByHumanId: admin.id,
        createdAt: sql`now() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS + 1})`,
        expiresAt: sql`now() + interval '1 hour'`,
      });

      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(201);

      const rows = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.email, INVITEE));
      expect(rows).toHaveLength(2);
      const stale = rows.find((row) => row.tokenHash === tokenHash("unknown-delivery-stale"));
      expect(stale).toMatchObject({ status: "revoked", expiredAt: null, deliveryStatus: null });
      expect(stale?.revokedAt).not.toBeNull();
      expect(stale?.revokedAt?.getTime()).toBeLessThan(stale?.expiresAt.getTime() ?? 0);
      const live = rows.filter((row) => row.status === "pending");
      expect(live).toHaveLength(1);
      expect(live[0]?.tokenHash).not.toBe(tokenHash("unknown-delivery-stale"));

      const oldToken = await postJson(app, "/api/invitations/installation/registration", {
        token: "unknown-delivery-stale",
        password: INVITEE_PASSWORD,
      });
      expect(oldToken.status).toBe(400);
      expect(await problemBody(oldToken)).toMatchObject({ code: "invitation_invalid" });

      const fresh = tokenFrom(fake.sent[0]?.text ?? "");
      expect(fresh).not.toBe("");
      const ok = await postJson(app, "/api/invitations/installation/registration", {
        token: fresh,
        password: INVITEE_PASSWORD,
      });
      expect(ok.status).toBe(200);
    });

    it("records replacement as revocation for live undelivered offers and as actual expiry past the deadline", async () => {
      const { app, cookie } = await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      const liveDeadline = new Date(Date.now() + 60 * 60 * 1000);
      const pastDeadline = new Date(Date.now() - 60 * 1000);
      const staleCreation = new Date(Date.now() - (UNKNOWN_DELIVERY_GRACE_SECONDS + 1) * 1000);
      await database.db.insert(invitations).values([
        {
          id: randomUUID(),
          email: "live-failed@example.com",
          status: "pending",
          tokenHash: tokenHash("live-failed"),
          invitedByHumanId: admin.id,
          expiresAt: liveDeadline,
          deliveryStatus: "failed",
          deliveryAttemptedAt: sql`now() - interval '1 minute'`,
        },
        {
          id: randomUUID(),
          email: "live-unknown@example.com",
          status: "pending",
          tokenHash: tokenHash("live-unknown"),
          invitedByHumanId: admin.id,
          createdAt: staleCreation,
          expiresAt: liveDeadline,
        },
        {
          id: randomUUID(),
          email: "past-deadline@example.com",
          status: "pending",
          tokenHash: tokenHash("past-deadline"),
          invitedByHumanId: admin.id,
          expiresAt: pastDeadline,
          deliveryStatus: "failed",
          deliveryAttemptedAt: sql`now() - interval '8 days'`,
        },
      ]);

      for (const email of [
        "live-failed@example.com",
        "live-unknown@example.com",
        "past-deadline@example.com",
      ]) {
        const res = await postJson(app, "/api/invitations/installation", { email }, cookie);
        expect(res.status).toBe(201);
      }

      const rows = await database.db.select().from(invitations);
      const failedLive = rows.find((row) => row.tokenHash === tokenHash("live-failed"));
      expect(failedLive).toMatchObject({
        status: "revoked",
        deliveryStatus: "failed",
        expiredAt: null,
      });
      expect(failedLive?.revokedAt).not.toBeNull();
      expect(failedLive?.revokedAt?.getTime()).toBeLessThan(liveDeadline.getTime());
      expect(failedLive?.expiresAt.getTime()).toBe(liveDeadline.getTime());

      const unknownLive = rows.find((row) => row.tokenHash === tokenHash("live-unknown"));
      expect(unknownLive).toMatchObject({
        status: "revoked",
        deliveryStatus: null,
        expiredAt: null,
      });
      expect(unknownLive?.revokedAt).not.toBeNull();
      expect(unknownLive?.revokedAt?.getTime()).toBeLessThan(liveDeadline.getTime());
      expect(unknownLive?.expiresAt.getTime()).toBe(liveDeadline.getTime());

      const past = rows.find((row) => row.tokenHash === tokenHash("past-deadline"));
      expect(past).toMatchObject({ status: "expired", revokedAt: null });
      expect(past?.expiredAt?.getTime()).toBe(pastDeadline.getTime());
      expect(past?.expiredAt?.getTime() ?? 0).toBeLessThan(Date.now());
      expect(past?.deliveryStatus).toBe("failed");
    });

    it("settles two concurrent invitations for the same email with one winner", async () => {
      await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      const service = createInvitationsService({
        db: database.db,
        publicUrl: PUBLIC_URL,
        emailRegistered: async () => false,
        createInvitedHuman: async (input) => ({ humanId: input.email, handle: "test-handle" }),
        markEmailVerified: async () => {},
        deliver: async () => {},
      });
      const account = {
        humanId: admin.id,
        email: EMAIL,
        isSystemAdministrator: true,
        emailVerifiedAt: null,
      };
      const results = await Promise.allSettled([
        service.inviteInstallation(account, { email: "race@example.com" }),
        service.inviteInstallation(account, { email: "race@example.com" }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected attempt");
      expect(loser.reason).toBeInstanceOf(InvitationsError);
      expect(loser.reason.kind).toBe("invitation_pending");
      const rows = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.email, "race@example.com"));
      expect(rows).toHaveLength(1);
    });

    it("settles two concurrent re-invites of one expired row with exactly one new pending row", async () => {
      const { app, cookie, fake } = await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: INVITEE,
        status: "pending",
        tokenHash: tokenHash("expired-before-the-race"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() - interval '1 second'`,
        deliveryStatus: "sent",
      });

      const results = await Promise.all([
        postJson(app, "/api/invitations/installation", { email: INVITEE_INPUT }, cookie),
        postJson(app, "/api/invitations/installation", { email: INVITEE_INPUT }, cookie),
      ]);
      const statuses = results.map((res) => res.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(1);

      const conflict = results.find((res) => res.status === 409);
      if (conflict === undefined) throw new Error("expected one conflict");
      expect(conflict.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(conflict)).toMatchObject({
        status: 409,
        code: "invitation_pending",
      });

      const rows = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.email, INVITEE));
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.status === "expired")).toHaveLength(1);
      expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
      expect(fake.sent).toHaveLength(1);
    });

    it("records a failed delivery, which never redeems and does not block a fresh invitation", async () => {
      const fake = createFakeTransport();
      const app = makeApp({ smtp: fake.sender });
      await bootstrapAdmin(app);
      const cookie = await adminCookie(app);
      expect((await putJson(app, "/api/settings/smtp", SETTINGS, cookie)).status).toBe(200);

      fake.failWith(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
      const failed = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(failed.status).toBe(502);
      expect(failed.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(failed)).toMatchObject({
        status: 502,
        code: "smtp_unreachable",
        type: "urn:orrery:problem:smtp_unreachable",
      });

      const [row] = await database.db.select().from(invitations);
      if (row === undefined) throw new Error("the failed invitation was not recorded");
      expect(row).toMatchObject({ email: INVITEE, status: "pending", deliveryStatus: "failed" });
      expect(row.deliveryAttemptedAt).not.toBeNull();

      const token = tokenFrom(fake.sent[0]?.text ?? "");
      expect(token).not.toBe("");
      const redeem = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(redeem.status).toBe(400);
      expect(await problemBody(redeem)).toMatchObject({ code: "invitation_invalid" });

      fake.repair();
      const res = await postJson(
        app,
        "/api/invitations/installation",
        { email: INVITEE_INPUT },
        cookie,
      );
      expect(res.status).toBe(201);
      const rows = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.email, INVITEE));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.status === "revoked")).toHaveLength(1);
      const superseded = rows.find((candidate) => candidate.status === "revoked");
      expect(superseded).toMatchObject({ deliveryStatus: "failed", expiredAt: null });
      expect(superseded?.revokedAt).not.toBeNull();
      expect(superseded?.revokedAt?.getTime()).toBeLessThan(superseded?.expiresAt.getTime() ?? 0);
      const live = rows.filter((r) => r.status === "pending");
      expect(live).toHaveLength(1);
      expect(live[0]?.deliveryStatus).toBe("sent");

      const oldToken = await postJson(app, "/api/invitations/installation/registration", {
        token: token ?? "",
        password: INVITEE_PASSWORD,
      });
      expect(oldToken.status).toBe(400);
      const fresh = tokenFrom(fake.sent[1]?.text ?? "");
      expect(fresh).not.toBe("");
      const ok = await postJson(app, "/api/invitations/installation/registration", {
        token: fresh,
        password: INVITEE_PASSWORD,
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        email: INVITEE,
        handle: "member",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });
    });

    it("records requests without the invitation token", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      try {
        const fake = createFakeTransport();
        const log = createLogger("info");
        const app = makeApp({ smtp: fake.sender, log });
        await bootstrapAdmin(app);
        const cookie = await adminCookie(app);
        await putJson(app, "/api/settings/smtp", SETTINGS, cookie);
        await postJson(app, "/api/invitations/installation", { email: INVITEE_INPUT }, cookie);
        const token = tokenFrom(fake.sent[0]?.text ?? "") ?? "";
        expect(token).not.toBe("");
        await postJson(app, "/api/invitations/installation/registration", {
          token,
          password: INVITEE_PASSWORD,
        });

        const captured = lines.join("\n");

        expect(captured).toContain("/api/invitations/installation");
        expect(captured).not.toContain(token);
        expect(captured).not.toContain(INVITEE_PASSWORD);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("registering through an invitation", () => {
    it("registers through the emailed link's POST: one account, one personal workspace, one verified email", async () => {
      const { app, token } = await invitedApp();
      const humansBefore = await database.db.select().from(humans);
      const workspacesBefore = await database.db.select().from(workspaces);

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(SessionResponse.parse(await res.json())).toEqual({
        email: INVITEE,
        handle: "member",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });

      expect(await database.db.select().from(humans)).toHaveLength(humansBefore.length + 1);
      const [human] = await database.db.select().from(humans).where(eq(humans.email, INVITEE));
      expect(human).toMatchObject({ email: INVITEE, isSystemAdministrator: false });
      expect(human?.emailVerifiedAt).not.toBeNull();
      expect(human?.passwordHash).toMatch(/^scrypt\$/);
      expect(human?.passwordHash).not.toContain(INVITEE_PASSWORD);

      expect(await database.db.select().from(workspaces)).toHaveLength(workspacesBefore.length + 1);
      const [workspace] = await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, human?.id ?? ""));
      expect(workspace).toMatchObject({
        kind: "personal",
        personalOwnerHumanId: human?.id,
      });

      const [row] = await database.db.select().from(invitations);
      expect(row).toMatchObject({ email: INVITEE, status: "accepted" });
      expect(row?.acceptedAt).not.toBeNull();

      const login = await postJson(app, "/api/auth/login", {
        email: INVITEE,
        password: INVITEE_PASSWORD,
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .find((c) => c.startsWith("orrery_session="))
        ?.split(";")[0];
      const session = await app.request("/api/auth/session", { headers: { cookie: cookie ?? "" } });
      expect(await session.json()).toEqual({
        email: INVITEE,
        handle: "member",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });
    });

    it("redeems an invitation whose delivery is still unknown", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: INVITEE,
        status: "pending",
        tokenHash: tokenHash("unknown-delivery-redeems"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 hour'`,
      });

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token: "unknown-delivery-redeems",
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        email: INVITEE,
        handle: "member",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });

      const [human] = await database.db.select().from(humans).where(eq(humans.email, INVITEE));
      expect(human?.emailVerifiedAt).not.toBeNull();
      expect(await database.db.select().from(workspaces)).toHaveLength(2);
      const [row] = await database.db.select().from(invitations);
      expect(row).toMatchObject({ status: "accepted", deliveryStatus: null });
    });

    it("changes nothing on a mere link visit: GET never consumes the token", async () => {
      const { app, token } = await invitedApp();

      const page = await app.request(`/register?token=${token}`);
      expect(page.status).toBe(404);
      const apiList = await app.request("/api/invitations/installation");
      expect(apiList.status).toBe(401);
      const apiGet = await app.request("/api/invitations/installation/registration");
      expect(apiGet.status).toBe(404);

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("accepted");
    });

    it("refuses a reused token", async () => {
      const { app, token } = await invitedApp();
      const first = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(first.status).toBe(200);
      const humansAfterFirst = await database.db.select().from(humans);

      const again = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(again.status).toBe(400);
      expect(again.headers.get("content-type")).toBe("application/problem+json");
      expect(await problemBody(again)).toMatchObject({
        status: 400,
        code: "invitation_invalid",
        type: "urn:orrery:problem:invitation_invalid",
      });

      expect(await database.db.select().from(humans)).toHaveLength(humansAfterFirst.length);
    });

    it("refuses a token that was never issued", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token: "never-issued",
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(await problemBody(res)).toMatchObject({ code: "invitation_invalid" });
      expect(await database.db.select().from(humans)).toHaveLength(1);
    });

    it("refuses an expired invitation and accepts one just inside the seven days", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values([
        {
          id: randomUUID(),
          email: INVITEE,
          status: "pending",
          tokenHash: tokenHash("just-expired"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() - interval '1 second'`,
          deliveryStatus: "sent",
        },
        {
          id: randomUUID(),
          email: "still.valid@example.com",
          status: "pending",
          tokenHash: tokenHash("still-valid"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() + make_interval(secs => ${7 * 24 * 60 * 60 - 1})`,
          deliveryStatus: "sent",
        },
      ]);

      const expired = await postJson(app, "/api/invitations/installation/registration", {
        token: "just-expired",
        password: INVITEE_PASSWORD,
      });
      expect(expired.status).toBe(400);
      expect(await problemBody(expired)).toMatchObject({ code: "invitation_invalid" });

      const [expiredRow] = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash("just-expired")));
      expect(expiredRow?.acceptedAt).toBeNull();
      expect(await database.db.select().from(humans)).toHaveLength(1);

      const valid = await postJson(app, "/api/invitations/installation/registration", {
        token: "still-valid",
        password: INVITEE_PASSWORD,
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({
        email: "still.valid@example.com",
        handle: "still-valid",
        displayName: null,
        emailVerified: true,
        avatarUrl: null,
      });
    });

    it("refuses a short password without consuming the invitation", async () => {
      const { app, token } = await invitedApp();

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: "short",
      });
      expect(res.status).toBe(400);
      expect(await problemBody(res)).toMatchObject({ code: "validation_failed" });

      const retry = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(retry.status).toBe(200);
    });

    it("refuses an invited email that already has an account, changing nothing", async () => {
      const app = makeApp();
      await bootstrapAdmin(app);

      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");
      await database.db.insert(invitations).values({
        id: randomUUID(),
        email: EMAIL,
        status: "pending",
        tokenHash: tokenHash("already-registered"),
        invitedByHumanId: admin.id,
        expiresAt: sql`now() + interval '1 hour'`,
        deliveryStatus: "sent",
      });

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token: "already-registered",
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(409);
      expect(await problemBody(res)).toMatchObject({ status: 409, code: "account_exists" });

      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("pending");
      expect(row?.acceptedAt).toBeNull();
      expect(await database.db.select().from(workspaces)).toHaveLength(1);
    });

    it("settles two concurrent redemptions of one token with one winner", async () => {
      const { app, token } = await invitedApp();

      const results = await Promise.allSettled([
        app.request("/api/invitations/installation/registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password: INVITEE_PASSWORD }),
        }),
        app.request("/api/invitations/installation/registration", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, password: INVITEE_PASSWORD }),
        }),
      ]);
      const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 400)).toHaveLength(1);

      const invitedHumans = await database.db
        .select()
        .from(humans)
        .where(eq(humans.email, INVITEE));
      expect(invitedHumans).toHaveLength(1);
      const personal = await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.personalOwnerHumanId, invitedHumans[0]?.id ?? ""));
      expect(personal).toHaveLength(1);
    });

    it("proves registration is invitation-only: no other route creates an account", async () => {
      const { app, token } = await invitedApp();
      const before = await database.db.select().from(humans);

      const garbage = await postJson(app, "/api/invitations/installation/registration", {
        token: "not-a-token",
        password: INVITEE_PASSWORD,
      });
      expect(garbage.status).toBe(400);
      expect(await database.db.select().from(humans)).toHaveLength(before.length);

      const res = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(await database.db.select().from(humans)).toHaveLength(before.length + 1);
    });
  });

  describe("managing installation invitations", () => {
    it("lists every lifecycle state with recipient, inviter, target, grants, timestamps, and separate delivery", async () => {
      const { app, cookie } = await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");

      await database.db.insert(invitations).values([
        {
          id: randomUUID(),
          email: "pending@example.com",
          status: "pending",
          tokenHash: tokenHash("list-pending"),
          invitedByHumanId: admin.id,
          createdAt: sql`now() - interval '1 hour'`,
          expiresAt: sql`now() + interval '1 day'`,
          deliveryStatus: "sent",
          deliveryAttemptedAt: sql`now() - interval '1 minute'`,
        },
        {
          id: randomUUID(),
          email: "accepted@example.com",
          status: "accepted",
          tokenHash: tokenHash("list-accepted"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() + interval '1 day'`,
          acceptedAt: sql`now() - interval '1 minute'`,
          deliveryStatus: "sent",
        },
        {
          id: randomUUID(),
          email: "declined@example.com",
          status: "declined",
          tokenHash: tokenHash("list-declined"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() + interval '1 day'`,
          declinedAt: sql`now() - interval '1 minute'`,
          deliveryStatus: "sent",
        },
        {
          id: randomUUID(),
          email: "expired@example.com",
          status: "expired",
          tokenHash: tokenHash("list-expired"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() - interval '1 day'`,
          expiredAt: sql`now() - interval '1 day'`,
          deliveryStatus: "sent",
        },
        {
          id: randomUUID(),
          email: "revoked@example.com",
          status: "revoked",
          tokenHash: tokenHash("list-revoked"),
          invitedByHumanId: admin.id,
          expiresAt: sql`now() + interval '1 day'`,
          revokedAt: sql`now() - interval '1 minute'`,
          deliveryStatus: "failed",
          deliveryAttemptedAt: sql`now() - interval '2 minutes'`,
        },
      ]);

      const res = await getJson(app, "/api/invitations/installation", cookie);
      expect(res.status).toBe(200);
      const listed = InvitationSummaries.parse(await res.json());
      expect(listed).toHaveLength(5);
      const byEmail = new Map(listed.map((invitation) => [invitation.email, invitation]));
      expect(byEmail.get("pending@example.com")).toMatchObject({
        status: "pending",
        target: { kind: "installation" },
        grants: [{ kind: "installation_account" }],
        invitedBy: { humanId: admin.id, email: EMAIL },
        delivery: { status: "sent", attemptedAt: expect.any(String) },
        acceptedAt: null,
        declinedAt: null,
        expiredAt: null,
        revokedAt: null,
      });
      expect(byEmail.get("accepted@example.com")).toMatchObject({
        status: "accepted",
        acceptedAt: expect.any(String),
      });
      expect(byEmail.get("declined@example.com")).toMatchObject({
        status: "declined",
        declinedAt: expect.any(String),
      });
      expect(byEmail.get("expired@example.com")).toMatchObject({
        status: "expired",
        expiredAt: expect.any(String),
      });
      expect(byEmail.get("revoked@example.com")).toMatchObject({
        status: "revoked",
        revokedAt: expect.any(String),
        delivery: { status: "failed", attemptedAt: expect.any(String) },
      });
    });

    it("reports a due pending invitation as expired, at its deadline, without consuming it", async () => {
      const { app, cookie } = await armedApp();
      const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
      if (admin === undefined) throw new Error("the administrator was not found");
      const id = randomUUID();
      const deadline = new Date(Date.now() - 1_000);
      await database.db.insert(invitations).values({
        id,
        email: INVITEE,
        status: "pending",
        tokenHash: tokenHash("due-pending"),
        invitedByHumanId: admin.id,
        expiresAt: deadline,
        deliveryStatus: "sent",
      });

      const res = await getJson(app, "/api/invitations/installation", cookie);
      const [listed] = InvitationSummaries.parse(await res.json());
      expect(listed).toMatchObject({
        id,
        status: "expired",
        expiredAt: deadline.toISOString(),
      });
      const [row] = await database.db.select().from(invitations).where(eq(invitations.id, id));
      expect(row).toMatchObject({ status: "expired", expiredAt: deadline });
      expect(row?.acceptedAt).toBeNull();
    });

    it("refuses management without a system administrator session", async () => {
      const { app, cookie, fake } = await invitedApp();
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const [invitation] = InvitationSummaries.parse(await list.json());
      if (invitation === undefined) throw new Error("the invitation was not listed");

      const ordinary = await ordinaryCookie();
      const attempts = [
        await getJson(app, "/api/invitations/installation", ordinary),
        await postJson(app, `/api/invitations/installation/${invitation.id}/resend`, {}, ordinary),
        await postJson(app, `/api/invitations/installation/${invitation.id}/revoke`, {}, ordinary),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(403);
        expect(await problemBody(res)).toMatchObject({ code: "not_admin" });
      }
      const anonymous = await getJson(app, "/api/invitations/installation");
      expect(anonymous.status).toBe(401);

      const [row] = await database.db.select().from(invitations);
      expect(row?.status).toBe("pending");
      expect(fake.sent).toHaveLength(1);
    });

    it("revokes a pending invitation, and the old link never registers", async () => {
      const { app, cookie, fake } = await invitedApp();
      const token = tokenFrom(fake.sent[0]?.text ?? "");
      expect(token).not.toBe("");
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const [invitation] = InvitationSummaries.parse(await list.json());
      if (invitation === undefined) throw new Error("the invitation was not listed");

      const revoked = await postJson(
        app,
        `/api/invitations/installation/${invitation.id}/revoke`,
        {},
        cookie,
      );
      expect(revoked.status).toBe(200);
      expect(InvitationSummary.parse(await revoked.json())).toMatchObject({
        id: invitation.id,
        status: "revoked",
        revokedAt: expect.any(String),
      });

      const registration = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(registration.status).toBe(400);
      expect(await problemBody(registration)).toMatchObject({ code: "invitation_invalid" });
      expect(await database.db.select().from(humans)).toHaveLength(1);

      const again = await postJson(
        app,
        `/api/invitations/installation/${invitation.id}/revoke`,
        {},
        cookie,
      );
      expect(again.status).toBe(409);
      expect(await problemBody(again)).toMatchObject({ code: "invitation_not_pending" });
    });

    it("refuses decline when installation invitation delivery failed", async () => {
      const { app, token } = await invitedApp();
      await database.db
        .update(invitations)
        .set({ deliveryStatus: "failed" })
        .where(eq(invitations.tokenHash, tokenHash(token)));
      const decline = await postJson(app, "/api/invitations/installation/decline", { token });
      expect(decline.status).toBe(400);
      expect(await problemBody(decline)).toMatchObject({ code: "invitation_invalid" });
      const [row] = await database.db.select().from(invitations);
      expect(row).toMatchObject({ status: "pending", deliveryStatus: "failed", declinedAt: null });
    });

    it("lets the recipient decline, and the link then never registers", async () => {
      const { app, cookie, fake } = await invitedApp();
      const token = tokenFrom(fake.sent[0]?.text ?? "");
      expect(token).not.toBe("");
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const [invitation] = InvitationSummaries.parse(await list.json());
      if (invitation === undefined) throw new Error("the invitation was not listed");

      const declined = await postJson(app, "/api/invitations/installation/decline", { token });
      expect(declined.status).toBe(204);
      const [row] = await database.db.select().from(invitations);
      expect(row).toMatchObject({ status: "declined" });
      expect(row?.declinedAt).not.toBeNull();

      const again = await postJson(app, "/api/invitations/installation/decline", { token });
      expect(again.status).toBe(400);
      expect(await problemBody(again)).toMatchObject({ code: "invitation_invalid" });
      const registration = await postJson(app, "/api/invitations/installation/registration", {
        token,
        password: INVITEE_PASSWORD,
      });
      expect(registration.status).toBe(400);
      expect(await database.db.select().from(humans)).toHaveLength(1);

      const after = await getJson(app, "/api/invitations/installation", cookie);
      const [declinedRow] = InvitationSummaries.parse(await after.json());
      expect(declinedRow).toMatchObject({
        id: invitation.id,
        status: "declined",
        declinedAt: expect.any(String),
      });
    });

    it("resends a live invitation: the old link dies, history stays, and the deadline is seven fresh days", async () => {
      const { app, cookie, fake } = await invitedApp();
      const oldToken = tokenFrom(fake.sent[0]?.text ?? "");
      expect(oldToken).not.toBe("");
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const [oldInvitation] = InvitationSummaries.parse(await list.json());
      if (oldInvitation === undefined) throw new Error("the invitation was not listed");

      const resend = await postJson(
        app,
        `/api/invitations/installation/${oldInvitation.id}/resend`,
        {},
        cookie,
      );
      expect(resend.status).toBe(200);
      const fresh = InvitationSummary.parse(await resend.json());
      expect(fresh).toMatchObject({
        email: INVITEE,
        status: "pending",
        target: { kind: "installation" },
        delivery: { status: "sent", attemptedAt: expect.any(String) },
        acceptedAt: null,
        declinedAt: null,
        expiredAt: null,
        revokedAt: null,
      });
      expect(fresh.id).not.toBe(oldInvitation.id);
      const [oldRow] = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.id, oldInvitation.id));
      expect(oldRow).toMatchObject({ status: "revoked" });
      expect(oldRow?.revokedAt).not.toBeNull();
      const [freshRow] = await database.db
        .select()
        .from(invitations)
        .where(eq(invitations.id, fresh.id));
      expect(freshRow?.expiresAt.getTime() ?? 0).toBe(
        (freshRow?.createdAt.getTime() ?? 0) + INVITATION_TTL_MS,
      );
      expect(fake.sent).toHaveLength(2);
      const newToken = tokenFrom(fake.sent[1]?.text ?? "");
      expect(newToken).not.toBe(oldToken);

      const oldAttempt = await postJson(app, "/api/invitations/installation/registration", {
        token: oldToken,
        password: INVITEE_PASSWORD,
      });
      expect(oldAttempt.status).toBe(400);
      const newAttempt = await postJson(app, "/api/invitations/installation/registration", {
        token: newToken,
        password: INVITEE_PASSWORD,
      });
      expect(newAttempt.status).toBe(200);

      const after = await getJson(app, "/api/invitations/installation", cookie);
      const history = InvitationSummaries.parse(await after.json());
      expect(history).toHaveLength(2);
      expect(history.find((candidate) => candidate.id === oldInvitation.id)).toMatchObject({
        status: "revoked",
      });
      expect(history.find((candidate) => candidate.id === fresh.id)).toMatchObject({
        status: "accepted",
      });
    });

    it("resends on both sides of the expiry boundary with a fresh seven-day deadline", async () => {
      const { app, cookie, fake } = await armedApp();
      for (const email of ["just-before@example.com", "just-after@example.com"]) {
        const sent = await postJson(app, "/api/invitations/installation", { email }, cookie);
        expect(sent.status).toBe(201);
      }
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const listed = InvitationSummaries.parse(await list.json());
      const before = listed.find((candidate) => candidate.email === "just-before@example.com");
      const after = listed.find((candidate) => candidate.email === "just-after@example.com");
      if (before === undefined || after === undefined) throw new Error("invitations missing");

      await database.db
        .update(invitations)
        .set({ expiresAt: sql`now() + interval '1 second'` })
        .where(eq(invitations.id, before.id));
      await database.db
        .update(invitations)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(invitations.id, after.id));

      const resendBefore = await postJson(
        app,
        `/api/invitations/installation/${before.id}/resend`,
        {},
        cookie,
      );
      expect(resendBefore.status).toBe(200);
      const freshBefore = InvitationSummary.parse(await resendBefore.json());
      const resendAfter = await postJson(
        app,
        `/api/invitations/installation/${after.id}/resend`,
        {},
        cookie,
      );
      expect(resendAfter.status).toBe(200);
      const freshAfter = InvitationSummary.parse(await resendAfter.json());

      const rows = await database.db.select().from(invitations);
      const oldBefore = rows.find((row) => row.id === before.id);
      const oldAfter = rows.find((row) => row.id === after.id);
      expect(oldBefore).toMatchObject({ status: "revoked" });
      expect(oldBefore?.revokedAt).not.toBeNull();
      expect(oldAfter).toMatchObject({ status: "expired" });
      expect(oldAfter?.expiredAt?.getTime()).toBe(oldAfter?.expiresAt.getTime());
      for (const fresh of [freshBefore, freshAfter]) {
        const row = rows.find((candidate) => candidate.id === fresh.id);
        expect(row?.expiresAt.getTime() ?? 0).toBe(
          (row?.createdAt.getTime() ?? 0) + INVITATION_TTL_MS,
        );
        expect(fresh).toMatchObject({ status: "pending" });
      }

      for (const token of fake.sent.slice(0, 2).map((mail) => tokenFrom(mail.text) ?? "")) {
        const oldAttempt = await postJson(app, "/api/invitations/installation/registration", {
          token,
          password: INVITEE_PASSWORD,
        });
        expect(oldAttempt.status).toBe(400);
      }
    });

    it("keeps a failed resend delivery separate from the pending lifecycle", async () => {
      const { app, cookie, fake } = await invitedApp();
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const [invitation] = InvitationSummaries.parse(await list.json());
      if (invitation === undefined) throw new Error("the invitation was not listed");

      fake.failWith(() => codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:25"));
      const failed = await postJson(
        app,
        `/api/invitations/installation/${invitation.id}/resend`,
        {},
        cookie,
      );
      expect(failed.status).toBe(502);
      expect(await problemBody(failed)).toMatchObject({ code: "smtp_unreachable" });

      const after = await getJson(app, "/api/invitations/installation", cookie);
      const history = InvitationSummaries.parse(await after.json());
      expect(history).toHaveLength(2);
      const failedRow = history.find((candidate) => candidate.status === "pending");
      expect(failedRow).toMatchObject({
        status: "pending",
        delivery: { status: "failed", attemptedAt: expect.any(String) },
      });

      fake.repair();
      if (failedRow === undefined) throw new Error("the replacement invitation is missing");
      const retried = await postJson(
        app,
        `/api/invitations/installation/${failedRow.id}/resend`,
        {},
        cookie,
      );
      expect(retried.status).toBe(200);
      expect(InvitationSummary.parse(await retried.json())).toMatchObject({
        status: "pending",
        delivery: { status: "sent" },
      });
    });

    it("refuses to resend or revoke an invitation that is no longer pending or expired", async () => {
      const { app, cookie, fake } = await invitedApp();
      const token = tokenFrom(fake.sent[0]?.text ?? "");
      expect(token).not.toBe("");
      expect(
        (
          await postJson(app, "/api/invitations/installation/registration", {
            token,
            password: INVITEE_PASSWORD,
          })
        ).status,
      ).toBe(200);
      const list = await getJson(app, "/api/invitations/installation", cookie);
      const [invitation] = InvitationSummaries.parse(await list.json());
      if (invitation === undefined) throw new Error("the invitation was not listed");

      for (const action of ["resend", "revoke"]) {
        const res = await postJson(
          app,
          `/api/invitations/installation/${invitation.id}/${action}`,
          {},
          cookie,
        );
        expect(res.status).toBe(409);
        expect(await problemBody(res)).toMatchObject({ code: "invitation_not_pending" });
      }
      const missing = await postJson(
        app,
        `/api/invitations/installation/${randomUUID()}/revoke`,
        {},
        cookie,
      );
      expect(missing.status).toBe(404);
      expect(await problemBody(missing)).toMatchObject({ code: "invitation_not_found" });
    });
  });
});

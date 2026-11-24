import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Problem } from "@orrery/contract";
import type { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browserSessions, humans, instanceSetup, workspaces } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import type { Logger } from "../../platform/log.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { AccountsError, createAccountsService } from "./service.ts";
import { createAccountsFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL_INPUT = "  Admin@Example.COM ";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";

const silentLogger: Logger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.startsWith("orrery_session="));

const problemBody = async (res: Response) => Problem.parse(await res.json());

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

describe("accounts", () => {
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
    setupSecret: string | undefined,
    log: Logger = silentLogger,
    publicUrl = PUBLIC_URL,
  ) {
    return createApp({
      features: [createAccountsFeature({ db: database.db, setupSecret, publicUrl })],
      publicUrl,
      log,
    });
  }

  const setupBody = { secret: SECRET, email: EMAIL_INPUT, password: PASSWORD };

  async function seededAdmin() {
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    if (admin === undefined) throw new Error("the administrator was not created");
    return admin;
  }

  async function waitForLockWait(pattern: string) {
    await expect
      .poll(
        async () => {
          const [row] = await database.sql<{ count: number }[]>`
            select count(*)::int as count
            from pg_stat_activity
            where wait_event_type = 'Lock'
              and query ilike ${`%${pattern}%`}
              and pid <> pg_backend_pid()
          `;
          return row?.count ?? 0;
        },
        { timeout: 5_000, interval: 25 },
      )
      .toBeGreaterThan(0);
  }

  async function bootstrapAdmin(app: Hono) {
    const res = await postJson(app, "/api/setup/admin", setupBody);
    expect(res.status).toBe(201);
  }

  describe("initial setup", () => {
    it("reports setup as incomplete and changes nothing on GETs", async () => {
      const app = makeApp(SECRET);
      const status = await app.request("/api/setup/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ setupComplete: false });

      await app.request("/api/auth/session");
      await app.request("/api/setup/status");
      expect(await database.db.select().from(humans)).toHaveLength(0);
      expect(await database.db.select().from(instanceSetup)).toHaveLength(0);
    });

    it("refuses setup when no deployment secret is configured", async () => {
      const app = makeApp(undefined);
      const res = await postJson(app, "/api/setup/admin", setupBody);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toEqual({
        type: "urn:orrery:problem:setup_unavailable",
        title: "Initial setup is not available. Set BOOTSTRAP_SECRET in the server's environment.",
        status: 403,
        code: "setup_unavailable",
      });
      expect(await database.db.select().from(humans)).toHaveLength(0);
      expect(await database.db.select().from(instanceSetup)).toHaveLength(0);
    });

    it("answers an invalid setup body with a validation_failed Problem per field", async () => {
      const app = makeApp(SECRET);
      const res = await postJson(app, "/api/setup/admin", {
        ...setupBody,
        email: "nope",
        secret: "",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      const body = await problemBody(res);
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.map((e) => e.pointer).toSorted()).toEqual(["/email", "/secret"]);
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    });

    it("refuses an invalid secret without closing setup", async () => {
      const app = makeApp(SECRET);
      const res = await postJson(app, "/api/setup/admin", {
        ...setupBody,
        secret: "not the secret",
      });
      expect(res.status).toBe(401);
      const body = await problemBody(res);
      expect(body).toMatchObject({ code: "invalid_secret", title: "Invalid setup secret." });
      expect(JSON.stringify(body)).not.toContain(PASSWORD);

      const status = await app.request("/api/setup/status");
      expect(await status.json()).toEqual({ setupComplete: false });
      expect(await database.db.select().from(humans)).toHaveLength(0);
    });

    it("refuses an invalid request body", async () => {
      const app = makeApp(SECRET);
      for (const body of [
        { ...setupBody, secret: "" },
        { ...setupBody, password: "short" },
        { ...setupBody, email: "not-an-email" },
      ]) {
        const res = await postJson(app, "/api/setup/admin", body);
        expect(res.status).toBe(400);
      }
      expect(await database.db.select().from(humans)).toHaveLength(0);
    });

    it("creates the administrator, its personal workspace, and closes setup in one transaction", async () => {
      const app = makeApp(SECRET);
      const res = await postJson(app, "/api/setup/admin", setupBody);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ email: EMAIL });

      const [admin] = await database.db.select().from(humans);
      expect(admin).toMatchObject({
        email: EMAIL,
        isSystemAdministrator: true,
        emailVerifiedAt: null,
      });
      expect(admin?.passwordHash).toMatch(/^scrypt\$/);
      expect(admin?.passwordHash).not.toContain(PASSWORD);

      const [workspace] = await database.db.select().from(workspaces);
      expect(workspace).toMatchObject({ kind: "personal", personalOwnerHumanId: admin?.id });

      const [setup] = await database.db.select().from(instanceSetup);
      expect(setup).toMatchObject({ id: true, administratorHumanId: admin?.id });

      const status = await app.request("/api/setup/status");
      expect(await status.json()).toEqual({ setupComplete: true });
    });

    it("refuses a second setup attempt, even with the correct secret", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const res = await postJson(app, "/api/setup/admin", {
        ...setupBody,
        email: "other@example.com",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        status: 409,
        code: "setup_complete",
        title: "Initial setup is already complete.",
      });
      expect(await database.db.select().from(humans)).toHaveLength(1);
    });

    it("settles two concurrent setup attempts with exactly one winner", async () => {
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const results = await Promise.allSettled([
        service.setupAdmin({ secret: SECRET, email: "a@example.com", password: PASSWORD }),
        service.setupAdmin({ secret: SECRET, email: "b@example.com", password: PASSWORD }),
      ]);

      const winners = results.filter((r) => r.status === "fulfilled");
      expect(winners).toHaveLength(1);
      expect(winners[0]?.value.email).toMatch(/^[ab]@example\.com$/);

      const loser = results.find((r) => r.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected attempt");
      expect(loser.reason).toBeInstanceOf(AccountsError);
      expect(loser.reason.kind).toBe("setup_complete");

      expect(await database.db.select().from(humans)).toHaveLength(1);
      expect(await database.db.select().from(workspaces)).toHaveLength(1);
      expect(await database.db.select().from(instanceSetup)).toHaveLength(1);
    });

    it("settles two concurrent same-email attempts with one winner, and the loser learns setup is complete", async () => {
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const results = await Promise.allSettled([
        service.setupAdmin({ secret: SECRET, email: "race@example.com", password: PASSWORD }),
        service.setupAdmin({ secret: SECRET, email: "race@example.com", password: PASSWORD }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((r) => r.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected attempt");

      expect(loser.reason).toBeInstanceOf(AccountsError);
      expect(loser.reason.kind).toBe("setup_complete");
      expect(await database.db.select().from(humans)).toHaveLength(1);
    });
  });

  describe("database constraints", () => {
    it("rejects a human whose email is not normalized", async () => {
      const message = await rejectionMessage(
        database.db.insert(humans).values({
          id: randomUUID(),
          email: "Mixed@Example.com",
          passwordHash: "scrypt$anything",
        }),
      );
      expect(message).toContain("humans_email_normalized");
    });

    it("rejects a workspace kind outside the contract enum", async () => {
      const message = await rejectionMessage(
        database.db.execute(
          sql`insert into workspaces (id, kind, name) values (${randomUUID()}, 'team', 'Nope')`,
        ),
      );
      expect(message).toContain("workspace_kind");
    });

    it("rejects a personal workspace without an owner, and a shared one with an owner", async () => {
      const missingOwner = await rejectionMessage(
        database.db.insert(workspaces).values({ id: randomUUID(), kind: "personal", name: "Nope" }),
      );
      expect(missingOwner).toContain("workspace_owner_matches_kind");

      const [owner] = await database.db
        .insert(humans)
        .values({ id: randomUUID(), email: "owner@example.com", passwordHash: "scrypt$anything" })
        .returning();
      const sharedWithOwner = await rejectionMessage(
        database.db.insert(workspaces).values({
          id: randomUUID(),
          kind: "shared",
          name: "Nope",
          personalOwnerHumanId: owner?.id,
        }),
      );
      expect(sharedWithOwner).toContain("workspace_owner_matches_kind");
    });
  });

  describe("sign-in", () => {
    it("signs in, sets a secure cookie, and answers the session check", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const res = await postJson(app, "/api/auth/login", {
        email: EMAIL_INPUT,
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ email: EMAIL });

      const cookie = sessionCookie(res);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=604800");
      expect(cookie).not.toContain("Secure");

      const withSession = await app.request("/api/auth/session", {
        headers: { cookie: cookie?.split(";")[0] },
      });
      expect(withSession.status).toBe(200);

      expect(await withSession.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: false,
        avatarUrl: null,
      });

      const noSession = await app.request("/api/auth/session");
      expect(noSession.status).toBe(401);

      const garbage = await app.request("/api/auth/session", {
        headers: { cookie: "orrery_session=not-a-real-token" },
      });
      expect(garbage.status).toBe(401);
      expect(await database.db.select().from(browserSessions)).toHaveLength(1);
    });

    it("marks the cookie Secure when the public URL is https", async () => {
      const app = makeApp(SECRET, undefined, "https://orrery.test");
      await bootstrapAdmin(app);
      const res = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      expect(sessionCookie(res)).toContain("Secure");
    });

    it("answers a wrong password and an unknown email identically", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const wrongPassword = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "not-the-password",
      });
      const unknownEmail = await postJson(app, "/api/auth/login", {
        email: "nobody@example.com",
        password: PASSWORD,
      });
      expect(wrongPassword.status).toBe(unknownEmail.status);
      expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("answers a short password like any other wrong password", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const short = await postJson(app, "/api/auth/login", { email: EMAIL, password: "tiny" });
      const wrong = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "not-the-password",
      });
      expect(short.status).toBe(401);
      expect(await short.json()).toEqual(await wrong.json());
      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("answers a malformed email and overlong input like any other wrong credentials", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);

      const wrong = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "not-the-password",
      });
      const expected = await problemBody(wrong);
      const attempts = [
        { email: "not-an-email", password: PASSWORD },
        { email: "x".repeat(2048), password: PASSWORD },
        { email: EMAIL, password: "x".repeat(2048) },
        { email: "  Nobody@Example.COM  ", password: "not-the-password" },
      ];
      for (const body of attempts) {
        const res = await postJson(app, "/api/auth/login", body);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual(expected);
      }
      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("keeps setup closed and sign-in working for a fresh service instance over the same database", async () => {
      const first = makeApp(SECRET);
      await bootstrapAdmin(first);
      const login = await postJson(first, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const cookie = sessionCookie(login)?.split(";")[0];

      const second = makeApp(SECRET);

      const setupAgain = await postJson(second, "/api/setup/admin", setupBody);
      expect(setupAgain.status).toBe(409);
      const status = await second.request("/api/setup/status");
      expect(await status.json()).toEqual({ setupComplete: true });

      const stillSignedIn = await second.request("/api/auth/session", { headers: { cookie } });
      expect(stillSignedIn.status).toBe(200);
      expect(await stillSignedIn.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: false,
        avatarUrl: null,
      });

      const relogin = await postJson(second, "/api/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });
      expect(relogin.status).toBe(200);
    });

    it("updates display name, clears it, and persists across requests", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const cookie = sessionCookie(login)?.split(";")[0] ?? "";

      const unauth = await app.request("/api/account/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Ada" }),
      });
      expect(unauth.status).toBe(401);

      const updated = await app.request("/api/account/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ displayName: "  Ada Lovelace  " }),
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: "Ada Lovelace",
        emailVerified: false,
        avatarUrl: null,
      });

      const session = await app.request("/api/auth/session", { headers: { cookie } });
      expect(await session.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: "Ada Lovelace",
        emailVerified: false,
        avatarUrl: null,
      });

      const cleared = await app.request("/api/account/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ displayName: null }),
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toEqual({
        email: EMAIL,
        handle: "admin",
        displayName: null,
        emailVerified: false,
        avatarUrl: null,
      });
    });

    it("changes password, keeps the current session, and revokes other browser sessions", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const firstLogin = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });
      const secondLogin = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });
      const currentCookie = sessionCookie(firstLogin)?.split(";")[0] ?? "";
      const otherCookie = sessionCookie(secondLogin)?.split(";")[0] ?? "";

      const wrong = await app.request("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: currentCookie },
        body: JSON.stringify({
          currentPassword: "wrong-password-here",
          newPassword: "new-password-1234",
        }),
      });
      expect(wrong.status).toBe(401);
      expect(await problemBody(wrong)).toMatchObject({ code: "invalid_current_password" });

      const ok = await app.request("/api/account/password", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: currentCookie },
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: "new-password-1234",
        }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ changed: true });

      const stillActive = await app.request("/api/auth/session", {
        headers: { cookie: currentCookie },
      });
      expect(stillActive.status).toBe(200);
      const revoked = await app.request("/api/auth/session", {
        headers: { cookie: otherCookie },
      });
      expect(revoked.status).toBe(401);

      const oldLogin = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });
      expect(oldLogin.status).toBe(401);
      const newLogin = await postJson(app, "/api/auth/login", {
        email: EMAIL,
        password: "new-password-1234",
      });
      expect(newLogin.status).toBe(200);
    });

    it("refuses a password change when the presented session is no longer live", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const token = sessionCookie(login)?.split(";")[0]?.split("=")[1] ?? "";
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const admin = await seededAdmin();
      await service.logout(token);

      await expect(
        service.changePassword(admin.id, token, {
          currentPassword: PASSWORD,
          newPassword: "new-password-1234",
        }),
      ).rejects.toMatchObject({ name: "AccountsError", kind: "invalid_current_password" });

      expect(
        (await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD })).status,
      ).toBe(200);
      expect(
        (await postJson(app, "/api/auth/login", { email: EMAIL, password: "new-password-1234" }))
          .status,
      ).toBe(401);
    });

    it("settles two concurrent password changes with exactly one winner", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const token = sessionCookie(login)?.split(";")[0]?.split("=")[1] ?? "";
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const admin = await seededAdmin();

      const passwords = ["new-password-alpha", "new-password-bravo"];
      const results = await Promise.allSettled(
        passwords.map((newPassword) =>
          service.changePassword(admin.id, token, { currentPassword: PASSWORD, newPassword }),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected");
      if (loser?.status !== "rejected") throw new Error("expected one rejected change");
      expect(loser.reason).toBeInstanceOf(AccountsError);
      expect(loser.reason).toMatchObject({ kind: "invalid_current_password" });

      for (const [index, password] of passwords.entries()) {
        const res = await postJson(app, "/api/auth/login", { email: EMAIL, password });
        expect(res.status).toBe(results[index]?.status === "fulfilled" ? 200 : 401);
      }
      expect(
        (await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD })).status,
      ).toBe(401);
    });

    it("refuses a password change when the account is deactivated during hashing", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const token = sessionCookie(login)?.split(";")[0]?.split("=")[1] ?? "";
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const admin = await seededAdmin();
      const hashBefore = admin.passwordHash;

      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = database.sql.begin(async (tx) => {
        await tx`select id from humans where id = ${admin.id} for update`;
        markLocked();
        await gate;
        await tx`update humans set deactivated_at = now() where id = ${admin.id}`;
      });

      let change: Promise<void> | undefined;
      try {
        await locked;
        change = service.changePassword(admin.id, token, {
          currentPassword: PASSWORD,
          newPassword: "new-password-1234",
        });
        await waitForLockWait('%update "humans"%');
        release();
        await holder;
        await expect(change).rejects.toMatchObject({
          name: "AccountsError",
          kind: "invalid_current_password",
        });
      } finally {
        release();
        await holder.catch(() => {});
        if (change !== undefined) await change.catch(() => {});
      }

      const [after] = await database.db.select().from(humans).where(eq(humans.id, admin.id));
      expect(after?.passwordHash).toBe(hashBefore);
      expect(
        (await postJson(app, "/api/auth/login", { email: EMAIL, password: "new-password-1234" }))
          .status,
      ).toBe(401);
    });

    it("refuses to mint a session when the password changes during sign-in", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const admin = await seededAdmin();

      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = database.sql.begin(async (tx) => {
        await tx`select id from humans where id = ${admin.id} for update`;
        markLocked();
        await gate;
        await tx`update humans set password_hash = ${"scrypt$16384$8$1$cmFjZWQtc2FsdA$AA"} where id = ${admin.id}`;
      });

      let attempt: Promise<{ token: string; email: string }> | undefined;
      try {
        await locked;
        attempt = service.login({ email: EMAIL, password: PASSWORD });
        await waitForLockWait('%from "humans"%for update%');
        release();
        await holder;
        await expect(attempt).rejects.toMatchObject({
          name: "AccountsError",
          kind: "invalid_credentials",
        });
      } finally {
        release();
        await holder.catch(() => {});
        if (attempt !== undefined) await attempt.catch(() => {});
      }

      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("refuses to mint a session when the account is deactivated during sign-in", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const service = createAccountsService({
        db: database.db,
        setupSecret: SECRET,
        publicUrl: PUBLIC_URL,
      });
      const admin = await seededAdmin();

      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = database.sql.begin(async (tx) => {
        await tx`select id from humans where id = ${admin.id} for update`;
        markLocked();
        await gate;
        await tx`update humans set deactivated_at = now() where id = ${admin.id}`;
      });

      let attempt: Promise<{ token: string; email: string }> | undefined;
      try {
        await locked;
        attempt = service.login({ email: EMAIL, password: PASSWORD });
        await waitForLockWait('%from "humans"%for update%');
        release();
        await holder;
        await expect(attempt).rejects.toMatchObject({
          name: "AccountsError",
          kind: "invalid_credentials",
        });
      } finally {
        release();
        await holder.catch(() => {});
        if (attempt !== undefined) await attempt.catch(() => {});
      }

      expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    });

    it("signs out by revoking the browser session and clearing the cookie", async () => {
      const app = makeApp(SECRET);
      await bootstrapAdmin(app);
      const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
      const cookie = sessionCookie(login)?.split(";")[0] ?? "";

      const logout = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { cookie },
      });
      expect(logout.status).toBe(200);
      expect(await logout.json()).toEqual({ signedOut: true });
      expect(sessionCookie(logout)).toContain("Max-Age=0");

      const after = await app.request("/api/auth/session", { headers: { cookie } });
      expect(after.status).toBe(401);
    });
  });

  describe("logs", () => {
    it("records requests without the password, the secret, or the session token", async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.join(" "));
      });
      try {
        const log = createLogger("info");
        const app = makeApp(SECRET, log);
        await bootstrapAdmin(app);
        const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
        const token = sessionCookie(login)?.split(";")[0]?.split("=")[1] ?? "";

        const captured = lines.join("\n");

        expect(captured).toContain("/api/setup/admin");
        expect(captured).toContain("/api/auth/login");
        expect(captured).not.toContain(PASSWORD);
        expect(captured).not.toContain(SECRET);
        expect(captured).not.toContain(token);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

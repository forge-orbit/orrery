import { randomBytes, randomUUID } from "node:crypto";
import { AgentKeyValidity, Problem } from "@orrery/contract";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountRecoveryEvents,
  agentApiKeys,
  agents,
  browserSessions,
  humans,
  instanceSetup,
  passwordResetTokens,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  accountByEmail,
  createAccountsService,
  hashPassword,
  invalidateAccountSessions,
  setAccountPasswordHash,
} from "../accounts/index.ts";
import type { OutgoingMail } from "../settings/index.ts";
import {
  PASSWORD_RESET_CONFIRM_MESSAGE,
  PASSWORD_RESET_REQUEST_MESSAGE,
  RecoveryError,
  createRecoveryService,
  type RecoveryService,
} from "./service.ts";
import { createRecoveryFeature } from "./index.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const OTHER_EMAIL = "unverified@example.com";
const PASSWORD = "the-original-password";
const NEW_PASSWORD = "a-brand-new-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (cause: unknown) => cause,
  );
}

function tokenFromMail(mail: OutgoingMail | undefined): string {
  if (mail === undefined) throw new Error("no email was delivered");
  const token = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
  if (token === undefined) throw new Error("the email had no reset token");
  return token;
}

describe("password recovery", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let delivered: OutgoingMail[];
  let service: RecoveryService;

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
      await tx.execute(sql`delete from account_recovery_events`);
      await tx.execute(sql`delete from password_reset_tokens`);
      await tx.execute(sql`delete from agent_key_events`);
      await tx.execute(sql`delete from agent_api_key_projects`);
      await tx.execute(sql`delete from agent_api_keys`);
      await tx.execute(sql`delete from agents`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from workspace_events`);
      await tx.execute(sql`delete from workspace_invitations`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from invitations`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from instance_settings`);
      await tx.execute(sql`delete from email_verification_tokens`);
      await tx.execute(sql`delete from humans`);
    });
  });

  const accounts = () =>
    createAccountsService({ db: database.db, setupSecret: SECRET, publicUrl: PUBLIC_URL });

  function makeService(deliver: (mail: OutgoingMail) => Promise<void>) {
    return createRecoveryService({
      db: database.db,
      accounts: {
        accountByEmail: (email, tx) => accountByEmail(tx ?? database.db, email),
        hashPassword: (password) => hashPassword(password),
        setPasswordHash: (humanId, passwordHash, tx) =>
          setAccountPasswordHash(tx, humanId, passwordHash),
        invalidateBrowserSessions: (humanId, tx) => invalidateAccountSessions(tx, humanId),
      },
      deliver,
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
  }

  beforeEach(() => {
    delivered = [];
    service = makeService(async (mail) => {
      delivered.push(mail);
    });
  });

  async function bootstrap(verified: boolean) {
    await accounts().setupAdmin({ secret: SECRET, email: EMAIL, password: PASSWORD });
    if (verified) {
      await database.db
        .update(humans)
        .set({ emailVerifiedAt: sql`now()` })
        .where(eq(humans.email, EMAIL));
    }
    return (await accountByEmail(database.db, EMAIL))?.humanId ?? "";
  }

  async function createUnverifiedHuman() {
    await database.db.transaction(async (tx) => {
      await accounts().createInvitedHuman({ email: OTHER_EMAIL, password: PASSWORD }, tx);
    });
    return (await accountByEmail(database.db, OTHER_EMAIL))?.humanId ?? "";
  }

  async function insertToken(humanId: string, raw: string, secondsFromNow: number) {
    await database.db.insert(passwordResetTokens).values({
      id: randomUUID(),
      humanId,
      tokenHash: tokenHash(raw),
      expiresAt: sql`now() + make_interval(secs => ${secondsFromNow})`,
    });
  }

  async function tokenFromLastMail(): Promise<string> {
    return tokenFromMail(delivered.at(-1));
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

  async function usedAtOf(raw: string) {
    const [row] = await database.db
      .select({ usedAt: passwordResetTokens.usedAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash(raw)));
    return row === undefined ? undefined : row.usedAt;
  }

  it("mails a single-use link only to a verified address, with one uniform answer", async () => {
    await bootstrap(false);
    await createUnverifiedHuman();
    const unverifiedBefore = await database.db.select().from(passwordResetTokens);
    expect(unverifiedBefore).toHaveLength(0);

    const unknown = await service.requestReset("nobody@example.com");
    const unverified = await service.requestReset(OTHER_EMAIL);
    const adminUnverified = await service.requestReset(EMAIL);
    expect(unknown).toEqual({ message: PASSWORD_RESET_REQUEST_MESSAGE });
    expect(unverified).toEqual(unknown);
    expect(adminUnverified).toEqual(unknown);
    expect(delivered).toHaveLength(0);
    expect(await database.db.select().from(passwordResetTokens)).toHaveLength(0);

    await database.db
      .update(humans)
      .set({ emailVerifiedAt: sql`now()` })
      .where(eq(humans.email, EMAIL));
    const verified = await service.requestReset(EMAIL);
    expect(verified).toEqual(unknown);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe(EMAIL);
    const token = await tokenFromLastMail();

    const rows = await database.db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(tokenHash(token));
    expect(rows[0]?.tokenHash).not.toContain(token);
    expect(rows[0]?.usedAt).toBeNull();

    const events = await database.db.select().from(accountRecoveryEvents);
    expect(events.map((event) => event.type)).toEqual(["password_reset_requested"]);
  });

  it("sends no reset link to a deactivated account, but answers like every other address", async () => {
    await bootstrap(true);
    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`now()` })
      .where(eq(humans.email, EMAIL));

    expect(await service.requestReset(EMAIL)).toEqual({
      message: PASSWORD_RESET_REQUEST_MESSAGE,
    });
    expect(delivered).toHaveLength(0);
    expect(await database.db.select().from(passwordResetTokens)).toHaveLength(0);
    expect(await database.db.select().from(accountRecoveryEvents)).toHaveLength(0);
  });

  it("swallows a broken relay, leaves no redeemable link, and still answers the same", async () => {
    await bootstrap(true);
    const broken = makeService(async () => {
      throw new Error("smtp is broken");
    });
    const answer = await broken.requestReset(EMAIL);
    expect(answer).toEqual({ message: PASSWORD_RESET_REQUEST_MESSAGE });
    expect(await database.db.select().from(passwordResetTokens)).toHaveLength(0);
    expect(await database.db.select().from(accountRecoveryEvents)).toHaveLength(0);
  });

  it("accepts a token just before expiry and rejects one just after, in database time", async () => {
    const humanId = await bootstrap(true);
    const before = randomBytes(32).toString("base64url");
    const after = randomBytes(32).toString("base64url");
    await insertToken(humanId, before, 1);
    await insertToken(humanId, after, -1);

    expect(await service.confirmReset(before, NEW_PASSWORD)).toEqual({
      message: PASSWORD_RESET_CONFIRM_MESSAGE,
    });
    const refused = await rejection(service.confirmReset(after, NEW_PASSWORD));
    expect(refused).toBeInstanceOf(RecoveryError);
    expect(refused).toMatchObject({ kind: "reset_token_invalid" });

    const rows = await database.db.select().from(passwordResetTokens);

    expect(rows.every((row) => row.usedAt !== null)).toBe(true);
  });

  it("refuses a reused or fabricated token and changes the password exactly once", async () => {
    const humanId = await bootstrap(true);
    await service.requestReset(EMAIL);
    const token = await tokenFromLastMail();

    expect((await service.confirmReset(token, NEW_PASSWORD)).message).toBe(
      PASSWORD_RESET_CONFIRM_MESSAGE,
    );
    for (const attempt of [token, randomBytes(32).toString("base64url")]) {
      const refused = await rejection(service.confirmReset(attempt, "another-new-password"));
      expect(refused).toMatchObject({ kind: "reset_token_invalid" });
    }

    expect(await rejection(accounts().login({ email: EMAIL, password: PASSWORD }))).toMatchObject({
      kind: "invalid_credentials",
    });
    expect((await accounts().login({ email: EMAIL, password: NEW_PASSWORD })).email).toBe(EMAIL);

    const events = await database.db.select().from(accountRecoveryEvents);
    expect(events.map((event) => event.type)).toContain("password_reset_completed");
    expect(events.filter((event) => event.type === "password_reset_completed")).toHaveLength(1);
    expect(humanId).not.toBe("");
  });

  it("redeeming one of two pending links revokes the other", async () => {
    await bootstrap(true);
    await service.requestReset(EMAIL);
    await service.requestReset(EMAIL);
    expect(delivered).toHaveLength(2);
    const first = tokenFromMail(delivered[0]);
    const second = tokenFromMail(delivered[1]);
    expect(first).not.toBe(second);

    expect((await service.confirmReset(first, NEW_PASSWORD)).message).toBe(
      PASSWORD_RESET_CONFIRM_MESSAGE,
    );
    const refused = await rejection(service.confirmReset(second, "another-new-password"));
    expect(refused).toMatchObject({ kind: "reset_token_invalid" });
    expect((await accounts().login({ email: EMAIL, password: NEW_PASSWORD })).email).toBe(EMAIL);

    const rows = await database.db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.usedAt !== null)).toBe(true);
  });

  it("settles two concurrent confirmations with different valid tokens without deadlocking", async () => {
    const humanId = await bootstrap(true);
    const first = randomBytes(32).toString("base64url");
    const second = randomBytes(32).toString("base64url");
    await insertToken(humanId, first, 3600);
    await insertToken(humanId, second, 3600);

    const results = await Promise.allSettled([
      service.confirmReset(first, NEW_PASSWORD),
      service.confirmReset(second, "another-new-password"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    if (loser?.status !== "rejected") throw new Error("expected one confirmation to lose");
    expect(loser.reason).toBeInstanceOf(RecoveryError);
    expect(loser.reason).toMatchObject({ kind: "reset_token_invalid" });

    const winningPassword =
      results[0]?.status === "fulfilled" ? NEW_PASSWORD : "another-new-password";
    expect((await accounts().login({ email: EMAIL, password: winningPassword })).email).toBe(EMAIL);

    const rows = await database.db.select().from(passwordResetTokens);
    expect(rows.every((row) => row.usedAt !== null)).toBe(true);
    expect(
      (await database.db.select().from(accountRecoveryEvents)).filter(
        (event) => event.type === "password_reset_completed",
      ),
    ).toHaveLength(1);
  });

  it("locks the human before it redeems the reset token", async () => {
    const humanId = await bootstrap(true);
    const token = randomBytes(32).toString("base64url");
    await insertToken(humanId, token, 3600);

    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = database.sql.begin(async (tx) => {
      await tx`select id from humans where id = ${humanId} for update`;
      markLocked();
      await gate;
    });

    let confirmation: Promise<{ message: string }> | undefined;
    try {
      await locked;
      confirmation = service.confirmReset(token, NEW_PASSWORD);
      await waitForLockWait('%from "humans"%for update%');
      expect(await usedAtOf(token)).toBeNull();
      release();
      await holder;
      await expect(confirmation).resolves.toEqual({ message: PASSWORD_RESET_CONFIRM_MESSAGE });
    } finally {
      release();
      await holder.catch(() => {});
      if (confirmation !== undefined) await confirmation.catch(() => {});
    }

    expect(await usedAtOf(token)).not.toBeNull();
  });

  it("locks the human before local recovery revokes pending reset tokens", async () => {
    const humanId = await bootstrap(true);
    const token = randomBytes(32).toString("base64url");
    await insertToken(humanId, token, 3600);

    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = database.sql.begin(async (tx) => {
      await tx`select id from humans where id = ${humanId} for update`;
      markLocked();
      await gate;
    });

    let recovery: Promise<{ email: string; message: string }> | undefined;
    try {
      await locked;
      recovery = service.localRecover(EMAIL, NEW_PASSWORD);
      await waitForLockWait('%from "humans"%for update%');
      expect(await usedAtOf(token)).toBeNull();
      release();
      await holder;
      await expect(recovery).resolves.toMatchObject({ email: EMAIL });
    } finally {
      release();
      await holder.catch(() => {});
      if (recovery !== undefined) await recovery.catch(() => {});
    }

    expect(await usedAtOf(token)).not.toBeNull();
    expect((await accounts().login({ email: EMAIL, password: NEW_PASSWORD })).email).toBe(EMAIL);
  });

  it("local recovery revokes pending links and is for system administrators only", async () => {
    const adminId = await bootstrap(false);
    const nonAdminId = await createUnverifiedHuman();
    expect((await accountByEmail(database.db, EMAIL))?.isSystemAdministrator).toBe(true);
    expect((await accountByEmail(database.db, OTHER_EMAIL))?.isSystemAdministrator).toBe(false);

    await database.db
      .update(humans)
      .set({ emailVerifiedAt: sql`now()` })
      .where(eq(humans.email, EMAIL));
    await service.requestReset(EMAIL);
    const pending = tokenFromMail(delivered[0]);

    const refused = await rejection(service.localRecover(OTHER_EMAIL, NEW_PASSWORD));
    expect(refused).toMatchObject({ kind: "not_system_administrator" });
    expect((await accounts().login({ email: OTHER_EMAIL, password: PASSWORD })).email).toBe(
      OTHER_EMAIL,
    );
    expect((await database.db.select().from(accountRecoveryEvents)).map((e) => e.type)).toEqual([
      "password_reset_requested",
    ]);

    const broken = makeService(async () => {
      throw new Error("smtp is broken");
    });
    expect((await broken.localRecover(EMAIL, NEW_PASSWORD)).email).toBe(EMAIL);
    expect(delivered).toHaveLength(1);
    const redeemedLater = await rejection(service.confirmReset(pending, "later-password"));
    expect(redeemedLater).toMatchObject({ kind: "reset_token_invalid" });
    expect(
      (await database.db.select().from(passwordResetTokens)).every((r) => r.usedAt !== null),
    ).toBe(true);
    expect((await database.db.select().from(accountRecoveryEvents)).map((e) => e.type)).toEqual([
      "password_reset_requested",
      "local_recovery_completed",
    ]);
    expect(adminId).not.toBe("");
    expect(nonAdminId).not.toBe("");
  });

  it("refuses local recovery for a deactivated administrator", async () => {
    await bootstrap(false);
    await database.db
      .update(humans)
      .set({ deactivatedAt: sql`now()` })
      .where(eq(humans.email, EMAIL));

    const refused = await rejection(service.localRecover(EMAIL, NEW_PASSWORD));
    expect(refused).toBeInstanceOf(RecoveryError);
    expect(refused).toMatchObject({ kind: "account_deactivated" });

    expect(
      await rejection(accounts().login({ email: EMAIL, password: NEW_PASSWORD })),
    ).toMatchObject({ kind: "invalid_credentials" });
    expect(await database.db.select().from(accountRecoveryEvents)).toHaveLength(0);
  });

  it("signs out every prior browser session, leaves other sessions and agent keys alone", async () => {
    const humanId = await bootstrap(true);
    const otherId = await createUnverifiedHuman();
    for (const id of [humanId, humanId, otherId]) {
      await database.db.insert(browserSessions).values({
        id: randomUUID(),
        humanId: id,
        tokenHash: tokenHash(randomBytes(32).toString("base64url")),
        expiresAt: sql`now() + interval '1 hour'`,
      });
    }
    const [agent] = await database.db
      .insert(agents)
      .values({ id: randomUUID(), humanId, name: "worker" })
      .returning();
    const [key] = await database.db
      .insert(agentApiKeys)
      .values({
        id: randomUUID(),
        agentId: agent?.id ?? "",
        workspaceId:
          (
            await database.db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.personalOwnerHumanId, humanId))
              .limit(1)
          )[0]?.id ?? "",
        createdByHumanId: humanId,
        validity: AgentKeyValidity.enum["90"],
        tokenHash: tokenHash("agent-secret-that-must-survive"),
      })
      .returning();

    const [workspace] = await database.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, humanId))
      .limit(1);

    await service.requestReset(EMAIL);
    await service.confirmReset(await tokenFromLastMail(), NEW_PASSWORD);

    const sessions = await database.db.select().from(browserSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.humanId).toBe(otherId);
    expect(workspace?.id).not.toBe("");

    const [afterKey] = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, key?.id ?? ""));
    expect(afterKey).toMatchObject({
      tokenHash: tokenHash("agent-secret-that-must-survive"),
      revokedAt: null,
    });
  });

  it("recovers locally with broken SMTP, even for an unverified address", async () => {
    await bootstrap(false);
    const broken = makeService(async () => {
      throw new Error("smtp is broken");
    });
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: (await accountByEmail(database.db, EMAIL))?.humanId ?? "",
      tokenHash: tokenHash(randomBytes(32).toString("base64url")),
      expiresAt: sql`now() + interval '1 hour'`,
    });

    const result = await broken.localRecover(EMAIL, NEW_PASSWORD);
    expect(result.email).toBe(EMAIL);
    expect(delivered).toHaveLength(0);
    expect(await database.db.select().from(passwordResetTokens)).toHaveLength(0);
    expect(await database.db.select().from(browserSessions)).toHaveLength(0);
    expect((await database.db.select().from(accountRecoveryEvents)).map((e) => e.type)).toEqual([
      "local_recovery_completed",
    ]);
    expect((await accounts().login({ email: EMAIL, password: NEW_PASSWORD })).email).toBe(EMAIL);

    const missing = await rejection(broken.localRecover("nobody@example.com", NEW_PASSWORD));
    expect(missing).toMatchObject({ kind: "account_not_found" });
  });

  it("cannot reopen bootstrap or change workspace ownership", async () => {
    const adminId = await bootstrap(true);
    const memberId = await createUnverifiedHuman();
    const sharedId = randomUUID();

    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id: sharedId, kind: "shared", name: "Team" });
      await tx.insert(workspaceMemberships).values([
        { id: randomUUID(), workspaceId: sharedId, humanId: adminId, isOwner: true },
        { id: randomUUID(), workspaceId: sharedId, humanId: memberId, isOwner: false },
      ]);
    });

    const setupBefore = await database.db.select().from(instanceSetup);
    const workspacesBefore = await database.db.select().from(workspaces);
    const membershipsBefore = await database.db.select().from(workspaceMemberships);

    await service.localRecover(EMAIL, NEW_PASSWORD);

    expect(await database.db.select().from(instanceSetup)).toEqual(setupBefore);
    expect(await database.db.select().from(workspaces)).toEqual(workspacesBefore);
    expect(await database.db.select().from(workspaceMemberships)).toEqual(membershipsBefore);
    expect((await accounts().setupStatus()).setupComplete).toBe(true);

    const secondSetup = await rejection(
      accounts().setupAdmin({ secret: SECRET, email: "second@example.com", password: PASSWORD }),
    );
    expect(secondSetup).toMatchObject({ kind: "setup_complete" });
  });

  it("answers uniform HTTP responses, declares Problems, and never stores or logs secrets", async () => {
    await bootstrap(true);
    await service.requestReset(EMAIL);
    const token = await tokenFromLastMail();
    const logLines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(" "));
    });
    try {
      const app = createApp({
        features: [
          createRecoveryFeature({
            db: database.db,
            accounts: {
              accountByEmail: (email, tx) => accountByEmail(tx ?? database.db, email),
              hashPassword: (password) => hashPassword(password),
              setPasswordHash: (humanId, passwordHash, tx) =>
                setAccountPasswordHash(tx, humanId, passwordHash),
              invalidateBrowserSessions: (humanId, tx) => invalidateAccountSessions(tx, humanId),
            },
            deliver: async (mail) => {
              delivered.push(mail);
            },
            publicUrl: PUBLIC_URL,
          }),
        ],
        publicUrl: PUBLIC_URL,
        log: createLogger("info"),
      });

      const known = await postJson(app, "/api/auth/password-reset/request", { email: EMAIL });
      const unknown = await postJson(app, "/api/auth/password-reset/request", {
        email: "nobody@example.com",
      });
      expect(known.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());

      const bad = await postJson(app, "/api/auth/password-reset/request", { email: "nope" });
      expect(bad.status).toBe(400);
      expect(Problem.parse(await bad.json()).code).toBe("validation_failed");

      const used = await postJson(app, "/api/auth/password-reset/confirm", {
        token,
        password: NEW_PASSWORD,
      });
      expect(used.status).toBe(200);
      const again = await postJson(app, "/api/auth/password-reset/confirm", {
        token,
        password: "yet-another-password",
      });
      expect(again.status).toBe(400);
      expect(Problem.parse(await again.json()).code).toBe("reset_token_invalid");

      const captured = logLines.join("\n");
      expect(captured).toContain("/api/auth/password-reset/confirm");
      expect(captured).not.toContain(token);
      expect(captured).not.toContain(NEW_PASSWORD);
      expect(captured).not.toContain("yet-another-password");
    } finally {
      spy.mockRestore();
    }

    const events = await database.db.select().from(accountRecoveryEvents);
    const stored = JSON.stringify(events);
    expect(Object.keys(events[0] ?? {}).toSorted()).toEqual([
      "actorHumanId",
      "createdAt",
      "humanId",
      "id",
      "type",
    ]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(NEW_PASSWORD);
  });
});

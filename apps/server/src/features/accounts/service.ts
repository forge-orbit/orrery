import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { avatarUrlFor, WorkspaceKind } from "@orrery/contract";
import type {
  ChangePasswordRequest,
  LoginRequest,
  SetupAdminRequest,
  SetupAdminResponse,
  SetupStatus,
  UpdateProfileRequest,
} from "@orrery/contract";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { uniqueConstraintName } from "../../platform/errors.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { browserSessions, humans, instanceSetup, workspaces } from "../../db/schema.ts";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;
const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || saltB64 === undefined || hashB64 === undefined) return false;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashB64, "base64url");
  if (expected.length === 0 || expected.length > 256) return false;
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64url"), expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DUMMY_HASH =
  "scrypt$16384$8$1$b3JyZXJ5LWR1bW15LXNhbHQtMTY$6Awy600SskzLpdZgeUpvnyksgenN_1gvcbM0bdSXr2z1bBJFVDN3J6Zn3op2hfS_fK_UaWrf57BezjLa2V2Cxw";

function secretsEqual(presented: string, configured: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AccountsErrorKind =
  | "setup_unavailable"
  | "invalid_secret"
  | "setup_complete"
  | "invalid_credentials"
  | "invalid_current_password"
  | "handle_taken";

const messages = {
  setup_unavailable:
    "Initial setup is not available. Set BOOTSTRAP_SECRET in the server's environment.",
  invalid_secret: "Invalid setup secret.",
  setup_complete: "Initial setup is already complete.",
  invalid_credentials: "Invalid email or password.",
  invalid_current_password: "Current password is incorrect.",
  handle_taken: "That handle is already in use.",
} as const satisfies Record<AccountsErrorKind, string>;

export class AccountsError extends Error {
  readonly kind: AccountsErrorKind;

  constructor(kind: AccountsErrorKind) {
    super(messages[kind]);
    this.name = "AccountsError";
    this.kind = kind;
  }
}

export function rejectLogin(): AccountsError {
  return new AccountsError("invalid_credentials");
}

type AccountRunner = PostgresJsDatabase | DbTransaction;

export async function accountByEmail(runner: AccountRunner, email: string) {
  const [row] = await runner
    .select({
      humanId: humans.id,
      email: humans.email,
      emailVerifiedAt: humans.emailVerifiedAt,
      isSystemAdministrator: humans.isSystemAdministrator,
      deactivatedAt: humans.deactivatedAt,
    })
    .from(humans)
    .where(eq(humans.email, email))
    .limit(1);
  return row ?? null;
}

export async function setAccountPasswordHash(
  runner: AccountRunner,
  humanId: string,
  passwordHash: string,
) {
  await runner.update(humans).set({ passwordHash }).where(eq(humans.id, humanId));
}

export async function invalidateAccountSessions(runner: AccountRunner, humanId: string) {
  await runner.delete(browserSessions).where(eq(browserSessions.humanId, humanId));
}

/** Mirrors the Postgres handle derivation for callers that supply only an email. */
export function deriveHandleFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length >= 2 ? base.slice(0, 39) : "user";
}

export interface SessionAccount {
  humanId: string;
  email: string;
  handle?: string | undefined;
  displayName?: string | null;
  isSystemAdministrator: boolean;
  emailVerifiedAt: Date | null;
  avatarUrl?: string | null;
}

export const sessionAccountFrom = (row: {
  humanId: string;
  email: string;
  handle?: string | undefined;
  displayName?: string | null;
  isSystemAdministrator: boolean;
  emailVerifiedAt: Date | null;
  avatarObjectId?: string | null;
}): SessionAccount => ({
  humanId: row.humanId,
  email: row.email,
  handle: row.handle,
  displayName: row.displayName ?? null,
  isSystemAdministrator: row.isSystemAdministrator,
  emailVerifiedAt: row.emailVerifiedAt,
  avatarUrl:
    row.avatarObjectId === null || row.avatarObjectId === undefined
      ? null
      : avatarUrlFor(row.humanId, row.avatarObjectId),
});

export interface SessionPolicy {
  maxAgeSeconds: number;
  secure: boolean;
}

export interface AccountsDeps {
  db: PostgresJsDatabase;

  setupSecret: string | undefined;

  publicUrl: string;
}

export interface AccountsService {
  setupStatus(): Promise<SetupStatus>;
  setupAdmin(input: SetupAdminRequest): Promise<SetupAdminResponse>;
  login(input: LoginRequest): Promise<{ token: string; email: string }>;
  logout(token: string): Promise<void>;
  session(token: string): Promise<SessionAccount | null>;
  updateProfile(humanId: string, input: UpdateProfileRequest): Promise<SessionAccount>;
  changePassword(
    humanId: string,
    currentSessionToken: string,
    input: ChangePasswordRequest,
  ): Promise<void>;
  sessionPolicy(): SessionPolicy;

  markEmailVerified(humanId: string, tx: DbTransaction): Promise<void>;

  createInvitedHuman(
    input: { email: string; password: string },
    tx: DbTransaction,
  ): Promise<{ humanId: string; handle: string }>;

  emailRegistered(email: string, tx?: DbTransaction): Promise<boolean>;

  accountByEmail(
    email: string,
    tx?: DbTransaction,
  ): Promise<{
    humanId: string;
    email: string;
    emailVerifiedAt: Date | null;
    isSystemAdministrator: boolean;
    deactivatedAt: Date | null;
  } | null>;
  hashPassword(password: string): Promise<string>;
  setPasswordHash(humanId: string, passwordHash: string, tx: DbTransaction): Promise<void>;
  invalidateBrowserSessions(humanId: string, tx: DbTransaction): Promise<void>;
}

async function insertHumanWithPersonalWorkspace(
  tx: DbTransaction,
  input: { id: string; email: string; passwordHash: string; isSystemAdministrator?: boolean },
) {
  const [inserted] = await tx
    .insert(humans)
    .values({
      id: input.id,
      email: input.email,
      passwordHash: input.passwordHash,

      ...(input.isSystemAdministrator === true ? { isSystemAdministrator: true } : {}),
    })
    .returning({ handle: humans.handle });
  await tx.insert(workspaces).values({
    id: randomUUID(),
    kind: WorkspaceKind.enum.personal,
    name: "Personal",
    personalOwnerHumanId: input.id,
  });
  return inserted?.handle ?? "";
}

export function createAccountsService({
  db,
  setupSecret,
  publicUrl,
}: AccountsDeps): AccountsService {
  const sessionPolicy: SessionPolicy = {
    maxAgeSeconds: SESSION_TTL_SECONDS,
    secure: publicUrl.startsWith("https://"),
  };
  return {
    sessionPolicy: () => sessionPolicy,

    async setupStatus() {
      const rows = await db.select({ id: instanceSetup.id }).from(instanceSetup).limit(1);
      return { setupComplete: rows.length > 0 };
    },

    async setupAdmin(input: SetupAdminRequest) {
      if (setupSecret === undefined) throw new AccountsError("setup_unavailable");
      if (!secretsEqual(input.secret, setupSecret)) throw new AccountsError("invalid_secret");

      const humanId = randomUUID();
      const passwordHash = await hashPassword(input.password);

      try {
        await db.transaction(async (tx) => {
          await insertHumanWithPersonalWorkspace(tx, {
            id: humanId,
            email: input.email,
            passwordHash,
            isSystemAdministrator: true,
          });
          await tx.insert(instanceSetup).values({ id: true, administratorHumanId: humanId });
        });
      } catch (error) {
        const constraint = uniqueConstraintName(error);

        if (constraint === "instance_setup_pkey" || constraint === "humans_email_unique") {
          throw new AccountsError("setup_complete");
        }
        throw error;
      }
      return { email: input.email };
    },

    async login(input: LoginRequest) {
      const [human] = await db
        .select({
          id: humans.id,
          passwordHash: humans.passwordHash,
          deactivatedAt: humans.deactivatedAt,
        })
        .from(humans)
        .where(eq(humans.email, input.email))
        .limit(1);

      if (human === undefined || human.deactivatedAt !== null) {
        await verifyPassword(DUMMY_HASH, input.password);
        throw new AccountsError("invalid_credentials");
      }
      if (!(await verifyPassword(human.passwordHash, input.password))) {
        throw new AccountsError("invalid_credentials");
      }

      const token = randomBytes(32).toString("base64url");
      await db.transaction(async (tx) => {
        // Verification above reads a snapshot. Lock the row and re-check the
        // state that made those credentials valid before minting a session, so
        // a concurrent password change or deactivation cannot leave a live
        // session for credentials that no longer work.
        const [current] = await tx
          .select({ id: humans.id })
          .from(humans)
          .where(
            and(
              eq(humans.id, human.id),
              eq(humans.passwordHash, human.passwordHash),
              isNull(humans.deactivatedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (current === undefined) {
          throw new AccountsError("invalid_credentials");
        }

        await tx.insert(browserSessions).values({
          id: randomUUID(),
          humanId: human.id,
          tokenHash: tokenHash(token),
          expiresAt: sql`now() + make_interval(secs => ${sessionPolicy.maxAgeSeconds})`,
        });
      });
      return { token, email: input.email };
    },

    async logout(token: string) {
      await db.delete(browserSessions).where(eq(browserSessions.tokenHash, tokenHash(token)));
    },

    async session(token: string) {
      const [row] = await db
        .select({
          humanId: humans.id,
          email: humans.email,
          handle: humans.handle,
          displayName: humans.displayName,
          isSystemAdministrator: humans.isSystemAdministrator,
          emailVerifiedAt: humans.emailVerifiedAt,
          avatarObjectId: humans.avatarObjectId,
        })
        .from(browserSessions)
        .innerJoin(humans, eq(humans.id, browserSessions.humanId))
        .where(
          and(
            eq(browserSessions.tokenHash, tokenHash(token)),
            gt(browserSessions.expiresAt, sql`now()`),

            isNull(humans.deactivatedAt),
          ),
        )
        .limit(1);
      return row === undefined
        ? null
        : sessionAccountFrom({ ...row, handle: row.handle ?? undefined });
    },

    async updateProfile(humanId: string, input: UpdateProfileRequest) {
      let row:
        | {
            humanId: string;
            email: string;
            handle: string | null;
            displayName: string | null;
            isSystemAdministrator: boolean;
            emailVerifiedAt: Date | null;
            avatarObjectId: string | null;
          }
        | undefined;
      try {
        [row] = await db
          .update(humans)
          .set({
            displayName: input.displayName,
            ...(input.handle === undefined ? {} : { handle: input.handle }),
          })
          .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
          .returning({
            humanId: humans.id,
            email: humans.email,
            handle: humans.handle,
            displayName: humans.displayName,
            isSystemAdministrator: humans.isSystemAdministrator,
            emailVerifiedAt: humans.emailVerifiedAt,
            avatarObjectId: humans.avatarObjectId,
          });
      } catch (error) {
        if (uniqueConstraintName(error) === "humans_handle_unique") {
          throw new AccountsError("handle_taken");
        }
        throw error;
      }
      if (row === undefined) {
        throw new AccountsError("invalid_credentials");
      }
      return sessionAccountFrom({ ...row, handle: row.handle ?? undefined });
    },

    async changePassword(
      humanId: string,
      currentSessionToken: string,
      input: ChangePasswordRequest,
    ) {
      const [human] = await db
        .select({
          passwordHash: humans.passwordHash,
          deactivatedAt: humans.deactivatedAt,
        })
        .from(humans)
        .where(eq(humans.id, humanId))
        .limit(1);

      if (human === undefined || human.deactivatedAt !== null) {
        throw new AccountsError("invalid_current_password");
      }
      if (!(await verifyPassword(human.passwordHash, input.currentPassword))) {
        throw new AccountsError("invalid_current_password");
      }

      const nextHash = await hashPassword(input.newPassword);
      const currentHash = tokenHash(currentSessionToken);
      await db.transaction(async (tx) => {
        // The password check used a snapshot taken before scrypt ran. Confirm
        // the session the caller presented is still live, then swap the hash
        // only if the account is active and no other password change won first.
        const [session] = await tx
          .select({ id: browserSessions.id })
          .from(browserSessions)
          .where(
            and(
              eq(browserSessions.tokenHash, currentHash),
              eq(browserSessions.humanId, humanId),
              gt(browserSessions.expiresAt, sql`now()`),
            ),
          )
          .limit(1);
        if (session === undefined) {
          throw new AccountsError("invalid_current_password");
        }

        const [updated] = await tx
          .update(humans)
          .set({ passwordHash: nextHash })
          .where(
            and(
              eq(humans.id, humanId),
              isNull(humans.deactivatedAt),
              eq(humans.passwordHash, human.passwordHash),
            ),
          )
          .returning({ id: humans.id });
        if (updated === undefined) {
          throw new AccountsError("invalid_current_password");
        }

        await tx
          .delete(browserSessions)
          .where(
            and(eq(browserSessions.humanId, humanId), ne(browserSessions.tokenHash, currentHash)),
          );
      });
    },

    async markEmailVerified(humanId: string, tx: DbTransaction) {
      await tx
        .update(humans)
        .set({ emailVerifiedAt: sql`now()` })
        .where(eq(humans.id, humanId));
    },

    async createInvitedHuman(input: { email: string; password: string }, tx: DbTransaction) {
      await tx.execute(sql`select pg_advisory_xact_lock(61683815, hashtext(${input.email}))`);
      const humanId = randomUUID();
      const passwordHash = await hashPassword(input.password);
      const handle = await insertHumanWithPersonalWorkspace(tx, {
        id: humanId,
        email: input.email,
        passwordHash,
      });
      return { humanId, handle };
    },

    async emailRegistered(email: string, tx?: DbTransaction) {
      const runner = tx ?? db;
      const rows = await runner
        .select({ id: humans.id })
        .from(humans)
        .where(eq(humans.email, email))
        .limit(1);
      return rows.length > 0;
    },

    async accountByEmail(email: string, tx?: DbTransaction) {
      return accountByEmail(tx ?? db, email);
    },

    async hashPassword(password: string) {
      return hashPassword(password);
    },

    async setPasswordHash(humanId: string, passwordHash: string, tx: DbTransaction) {
      await setAccountPasswordHash(tx, humanId, passwordHash);
    },

    async invalidateBrowserSessions(humanId: string, tx: DbTransaction) {
      await invalidateAccountSessions(tx, humanId);
    },
  };
}

export async function startupWarnings({
  db,
  setupSecret,
}: Pick<AccountsDeps, "db" | "setupSecret">): Promise<string[]> {
  if (setupSecret !== undefined) return [];
  const rows = await db.select({ id: instanceSetup.id }).from(instanceSetup).limit(1);
  return rows.length > 0 ? [] : ["initial setup cannot run until BOOTSTRAP_SECRET is set"];
}

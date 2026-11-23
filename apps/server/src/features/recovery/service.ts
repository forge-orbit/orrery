import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { accountRecoveryEvents, humans, passwordResetTokens } from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { renderEmail, type OutgoingMail } from "../settings/index.ts";

const RESET_TTL_SECONDS = 60 * 60;

export const PASSWORD_RESET_REQUEST_MESSAGE =
  "If that address is eligible, a password reset link has been sent. Check your mailbox.";
export const PASSWORD_RESET_CONFIRM_MESSAGE =
  "Your password has been reset. Sign in with your new password.";
export const LOCAL_RECOVERY_MESSAGE =
  "The password was changed locally. All browser sessions for that account were signed out.";

function resetMail(email: string, token: string, publicUrl: string): OutgoingMail {
  const url = `${publicUrl}/reset-password?token=${token}`;
  return {
    to: email,
    subject: "Reset your Orrery password",
    text: [
      `A password reset was requested for ${email}.`,
      "",
      `Choose a new password: ${url}`,
      "",
      "This link works once and is valid for one hour. Opening it changes nothing; the password is set by the page it opens.",
      "",
      "If you did not ask for this, ignore the email. Your password has not changed.",
    ].join("\n"),
    html: renderEmail({
      preheader: `Reset the password for ${email}.`,
      heading: "Reset your password",
      paragraphs: [
        `A password reset was requested for ${email}. Use the button below to choose a new password.`,
      ],
      action: { label: "Reset password", url },
      footnote:
        "This link works once and expires in 1 hour. If you did not ask for a reset, ignore this email and your password will stay the same.",
    }),
  };
}

export type RecoveryErrorKind =
  | "reset_token_invalid"
  | "account_not_found"
  | "not_system_administrator"
  | "account_deactivated";

const messages = {
  reset_token_invalid: "This password reset link is invalid, expired, or already used.",
  account_not_found: "No account has that email address.",
  not_system_administrator:
    "Local recovery is for system administrators only. An ordinary account recovers by email.",
  account_deactivated: "This account is deactivated and cannot change its password.",
} as const satisfies Record<RecoveryErrorKind, string>;

export class RecoveryError extends Error {
  readonly kind: RecoveryErrorKind;

  constructor(kind: RecoveryErrorKind) {
    super(messages[kind]);
    this.name = "RecoveryError";
    this.kind = kind;
  }
}

export interface RecoveryAccountAccess {
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
  setPassword(humanId: string, password: string, tx: DbTransaction): Promise<void>;
  invalidateBrowserSessions(humanId: string, tx: DbTransaction): Promise<void>;
}

export interface RecoveryDeps {
  db: PostgresJsDatabase;
  accounts: RecoveryAccountAccess;

  deliver: (mail: OutgoingMail) => Promise<void>;
  publicUrl: string;
  log?: Logger;
}

export interface RecoveryService {
  requestReset(email: string): Promise<{ message: string }>;

  confirmReset(token: string, password: string): Promise<{ message: string }>;

  localRecover(email: string, password: string): Promise<{ email: string; message: string }>;
}

async function changePasswordAndSignOut(
  tx: DbTransaction,
  accounts: RecoveryAccountAccess,
  humanId: string,
  password: string,
  type: "password_reset_completed" | "local_recovery_completed",
) {
  await accounts.setPassword(humanId, password, tx);
  await accounts.invalidateBrowserSessions(humanId, tx);
  await tx
    .update(passwordResetTokens)
    .set({ usedAt: sql`now()` })
    .where(and(eq(passwordResetTokens.humanId, humanId), isNull(passwordResetTokens.usedAt)));
  await tx.insert(accountRecoveryEvents).values({ id: randomUUID(), humanId, type });
}

export function createRecoveryService({
  db,
  accounts,
  deliver,
  publicUrl,
  log,
}: RecoveryDeps): RecoveryService {
  return {
    async requestReset(email) {
      const account = await accounts.accountByEmail(email);

      if (account !== null && account.emailVerifiedAt !== null && account.deactivatedAt === null) {
        const token = randomBytes(32).toString("base64url");
        const id = randomUUID();
        await db.insert(passwordResetTokens).values({
          id,
          humanId: account.humanId,
          tokenHash: tokenHash(token),
          expiresAt: sql`now() + make_interval(secs => ${RESET_TTL_SECONDS})`,
        });
        try {
          await deliver(resetMail(account.email, token, publicUrl));
          await db.insert(accountRecoveryEvents).values({
            id: randomUUID(),
            humanId: account.humanId,
            type: "password_reset_requested",
          });
        } catch (error) {
          log?.warn("password reset email failed", errorNameAndCode(error));
          try {
            await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, id));
          } catch (cleanupError) {
            log?.warn("reset token cleanup failed", errorNameAndCode(cleanupError));
          }
        }
      }
      return { message: PASSWORD_RESET_REQUEST_MESSAGE };
    },

    async confirmReset(token, password) {
      await db.transaction(async (tx) => {
        const redeemed = await tx
          .update(passwordResetTokens)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash(token)),
              isNull(passwordResetTokens.usedAt),
              gt(passwordResetTokens.expiresAt, sql`now()`),
            ),
          )
          .returning({ humanId: passwordResetTokens.humanId });
        const [row] = redeemed;
        if (row === undefined) throw new RecoveryError("reset_token_invalid");

        const [account] = await tx
          .select({ deactivatedAt: humans.deactivatedAt })
          .from(humans)
          .where(eq(humans.id, row.humanId))
          .limit(1);
        if (account === undefined || account.deactivatedAt !== null) {
          throw new RecoveryError("account_deactivated");
        }
        await changePasswordAndSignOut(
          tx,
          accounts,
          row.humanId,
          password,
          "password_reset_completed",
        );
      });
      return { message: PASSWORD_RESET_CONFIRM_MESSAGE };
    },

    async localRecover(email, password) {
      const recoveredEmail = await db.transaction(async (tx) => {
        const account = await accounts.accountByEmail(email, tx);
        if (account === null) throw new RecoveryError("account_not_found");

        if (account.deactivatedAt !== null) throw new RecoveryError("account_deactivated");
        if (!account.isSystemAdministrator) {
          throw new RecoveryError("not_system_administrator");
        }
        await changePasswordAndSignOut(
          tx,
          accounts,
          account.humanId,
          password,
          "local_recovery_completed",
        );
        return account.email;
      });
      return { email: recoveredEmail, message: LOCAL_RECOVERY_MESSAGE };
    },
  };
}

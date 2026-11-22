import { randomBytes, randomUUID } from "node:crypto";
import { createTransport } from "nodemailer";
import type { SmtpSecurity, SmtpSettings, SmtpSettingsResponse } from "@orrery/contract";
import type { SessionAccount } from "../accounts/index.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { emailVerificationTokens, instanceSettings } from "../../db/schema.ts";
import { decryptSecret, encryptSecret } from "../../platform/secrets.ts";

export interface SmtpMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export type SmtpSender = (settings: SmtpSettings, mail: SmtpMail) => Promise<void>;

export type SettingsErrorKind =
  | "not_signed_in"
  | "not_admin"
  | "insecure_smtp_credentials"
  | "encryption_key_missing"
  | "smtp_unconfigured"
  | "smtp_password_unreadable"
  | "verification_token_invalid"
  | "smtp_unreachable"
  | "smtp_auth_failed"
  | "smtp_tls_failed"
  | "smtp_send_failed";

export type DeliveryErrorKind = Extract<
  SettingsErrorKind,
  | "smtp_unconfigured"
  | "smtp_password_unreadable"
  | "smtp_unreachable"
  | "smtp_auth_failed"
  | "smtp_tls_failed"
  | "smtp_send_failed"
>;

const deliveryKinds = [
  "smtp_unconfigured",
  "smtp_password_unreadable",
  "smtp_unreachable",
  "smtp_auth_failed",
  "smtp_tls_failed",
  "smtp_send_failed",
] as const satisfies readonly DeliveryErrorKind[];

export function isDeliveryKind(error: SettingsError): error is SettingsError & {
  kind: DeliveryErrorKind;
} {
  return deliveryKinds.some((kind) => kind === error.kind);
}

const messages = {
  not_signed_in: "Not signed in.",
  not_admin: "Only a system administrator can manage installation settings.",
  insecure_smtp_credentials:
    "SMTP security 'none' sends the username and password in clear text. Choose starttls or tls, or save no credentials.",
  encryption_key_missing:
    "No encryption key is configured, so a password cannot be saved. Set ORRERY_ENCRYPTION_KEY on the server and try again.",
  smtp_unconfigured: "SMTP is not configured yet. Save the SMTP settings first.",
  smtp_password_unreadable:
    "The stored SMTP password cannot be read with the server's encryption key. Re-enter the password in the settings.",
  verification_token_invalid: "This verification token is invalid, expired, or already used.",
  smtp_unreachable:
    "Could not reach the SMTP server. Check the host and port, and that the server accepts connections from this Orrery server.",
  smtp_auth_failed: "The SMTP server rejected the username or password. Check them and try again.",
  smtp_tls_failed:
    "The TLS connection failed. Check that the security setting (starttls or tls) matches the server, and that its certificate is valid.",
  smtp_send_failed: "The SMTP server did not accept the message. Check the settings and try again.",
} as const satisfies Record<SettingsErrorKind, string>;

export class SettingsError extends Error {
  readonly kind: SettingsErrorKind;

  constructor(kind: SettingsErrorKind) {
    super(messages[kind]);
    this.name = "SettingsError";
    this.kind = kind;
  }
}

const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

export interface SettingsDeps {
  db: PostgresJsDatabase;

  publicUrl: string;

  encryptionKey: Buffer | undefined;

  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;

  sendMail?: SmtpSender;
  log?: Logger;
}

export interface SettingsService {
  smtp(account: SessionAccount | null): Promise<SmtpSettingsResponse>;
  saveSmtp(account: SessionAccount | null, input: SmtpSettings): Promise<SmtpSettingsResponse>;
  sendTestEmail(account: SessionAccount | null): Promise<{ sentTo: string; message: string }>;
  verifyEmail(
    account: SessionAccount | null,
    input: { token: string },
  ): Promise<{ email: string; emailVerified: true; avatarUrl: string | null }>;

  deliver(mail: OutgoingMail): Promise<void>;
}

interface StoredSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  passwordEncrypted: string | null;
  from: string;
}

function toSettings(row: typeof instanceSettings.$inferSelect): StoredSettings {
  return {
    host: row.smtpHost,
    port: row.smtpPort,
    security: row.smtpSecurity,
    username: row.smtpUsername,
    passwordEncrypted: row.smtpPasswordEncrypted,
    from: row.smtpFrom,
  };
}

function toResponse(stored: StoredSettings): SmtpSettingsResponse {
  return {
    host: stored.host,
    port: stored.port,
    security: stored.security,
    username: stored.username,
    hasPassword: stored.passwordEncrypted !== null,
    from: stored.from,
  };
}

function toSmtpSettings(stored: StoredSettings, password: string | null): SmtpSettings {
  return {
    host: stored.host,
    port: stored.port,
    security: stored.security,
    username: stored.username,
    password,
    from: stored.from,
  };
}

const UNSET_RESPONSE: SmtpSettingsResponse = {
  host: null,
  port: null,
  security: null,
  username: null,
  hasPassword: false,
  from: null,
};

const UNREACHABLE_CODES =
  /ECONNREFUSED|ECONNRESET|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ECONNECTION/;

function deliveryFailureKind(error: unknown): SettingsErrorKind {
  const { code } = errorNameAndCode(error);
  if (code === "EAUTH") return "smtp_auth_failed";
  const message = error instanceof Error ? error.message : "";
  if (UNREACHABLE_CODES.test(message)) return "smtp_unreachable";
  if (code !== undefined && UNREACHABLE_CODES.test(code)) return "smtp_unreachable";

  if (
    (code !== undefined && code.startsWith("ERR_SSL")) ||
    /SSL|TLS|certificate|handshake/i.test(message)
  ) {
    return "smtp_tls_failed";
  }
  return "smtp_send_failed";
}

function verificationEmail(email: string, token: string, publicUrl: string): SmtpMail["text"] {
  const verifyUrl = `${publicUrl}/settings/smtp?token=${encodeURIComponent(token)}`;
  return [
    `Confirm that ${email} belongs to you.`,
    "",
    "Open this link to verify your address (valid for 24 hours):",
    "",
    verifyUrl,
    "",
    "Single-use token, valid for 24 hours:",
    "",
    token,
    "",
    `Opening the link only pre-fills the form — nothing is verified until you click Verify email (or POST the token to ${publicUrl}/api/settings/email-verification).`,
    "",
    "If you did not expect this email, ignore it.",
  ].join("\n");
}

function requireAdministrator(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new SettingsError("not_signed_in");
  if (!account.isSystemAdministrator) throw new SettingsError("not_admin");
  return account;
}

function storedPassword(stored: StoredSettings, key: Buffer | undefined): string | null {
  if (stored.passwordEncrypted === null) return null;
  if (key === undefined) throw new SettingsError("smtp_password_unreadable");
  const password = decryptSecret(key, stored.passwordEncrypted);
  if (password === undefined) throw new SettingsError("smtp_password_unreadable");
  return password;
}

export function createSettingsService({
  db,
  publicUrl,
  encryptionKey,
  markEmailVerified,
  sendMail = sendWithSmtp,
  log,
}: SettingsDeps): SettingsService {
  return {
    async smtp(account) {
      requireAdministrator(account);
      const [row] = await db.select().from(instanceSettings).limit(1);
      return row === undefined ? UNSET_RESPONSE : toResponse(toSettings(row));
    },

    async saveSmtp(account, input) {
      const admin = requireAdministrator(account);

      if (input.security === "none" && (input.username !== null || input.password !== null)) {
        throw new SettingsError("insecure_smtp_credentials");
      }
      if (input.password !== null && encryptionKey === undefined) {
        throw new SettingsError("encryption_key_missing");
      }
      const encrypted =
        input.password === null || encryptionKey === undefined
          ? null
          : encryptSecret(encryptionKey, input.password);
      const stored: StoredSettings = {
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        passwordEncrypted: encrypted,
        from: input.from,
      };
      await db
        .insert(instanceSettings)
        .values({
          id: true,
          smtpHost: stored.host,
          smtpPort: stored.port,
          smtpSecurity: stored.security,
          smtpUsername: stored.username,
          smtpPasswordEncrypted: stored.passwordEncrypted,
          smtpFrom: stored.from,
          updatedAt: sql`now()`,
          updatedByHumanId: admin.humanId,
        })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: {
            smtpHost: stored.host,
            smtpPort: stored.port,
            smtpSecurity: stored.security,
            smtpUsername: stored.username,
            smtpPasswordEncrypted: stored.passwordEncrypted,
            smtpFrom: stored.from,
            updatedAt: sql`now()`,
            updatedByHumanId: admin.humanId,
          },
        });
      return toResponse(stored);
    },

    async sendTestEmail(account) {
      const admin = requireAdministrator(account);
      const [row] = await db.select().from(instanceSettings).limit(1);
      if (row === undefined) throw new SettingsError("smtp_unconfigured");
      const stored = toSettings(row);
      const settings = toSmtpSettings(stored, storedPassword(stored, encryptionKey));

      const token = randomBytes(32).toString("base64url");
      const tokenId = randomUUID();
      await db.insert(emailVerificationTokens).values({
        id: tokenId,
        humanId: admin.humanId,
        tokenHash: tokenHash(token),
        expiresAt: sql`now() + make_interval(secs => ${VERIFICATION_TTL_SECONDS})`,
      });
      const mail: SmtpMail = {
        from: settings.from,
        to: admin.email,
        subject: "Verify your Orrery email",
        text: verificationEmail(admin.email, token, publicUrl),
      };

      try {
        await sendMail(settings, mail);
      } catch (error) {
        log?.warn("test email failed", errorNameAndCode(error));

        try {
          await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.id, tokenId));
        } catch (cleanupError) {
          log?.warn("token cleanup after a failed send failed", errorNameAndCode(cleanupError));
        }
        throw new SettingsError(deliveryFailureKind(error));
      }

      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(61683816, hashtext(${admin.humanId}))`);
        const [stillPresent] = await tx
          .select({ id: emailVerificationTokens.id })
          .from(emailVerificationTokens)
          .where(eq(emailVerificationTokens.id, tokenId))
          .limit(1);
        if (stillPresent === undefined) return;
        await tx
          .delete(emailVerificationTokens)
          .where(
            and(
              eq(emailVerificationTokens.humanId, admin.humanId),
              isNull(emailVerificationTokens.usedAt),
              ne(emailVerificationTokens.id, tokenId),
            ),
          );
      });
      return {
        sentTo: admin.email,
        message:
          "The email contains a single-use token. Redeem it to finish verifying this address.",
      };
    },

    async verifyEmail(account, input) {
      if (account === null) throw new SettingsError("not_signed_in");
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(emailVerificationTokens)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(emailVerificationTokens.tokenHash, tokenHash(input.token)),
              isNull(emailVerificationTokens.usedAt),
              gt(emailVerificationTokens.expiresAt, sql`now()`),
            ),
          )
          .returning({ humanId: emailVerificationTokens.humanId });
        const [row] = rows;
        if (row === undefined || row.humanId !== account.humanId) {
          throw new SettingsError("verification_token_invalid");
        }
        await markEmailVerified(row.humanId, tx);
      });
      return {
        email: account.email,
        emailVerified: true as const,
        avatarUrl: account.avatarUrl ?? null,
      };
    },

    async deliver(mail) {
      const [row] = await db.select().from(instanceSettings).limit(1);
      if (row === undefined) throw new SettingsError("smtp_unconfigured");
      const stored = toSettings(row);
      const settings = toSmtpSettings(stored, storedPassword(stored, encryptionKey));
      try {
        await sendMail(settings, { from: settings.from, ...mail });
      } catch (error) {
        log?.warn("mail delivery failed", errorNameAndCode(error));
        throw new SettingsError(deliveryFailureKind(error));
      }
    },
  };
}

export const sendWithSmtp: SmtpSender = async (settings, mail) => {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,

    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth:
      settings.username === null
        ? undefined
        : { user: settings.username, pass: settings.password ?? "" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: settings.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  } finally {
    transport.close();
  }
};

export async function startupWarnings({
  db,
  encryptionKey,
}: Pick<SettingsDeps, "db" | "encryptionKey">): Promise<string[]> {
  if (encryptionKey !== undefined) return [];
  const [row] = await db
    .select({ passwordEncrypted: instanceSettings.smtpPasswordEncrypted })
    .from(instanceSettings)
    .limit(1);
  return row?.passwordEncrypted != null
    ? ["an SMTP password is stored but ORRERY_ENCRYPTION_KEY is not set, so it cannot be sent"]
    : [];
}

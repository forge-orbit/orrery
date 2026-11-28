import { randomBytes, randomUUID } from "node:crypto";
import { InvitationDelivery, InvitationStatus } from "@orrery/contract";
import type { InstallationInvitation, InvitationSummary, SessionResponse } from "@orrery/contract";
import { and, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode, uniqueConstraintName } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { toSessionResponse, type SessionAccount } from "../accounts/index.ts";
import { renderEmail, type OutgoingMail } from "../settings/index.ts";
import { invitations, humans } from "../../db/schema.ts";
import { canResendInvitation, supersedeTargetForPending } from "./state-machine.ts";

const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const UNKNOWN_DELIVERY_GRACE_SECONDS = 10 * 60;

export type InvitationsErrorKind =
  | "not_signed_in"
  | "not_admin"
  | "account_exists"
  | "invitation_pending"
  | "invitation_invalid"
  | "invitation_not_found"
  | "invitation_not_pending"
  | "inviter_not_authorized";

const messages = {
  not_signed_in: "Not signed in.",
  not_admin: "Only a system administrator can manage installation invitations.",
  account_exists: "This email already has an account.",
  invitation_pending: "An invitation for this email is already pending.",
  invitation_invalid: "This invitation is invalid, expired, or already used.",
  invitation_not_found: "This invitation does not exist.",
  invitation_not_pending: "Only a pending or expired invitation can be changed.",
  inviter_not_authorized:
    "The person who sent this invitation is no longer a system administrator.",
} as const satisfies Record<InvitationsErrorKind, string>;

export class InvitationsError extends Error {
  readonly kind: InvitationsErrorKind;

  constructor(kind: InvitationsErrorKind) {
    super(messages[kind]);
    this.name = "InvitationsError";
    this.kind = kind;
  }
}

function invitationMail(email: string, token: string, publicUrl: string): OutgoingMail {
  const url = `${publicUrl}/register?token=${token}`;
  return {
    to: email,
    subject: "Your Orrery invitation",
    text: [
      `You have been invited to join this Orrery installation as ${email}.`,
      "",
      "Follow the link and choose a password to register:",
      "",
      url,
      "",
      "The link is valid for seven days. Opening it changes nothing; choosing a password completes your registration.",
      "",
      "If you did not expect this invitation, ignore it.",
    ].join("\n"),
    html: renderEmail({
      preheader: `You have been invited to join Orrery as ${email}.`,
      heading: "You're invited to Orrery",
      paragraphs: [
        `You have been invited to join this Orrery installation as ${email}. Choose a password to finish setting up your account.`,
      ],
      action: { label: "Accept invitation", url },
      footnote:
        "This link is valid for 7 days. Opening it changes nothing until you set a password. If you did not expect this invitation, ignore this email.",
    }),
  };
}

function requireAdministrator(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new InvitationsError("not_signed_in");
  if (!account.isSystemAdministrator) throw new InvitationsError("not_admin");
  return account;
}

async function requireActiveAdministratorInTx(tx: DbTransaction, humanId: string): Promise<void> {
  const [row] = await tx
    .select({ isSystemAdministrator: humans.isSystemAdministrator })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .for("share")
    .limit(1);
  if (row === undefined) throw new InvitationsError("not_signed_in");
  if (!row.isSystemAdministrator) throw new InvitationsError("not_admin");
}

async function recordDelivery(db: PostgresJsDatabase, id: string, delivery: InvitationDelivery) {
  await db
    .update(invitations)
    .set({ deliveryStatus: delivery, deliveryAttemptedAt: sql`statement_timestamp()` })
    .where(and(eq(invitations.id, id), eq(invitations.status, InvitationStatus.enum.pending)));
}

async function expireDueInstallationInvitations(db: PostgresJsDatabase) {
  await db
    .update(invitations)
    .set({ status: InvitationStatus.enum.expired, expiredAt: invitations.expiresAt })
    .where(
      and(
        eq(invitations.status, InvitationStatus.enum.pending),
        lte(invitations.expiresAt, sql`statement_timestamp()`),
      ),
    );
}

const summarySelection = {
  id: invitations.id,
  email: invitations.email,
  status: invitations.status,
  invitedByHumanId: invitations.invitedByHumanId,
  invitedByEmail: humans.email,
  createdAt: invitations.createdAt,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  declinedAt: invitations.declinedAt,
  expiredAt: invitations.expiredAt,
  revokedAt: invitations.revokedAt,
  deliveryStatus: invitations.deliveryStatus,
  deliveryAttemptedAt: invitations.deliveryAttemptedAt,
} as const;

interface InstallationSummaryRow {
  id: string;
  email: string;
  status: InvitationStatus;
  invitedByHumanId: string;
  invitedByEmail: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  deliveryStatus: InvitationDelivery | null;
  deliveryAttemptedAt: Date | null;
}

function toInstallationSummary(row: InstallationSummaryRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    target: { kind: "installation" },
    grants: [{ kind: "installation_account" }],
    invitedBy: { humanId: row.invitedByHumanId, email: row.invitedByEmail },
    delivery: {
      status: row.deliveryStatus,
      attemptedAt: row.deliveryAttemptedAt?.toISOString() ?? null,
    },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

async function readInstallationSummary(
  db: PostgresJsDatabase,
  id: string,
): Promise<InvitationSummary> {
  const [row] = await db
    .select(summarySelection)
    .from(invitations)
    .innerJoin(humans, eq(humans.id, invitations.invitedByHumanId))
    .where(eq(invitations.id, id))
    .limit(1);
  if (row === undefined) throw new InvitationsError("invitation_not_found");
  return toInstallationSummary(row);
}

async function sendInstallationInvitation(
  db: PostgresJsDatabase,
  deliver: (mail: OutgoingMail) => Promise<void>,
  log: Logger | undefined,
  input: { id: string; email: string; token: string; publicUrl: string },
) {
  try {
    await deliver(invitationMail(input.email, input.token, input.publicUrl));
  } catch (error) {
    try {
      await recordDelivery(db, input.id, InvitationDelivery.enum.failed);
    } catch (recordingError) {
      log?.warn("failed-delivery recording failed", errorNameAndCode(recordingError));
    }
    throw error;
  }
  await recordDelivery(db, input.id, InvitationDelivery.enum.sent);
}

export interface InvitationsServiceDeps {
  db: PostgresJsDatabase;

  publicUrl: string;

  emailRegistered: (email: string, tx?: DbTransaction) => Promise<boolean>;
  createInvitedHuman: (
    input: { email: string; password: string },
    tx: DbTransaction,
  ) => Promise<{ humanId: string; handle: string }>;
  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;

  deliver: (mail: OutgoingMail) => Promise<void>;
  log?: Logger;
}

export interface InvitationsService {
  inviteInstallation(
    account: SessionAccount | null,
    input: { email: string },
  ): Promise<InstallationInvitation>;
  listInstallation(account: SessionAccount | null): Promise<InvitationSummary[]>;
  resendInstallation(
    account: SessionAccount | null,
    invitationId: string,
  ): Promise<InvitationSummary>;
  revokeInstallation(
    account: SessionAccount | null,
    invitationId: string,
  ): Promise<InvitationSummary>;
  declineInstallation(input: { token: string }): Promise<void>;
  registerInstallation(input: { token: string; password: string }): Promise<SessionResponse>;
}

export function createInvitationsService({
  db,
  publicUrl,
  emailRegistered,
  createInvitedHuman,
  markEmailVerified,
  deliver,
  log,
}: InvitationsServiceDeps): InvitationsService {
  return {
    async inviteInstallation(account, input) {
      const admin = requireAdministrator(account);
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      try {
        await db.transaction(async (tx) => {
          await requireActiveAdministratorInTx(tx, admin.humanId);
          await tx.execute(sql`select pg_advisory_xact_lock(61683815, hashtext(${input.email}))`);

          if (await emailRegistered(input.email, tx)) {
            throw new InvitationsError("account_exists");
          }

          const blocking = await tx
            .select({ id: invitations.id })
            .from(invitations)
            .where(
              and(
                eq(invitations.email, input.email),
                eq(invitations.status, InvitationStatus.enum.pending),
                gt(invitations.expiresAt, sql`now()`),
                or(
                  eq(invitations.deliveryStatus, InvitationDelivery.enum.sent),
                  and(
                    isNull(invitations.deliveryStatus),
                    gte(
                      invitations.createdAt,
                      sql`now() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS})`,
                    ),
                  ),
                ),
              ),
            )
            .limit(1);
          if (blocking.length > 0) throw new InvitationsError("invitation_pending");

          await tx
            .update(invitations)
            .set({
              status: InvitationStatus.enum.expired,
              expiredAt: invitations.expiresAt,
            })
            .where(
              and(
                eq(invitations.email, input.email),
                eq(invitations.status, InvitationStatus.enum.pending),
                lte(invitations.expiresAt, sql`now()`),
              ),
            );
          await tx
            .update(invitations)
            .set({
              status: InvitationStatus.enum.revoked,
              revokedAt: sql`now()`,
            })
            .where(
              and(
                eq(invitations.email, input.email),
                eq(invitations.status, InvitationStatus.enum.pending),
                gt(invitations.expiresAt, sql`now()`),
                or(
                  eq(invitations.deliveryStatus, InvitationDelivery.enum.failed),
                  and(
                    isNull(invitations.deliveryStatus),
                    lt(
                      invitations.createdAt,
                      sql`now() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS})`,
                    ),
                  ),
                ),
              ),
            );
          await tx.insert(invitations).values({
            id,
            email: input.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: admin.humanId,
            expiresAt: sql`now() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
        });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_pending_invitation_per_email") {
          throw new InvitationsError("invitation_pending");
        }
        throw error;
      }

      await sendInstallationInvitation(db, deliver, log, {
        id,
        email: input.email,
        token,
        publicUrl,
      });
      return { email: input.email, status: InvitationStatus.enum.pending };
    },

    async listInstallation(account) {
      requireAdministrator(account);
      await expireDueInstallationInvitations(db);
      const rows = await db
        .select(summarySelection)
        .from(invitations)
        .innerJoin(humans, eq(humans.id, invitations.invitedByHumanId))
        .orderBy(desc(invitations.createdAt), desc(invitations.id));
      return rows.map(toInstallationSummary);
    },

    async resendInstallation(account, invitationId) {
      const admin = requireAdministrator(account);
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      let email: string;
      try {
        email = await db.transaction(async (tx) => {
          await requireActiveAdministratorInTx(tx, admin.humanId);
          const [target] = await tx
            .select({ email: invitations.email })
            .from(invitations)
            .where(eq(invitations.id, invitationId))
            .limit(1);
          if (target === undefined) throw new InvitationsError("invitation_not_found");
          await tx.execute(sql`select pg_advisory_xact_lock(61683815, hashtext(${target.email}))`);

          const [row] = await tx
            .select({
              id: invitations.id,
              email: invitations.email,
              status: invitations.status,
              live: sql<boolean>`${invitations.expiresAt} > statement_timestamp()`,
            })
            .from(invitations)
            .where(eq(invitations.id, invitationId))
            .for("update");
          if (row === undefined) throw new InvitationsError("invitation_not_found");
          if (!canResendInvitation(row.status)) {
            throw new InvitationsError("invitation_not_pending");
          }
          if (await emailRegistered(row.email, tx)) throw new InvitationsError("account_exists");

          if (row.status === InvitationStatus.enum.pending) {
            const superseded = supersedeTargetForPending(row.live);
            await tx
              .update(invitations)
              .set(
                superseded === "revoked"
                  ? {
                      status: InvitationStatus.enum.revoked,
                      revokedAt: sql`statement_timestamp()`,
                    }
                  : {
                      status: InvitationStatus.enum.expired,
                      expiredAt: invitations.expiresAt,
                    },
              )
              .where(eq(invitations.id, invitationId));
          }

          await tx.insert(invitations).values({
            id,
            email: row.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: admin.humanId,
            createdAt: sql`statement_timestamp()`,
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
          return row.email;
        });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_pending_invitation_per_email") {
          throw new InvitationsError("invitation_pending");
        }
        throw error;
      }

      await sendInstallationInvitation(db, deliver, log, {
        id,
        email,
        token,
        publicUrl,
      });
      return readInstallationSummary(db, id);
    },

    async revokeInstallation(account, invitationId) {
      const admin = requireAdministrator(account);
      await expireDueInstallationInvitations(db);
      await db.transaction(async (tx) => {
        await requireActiveAdministratorInTx(tx, admin.humanId);
        const [row] = await tx
          .select({ id: invitations.id, status: invitations.status })
          .from(invitations)
          .where(eq(invitations.id, invitationId))
          .for("update");
        if (row === undefined) throw new InvitationsError("invitation_not_found");
        if (row.status !== InvitationStatus.enum.pending) {
          throw new InvitationsError("invitation_not_pending");
        }
        const revoked = await tx
          .update(invitations)
          .set({
            status: InvitationStatus.enum.revoked,
            revokedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.status, InvitationStatus.enum.pending),
              gt(invitations.expiresAt, sql`statement_timestamp()`),
            ),
          )
          .returning({ id: invitations.id });
        if (revoked.length === 0) throw new InvitationsError("invitation_not_pending");
      });
      return readInstallationSummary(db, invitationId);
    },

    async declineInstallation(input) {
      const declined = await db
        .update(invitations)
        .set({
          status: InvitationStatus.enum.declined,
          declinedAt: sql`statement_timestamp()`,
        })
        .where(
          and(
            eq(invitations.tokenHash, tokenHash(input.token)),
            eq(invitations.status, InvitationStatus.enum.pending),
            gt(invitations.expiresAt, sql`statement_timestamp()`),
            sql`${invitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
          ),
        )
        .returning({ id: invitations.id });
      if (declined.length === 0) throw new InvitationsError("invitation_invalid");
    },

    async registerInstallation(input) {
      const hash = tokenHash(input.token);
      const registered = await db.transaction(async (tx) => {
        const [target] = await tx
          .select({ email: invitations.email })
          .from(invitations)
          .where(eq(invitations.tokenHash, hash))
          .limit(1);
        if (target === undefined) throw new InvitationsError("invitation_invalid");

        await tx.execute(sql`select pg_advisory_xact_lock(61683815, hashtext(${target.email}))`);
        const rows = await tx
          .update(invitations)
          .set({ status: InvitationStatus.enum.accepted, acceptedAt: sql`statement_timestamp()` })
          .where(
            and(
              eq(invitations.tokenHash, hash),
              eq(invitations.status, InvitationStatus.enum.pending),
              gt(invitations.expiresAt, sql`statement_timestamp()`),
              sql`${invitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
            ),
          )
          .returning({ email: invitations.email, invitedByHumanId: invitations.invitedByHumanId });
        const [row] = rows;
        if (row === undefined) throw new InvitationsError("invitation_invalid");

        const [inviter] = await tx
          .select({ isSystemAdministrator: humans.isSystemAdministrator })
          .from(humans)

          .where(and(eq(humans.id, row.invitedByHumanId), isNull(humans.deactivatedAt)))
          .limit(1);
        if (inviter?.isSystemAdministrator !== true) {
          throw new InvitationsError("inviter_not_authorized");
        }

        let handle = "";
        let humanId = "";
        try {
          const created = await createInvitedHuman(
            { email: row.email, password: input.password },
            tx,
          );
          handle = created.handle;
          humanId = created.humanId;
          await markEmailVerified(created.humanId, tx);
        } catch (error) {
          if (uniqueConstraintName(error) === "humans_email_unique") {
            throw new InvitationsError("account_exists");
          }
          throw error;
        }
        return { humanId, email: row.email, handle };
      });
      return toSessionResponse({
        humanId: registered.humanId,
        email: registered.email,
        handle: registered.handle,
        displayName: null,
        emailVerifiedAt: new Date(),
        avatarUrl: null,
      });
    },
  };
}

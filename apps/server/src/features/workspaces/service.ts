import { randomBytes, randomUUID } from "node:crypto";
import {
  avatarUrlFor,
  InvitationDelivery,
  InvitationStatus,
  ProjectAccessLevel,
  WorkspaceKind,
  UpdateWorkspaceMemberRequest,
  workspaceCapabilities,
  type CreateWorkspaceRequest,
  type InvitationSummary,
  type InviteWorkspaceMemberRequest,
  type SessionResponse,
  type Workspace,
  type WorkspaceCapability,
  type WorkspaceInvitation,
  type WorkspaceInvitationPreview,
  type WorkspaceMember,
} from "@orrery/contract";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { errorNameAndCode, uniqueConstraintName } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { toSessionResponse, type SessionAccount } from "../accounts/index.ts";
import { canResendInvitation, supersedeTargetForPending } from "../invitations/index.ts";
import { renderEmail, type OutgoingMail } from "../settings/index.ts";
import {
  humans,
  projectAccessGrants,
  projects,
  workspaceEvents,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
  type WorkspaceEventType,
} from "../../db/schema.ts";

const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const UNKNOWN_DELIVERY_GRACE_SECONDS = 10 * 60;

export type WorkspacesErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "not_workspace_owner"
  | "inviter_unverified"
  | "inviter_not_authorized"
  | "invitation_invalid"
  | "invitation_recipient_mismatch"
  | "email_unverified"
  | "invitation_pending"
  | "invitation_not_found"
  | "invitation_not_pending"
  | "invitation_scope_invalid"
  | "already_member"
  | "account_exists"
  | "member_not_found"
  | "last_owner"
  | "workspace_owner_capability"
  | "account_deactivated"
  | "ownerless_workspace";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  not_workspace_owner: "Only a workspace owner or an authorized delegate can do that.",
  inviter_unverified: "Verify your own email before inviting someone to a workspace.",
  inviter_not_authorized:
    "The person who sent this invitation can no longer invite to this workspace.",
  invitation_invalid: "This workspace invitation is invalid, expired, or already used.",
  invitation_recipient_mismatch: "This invitation was sent to a different email address.",
  email_unverified: "Verify this account's email before accepting the invitation.",
  invitation_pending: "An invitation for this email is already pending in this workspace.",
  invitation_not_found: "This workspace invitation does not exist.",
  invitation_not_pending: "Only a pending or expired invitation can be changed.",
  invitation_scope_invalid:
    "This invitation offers a project that no longer belongs to this workspace.",
  already_member: "This person is already a member of the workspace.",
  account_exists: "This email already has an account. Sign in to accept the invitation.",
  member_not_found: "This person is not a member of the workspace.",
  last_owner: "A workspace must keep at least one owner.",
  workspace_owner_capability: "Workspace owners always hold every capability.",
  account_deactivated: "This account is deactivated and cannot join a workspace.",
  ownerless_workspace:
    "This workspace has no active owner. Ownership recovery must happen before it can accept members.",
} as const satisfies Record<WorkspacesErrorKind, string>;

export class WorkspacesError extends Error {
  readonly kind: WorkspacesErrorKind;

  constructor(kind: WorkspacesErrorKind) {
    super(messages[kind]);
    this.name = "WorkspacesError";
    this.kind = kind;
  }
}

function invitationMail(
  workspaceName: string,
  email: string,
  token: string,
  publicUrl: string,
): OutgoingMail {
  const url = `${publicUrl}/workspace-invitation?token=${token}`;
  return {
    to: email,
    subject: "Your Orrery workspace invitation",
    text: [
      `You have been invited to join the workspace "${workspaceName}" on Orrery as ${email}.`,
      "",
      "Follow the link to see the invitation:",
      "",
      url,
      "",
      "If you already have an Orrery account, sign in with this address and accept.",
      "If you are new, choose a password there to create your account, personal workspace, and membership.",
      "",
      "The link is valid for seven days. Opening it changes nothing.",
      "",
      "If you did not expect this invitation, ignore it.",
    ].join("\n"),
    html: renderEmail({
      preheader: `Join "${workspaceName}" on Orrery as ${email}.`,
      heading: `Join "${workspaceName}" on Orrery`,
      paragraphs: [
        `You have been invited to join the "${workspaceName}" workspace as ${email}.`,
        "If you already have an Orrery account, sign in to accept. If you're new, you can create your account from the invitation page.",
      ],
      action: { label: "View invitation", url },
      footnote:
        "This link is valid for 7 days. Opening it changes nothing until you accept. If you did not expect this invitation, ignore this email.",
    }),
  };
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new WorkspacesError("not_signed_in");
  return account;
}

async function recordEvent(
  tx: DbTransaction,
  type: WorkspaceEventType,
  workspaceId: string,
  actorHumanId: string,
  subjectHumanId: string,
) {
  await tx.insert(workspaceEvents).values({
    id: randomUUID(),
    workspaceId,
    type,
    actorHumanId,
    subjectHumanId,
  });
}

async function readSharedWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  missingKind: "workspace_not_found" | "invitation_invalid" = "workspace_not_found",
) {
  const [workspace] = await tx
    .select({ id: workspaces.id, kind: workspaces.kind, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (workspace === undefined || workspace.kind !== WorkspaceKind.enum.shared) {
    throw new WorkspacesError(missingKind);
  }
  return workspace;
}

async function lockOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function lockWorkspaceForMutation(
  tx: DbTransaction,
  workspaceId: string,
  missingKind: "workspace_not_found" | "invitation_invalid" = "workspace_not_found",
) {
  await lockOwnershipWrites(tx);
  const workspace = await readSharedWorkspace(tx, workspaceId, missingKind);
  await tx
    .insert(workspaceOwnershipGuards)
    .values({ workspaceId, version: 0 })
    .onConflictDoUpdate({
      target: workspaceOwnershipGuards.workspaceId,
      set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
    });
  return workspace;
}

interface WorkspaceMembershipRow {
  humanId: string;
  email: string;
  avatarObjectId: string | null;
  isOwner: boolean;
  canCreateProjects: boolean;
  canInviteMembers: boolean;
  canRemoveMembers: boolean;
  canManageMemberPermissions: boolean;
  emailVerifiedAt: Date | null;
}

async function readMembership(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  missingKind: "workspace_not_found" | "member_not_found" | "inviter_not_authorized",
): Promise<WorkspaceMembershipRow> {
  const [membership] = await tx
    .select({
      humanId: workspaceMemberships.humanId,
      email: humans.email,
      avatarObjectId: humans.avatarObjectId,
      isOwner: workspaceMemberships.isOwner,
      canCreateProjects: workspaceMemberships.canCreateProjects,
      canInviteMembers: workspaceMemberships.canInviteMembers,
      canRemoveMembers: workspaceMemberships.canRemoveMembers,
      canManageMemberPermissions: workspaceMemberships.canManageMemberPermissions,
      emailVerifiedAt: humans.emailVerifiedAt,
    })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),

        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  if (membership === undefined) throw new WorkspacesError(missingKind);
  return membership;
}

async function requireOwner(tx: DbTransaction, workspaceId: string, humanId: string) {
  const membership = await readMembership(tx, workspaceId, humanId, "workspace_not_found");
  if (!membership.isOwner) throw new WorkspacesError("not_workspace_owner");
}

async function requireInviter(tx: DbTransaction, workspaceId: string, humanId: string) {
  const inviter = await readMembership(tx, workspaceId, humanId, "workspace_not_found");
  if (!inviter.isOwner && !inviter.canInviteMembers) {
    throw new WorkspacesError("not_workspace_owner");
  }
  return inviter;
}

const capabilityEvents: Record<
  WorkspaceCapability,
  { granted: WorkspaceEventType; revoked: WorkspaceEventType }
> = {
  canCreateProjects: {
    granted: "create_projects_granted",
    revoked: "create_projects_revoked",
  },
  canInviteMembers: { granted: "invite_members_granted", revoked: "invite_members_revoked" },
  canRemoveMembers: { granted: "remove_members_granted", revoked: "remove_members_revoked" },
  canManageMemberPermissions: {
    granted: "manage_member_permissions_granted",
    revoked: "manage_member_permissions_revoked",
  },
};

async function requireProjectManageScope(
  tx: DbTransaction,
  workspaceId: string,
  actor: WorkspaceMembershipRow,
  offered: readonly { projectId: string }[],
  deniedKind: "not_workspace_owner" | "inviter_not_authorized",
) {
  if (actor.isOwner || offered.length === 0) return;
  const ids = [...new Set(offered.map((grant) => grant.projectId))];
  const rows = await tx
    .select({ projectId: projectAccessGrants.projectId })
    .from(projectAccessGrants)
    .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
    .where(
      and(
        eq(projectAccessGrants.humanId, actor.humanId),
        eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage),
        eq(projects.workspaceId, workspaceId),
        inArray(projectAccessGrants.projectId, ids),
      ),
    );
  const managed = new Set(rows.map((row) => row.projectId));
  if (ids.some((id) => !managed.has(id))) throw new WorkspacesError(deniedKind);
}

async function requireVerifiedInviter(tx: DbTransaction, humanId: string) {
  const [inviter] = await tx
    .select({ emailVerifiedAt: humans.emailVerifiedAt })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .limit(1);
  if (inviter?.emailVerifiedAt == null) {
    throw new WorkspacesError("inviter_unverified");
  }
}

async function requireInviterStillAuthorized(
  tx: DbTransaction,
  workspaceId: string,
  inviterHumanId: string,
  offered: readonly { projectId: string }[],
) {
  const inviter = await readMembership(tx, workspaceId, inviterHumanId, "inviter_not_authorized");
  if (inviter.emailVerifiedAt === null) throw new WorkspacesError("inviter_not_authorized");
  if (!inviter.isOwner && !inviter.canInviteMembers) {
    throw new WorkspacesError("inviter_not_authorized");
  }
  await requireProjectManageScope(tx, workspaceId, inviter, offered, "inviter_not_authorized");
}

async function loadManagedProjectIds(tx: DbTransaction, workspaceId: string, humanId: string) {
  const rows = await tx
    .select({ projectId: projectAccessGrants.projectId })
    .from(projectAccessGrants)
    .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
    .where(
      and(
        eq(projectAccessGrants.humanId, humanId),
        eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage),
        eq(projects.workspaceId, workspaceId),
      ),
    );
  return new Set(rows.map((row) => row.projectId));
}

async function inviterStillAuthorized(
  tx: DbTransaction,
  workspaceId: string,
  inviterHumanId: string,
  offered: readonly { projectId: string }[],
) {
  const [inviter] = await tx
    .select({
      isOwner: workspaceMemberships.isOwner,
      canInviteMembers: workspaceMemberships.canInviteMembers,
      emailVerifiedAt: humans.emailVerifiedAt,
    })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, inviterHumanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  if (
    inviter === undefined ||
    inviter.emailVerifiedAt === null ||
    (!inviter.isOwner && !inviter.canInviteMembers)
  ) {
    return false;
  }

  if (!(await offeredProjectsInWorkspace(tx, workspaceId, offered))) return false;
  if (inviter.isOwner) return true;
  const managed = await loadManagedProjectIds(tx, workspaceId, inviterHumanId);
  return offered.every((grant) => managed.has(grant.projectId));
}

function toWorkspace(row: {
  id: string;
  kind: Workspace["kind"];
  name: string;
  membershipIsOwner: boolean | null;
  membershipCanCreateProjects: boolean | null;
  membershipCanInviteMembers: boolean | null;
  membershipCanRemoveMembers: boolean | null;
  membershipCanManageMemberPermissions: boolean | null;
}): Workspace {
  const isOwner = row.kind === WorkspaceKind.enum.personal || row.membershipIsOwner === true;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isOwner,
    canCreateProjects: isOwner || row.membershipCanCreateProjects === true,
    canInviteMembers: isOwner || row.membershipCanInviteMembers === true,
    canRemoveMembers: isOwner || row.membershipCanRemoveMembers === true,
    canManageMemberPermissions: isOwner || row.membershipCanManageMemberPermissions === true,
  };
}

function toMember(row: WorkspaceMembershipRow): WorkspaceMember {
  return {
    humanId: row.humanId,
    email: row.email,
    avatarUrl: row.avatarObjectId === null ? null : avatarUrlFor(row.humanId, row.avatarObjectId),
    isOwner: row.isOwner,
    canCreateProjects: row.isOwner || row.canCreateProjects,
    canInviteMembers: row.isOwner || row.canInviteMembers,
    canRemoveMembers: row.isOwner || row.canRemoveMembers,
    canManageMemberPermissions: row.isOwner || row.canManageMemberPermissions,
  };
}

interface OfferedProjectGrant {
  projectId: string;
  projectName: string | null;
  level: ProjectAccessLevel;
}

const summarySelection = {
  id: workspaceInvitations.id,
  workspaceId: workspaceInvitations.workspaceId,
  workspaceName: workspaces.name,
  email: workspaceInvitations.email,
  status: workspaceInvitations.status,
  invitedByHumanId: workspaceInvitations.invitedByHumanId,
  invitedByEmail: humans.email,
  createdAt: workspaceInvitations.createdAt,
  expiresAt: workspaceInvitations.expiresAt,
  acceptedAt: workspaceInvitations.acceptedAt,
  declinedAt: workspaceInvitations.declinedAt,
  expiredAt: workspaceInvitations.expiredAt,
  revokedAt: workspaceInvitations.revokedAt,
  deliveryStatus: workspaceInvitations.deliveryStatus,
  deliveryAttemptedAt: workspaceInvitations.deliveryAttemptedAt,
} as const;

interface WorkspaceSummaryRow {
  id: string;
  workspaceId: string;
  workspaceName: string;
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

async function loadOfferedProjectGrants(
  db: PostgresJsDatabase | DbTransaction,
  workspaceId: string,
  invitationIds: readonly string[],
): Promise<Map<string, OfferedProjectGrant[]>> {
  const byInvitation = new Map<string, OfferedProjectGrant[]>();
  if (invitationIds.length === 0) return byInvitation;
  const rows = await db
    .select({
      invitationId: workspaceInvitationGrants.invitationId,
      projectId: workspaceInvitationGrants.projectId,
      projectName: projects.name,
      level: workspaceInvitationGrants.level,
    })
    .from(workspaceInvitationGrants)
    .leftJoin(
      projects,
      and(
        eq(projects.id, workspaceInvitationGrants.projectId),
        eq(projects.workspaceId, workspaceId),
      ),
    )
    .where(inArray(workspaceInvitationGrants.invitationId, [...invitationIds]));
  for (const row of rows) {
    const grants = byInvitation.get(row.invitationId) ?? [];
    grants.push({
      projectId: row.projectId,
      projectName: row.projectName,
      level: ProjectAccessLevel.parse(row.level),
    });
    byInvitation.set(row.invitationId, grants);
  }
  return byInvitation;
}

function toWorkspaceSummary(
  row: WorkspaceSummaryRow,
  projectGrants: readonly OfferedProjectGrant[],
): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    target: { kind: "workspace", id: row.workspaceId, name: row.workspaceName },
    grants: [
      {
        kind: "workspace_membership",
        workspaceId: row.workspaceId,
        role: "member",
      },
      ...projectGrants.map((grant) => ({
        kind: "project_access" as const,
        projectId: grant.projectId,
        projectName: grant.projectName,
        level: grant.level,
      })),
    ],
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

async function readWorkspaceInvitationSummary(
  db: PostgresJsDatabase,
  workspaceId: string,
  invitationId: string,
): Promise<InvitationSummary> {
  const [row] = await db
    .select(summarySelection)
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .innerJoin(humans, eq(humans.id, workspaceInvitations.invitedByHumanId))
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.id, invitationId),
      ),
    )
    .limit(1);
  if (row === undefined) throw new WorkspacesError("invitation_not_found");
  const grants = await loadOfferedProjectGrants(db, workspaceId, [invitationId]);
  return toWorkspaceSummary(row, grants.get(invitationId) ?? []);
}

async function offeredProjectsInWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  offered: readonly { projectId: string }[],
): Promise<boolean> {
  const ids = [...new Set(offered.map((grant) => grant.projectId))];
  if (ids.length === 0) return true;
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.id, ids)));
  return rows.length === ids.length;
}

async function requireOfferedProjectsInWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  offered: readonly { projectId: string }[],
) {
  if (!(await offeredProjectsInWorkspace(tx, workspaceId, offered))) {
    throw new WorkspacesError("invitation_scope_invalid");
  }
}

export interface WorkspacesDeps {
  db: PostgresJsDatabase;

  publicUrl: string;

  createInvitedHuman: (
    input: { email: string; password: string },
    tx: DbTransaction,
  ) => Promise<{ humanId: string; handle: string }>;
  markEmailVerified: (humanId: string, tx: DbTransaction) => Promise<void>;

  deliver: (mail: OutgoingMail) => Promise<void>;

  revokeMemberProjectAccess: (
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ) => Promise<void>;

  revokeMemberWorkspaceKeys: (
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ) => Promise<void>;

  releaseMemberWorkSessions: (
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
  ) => Promise<void>;

  applyInvitationGrants: (
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    grantedByHumanId: string,
    offered: readonly { projectId: string; level: ProjectAccessLevel }[],
  ) => Promise<string[]>;
  log?: Logger;
}

export interface WorkspacesService {
  list(account: SessionAccount | null): Promise<Workspace[]>;
  get(account: SessionAccount | null, workspaceId: string): Promise<Workspace>;
  members(account: SessionAccount | null, workspaceId: string): Promise<WorkspaceMember[]>;
  create(account: SessionAccount | null, input: CreateWorkspaceRequest): Promise<Workspace>;
  invite(
    account: SessionAccount | null,
    workspaceId: string,
    input: InviteWorkspaceMemberRequest,
  ): Promise<WorkspaceInvitation>;
  invitations(account: SessionAccount | null, workspaceId: string): Promise<InvitationSummary[]>;
  resendInvitation(
    account: SessionAccount | null,
    workspaceId: string,
    invitationId: string,
  ): Promise<InvitationSummary>;
  revokeInvitation(
    account: SessionAccount | null,
    workspaceId: string,
    invitationId: string,
  ): Promise<InvitationSummary>;
  declineInvitation(input: { token: string }): Promise<void>;
  previewInvitation(token: string): Promise<WorkspaceInvitationPreview>;
  acceptInvitation(account: SessionAccount | null, token: string): Promise<Workspace>;
  registerThroughInvitation(input: { token: string; password: string }): Promise<SessionResponse>;
  appointOwner(
    account: SessionAccount | null,
    workspaceId: string,
    humanId: string,
  ): Promise<WorkspaceMember>;
  updateMemberCapability(
    account: SessionAccount | null,
    workspaceId: string,
    humanId: string,
    input: UpdateWorkspaceMemberRequest,
  ): Promise<WorkspaceMember>;
  removeMember(account: SessionAccount | null, workspaceId: string, humanId: string): Promise<void>;

  leaveWorkspace(account: SessionAccount | null, workspaceId: string): Promise<void>;
}

async function recordDelivery(db: PostgresJsDatabase, id: string, delivery: InvitationDelivery) {
  await db
    .update(workspaceInvitations)
    .set({ deliveryStatus: delivery, deliveryAttemptedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(workspaceInvitations.id, id),
        eq(workspaceInvitations.status, InvitationStatus.enum.pending),
      ),
    );
}

async function deliverWorkspaceInvitation(
  db: PostgresJsDatabase,
  deliver: (mail: OutgoingMail) => Promise<void>,
  log: Logger | undefined,
  input: {
    id: string;
    workspaceName: string;
    email: string;
    token: string;
    publicUrl: string;
  },
) {
  try {
    await deliver(invitationMail(input.workspaceName, input.email, input.token, input.publicUrl));
  } catch (error) {
    try {
      await recordDelivery(db, input.id, InvitationDelivery.enum.failed);
    } catch (recordingError) {
      log?.warn(
        "failed workspace invitation delivery recording failed",
        errorNameAndCode(recordingError),
      );
    }
    throw error;
  }
  await recordDelivery(db, input.id, InvitationDelivery.enum.sent);
}

async function redeemWorkspaceInvitation(tx: DbTransaction, token: string) {
  const [located] = await tx
    .select({ workspaceId: workspaceInvitations.workspaceId })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.tokenHash, tokenHash(token)))
    .limit(1);
  if (located === undefined) throw new WorkspacesError("invitation_invalid");

  const workspace = await lockWorkspaceForMutation(tx, located.workspaceId, "invitation_invalid");

  const [locked] = await tx
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.tokenHash, tokenHash(token)),
        eq(workspaceInvitations.workspaceId, located.workspaceId),
      ),
    )
    .for("update");
  if (locked === undefined) throw new WorkspacesError("invitation_invalid");

  const [invitation] = await tx
    .update(workspaceInvitations)
    .set({ status: InvitationStatus.enum.accepted, acceptedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(workspaceInvitations.tokenHash, tokenHash(token)),
        eq(workspaceInvitations.workspaceId, located.workspaceId),
        eq(workspaceInvitations.status, InvitationStatus.enum.pending),
        gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
        sql`${workspaceInvitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
      ),
    )
    .returning({
      id: workspaceInvitations.id,
      workspaceId: workspaceInvitations.workspaceId,
      email: workspaceInvitations.email,
      invitedByHumanId: workspaceInvitations.invitedByHumanId,
    });
  if (invitation === undefined) throw new WorkspacesError("invitation_invalid");

  const offered = await tx
    .select({
      projectId: workspaceInvitationGrants.projectId,
      level: workspaceInvitationGrants.level,
    })
    .from(workspaceInvitationGrants)
    .where(eq(workspaceInvitationGrants.invitationId, invitation.id));
  await requireInviterStillAuthorized(
    tx,
    invitation.workspaceId,
    invitation.invitedByHumanId,
    offered,
  );
  return {
    ...invitation,
    workspace,
    offered: offered.map((grant) => ({
      projectId: grant.projectId,
      level: ProjectAccessLevel.parse(grant.level),
    })),
  };
}

async function requireRecipientNotMember(tx: DbTransaction, workspaceId: string, email: string) {
  const [member] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(humans.email, email),

        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  if (member !== undefined) throw new WorkspacesError("already_member");
}

async function requireWorkspaceMember(tx: DbTransaction, workspaceId: string, humanId: string) {
  return readMembership(tx, workspaceId, humanId, "member_not_found");
}

export function createWorkspacesService({
  db,
  publicUrl,
  createInvitedHuman,
  markEmailVerified,
  deliver,
  revokeMemberProjectAccess,
  revokeMemberWorkspaceKeys,
  releaseMemberWorkSessions,
  applyInvitationGrants,
  log,
}: WorkspacesDeps): WorkspacesService {
  async function endMembership(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
    event: WorkspaceEventType,
  ) {
    await tx
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, humanId),
        ),
      );

    await revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId);
    await revokeMemberWorkspaceKeys(tx, workspaceId, humanId, actorHumanId);
    await releaseMemberWorkSessions(tx, workspaceId, humanId);
    await recordEvent(tx, event, workspaceId, actorHumanId, humanId);
  }

  return {
    async list(account) {
      if (account === null) throw new WorkspacesError("not_signed_in");
      const rows = await db
        .select({
          id: workspaces.id,
          kind: workspaces.kind,
          name: workspaces.name,
          membershipIsOwner: workspaceMemberships.isOwner,
          membershipCanCreateProjects: workspaceMemberships.canCreateProjects,
          membershipCanInviteMembers: workspaceMemberships.canInviteMembers,
          membershipCanRemoveMembers: workspaceMemberships.canRemoveMembers,
          membershipCanManageMemberPermissions: workspaceMemberships.canManageMemberPermissions,
        })
        .from(workspaces)
        .leftJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.workspaceId, workspaces.id),
            eq(workspaceMemberships.humanId, account.humanId),
            isNull(workspaceMemberships.suspendedAt),
          ),
        )
        .where(
          or(
            eq(workspaces.personalOwnerHumanId, account.humanId),
            and(
              eq(workspaceMemberships.humanId, account.humanId),
              isNull(workspaceMemberships.suspendedAt),
            ),
          ),
        )
        .orderBy(workspaces.createdAt, workspaces.id);
      return rows.map(toWorkspace);
    },

    async get(account, workspaceId) {
      if (account === null) throw new WorkspacesError("not_signed_in");
      const [row] = await db
        .select({
          id: workspaces.id,
          kind: workspaces.kind,
          name: workspaces.name,
          membershipIsOwner: workspaceMemberships.isOwner,
          membershipCanCreateProjects: workspaceMemberships.canCreateProjects,
          membershipCanInviteMembers: workspaceMemberships.canInviteMembers,
          membershipCanRemoveMembers: workspaceMemberships.canRemoveMembers,
          membershipCanManageMemberPermissions: workspaceMemberships.canManageMemberPermissions,
        })
        .from(workspaces)
        .leftJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.workspaceId, workspaces.id),
            eq(workspaceMemberships.humanId, account.humanId),
            isNull(workspaceMemberships.suspendedAt),
          ),
        )
        .where(
          and(
            eq(workspaces.id, workspaceId),
            or(
              eq(workspaces.personalOwnerHumanId, account.humanId),
              and(
                eq(workspaceMemberships.humanId, account.humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            ),
          ),
        )
        .limit(1);
      if (row === undefined) throw new WorkspacesError("workspace_not_found");
      return toWorkspace(row);
    },

    async members(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          await readSharedWorkspace(tx, workspaceId);
          const membership = await readMembership(
            tx,
            workspaceId,
            actor.humanId,
            "workspace_not_found",
          );
          if (
            !membership.isOwner &&
            !membership.canManageMemberPermissions &&
            !membership.canRemoveMembers
          ) {
            throw new WorkspacesError("not_workspace_owner");
          }
          const rows = await tx
            .select({
              humanId: workspaceMemberships.humanId,
              email: humans.email,
              avatarObjectId: humans.avatarObjectId,
              isOwner: workspaceMemberships.isOwner,
              canCreateProjects: workspaceMemberships.canCreateProjects,
              canInviteMembers: workspaceMemberships.canInviteMembers,
              canRemoveMembers: workspaceMemberships.canRemoveMembers,
              canManageMemberPermissions: workspaceMemberships.canManageMemberPermissions,
              emailVerifiedAt: humans.emailVerifiedAt,
            })
            .from(workspaceMemberships)
            .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspaceId),

                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .orderBy(workspaceMemberships.createdAt, workspaceMemberships.humanId);
          return rows.map(toMember);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async create(account, input) {
      const actor = requireAccount(account);
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        await tx.insert(workspaces).values({
          id,
          kind: WorkspaceKind.enum.shared,
          name: input.name,
        });
        await tx.insert(workspaceMemberships).values({
          id: randomUUID(),
          workspaceId: id,
          humanId: actor.humanId,
          isOwner: true,
        });
        await recordEvent(tx, "workspace_created", id, actor.humanId, actor.humanId);
      });
      return {
        id,
        kind: WorkspaceKind.enum.shared,
        name: input.name,
        isOwner: true,
        canCreateProjects: true,
        canInviteMembers: true,
        canRemoveMembers: true,
        canManageMemberPermissions: true,
      };
    },

    async invite(account, workspaceId, input) {
      const actor = requireAccount(account);
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      let workspaceName: string;
      try {
        workspaceName = await db.transaction(async (tx) => {
          const workspace = await lockWorkspaceForMutation(tx, workspaceId);
          const inviter = await requireInviter(tx, workspaceId, actor.humanId);
          await requireVerifiedInviter(tx, actor.humanId);
          await requireOfferedProjectsInWorkspace(tx, workspaceId, input.projectGrants);
          await requireProjectManageScope(
            tx,
            workspaceId,
            inviter,
            input.projectGrants,
            "not_workspace_owner",
          );

          await requireRecipientNotMember(tx, workspaceId, input.email);

          const [blocking] = await tx
            .select({
              id: workspaceInvitations.id,
              invitedByHumanId: workspaceInvitations.invitedByHumanId,
            })
            .from(workspaceInvitations)
            .where(
              and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.email, input.email),
                eq(workspaceInvitations.status, InvitationStatus.enum.pending),
                gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
                or(
                  eq(workspaceInvitations.deliveryStatus, InvitationDelivery.enum.sent),
                  and(
                    isNull(workspaceInvitations.deliveryStatus),
                    gte(
                      workspaceInvitations.createdAt,
                      sql`statement_timestamp() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS})`,
                    ),
                  ),
                ),
              ),
            )
            .limit(1);
          if (blocking !== undefined) {
            const deadOffered = await tx
              .select({ projectId: workspaceInvitationGrants.projectId })
              .from(workspaceInvitationGrants)
              .where(eq(workspaceInvitationGrants.invitationId, blocking.id));
            if (
              await inviterStillAuthorized(tx, workspaceId, blocking.invitedByHumanId, deadOffered)
            ) {
              throw new WorkspacesError("invitation_pending");
            }
            await tx
              .update(workspaceInvitations)
              .set({ status: InvitationStatus.enum.revoked, revokedAt: sql`statement_timestamp()` })
              .where(eq(workspaceInvitations.id, blocking.id));
          }

          await tx
            .update(workspaceInvitations)
            .set({
              status: InvitationStatus.enum.expired,
              expiredAt: workspaceInvitations.expiresAt,
            })
            .where(
              and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.email, input.email),
                eq(workspaceInvitations.status, InvitationStatus.enum.pending),
                lte(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
              ),
            );

          await tx
            .update(workspaceInvitations)
            .set({ status: InvitationStatus.enum.revoked, revokedAt: sql`statement_timestamp()` })
            .where(
              and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.email, input.email),
                eq(workspaceInvitations.status, InvitationStatus.enum.pending),
                gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
                or(
                  eq(workspaceInvitations.deliveryStatus, InvitationDelivery.enum.failed),
                  and(
                    isNull(workspaceInvitations.deliveryStatus),
                    lt(
                      workspaceInvitations.createdAt,
                      sql`statement_timestamp() - make_interval(secs => ${UNKNOWN_DELIVERY_GRACE_SECONDS})`,
                    ),
                  ),
                ),
              ),
            );

          await tx.insert(workspaceInvitations).values({
            id,
            workspaceId,
            email: input.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
          if (input.projectGrants.length > 0) {
            await tx.insert(workspaceInvitationGrants).values(
              input.projectGrants.map((grant) => ({
                id: randomUUID(),
                invitationId: id,
                projectId: grant.projectId,
                level: grant.level,
              })),
            );
          }

          return workspace.name;
        });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_pending_workspace_invitation_per_email") {
          throw new WorkspacesError("invitation_pending");
        }
        throw error;
      }

      try {
        await deliver(invitationMail(workspaceName, input.email, token, publicUrl));
      } catch (error) {
        try {
          await recordDelivery(db, id, InvitationDelivery.enum.failed);
        } catch (recordingError) {
          log?.warn(
            "failed workspace invitation delivery recording failed",
            errorNameAndCode(recordingError),
          );
        }
        throw error;
      }
      await recordDelivery(db, id, InvitationDelivery.enum.sent);
      return { workspaceId, email: input.email, status: InvitationStatus.enum.pending };
    },

    async invitations(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await readSharedWorkspace(tx, workspaceId);
        const inviter = await requireInviter(tx, workspaceId, actor.humanId);
        await tx
          .update(workspaceInvitations)
          .set({
            status: InvitationStatus.enum.expired,
            expiredAt: workspaceInvitations.expiresAt,
          })
          .where(
            and(
              eq(workspaceInvitations.workspaceId, workspaceId),
              eq(workspaceInvitations.status, InvitationStatus.enum.pending),
              lte(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
            ),
          );
        const rows = await tx
          .select(summarySelection)
          .from(workspaceInvitations)
          .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
          .innerJoin(humans, eq(humans.id, workspaceInvitations.invitedByHumanId))
          .where(eq(workspaceInvitations.workspaceId, workspaceId))
          .orderBy(desc(workspaceInvitations.createdAt), desc(workspaceInvitations.id));
        const grantsByInvitation = await loadOfferedProjectGrants(
          tx,
          workspaceId,
          rows.map((row) => row.id),
        );

        const managed = inviter.isOwner
          ? new Set<string>()
          : await loadManagedProjectIds(tx, workspaceId, actor.humanId);
        return rows
          .filter((row) => {
            if (inviter.isOwner) return true;
            const offered = grantsByInvitation.get(row.id) ?? [];
            return offered.every((grant) => managed.has(grant.projectId));
          })
          .map((row) => toWorkspaceSummary(row, grantsByInvitation.get(row.id) ?? []));
      });
    },

    async resendInvitation(account, workspaceId, invitationId) {
      const actor = requireAccount(account);
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      let invitation: { email: string; workspaceName: string };
      try {
        invitation = await db.transaction(async (tx) => {
          const workspace = await lockWorkspaceForMutation(tx, workspaceId);
          const inviter = await requireInviter(tx, workspaceId, actor.humanId);

          await requireVerifiedInviter(tx, actor.humanId);

          const [row] = await tx
            .select({
              id: workspaceInvitations.id,
              email: workspaceInvitations.email,
              status: workspaceInvitations.status,
              live: sql<boolean>`${workspaceInvitations.expiresAt} > statement_timestamp()`,
            })
            .from(workspaceInvitations)
            .where(
              and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.id, invitationId),
              ),
            )
            .for("update");
          if (row === undefined) throw new WorkspacesError("invitation_not_found");
          if (!canResendInvitation(row.status)) {
            throw new WorkspacesError("invitation_not_pending");
          }

          const offered = await tx
            .select({
              projectId: workspaceInvitationGrants.projectId,
              level: workspaceInvitationGrants.level,
            })
            .from(workspaceInvitationGrants)
            .where(eq(workspaceInvitationGrants.invitationId, invitationId));

          await requireRecipientNotMember(tx, workspaceId, row.email);
          await requireOfferedProjectsInWorkspace(tx, workspaceId, offered);
          await requireProjectManageScope(tx, workspaceId, inviter, offered, "not_workspace_owner");

          if (row.status === InvitationStatus.enum.pending) {
            const superseded = supersedeTargetForPending(row.live);
            await tx
              .update(workspaceInvitations)
              .set(
                superseded === "revoked"
                  ? {
                      status: InvitationStatus.enum.revoked,
                      revokedAt: sql`statement_timestamp()`,
                    }
                  : {
                      status: InvitationStatus.enum.expired,
                      expiredAt: workspaceInvitations.expiresAt,
                    },
              )
              .where(eq(workspaceInvitations.id, invitationId));
          }

          await tx.insert(workspaceInvitations).values({
            id,
            workspaceId,
            email: row.email,
            status: InvitationStatus.enum.pending,
            tokenHash: tokenHash(token),
            invitedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${INVITATION_TTL_SECONDS})`,
          });
          if (offered.length > 0) {
            await tx.insert(workspaceInvitationGrants).values(
              offered.map((grant) => ({
                id: randomUUID(),
                invitationId: id,
                projectId: grant.projectId,
                level: ProjectAccessLevel.parse(grant.level),
              })),
            );
          }
          return { email: row.email, workspaceName: workspace.name };
        });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_pending_workspace_invitation_per_email") {
          throw new WorkspacesError("invitation_pending");
        }
        throw error;
      }

      await deliverWorkspaceInvitation(db, deliver, log, {
        id,
        workspaceName: invitation.workspaceName,
        email: invitation.email,
        token,
        publicUrl,
      });
      return readWorkspaceInvitationSummary(db, workspaceId, id);
    },

    async revokeInvitation(account, workspaceId, invitationId) {
      const actor = requireAccount(account);
      const didRevoke = await db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        const inviter = await requireInviter(tx, workspaceId, actor.humanId);

        const [row] = await tx
          .select({
            id: workspaceInvitations.id,
            status: workspaceInvitations.status,
            invitedByHumanId: workspaceInvitations.invitedByHumanId,
          })
          .from(workspaceInvitations)
          .where(
            and(
              eq(workspaceInvitations.workspaceId, workspaceId),
              eq(workspaceInvitations.id, invitationId),
            ),
          )
          .for("update");
        if (row === undefined) throw new WorkspacesError("invitation_not_found");
        if (row.status !== InvitationStatus.enum.pending) {
          throw new WorkspacesError("invitation_not_pending");
        }
        const offered = await tx
          .select({ projectId: workspaceInvitationGrants.projectId })
          .from(workspaceInvitationGrants)
          .where(eq(workspaceInvitationGrants.invitationId, invitationId));
        if (row.invitedByHumanId !== actor.humanId) {
          await requireProjectManageScope(tx, workspaceId, inviter, offered, "not_workspace_owner");
        }
        const revoked = await tx
          .update(workspaceInvitations)
          .set({
            status: InvitationStatus.enum.revoked,
            revokedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(workspaceInvitations.workspaceId, workspaceId),
              eq(workspaceInvitations.id, invitationId),
              eq(workspaceInvitations.status, InvitationStatus.enum.pending),
              gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
            ),
          )
          .returning({ id: workspaceInvitations.id });
        if (revoked.length > 0) return true;

        await tx
          .update(workspaceInvitations)
          .set({
            status: InvitationStatus.enum.expired,
            expiredAt: workspaceInvitations.expiresAt,
          })
          .where(eq(workspaceInvitations.id, invitationId));
        return false;
      });
      if (!didRevoke) throw new WorkspacesError("invitation_not_pending");
      return readWorkspaceInvitationSummary(db, workspaceId, invitationId);
    },

    async declineInvitation(input) {
      const declined = await db
        .update(workspaceInvitations)
        .set({
          status: InvitationStatus.enum.declined,
          declinedAt: sql`statement_timestamp()`,
        })
        .where(
          and(
            eq(workspaceInvitations.tokenHash, tokenHash(input.token)),
            eq(workspaceInvitations.status, InvitationStatus.enum.pending),
            gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
            sql`${workspaceInvitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
          ),
        )
        .returning({ id: workspaceInvitations.id });
      if (declined.length === 0) throw new WorkspacesError("invitation_invalid");
    },

    async previewInvitation(token) {
      const [row] = await db
        .select({
          id: workspaceInvitations.id,
          workspaceId: workspaceInvitations.workspaceId,
          workspaceName: workspaces.name,
          email: workspaceInvitations.email,
          invitedByEmail: humans.email,
          expiresAt: workspaceInvitations.expiresAt,
        })
        .from(workspaceInvitations)
        .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
        .innerJoin(humans, eq(humans.id, workspaceInvitations.invitedByHumanId))
        .where(
          and(
            eq(workspaceInvitations.tokenHash, tokenHash(token)),
            eq(workspaceInvitations.status, InvitationStatus.enum.pending),
            gt(workspaceInvitations.expiresAt, sql`statement_timestamp()`),
            sql`${workspaceInvitations.deliveryStatus} is distinct from ${InvitationDelivery.enum.failed}`,
          ),
        )
        .limit(1);
      if (row === undefined) throw new WorkspacesError("invitation_invalid");
      const grants = await loadOfferedProjectGrants(db, row.workspaceId, [row.id]);
      const offered = grants.get(row.id) ?? [];
      if (offered.some((grant) => grant.projectName === null)) {
        throw new WorkspacesError("invitation_scope_invalid");
      }
      const [existingAccount] = await db
        .select({ id: humans.id })
        .from(humans)
        .where(eq(humans.email, row.email))
        .limit(1);
      return {
        workspaceId: row.workspaceId,
        workspaceName: row.workspaceName,
        email: row.email,
        invitedByEmail: row.invitedByEmail,
        accountExists: existingAccount !== undefined,
        grants: [
          {
            kind: "workspace_membership" as const,
            workspaceId: row.workspaceId,
            role: "member" as const,
          },
          ...offered.map((grant) => ({
            kind: "project_access" as const,
            projectId: grant.projectId,
            projectName: grant.projectName,
            level: grant.level,
          })),
        ],
        expiresAt: row.expiresAt.toISOString(),
      };
    },

    async acceptInvitation(account, token) {
      const actor = requireAccount(account);
      const workspace = await db.transaction(async (tx) => {
        const invitation = await redeemWorkspaceInvitation(tx, token);

        const [human] = await tx
          .select({
            email: humans.email,
            emailVerifiedAt: humans.emailVerifiedAt,
            deactivatedAt: humans.deactivatedAt,
          })
          .from(humans)
          .where(eq(humans.id, actor.humanId))
          .limit(1);
        if (human === undefined) throw new WorkspacesError("not_signed_in");

        if (human.deactivatedAt !== null) throw new WorkspacesError("account_deactivated");
        if (human.email !== invitation.email) {
          throw new WorkspacesError("invitation_recipient_mismatch");
        }
        if (human.emailVerifiedAt === null) throw new WorkspacesError("email_unverified");

        const [suspendedMembership] = await tx
          .select({ isFormerOwner: workspaceMemberships.isFormerOwner })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, invitation.workspaceId),
              eq(workspaceMemberships.humanId, actor.humanId),
              isNotNull(workspaceMemberships.suspendedAt),
            ),
          )
          .limit(1);
        if (suspendedMembership?.isFormerOwner === true) {
          const [activeOwners] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, invitation.workspaceId),
                eq(workspaceMemberships.isOwner, true),
                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          if ((activeOwners?.count ?? 0) === 0) {
            throw new WorkspacesError("ownerless_workspace");
          }
        }

        const inserted = await tx
          .insert(workspaceMemberships)
          .values({
            id: randomUUID(),
            workspaceId: invitation.workspaceId,
            humanId: actor.humanId,
            isOwner: false,
          })
          .onConflictDoUpdate({
            target: [workspaceMemberships.workspaceId, workspaceMemberships.humanId],
            set: {
              suspendedAt: null,
              isFormerOwner: false,
              isOwner: false,
              canCreateProjects: false,
              canInviteMembers: false,
              canRemoveMembers: false,
              canManageMemberPermissions: false,
            },
            setWhere: isNotNull(workspaceMemberships.suspendedAt),
          })
          .returning({ id: workspaceMemberships.id });
        if (inserted.length === 0) throw new WorkspacesError("already_member");

        await recordEvent(
          tx,
          "member_joined",
          invitation.workspaceId,
          actor.humanId,
          actor.humanId,
        );
        const missing = await applyInvitationGrants(
          tx,
          invitation.workspaceId,
          actor.humanId,
          invitation.invitedByHumanId,
          invitation.offered,
        );
        if (missing.length > 0) throw new WorkspacesError("invitation_scope_invalid");
        return invitation.workspace;
      });
      return {
        ...workspace,
        isOwner: false,
        canCreateProjects: false,
        canInviteMembers: false,
        canRemoveMembers: false,
        canManageMemberPermissions: false,
      };
    },

    async registerThroughInvitation(input) {
      const registered = await db.transaction(async (tx) => {
        const invitation = await redeemWorkspaceInvitation(tx, input.token);

        const [existing] = await tx
          .select({ id: humans.id })
          .from(humans)
          .where(eq(humans.email, invitation.email))
          .limit(1);
        if (existing !== undefined) throw new WorkspacesError("account_exists");

        let handle = "";
        try {
          const created = await createInvitedHuman(
            { email: invitation.email, password: input.password },
            tx,
          );
          const { humanId } = created;
          handle = created.handle;
          await markEmailVerified(humanId, tx);
          await tx.insert(workspaceMemberships).values({
            id: randomUUID(),
            workspaceId: invitation.workspaceId,
            humanId,
            isOwner: false,
          });
          await recordEvent(tx, "member_joined", invitation.workspaceId, humanId, humanId);
          const missing = await applyInvitationGrants(
            tx,
            invitation.workspaceId,
            humanId,
            invitation.invitedByHumanId,
            invitation.offered,
          );
          if (missing.length > 0) throw new WorkspacesError("invitation_scope_invalid");
        } catch (error) {
          if (uniqueConstraintName(error) === "humans_email_unique") {
            throw new WorkspacesError("account_exists");
          }
          throw error;
        }
        return { email: invitation.email, handle };
      });
      return toSessionResponse({
        email: registered.email,
        handle: registered.handle,
        displayName: null,
        emailVerifiedAt: new Date(),
        avatarUrl: null,
      });
    },

    async appointOwner(account, workspaceId, humanId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        await requireOwner(tx, workspaceId, actor.humanId);

        const member = await requireWorkspaceMember(tx, workspaceId, humanId);
        if (member.isOwner) return toMember(member);

        await tx
          .update(workspaceMemberships)
          .set({ isOwner: true })
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
            ),
          );
        await recordEvent(tx, "owner_appointed", workspaceId, actor.humanId, humanId);
        return toMember({ ...member, isOwner: true });
      });
    },

    async updateMemberCapability(account, workspaceId, humanId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        const actorMembership = await readMembership(
          tx,
          workspaceId,
          actor.humanId,
          "workspace_not_found",
        );

        const requested = UpdateWorkspaceMemberRequest.parse(input);

        const member = await requireWorkspaceMember(tx, workspaceId, humanId);

        if (member.isOwner) {
          if (!actorMembership.isOwner) throw new WorkspacesError("not_workspace_owner");

          if (Object.values(requested).some((value) => !value)) {
            throw new WorkspacesError("workspace_owner_capability");
          }
          return toMember(member);
        }

        if (!actorMembership.isOwner) {
          if (!actorMembership.canManageMemberPermissions) {
            throw new WorkspacesError("not_workspace_owner");
          }
          if (actorMembership.humanId === humanId) {
            throw new WorkspacesError("not_workspace_owner");
          }

          if (requested.canManageMemberPermissions !== undefined) {
            throw new WorkspacesError("not_workspace_owner");
          }

          for (const capability of workspaceCapabilities) {
            if (requested[capability] !== undefined && !actorMembership[capability]) {
              throw new WorkspacesError("not_workspace_owner");
            }
          }
        }

        const updates: Partial<typeof workspaceMemberships.$inferInsert> = {};
        const changed: { capability: WorkspaceCapability; granted: boolean }[] = [];
        for (const capability of workspaceCapabilities) {
          const value = requested[capability];
          if (value === undefined || member[capability] === value) continue;
          updates[capability] = value;
          changed.push({ capability, granted: value });
        }
        if (changed.length === 0) return toMember(member);

        await tx
          .update(workspaceMemberships)
          .set(updates)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, workspaceId),
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
            ),
          );
        const next: WorkspaceMembershipRow = { ...member };
        for (const change of changed) {
          next[change.capability] = change.granted;
          const type = change.granted
            ? capabilityEvents[change.capability].granted
            : capabilityEvents[change.capability].revoked;
          await recordEvent(tx, type, workspaceId, actor.humanId, humanId);
        }
        return toMember(next);
      });
    },

    async removeMember(account, workspaceId, humanId) {
      const actor = requireAccount(account);
      await db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        const actorMembership = await readMembership(
          tx,
          workspaceId,
          actor.humanId,
          "workspace_not_found",
        );
        const target = await requireWorkspaceMember(tx, workspaceId, humanId);
        if (!actorMembership.isOwner && !actorMembership.canRemoveMembers) {
          throw new WorkspacesError("not_workspace_owner");
        }
        if (!actorMembership.isOwner && (target.isOwner || target.canManageMemberPermissions)) {
          throw new WorkspacesError("not_workspace_owner");
        }

        if (target.isOwner) {
          const [owners] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.isOwner, true),

                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          if ((owners?.count ?? 0) <= 1) throw new WorkspacesError("last_owner");
        }

        await endMembership(
          tx,
          workspaceId,
          humanId,
          actor.humanId,
          target.isOwner ? "owner_removed" : "member_removed",
        );
      });
    },

    async leaveWorkspace(account, workspaceId) {
      const actor = requireAccount(account);
      await db.transaction(async (tx) => {
        await lockWorkspaceForMutation(tx, workspaceId);
        const membership = await readMembership(
          tx,
          workspaceId,
          actor.humanId,
          "workspace_not_found",
        );
        if (membership.isOwner) {
          const [owners] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(workspaceMemberships)
            .where(
              and(
                eq(workspaceMemberships.workspaceId, workspaceId),
                eq(workspaceMemberships.isOwner, true),

                isNull(workspaceMemberships.suspendedAt),
              ),
            );
          if ((owners?.count ?? 0) <= 1) throw new WorkspacesError("last_owner");
        }

        await endMembership(
          tx,
          workspaceId,
          actor.humanId,
          actor.humanId,
          membership.isOwner ? "owner_left" : "member_left",
        );
      });
    },
  };
}

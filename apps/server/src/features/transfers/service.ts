import { randomBytes, randomUUID } from "node:crypto";
import type {
  Project,
  ProjectAccessLevel,
  TransferAccessChange,
  TransferAuthorization,
  TransferPreview,
} from "@orrery/contract";
import {
  avatarUrlFor,
  InvitationStatus,
  ProjectAccessEventType,
  WorkspaceKind,
} from "@orrery/contract";
import { and, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agentApiKeyProjects,
  humans,
  issues,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projectTransferAuthorizations,
  projects,
  questions,
  webhookDeliveries,
  webhookProjects,
  webhooks,
  workSessions,
  workspaceEvents,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { tokenHash as hashToken } from "../../platform/tokens.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { transferAuthorizationMachine } from "./state-machine.ts";

export type TransfersErrorKind =
  | "not_signed_in"
  | "project_not_found"
  | "workspace_not_found"
  | "destination_authority_required"
  | "same_workspace"
  | "transfer_invalid"
  | "transfer_stale"
  | "source_authority_lost"
  | "active_work"
  | "project_key_conflict"
  | "project_key_immutable";

const messages: Record<TransfersErrorKind, string> = {
  not_signed_in: "Not signed in",
  project_not_found: "No project with this id is accessible to the caller",
  workspace_not_found: "No shared workspace with this id is accessible to the caller",
  destination_authority_required:
    "The receiver must be a destination owner or have Create projects in the destination",
  same_workspace: "The destination must be a different workspace from the source",
  transfer_invalid: "The transfer authorization is invalid, expired or already used",
  transfer_stale: "The project's workspace changed since the transfer was authorized",
  source_authority_lost: "The authorizing owner no longer controls the source workspace",
  active_work: "Finish or stop every active work session before transferring the project",
  project_key_conflict: "The destination workspace already uses this project key",
  project_key_immutable: "A project key can only change to resolve a transfer collision",
};

export class TransfersError extends Error {
  readonly kind: TransfersErrorKind;
  constructor(kind: TransfersErrorKind) {
    super(messages[kind]);
    this.name = "TransfersError";
    this.kind = kind;
  }
}

const AUTHORIZATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TransfersDeps {
  db: PostgresJsDatabase;
}

export interface TransfersService {
  preview(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
  ): Promise<TransferPreview>;
  authorize(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
  ): Promise<TransferAuthorization>;
  receiverPreview(account: SessionAccount | null, token: string): Promise<TransferPreview>;

  accept(account: SessionAccount | null, token: string, key?: string): Promise<Project>;
  complete(
    account: SessionAccount | null,
    projectId: string,
    destinationWorkspaceId: string,
    key?: string,
  ): Promise<Project>;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

interface Authority {
  project: ProjectRow;
  source: WorkspaceRow;
}

interface AuthorizationLike {
  id: string;
  projectId: string;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  authorizedByHumanId: string;
}

async function lockOwnershipWrites(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function bumpGuards(tx: DbTransaction, ids: readonly string[]): Promise<void> {
  const workspaceIds = ids.toSorted();
  if (workspaceIds.length === 0) return;
  await tx
    .insert(workspaceOwnershipGuards)
    .values(workspaceIds.map((workspaceId) => ({ workspaceId, version: 0 })))
    .onConflictDoUpdate({
      target: workspaceOwnershipGuards.workspaceId,
      set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
    });
}

async function readPersonalProject(
  tx: DbTransaction,
  projectId: string,
  humanId: string,
): Promise<Authority> {
  const [row] = await tx
    .select({ project: projects, source: workspaces })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(
      and(
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
        eq(workspaces.kind, WorkspaceKind.enum.personal),
        eq(workspaces.personalOwnerHumanId, humanId),
      ),
    )
    .limit(1);
  if (row === undefined) throw new TransfersError("project_not_found");
  return row;
}

async function readSharedSourceProject(
  tx: DbTransaction,
  projectId: string,
  humanId: string,
): Promise<Authority> {
  const [row] = await tx
    .select({ project: projects, source: workspaces })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
        eq(workspaceMemberships.isOwner, true),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(
      and(
        eq(projects.id, projectId),
        isNull(projects.deletedAt),
        eq(workspaces.kind, WorkspaceKind.enum.shared),
      ),
    )
    .limit(1);
  if (row === undefined) throw new TransfersError("project_not_found");
  return row;
}

async function readSourceProject(
  tx: DbTransaction,
  projectId: string,
  humanId: string,
): Promise<Authority> {
  const [row] = await tx
    .select({ kind: workspaces.kind })
    .from(projects)
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (row?.kind === WorkspaceKind.enum.shared) {
    return readSharedSourceProject(tx, projectId, humanId);
  }
  return readPersonalProject(tx, projectId, humanId);
}

async function readSharedDestination(
  tx: DbTransaction,
  workspaceId: string,
): Promise<WorkspaceRow> {
  const [row] = await tx
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, WorkspaceKind.enum.shared)))
    .limit(1);
  if (row === undefined) throw new TransfersError("workspace_not_found");
  return row;
}

function rejectSameWorkspace(sourceId: string, destinationId: string): void {
  if (sourceId === destinationId) throw new TransfersError("same_workspace");
}

async function hasDestinationMembership(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [membership] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

async function requireDestinationMember(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  if (!(await hasDestinationMembership(tx, workspaceId, humanId))) {
    throw new TransfersError("workspace_not_found");
  }
}

async function hasCreateProjectsAuthority(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [membership] = await tx
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  return membership !== undefined && (membership.isOwner || membership.canCreateProjects);
}

async function manageRecipients(
  tx: DbTransaction,
  destinationWorkspaceId: string,
  receiverHumanId: string | null,
): Promise<TransferAccessChange[]> {
  const owners = await tx
    .select({ humanId: humans.id, email: humans.email })
    .from(workspaceMemberships)
    .innerJoin(humans, eq(workspaceMemberships.humanId, humans.id))
    .where(
      and(
        eq(workspaceMemberships.workspaceId, destinationWorkspaceId),
        eq(workspaceMemberships.isOwner, true),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .orderBy(humans.email);
  const [receiver] =
    receiverHumanId === null
      ? []
      : await tx
          .select({ humanId: humans.id, email: humans.email })
          .from(humans)
          .where(eq(humans.id, receiverHumanId))
          .limit(1);

  const changes: TransferAccessChange[] = [];
  const seen = new Set<string>();
  for (const owner of owners) {
    if (seen.has(owner.humanId)) continue;
    seen.add(owner.humanId);
    changes.push({
      humanId: owner.humanId,
      email: owner.email,
      level: "manage",
      reason: "destination_owner",
    });
  }
  if (receiver !== undefined && !seen.has(receiver.humanId)) {
    changes.push({
      humanId: receiver.humanId,
      email: receiver.email,
      level: "manage",
      reason: "receiver",
    });
  }
  return changes;
}

async function liveWork(
  tx: DbTransaction,
  projectId: string,
): Promise<{ issueId: string; number: number; title: string }[]> {
  return tx
    .select({ issueId: issues.id, number: issues.number, title: issues.title })
    .from(workSessions)
    .innerJoin(issues, eq(workSessions.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(workSessions.status, "active"),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    )
    .orderBy(issues.number);
}

// A human assignee stays only if they can access the destination workspace as
// its personal owner or an active member.
async function clearInvalidAssignees(
  tx: DbTransaction,
  projectId: string,
  destination: WorkspaceRow,
): Promise<void> {
  const assigned = await tx
    .select({
      id: issues.id,
      assigneeHumanId: issues.assigneeHumanId,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), isNotNull(issues.assigneeHumanId)));
  const humanAssigneeIds = new Set<string>();
  for (const issue of assigned) {
    if (issue.assigneeHumanId === null) continue;
    if (issue.assigneeHumanId === destination.personalOwnerHumanId) continue;
    humanAssigneeIds.add(issue.assigneeHumanId);
  }
  const validHumanIds = new Set<string>();
  if (destination.personalOwnerHumanId !== null) {
    validHumanIds.add(destination.personalOwnerHumanId);
  }
  if (humanAssigneeIds.size > 0) {
    const memberships = await tx
      .select({ humanId: workspaceMemberships.humanId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, destination.id),
          inArray(workspaceMemberships.humanId, [...humanAssigneeIds]),
          isNull(workspaceMemberships.suspendedAt),
        ),
      );
    for (const membership of memberships) validHumanIds.add(membership.humanId);
  }
  const staleIds: string[] = [];
  for (const issue of assigned) {
    if (issue.assigneeHumanId !== null && validHumanIds.has(issue.assigneeHumanId)) {
      continue;
    }
    staleIds.push(issue.id);
  }
  if (staleIds.length === 0) return;
  await tx
    .update(issues)
    .set({ assigneeHumanId: null, updatedAt: sql`statement_timestamp()` })
    .where(inArray(issues.id, staleIds));
}

function toParty(workspace: WorkspaceRow) {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
  };
}

async function buildPreview(
  tx: DbTransaction,
  authority: Authority,
  destination: WorkspaceRow,
  receiverHumanId: string | null,
): Promise<TransferPreview> {
  const [grants] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectAccessGrants)
    .where(eq(projectAccessGrants.projectId, authority.project.id));
  const active = await liveWork(tx, authority.project.id);
  return {
    projectId: authority.project.id,
    projectName: authority.project.name,
    source: toParty(authority.source),
    destination: toParty(destination),
    visibilityChange:
      authority.source.kind === WorkspaceKind.enum.personal
        ? "personal_to_shared"
        : "shared_to_shared",
    accessChanges: await manageRecipients(tx, destination.id, receiverHumanId),
    revokedSourceGrants: grants?.count ?? 0,
    activeWork: { count: active.length, issues: active },
    ready: active.length === 0,
  };
}

function toProject(
  row: {
    id: string;
    workspaceId: string;
    name: string;
    description: string;
    key: string;
    createdAt: Date;
    creatorId: string;
    creatorEmail: string;
    creatorAvatarObjectId: string | null;
    kind: Project["workspaceKind"];
    fallbackPolicy: Project["fallbackPolicy"];
  },
  accessLevel: ProjectAccessLevel,
): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    key: row.key,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      humanId: row.creatorId,
      email: row.creatorEmail,
      displayName: row.creatorEmail,
      avatarUrl:
        row.creatorAvatarObjectId === null
          ? null
          : avatarUrlFor(row.creatorId, row.creatorAvatarObjectId),
    },
    workspaceKind: row.kind,
    accessLevel,
    fallbackPolicy: row.fallbackPolicy,
  };
}

async function readProjectView(
  tx: DbTransaction,
  projectId: string,
  accessLevel: ProjectAccessLevel,
): Promise<Project> {
  const [row] = await tx
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      name: projects.name,
      description: projects.description,
      key: projects.key,
      createdAt: projects.createdAt,
      creatorId: humans.id,
      creatorEmail: humans.email,
      creatorAvatarObjectId: humans.avatarObjectId,
      kind: workspaces.kind,
      fallbackPolicy: projects.fallbackPolicy,
    })
    .from(projects)
    .innerJoin(humans, eq(projects.createdByHumanId, humans.id))
    .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (row === undefined) throw new TransfersError("project_not_found");
  return toProject(row, accessLevel);
}

function workspaceEvent(
  workspaceId: string,
  type: "project_transfer_authorized" | "project_transfer_received" | "project_transferred_out",
  actorHumanId: string,
  subjectHumanId: string,
) {
  return {
    id: randomUUID(),
    workspaceId,
    type,
    actorHumanId,
    subjectHumanId,
    createdAt: sql`statement_timestamp()`,
  };
}

async function createAuthorization(
  tx: DbTransaction,
  input: {
    projectId: string;
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
    authorizedByHumanId: string;
    token: string;
  },
) {
  const [authorization] = await tx
    .insert(projectTransferAuthorizations)
    .values({
      id: randomUUID(),
      projectId: input.projectId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      destinationWorkspaceId: input.destinationWorkspaceId,
      authorizedByHumanId: input.authorizedByHumanId,
      tokenHash: hashToken(input.token),
      status: "pending",
      expiresAt: sql`statement_timestamp() + make_interval(secs => ${AUTHORIZATION_TTL_SECONDS})`,
    })
    .returning();
  if (authorization === undefined) throw new TransfersError("transfer_invalid");
  await tx
    .insert(workspaceEvents)
    .values(
      workspaceEvent(
        input.sourceWorkspaceId,
        "project_transfer_authorized",
        input.authorizedByHumanId,
        input.authorizedByHumanId,
      ),
    );
  return authorization;
}

async function pendingAuthorizationByToken(
  tx: DbTransaction,
  token: string,
  lock = false,
): Promise<typeof projectTransferAuthorizations.$inferSelect> {
  const query = tx
    .select()
    .from(projectTransferAuthorizations)
    .where(eq(projectTransferAuthorizations.tokenHash, hashToken(token)));
  const [row] = lock ? await query.for("update").limit(1) : await query.limit(1);
  if (row === undefined || row.status !== "pending") throw new TransfersError("transfer_invalid");
  const [live] = await tx
    .select({ id: projectTransferAuthorizations.id })
    .from(projectTransferAuthorizations)
    .where(
      and(
        eq(projectTransferAuthorizations.id, row.id),
        gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (live === undefined) throw new TransfersError("transfer_invalid");
  return row;
}

async function acceptInTransaction(
  tx: DbTransaction,
  auth: AuthorizationLike,
  acceptorHumanId: string,
  newKey?: string,
): Promise<Project> {
  const [row] = await tx
    .select()
    .from(projectTransferAuthorizations)
    .where(eq(projectTransferAuthorizations.id, auth.id))
    .for("update")
    .limit(1);
  if (row === undefined || row.status !== "pending") {
    throw new TransfersError("transfer_invalid");
  }
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, auth.projectId), isNull(projects.deletedAt)))
    .for("update")
    .limit(1);
  if (project === undefined) throw new TransfersError("transfer_invalid");

  const [live] = await tx
    .select({ id: projectTransferAuthorizations.id })
    .from(projectTransferAuthorizations)
    .where(
      and(
        eq(projectTransferAuthorizations.id, auth.id),
        gt(projectTransferAuthorizations.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  if (live === undefined) throw new TransfersError("transfer_invalid");

  const [source] = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, auth.sourceWorkspaceId))
    .limit(1);

  if (!(await hasDestinationMembership(tx, auth.destinationWorkspaceId, acceptorHumanId))) {
    throw new TransfersError("transfer_invalid");
  }
  const destination = await readSharedDestination(tx, auth.destinationWorkspaceId);
  if (!(await hasCreateProjectsAuthority(tx, destination.id, acceptorHumanId))) {
    throw new TransfersError("destination_authority_required");
  }

  if (source === undefined) throw new TransfersError("source_authority_lost");
  if (source.kind === WorkspaceKind.enum.personal) {
    const [activeOwner] = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(and(eq(humans.id, auth.authorizedByHumanId), isNull(humans.deactivatedAt)))
      .limit(1);
    if (source.personalOwnerHumanId !== auth.authorizedByHumanId || activeOwner === undefined) {
      throw new TransfersError("source_authority_lost");
    }
  } else if (source.kind === WorkspaceKind.enum.shared) {
    const [ownerMembership] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, source.id),
          eq(workspaceMemberships.humanId, auth.authorizedByHumanId),
          eq(workspaceMemberships.isOwner, true),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .limit(1);
    if (ownerMembership === undefined) throw new TransfersError("source_authority_lost");
  } else {
    throw new TransfersError("source_authority_lost");
  }

  await bumpGuards(tx, [source.id, destination.id]);

  if (project.workspaceId !== auth.sourceWorkspaceId) {
    throw new TransfersError("transfer_stale");
  }

  const [destinationKeyCollision] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, destination.id),
        eq(projects.key, project.key),
        ne(projects.id, auth.projectId),
        isNull(projects.purgedAt),
      ),
    )
    .limit(1);
  const keyCollides = destinationKeyCollision !== undefined;
  if (newKey !== undefined && (!keyCollides || newKey === project.key)) {
    throw new TransfersError(keyCollides ? "project_key_conflict" : "project_key_immutable");
  }
  if (keyCollides && newKey === undefined) throw new TransfersError("project_key_conflict");
  const effectiveKey = newKey ?? project.key;
  if (newKey !== undefined) {
    const [replacementCollision] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, destination.id),
          eq(projects.key, newKey),
          ne(projects.id, auth.projectId),
          isNull(projects.purgedAt),
        ),
      )
      .limit(1);
    if (replacementCollision !== undefined) throw new TransfersError("project_key_conflict");
  }

  const issueIds = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.projectId, auth.projectId))
    .orderBy(issues.id)
    .for("update");
  const issueIdList = issueIds.map((issue) => issue.id);
  if (issueIdList.length > 0) {
    const [liveSession] = await tx
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(
        and(
          inArray(workSessions.issueId, issueIdList),
          eq(workSessions.status, "active"),
          gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (liveSession !== undefined) throw new TransfersError("active_work");

    const expiredSessions = await tx
      .update(workSessions)
      .set({
        status: "expired",
        endedAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      })
      .where(
        and(
          inArray(workSessions.issueId, issueIdList),
          eq(workSessions.status, "active"),
          lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      )
      .returning({ issueId: workSessions.issueId });
    if (expiredSessions.length > 0) {
      await tx
        .update(issues)
        .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
        .where(
          and(
            inArray(
              issues.id,
              expiredSessions.map((session) => session.issueId),
            ),
            eq(issues.status, "in_progress"),
          ),
        );
    }
  }

  // Assignees valid only in the source workspace must not travel with the project.
  await clearInvalidAssignees(tx, auth.projectId, destination);

  await tx.delete(projectAccessGrants).where(eq(projectAccessGrants.projectId, auth.projectId));
  await tx.delete(agentApiKeyProjects).where(eq(agentApiKeyProjects.projectId, auth.projectId));
  // Keep the source workspace's webhook scopes from widening: remove the transferred
  // project from their explicit project lists but leave all_projects untouched.
  const sourceWebhookIds = tx
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(eq(webhooks.workspaceId, source.id));
  await tx
    .delete(webhookProjects)
    .where(
      and(
        eq(webhookProjects.projectId, auth.projectId),
        inArray(webhookProjects.webhookId, sourceWebhookIds),
      ),
    );
  // Cancel pending outbox deliveries for this project on source-workspace webhooks so
  // events queued before the transfer cannot leak to the source workspace afterward.
  await tx
    .update(webhookDeliveries)
    .set({
      status: "failed",
      lockedUntil: null,
      lastError: "project_transferred",
    })
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        inArray(webhookDeliveries.webhookId, sourceWebhookIds),
        inArray(
          webhookDeliveries.activityId,
          tx
            .select({ id: projectActivity.id })
            .from(projectActivity)
            .where(eq(projectActivity.projectId, auth.projectId)),
        ),
      ),
    );
  const pendingOffers = await tx
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitationGrants)
    .innerJoin(
      workspaceInvitations,
      eq(workspaceInvitations.id, workspaceInvitationGrants.invitationId),
    )
    .where(
      and(
        eq(workspaceInvitationGrants.projectId, auth.projectId),
        eq(workspaceInvitations.status, InvitationStatus.enum.pending),
      ),
    );
  if (pendingOffers.length > 0) {
    await tx.delete(workspaceInvitationGrants).where(
      and(
        eq(workspaceInvitationGrants.projectId, auth.projectId),
        inArray(
          workspaceInvitationGrants.invitationId,
          pendingOffers.map((offer) => offer.id),
        ),
      ),
    );
  }

  await tx
    .update(projects)
    .set({ workspaceId: destination.id, key: effectiveKey })
    .where(eq(projects.id, auth.projectId));
  await tx
    .update(questions)
    .set({ workspaceId: destination.id })
    .where(eq(questions.projectId, auth.projectId));

  const recipients = await manageRecipients(tx, destination.id, acceptorHumanId);
  if (recipients.length > 0) {
    await tx.insert(projectAccessGrants).values(
      recipients.map((recipient) => ({
        id: randomUUID(),
        projectId: auth.projectId,
        humanId: recipient.humanId,
        level: "manage" as const,
        grantedByHumanId: acceptorHumanId,
        createdAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      })),
    );
    await tx.insert(projectAccessEvents).values(
      recipients.map((recipient) => ({
        id: randomUUID(),
        projectId: auth.projectId,

        workspaceId: destination.id,
        actorHumanId: acceptorHumanId,
        subjectHumanId: recipient.humanId,
        type: ProjectAccessEventType.enum.project_access_granted,
        level: "manage" as const,
        previousLevel: null,
        createdAt: sql`statement_timestamp()`,
      })),
    );
  }

  await tx
    .insert(workspaceEvents)
    .values(
      workspaceEvent(
        source.id,
        "project_transferred_out",
        auth.authorizedByHumanId,
        acceptorHumanId,
      ),
    );
  await tx
    .insert(workspaceEvents)
    .values(
      workspaceEvent(
        destination.id,
        "project_transfer_received",
        acceptorHumanId,
        auth.authorizedByHumanId,
      ),
    );

  transferAuthorizationMachine.assertTransition("pending", "accepted");
  await tx
    .update(projectTransferAuthorizations)
    .set({
      status: "accepted",
      acceptedAt: sql`statement_timestamp()`,
    })
    .where(eq(projectTransferAuthorizations.id, auth.id));

  transferAuthorizationMachine.assertTransition("pending", "revoked");
  await tx
    .update(projectTransferAuthorizations)
    .set({
      status: "revoked",
      revokedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(projectTransferAuthorizations.projectId, auth.projectId),
        eq(projectTransferAuthorizations.status, "pending"),
        ne(projectTransferAuthorizations.id, auth.id),
      ),
    );

  return readProjectView(tx, auth.projectId, "manage");
}

export function createTransfersService({ db }: TransfersDeps): TransfersService {
  return {
    async preview(account, projectId, destinationWorkspaceId) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(
        async (tx) => {
          const authority = await readSourceProject(tx, projectId, account.humanId);
          rejectSameWorkspace(authority.source.id, destinationWorkspaceId);

          await requireDestinationMember(tx, destinationWorkspaceId, account.humanId);
          const destination = await readSharedDestination(tx, destinationWorkspaceId);
          const receiver = (await hasCreateProjectsAuthority(tx, destination.id, account.humanId))
            ? account.humanId
            : null;
          return buildPreview(tx, authority, destination, receiver);
        },
        { accessMode: "read only" },
      );
    },

    async authorize(account, projectId, destinationWorkspaceId) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const authority = await readSourceProject(tx, projectId, account.humanId);
        rejectSameWorkspace(authority.source.id, destinationWorkspaceId);
        const destination = await readSharedDestination(tx, destinationWorkspaceId);

        const canSeeDestination = await hasDestinationMembership(
          tx,
          destination.id,
          account.humanId,
        );
        const receiver = (await hasCreateProjectsAuthority(tx, destination.id, account.humanId))
          ? account.humanId
          : null;
        const fullPreview = await buildPreview(tx, authority, destination, receiver);
        const token = randomBytes(32).toString("base64url");
        const authorization = await createAuthorization(tx, {
          projectId,
          sourceWorkspaceId: authority.source.id,
          destinationWorkspaceId: destination.id,
          authorizedByHumanId: account.humanId,
          token,
        });

        return {
          token,
          authorizationId: authorization.id,
          projectId,
          sourceWorkspaceId: authority.source.id,
          destinationWorkspaceId: destination.id,
          authorizedByHumanId: account.humanId,
          status: authorization.status,
          createdAt: authorization.createdAt.toISOString(),
          expiresAt: authorization.expiresAt.toISOString(),
          preview: canSeeDestination ? fullPreview : null,
        };
      });
    },

    async receiverPreview(account, token) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(
        async (tx) => {
          const authorization = await pendingAuthorizationByToken(tx, token);

          if (
            !(await hasDestinationMembership(
              tx,
              authorization.destinationWorkspaceId,
              account.humanId,
            ))
          ) {
            throw new TransfersError("transfer_invalid");
          }
          if (
            !(await hasCreateProjectsAuthority(
              tx,
              authorization.destinationWorkspaceId,
              account.humanId,
            ))
          ) {
            throw new TransfersError("destination_authority_required");
          }
          const [project] = await tx
            .select()
            .from(projects)
            .where(and(eq(projects.id, authorization.projectId), isNull(projects.deletedAt)))
            .limit(1);
          const [source] = await tx
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, authorization.sourceWorkspaceId))
            .limit(1);
          if (project === undefined || source === undefined) {
            throw new TransfersError("transfer_invalid");
          }
          const destination = await readSharedDestination(tx, authorization.destinationWorkspaceId);
          return buildPreview(tx, { project, source }, destination, account.humanId);
        },
        { accessMode: "read only" },
      );
    },

    async accept(account, token, key) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        const row = await pendingAuthorizationByToken(tx, token, true);
        await lockOwnershipWrites(tx);
        return acceptInTransaction(tx, row, account.humanId, key);
      });
    },

    async complete(account, projectId, destinationWorkspaceId, key) {
      if (account === null) throw new TransfersError("not_signed_in");
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        const authority = await readSourceProject(tx, projectId, account.humanId);
        rejectSameWorkspace(authority.source.id, destinationWorkspaceId);

        await requireDestinationMember(tx, destinationWorkspaceId, account.humanId);
        const destination = await readSharedDestination(tx, destinationWorkspaceId);
        if (!(await hasCreateProjectsAuthority(tx, destination.id, account.humanId))) {
          throw new TransfersError("destination_authority_required");
        }
        const token = randomBytes(32).toString("base64url");
        const authorization = await createAuthorization(tx, {
          projectId,
          sourceWorkspaceId: authority.source.id,
          destinationWorkspaceId: destination.id,
          authorizedByHumanId: account.humanId,
          token,
        });
        return acceptInTransaction(
          tx,
          {
            id: authorization.id,
            projectId: authorization.projectId,
            sourceWorkspaceId: authorization.sourceWorkspaceId,
            destinationWorkspaceId: authorization.destinationWorkspaceId,
            authorizedByHumanId: account.humanId,
          },
          account.humanId,
          key,
        );
      });
    },
  };
}

import { randomUUID } from "node:crypto";
import {
  AgentKeyEventType,
  ProjectAccessEventType,
  ProjectAccessLevel,
  WorkSessionStatus,
  WorkspaceKind,
  type AccountStatus,
} from "@orrery/contract";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  accountRecoveryEvents,
  agentApiKeys,
  agentKeyEvents,
  agents,
  browserSessions,
  humans,
  issues,
  projectAccessEvents,
  projectAccessGrants,
  projectTransferAuthorizations,
  projects,
  workSessions,
  workspaceMemberships,
  workspaceOwnershipGuards,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";

export type DeactivationErrorKind =
  | "not_signed_in"
  | "not_system_administrator"
  | "account_not_found"
  | "last_admin"
  | "already_deactivated"
  | "already_active";

const messages: Record<DeactivationErrorKind, string> = {
  not_signed_in: "Not signed in.",
  not_system_administrator: "Only a system administrator can change account status.",
  account_not_found: "No account has that id.",
  last_admin: "The last active system administrator cannot be deactivated.",
  already_deactivated: "This account is already deactivated.",
  already_active: "This account is not deactivated.",
};

export class DeactivationError extends Error {
  readonly kind: DeactivationErrorKind;

  constructor(kind: DeactivationErrorKind) {
    super(messages[kind]);
    this.name = "DeactivationError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new DeactivationError("not_signed_in");
  return account;
}

async function requireActiveAdministrator(tx: DbTransaction, humanId: string) {
  const [admin] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(
      and(
        eq(humans.id, humanId),
        eq(humans.isSystemAdministrator, true),
        isNull(humans.deactivatedAt),
      ),
    )
    .limit(1);
  if (admin === undefined) throw new DeactivationError("not_system_administrator");
}

async function accountById(tx: DbTransaction, humanId: string) {
  const [row] = await tx
    .select({
      id: humans.id,
      email: humans.email,
      isSystemAdministrator: humans.isSystemAdministrator,
      deactivatedAt: humans.deactivatedAt,
    })
    .from(humans)
    .where(eq(humans.id, humanId))
    .limit(1)

    .for("update");
  if (row === undefined) throw new DeactivationError("account_not_found");
  return row;
}

async function lockOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function bumpGuards(tx: DbTransaction, workspaceIds: readonly string[]) {
  for (const workspaceId of workspaceIds) {
    await tx
      .insert(workspaceOwnershipGuards)
      .values({ workspaceId, version: 0 })
      .onConflictDoUpdate({
        target: workspaceOwnershipGuards.workspaceId,
        set: { version: sql`${workspaceOwnershipGuards.version} + 1` },
      });
  }
}

async function recordAccountEvent(
  tx: DbTransaction,
  input: {
    humanId: string;
    actorHumanId: string;
    type: "account_deactivated" | "account_reactivated";
  },
) {
  await tx.insert(accountRecoveryEvents).values({
    id: randomUUID(),
    humanId: input.humanId,
    actorHumanId: input.actorHumanId,
    type: input.type,
    createdAt: sql`statement_timestamp()`,
  });
}

export interface DeactivationDeps {
  db: PostgresJsDatabase;
}

export interface DeactivationService {
  deactivate(account: SessionAccount | null, humanId: string): Promise<AccountStatus>;
  reactivate(account: SessionAccount | null, humanId: string): Promise<AccountStatus>;
}

export function createDeactivationService({ db }: DeactivationDeps): DeactivationService {
  return {
    async deactivate(account, humanId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockOwnershipWrites(tx);
        await requireActiveAdministrator(tx, actor.humanId);
        const target = await accountById(tx, humanId);
        if (target.deactivatedAt !== null) throw new DeactivationError("already_deactivated");

        if (target.isSystemAdministrator) {
          const [activeAdmins] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(humans)
            .where(and(eq(humans.isSystemAdministrator, true), isNull(humans.deactivatedAt)));
          if ((activeAdmins?.count ?? 0) <= 1) throw new DeactivationError("last_admin");
        }

        const shared = await tx
          .select({ workspaceId: workspaceMemberships.workspaceId })
          .from(workspaceMemberships)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
          .where(
            and(
              eq(workspaceMemberships.humanId, humanId),
              eq(workspaces.kind, WorkspaceKind.enum.shared),
              isNull(workspaceMemberships.suspendedAt),
            ),
          );
        const workspaceIds = shared.map((row) => row.workspaceId).toSorted();
        await bumpGuards(tx, workspaceIds);

        await tx
          .update(humans)
          .set({ deactivatedAt: sql`statement_timestamp()` })
          .where(eq(humans.id, humanId));

        await tx.delete(browserSessions).where(eq(browserSessions.humanId, humanId));

        await tx
          .update(projectTransferAuthorizations)
          .set({ status: "revoked", revokedAt: sql`statement_timestamp()` })
          .where(
            and(
              eq(projectTransferAuthorizations.authorizedByHumanId, humanId),
              eq(projectTransferAuthorizations.status, "pending"),
            ),
          );

        const ownedAgents = tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.humanId, humanId));
        const revokedKeys = await tx
          .update(agentApiKeys)
          .set({
            revokedAt: sql`statement_timestamp()`,
            revokedByHumanId: actor.humanId,
          })
          .where(and(isNull(agentApiKeys.revokedAt), inArray(agentApiKeys.agentId, ownedAgents)))
          .returning({
            id: agentApiKeys.id,
            agentId: agentApiKeys.agentId,
            workspaceId: agentApiKeys.workspaceId,
          });
        for (const key of revokedKeys) {
          await tx.insert(agentKeyEvents).values({
            id: randomUUID(),
            keyId: key.id,
            agentId: key.agentId,
            workspaceId: key.workspaceId,
            type: AgentKeyEventType.enum.agent_key_revoked,
            actorHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
          });
        }

        const grants = await tx
          .select({
            id: projectAccessGrants.id,
            projectId: projectAccessGrants.projectId,
            workspaceId: projects.workspaceId,
            level: projectAccessGrants.level,
          })
          .from(projectAccessGrants)
          .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
          .where(eq(projectAccessGrants.humanId, humanId));
        if (grants.length > 0) {
          await tx.delete(projectAccessGrants).where(
            inArray(
              projectAccessGrants.id,
              grants.map((grant) => grant.id),
            ),
          );
          for (const grant of grants) {
            await tx.insert(projectAccessEvents).values({
              id: randomUUID(),
              projectId: grant.projectId,
              workspaceId: grant.workspaceId,
              actorHumanId: actor.humanId,
              subjectHumanId: humanId,
              type: ProjectAccessEventType.enum.project_access_revoked,
              level: null,
              previousLevel: ProjectAccessLevel.parse(grant.level),
              createdAt: sql`statement_timestamp()`,
            });
          }
        }

        const sharedWorkspaceIds = tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.kind, WorkspaceKind.enum.shared));

        await tx
          .select({ id: workspaceMemberships.id })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
              inArray(workspaceMemberships.workspaceId, sharedWorkspaceIds),
            ),
          )
          .orderBy(workspaceMemberships.id)
          .for("update");
        await tx
          .update(workspaceMemberships)
          .set({
            suspendedAt: sql`statement_timestamp()`,
            isFormerOwner: sql`${workspaceMemberships.isOwner}`,
            isOwner: false,
            canCreateProjects: false,
            canInviteMembers: false,
            canRemoveMembers: false,
            canManageMemberPermissions: false,
          })
          .where(
            and(
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
              inArray(workspaceMemberships.workspaceId, sharedWorkspaceIds),
            ),
          );

        const claims = await tx
          .select({ id: workSessions.id, issueId: workSessions.issueId })
          .from(workSessions)
          .where(
            and(
              eq(workSessions.status, WorkSessionStatus.enum.active),
              inArray(workSessions.agentId, ownedAgents),
            ),
          );
        if (claims.length > 0) {
          const issueIds = [...new Set(claims.map((claim) => claim.issueId))].toSorted();
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(inArray(issues.id, issueIds))
            .orderBy(issues.id)
            .for("update");
          const claimIds = claims.map((claim) => claim.id);
          await tx
            .update(workSessions)
            .set({
              status: WorkSessionStatus.enum.expired,
              endedAt: sql`statement_timestamp()`,
              updatedAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(workSessions.status, WorkSessionStatus.enum.active),
                lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
                inArray(workSessions.id, claimIds),
              ),
            );
          await tx
            .update(workSessions)
            .set({
              status: WorkSessionStatus.enum.released,
              endedAt: sql`statement_timestamp()`,
              updatedAt: sql`statement_timestamp()`,
            })
            .where(
              and(
                eq(workSessions.status, WorkSessionStatus.enum.active),
                gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
                inArray(workSessions.id, claimIds),
              ),
            );

          await tx
            .update(issues)
            .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
            .where(and(inArray(issues.id, issueIds), eq(issues.status, "in_progress")));
        }

        await recordAccountEvent(tx, {
          humanId,
          actorHumanId: actor.humanId,
          type: "account_deactivated",
        });

        const [updated] = await tx
          .select({ deactivatedAt: humans.deactivatedAt })
          .from(humans)
          .where(eq(humans.id, humanId))
          .limit(1);
        return {
          humanId,
          email: target.email,
          deactivatedAt: updated?.deactivatedAt?.toISOString() ?? null,
          isSystemAdministrator: target.isSystemAdministrator,
        };
      });
    },

    async reactivate(account, humanId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireActiveAdministrator(tx, actor.humanId);
        const target = await accountById(tx, humanId);
        if (target.deactivatedAt === null) throw new DeactivationError("already_active");

        await tx.update(humans).set({ deactivatedAt: null }).where(eq(humans.id, humanId));
        await recordAccountEvent(tx, {
          humanId,
          actorHumanId: actor.humanId,
          type: "account_reactivated",
        });
        return {
          humanId,
          email: target.email,
          deactivatedAt: null,
          isSystemAdministrator: target.isSystemAdministrator,
        };
      });
    },
  };
}

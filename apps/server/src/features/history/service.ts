import {
  avatarUrlFor,
  InvitationStatus,
  ProjectAccessLevel,
  WorkspaceKind,
  type Actor,
  type HistoryEvent,
} from "@orrery/contract";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import {
  accountRecoveryEvents,
  agentKeyEvents,
  agents,
  humans,
  instanceSetup,
  invitations,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projects,
  workspaceEvents,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { projectAccessAtLeast } from "../projects/index.ts";

type ProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export type HistoryErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "project_not_found"
  | "workspace_history_forbidden"
  | "not_system_administrator";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  project_not_found: "This project does not exist.",
  workspace_history_forbidden:
    "Only a workspace owner or permission manager can view this history.",
  not_system_administrator: "Only a system administrator can view installation history.",
} as const satisfies Record<HistoryErrorKind, string>;

export class HistoryError extends Error {
  readonly kind: HistoryErrorKind;

  constructor(kind: HistoryErrorKind) {
    super(messages[kind]);
    this.name = "HistoryError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new HistoryError("not_signed_in");
  return account;
}

function humanActor(
  id: string | null,
  email: string | null,
  deactivatedAt: Date | null = null,
  avatarObjectId: string | null = null,
): Actor {
  const deactivated = deactivatedAt !== null;
  const label = email ?? id ?? "unknown human";
  return {
    humanId: id,
    email,
    displayName: deactivated ? `${label} (deactivated)` : label,
    ...(deactivated ? { deactivated: true } : {}),
    avatarUrl: id !== null && avatarObjectId !== null ? avatarUrlFor(id, avatarObjectId) : null,
  };
}

function agentActor(id: string | null, name: string | null): Actor {
  return {
    agentId: id,
    agentName: name,
    displayName: name ?? id ?? "unknown agent",
    avatarUrl: null,
  };
}

type Db = PostgresJsDatabase | DbTransaction;

type Scope = HistoryEvent["scope"];

function installationScope(): Scope {
  return { kind: "installation", id: "installation", name: null };
}

function sortNewestFirst(events: HistoryEvent[]): HistoryEvent[] {
  return events.toSorted((a, b) =>
    a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
  );
}

const INSTALLATION_TYPE = {
  bootstrap: "installation_bootstrap",
  invited: "installation_invitation_created",
  accepted: "installation_invitation_accepted",
  declined: "installation_invitation_declined",
  expired: "installation_invitation_expired",
  revoked: "installation_invitation_revoked",
} as const;

async function loadWorkspaceEvents(db: Db, workspaceId: string, workspaceName: string) {
  const actorHuman = alias(humans, "history_workspace_actor");
  const subjectHuman = alias(humans, "history_workspace_subject");
  const rows = await db
    .select({
      id: workspaceEvents.id,
      type: workspaceEvents.type,
      createdAt: workspaceEvents.createdAt,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      actorDeactivatedAt: actorHuman.deactivatedAt,
      actorAvatarObjectId: actorHuman.avatarObjectId,
      subjectId: subjectHuman.id,
      subjectEmail: subjectHuman.email,
      subjectDeactivatedAt: subjectHuman.deactivatedAt,
      subjectAvatarObjectId: subjectHuman.avatarObjectId,
    })
    .from(workspaceEvents)
    .leftJoin(actorHuman, eq(actorHuman.id, workspaceEvents.actorHumanId))
    .leftJoin(subjectHuman, eq(subjectHuman.id, workspaceEvents.subjectHumanId))
    .where(eq(workspaceEvents.workspaceId, workspaceId))
    .orderBy(desc(workspaceEvents.createdAt), desc(workspaceEvents.id));
  const scope: Scope = { kind: "workspace", id: workspaceId, name: workspaceName };
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "workspace_access",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),
    actor: humanActor(row.actorId, row.actorEmail, row.actorDeactivatedAt, row.actorAvatarObjectId),
    subject: humanActor(
      row.subjectId,
      row.subjectEmail,
      row.subjectDeactivatedAt,
      row.subjectAvatarObjectId,
    ),
    summary: null,
    level: null,
    previousLevel: null,
  }));
}

async function loadKeyEvents(db: Db, workspaceId: string, workspaceName: string) {
  const actorHuman = alias(humans, "history_key_actor");
  const rows = await db
    .select({
      id: agentKeyEvents.id,
      type: agentKeyEvents.type,
      createdAt: agentKeyEvents.createdAt,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      actorDeactivatedAt: actorHuman.deactivatedAt,
      actorAvatarObjectId: actorHuman.avatarObjectId,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(agentKeyEvents)
    .innerJoin(agents, eq(agents.id, agentKeyEvents.agentId))
    .leftJoin(actorHuman, eq(actorHuman.id, agentKeyEvents.actorHumanId))
    .where(eq(agentKeyEvents.workspaceId, workspaceId))
    .orderBy(desc(agentKeyEvents.createdAt), desc(agentKeyEvents.id));

  const scope: Scope = { kind: "workspace", id: workspaceId, name: workspaceName };
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "agent_key",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),
    actor: humanActor(row.actorId, row.actorEmail, row.actorDeactivatedAt, row.actorAvatarObjectId),
    subject: agentActor(row.agentId, row.agentName),
    summary: null,
    level: null,
    previousLevel: null,
  }));
}

async function loadProjectAccessEvents(
  db: Db,

  workspaceId: string,

  projectIds?: readonly string[],
): Promise<HistoryEvent[]> {
  if (projectIds !== undefined && projectIds.length === 0) return [];
  const actorHuman = alias(humans, "history_access_actor");
  const subjectHuman = alias(humans, "history_access_subject");
  const conditions = [eq(projectAccessEvents.workspaceId, workspaceId)];
  if (projectIds !== undefined) {
    conditions.push(inArray(projectAccessEvents.projectId, [...projectIds]));
  }
  const rows = await db
    .select({
      id: projectAccessEvents.id,
      projectId: projectAccessEvents.projectId,
      type: projectAccessEvents.type,
      level: projectAccessEvents.level,
      previousLevel: projectAccessEvents.previousLevel,
      createdAt: projectAccessEvents.createdAt,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      actorDeactivatedAt: actorHuman.deactivatedAt,
      actorAvatarObjectId: actorHuman.avatarObjectId,
      subjectId: subjectHuman.id,
      subjectEmail: subjectHuman.email,
      subjectDeactivatedAt: subjectHuman.deactivatedAt,
      subjectAvatarObjectId: subjectHuman.avatarObjectId,
    })
    .from(projectAccessEvents)
    .leftJoin(actorHuman, eq(actorHuman.id, projectAccessEvents.actorHumanId))
    .leftJoin(subjectHuman, eq(subjectHuman.id, projectAccessEvents.subjectHumanId))
    .where(and(...conditions))
    .orderBy(desc(projectAccessEvents.createdAt), desc(projectAccessEvents.id));
  if (rows.length === 0) return [];
  const projectIdList = [...new Set(rows.map((row) => row.projectId))];
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIdList));
  const names = new Map(projectRows.map((project) => [project.id, project.name]));
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "project_access",
    type: row.type,

    scope: {
      kind: "project",
      id: row.projectId,
      name: names.get(row.projectId) ?? null,
    },
    createdAt: row.createdAt.toISOString(),
    actor: humanActor(row.actorId, row.actorEmail, row.actorDeactivatedAt, row.actorAvatarObjectId),
    subject: humanActor(
      row.subjectId,
      row.subjectEmail,
      row.subjectDeactivatedAt,
      row.subjectAvatarObjectId,
    ),
    summary: null,
    level: row.level === null ? null : ProjectAccessLevel.parse(row.level),
    previousLevel: row.previousLevel === null ? null : ProjectAccessLevel.parse(row.previousLevel),
  }));
}

async function loadProjectActivity(db: Db, projectId: string, projectName: string) {
  const actorHuman = alias(humans, "history_activity_human");
  const actorAgent = alias(agents, "history_activity_agent");
  const rows = await db
    .select({
      id: projectActivity.id,
      type: projectActivity.type,
      summary: projectActivity.summary,
      createdAt: projectActivity.createdAt,
      humanId: actorHuman.id,
      humanEmail: actorHuman.email,
      humanDeactivatedAt: actorHuman.deactivatedAt,
      humanAvatarObjectId: actorHuman.avatarObjectId,
      agentId: actorAgent.id,
      agentName: actorAgent.name,
    })
    .from(projectActivity)
    .leftJoin(actorHuman, eq(actorHuman.id, projectActivity.actorHumanId))
    .leftJoin(actorAgent, eq(actorAgent.id, projectActivity.actorAgentId))
    .where(eq(projectActivity.projectId, projectId))
    .orderBy(desc(projectActivity.createdAt), desc(projectActivity.id));
  const scope: Scope = { kind: "project", id: projectId, name: projectName };
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "project_activity",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),
    actor:
      row.agentId !== null
        ? agentActor(row.agentId, row.agentName)
        : humanActor(row.humanId, row.humanEmail, row.humanDeactivatedAt, row.humanAvatarObjectId),
    subject: null,
    summary: row.summary,
    level: null,
    previousLevel: null,
  }));
}

async function loadInstallationEvents(db: Db): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  const scope = installationScope();

  const [setup] = await db
    .select({
      humanId: instanceSetup.administratorHumanId,
      email: humans.email,
      deactivatedAt: humans.deactivatedAt,
      avatarObjectId: humans.avatarObjectId,
      createdAt: instanceSetup.completedAt,
    })
    .from(instanceSetup)
    .innerJoin(humans, eq(humans.id, instanceSetup.administratorHumanId))
    .limit(1);
  if (setup !== undefined) {
    events.push({
      id: `installation_setup:${setup.humanId}`,
      kind: "installation_access",
      type: INSTALLATION_TYPE.bootstrap,
      scope,
      createdAt: setup.createdAt.toISOString(),
      actor: humanActor(setup.humanId, setup.email, setup.deactivatedAt, setup.avatarObjectId),
      subject: humanActor(setup.humanId, setup.email, setup.deactivatedAt, setup.avatarObjectId),
      summary: `Installation bootstrapped by ${setup.email}`,
      level: null,
      previousLevel: null,
    });
  }

  const inviter = alias(humans, "history_invitation_inviter");
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      status: invitations.status,
      createdAt: invitations.createdAt,
      acceptedAt: invitations.acceptedAt,
      declinedAt: invitations.declinedAt,
      expiredAt: invitations.expiredAt,
      revokedAt: invitations.revokedAt,
      inviterId: inviter.id,
      inviterEmail: inviter.email,
      inviterDeactivatedAt: inviter.deactivatedAt,
      inviterAvatarObjectId: inviter.avatarObjectId,
    })
    .from(invitations)
    .leftJoin(inviter, eq(inviter.id, invitations.invitedByHumanId))
    .orderBy(desc(invitations.createdAt), desc(invitations.id));
  for (const row of rows) {
    const inviterActor = humanActor(
      row.inviterId,
      row.inviterEmail,
      row.inviterDeactivatedAt,
      row.inviterAvatarObjectId,
    );
    const inviteeActor = humanActor(null, row.email);
    const add = (type: string, at: Date | null, actor: Actor, subject: Actor) => {
      if (at === null) return;
      events.push({
        id: `${row.id}:${type}`,
        kind: "installation_access",
        type,
        scope,
        createdAt: at.toISOString(),
        actor,
        subject,
        summary: `Installation invitation for ${row.email}`,
        level: null,
        previousLevel: null,
      });
    };
    add(INSTALLATION_TYPE.invited, row.createdAt, inviterActor, inviteeActor);

    if (row.status === InvitationStatus.enum.accepted)
      add(INSTALLATION_TYPE.accepted, row.acceptedAt, inviteeActor, inviterActor);
    if (row.status === InvitationStatus.enum.declined)
      add(INSTALLATION_TYPE.declined, row.declinedAt, inviteeActor, inviterActor);
    if (row.status === InvitationStatus.enum.expired)
      add(INSTALLATION_TYPE.expired, row.expiredAt, inviterActor, inviteeActor);
    if (row.status === InvitationStatus.enum.revoked)
      add(INSTALLATION_TYPE.revoked, row.revokedAt, inviterActor, inviteeActor);
  }
  return events;
}

async function loadAccountStatusEvents(db: Db): Promise<HistoryEvent[]> {
  const subjectHuman = alias(humans, "history_account_subject");
  const actorHuman = alias(humans, "history_account_actor");
  const rows = await db
    .select({
      id: accountRecoveryEvents.id,
      type: accountRecoveryEvents.type,
      createdAt: accountRecoveryEvents.createdAt,
      subjectId: subjectHuman.id,
      subjectEmail: subjectHuman.email,
      subjectDeactivatedAt: subjectHuman.deactivatedAt,
      subjectAvatarObjectId: subjectHuman.avatarObjectId,
      actorId: actorHuman.id,
      actorEmail: actorHuman.email,
      actorDeactivatedAt: actorHuman.deactivatedAt,
      actorAvatarObjectId: actorHuman.avatarObjectId,
    })
    .from(accountRecoveryEvents)
    .innerJoin(subjectHuman, eq(subjectHuman.id, accountRecoveryEvents.humanId))
    .leftJoin(actorHuman, eq(actorHuman.id, accountRecoveryEvents.actorHumanId))
    .where(
      inArray(accountRecoveryEvents.type, [
        "account_deactivated",
        "account_reactivated",

        "workspace_ownership_recovered",
      ]),
    )
    .orderBy(desc(accountRecoveryEvents.createdAt), desc(accountRecoveryEvents.id));
  const scope = installationScope();
  return rows.map((row): HistoryEvent => ({
    id: row.id,
    kind: "account_status",
    type: row.type,
    scope,
    createdAt: row.createdAt.toISOString(),

    actor: humanActor(
      row.actorId ?? row.subjectId,
      row.actorEmail ?? row.subjectEmail,
      row.actorDeactivatedAt ?? row.subjectDeactivatedAt,
      row.actorAvatarObjectId ?? row.subjectAvatarObjectId,
    ),
    subject: humanActor(
      row.subjectId,
      row.subjectEmail,
      row.subjectDeactivatedAt,
      row.subjectAvatarObjectId,
    ),
    summary: null,
    level: null,
    previousLevel: null,
  }));
}

export interface HistoryDeps {
  db: PostgresJsDatabase;

  projectAccessCeiling: ProjectAccessCeiling;
}

export interface HistoryService {
  workspaceHistory(account: SessionAccount | null, workspaceId: string): Promise<HistoryEvent[]>;
  projectHistory(account: SessionAccount | null, projectId: string): Promise<HistoryEvent[]>;
  installationHistory(account: SessionAccount | null): Promise<HistoryEvent[]>;
}

export function createHistoryService({ db, projectAccessCeiling }: HistoryDeps): HistoryService {
  return {
    async workspaceHistory(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          const [row] = await tx
            .select({
              id: workspaces.id,
              kind: workspaces.kind,
              name: workspaces.name,
              personalOwnerId: workspaces.personalOwnerHumanId,
              isOwner: workspaceMemberships.isOwner,
              canManageMemberPermissions: workspaceMemberships.canManageMemberPermissions,
            })
            .from(workspaces)
            .leftJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, workspaces.id),
                eq(workspaceMemberships.humanId, actor.humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .where(eq(workspaces.id, workspaceId))
            .limit(1);
          if (row === undefined) throw new HistoryError("workspace_not_found");

          const personal = row.kind === WorkspaceKind.enum.personal;
          const isOwner = personal ? row.personalOwnerId === actor.humanId : row.isOwner === true;

          const inScope = personal ? row.personalOwnerId === actor.humanId : row.isOwner !== null;
          if (!inScope) throw new HistoryError("workspace_not_found");

          if (!isOwner && row.canManageMemberPermissions !== true) {
            throw new HistoryError("workspace_history_forbidden");
          }

          const events: HistoryEvent[] = [
            ...(await loadWorkspaceEvents(tx, workspaceId, row.name)),
          ];
          if (isOwner) {
            events.push(...(await loadKeyEvents(tx, workspaceId, row.name)));

            events.push(...(await loadProjectAccessEvents(tx, workspaceId)));
          } else {
            const managed = await tx
              .select({ id: projects.id })
              .from(projects)
              .innerJoin(
                projectAccessGrants,
                and(
                  eq(projectAccessGrants.projectId, projects.id),
                  eq(projectAccessGrants.humanId, actor.humanId),
                  eq(projectAccessGrants.level, ProjectAccessLevel.enum.manage),
                ),
              )
              .where(eq(projects.workspaceId, workspaceId));
            events.push(
              ...(await loadProjectAccessEvents(
                tx,
                workspaceId,
                managed.map((project) => project.id),
              )),
            );
          }
          return sortNewestFirst(events);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async projectHistory(account, projectId) {
      const actor = requireAccount(account);
      return db.transaction(
        async (tx) => {
          const [project] = await tx
            .select({ id: projects.id, workspaceId: projects.workspaceId, name: projects.name })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (project === undefined) throw new HistoryError("project_not_found");

          const ceiling = await projectAccessCeiling(tx, project.workspaceId, actor.humanId, [
            projectId,
          ]);
          const level = ceiling.get(projectId) ?? null;
          if (level === null) throw new HistoryError("project_not_found");

          const events = await loadProjectActivity(tx, projectId, project.name);
          if (projectAccessAtLeast(level, ProjectAccessLevel.enum.manage)) {
            events.push(...(await loadProjectAccessEvents(tx, project.workspaceId, [projectId])));
          }
          return sortNewestFirst(events);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async installationHistory(account) {
      const actor = requireAccount(account);
      if (!actor.isSystemAdministrator) throw new HistoryError("not_system_administrator");

      return sortNewestFirst([
        ...(await loadInstallationEvents(db)),
        ...(await loadAccountStatusEvents(db)),
      ]);
    },
  };
}

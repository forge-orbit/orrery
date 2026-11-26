import {
  AgentKeyEventType,
  AgentKeyValidity,
  AssigneeType,
  AttachmentHolderType,
  DispatchState,
  FallbackPolicy,
  InvitationDelivery,
  InvitationStatus,
  IssueLinkKind,
  IssuePriority,
  IssueStatus,
  type IssueActivityDetail,
  NotificationKind,
  TERMINAL_ISSUE_STATUSES,
  ProjectAccessEventType,
  ProjectAccessLevel,
  ProjectActivityType,
  QuestionStatus,
  RunnerCommandKind,
  type RunnerCommandPayload,
  type HarnessCatalog,
  RunEndReason,
  RunStatus,
  SessionActivityKind,
  TransferAuthorizationStatus,
  WorkSessionStatus,
  WorkspaceKind,
  SmtpSecurity,
  StoredObjectStatus,
  type StreamChunk,
} from "@orrery/contract";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const storedObjects = pgTable(
  "stored_objects",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    status: text("status").$type<StoredObjectStatus>().notNull().default("pending"),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "stored_objects_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(StoredObjectStatus))})`,
    ),
    check("stored_objects_byte_size_positive", sql`${t.byteSize} > 0`),
    check("stored_objects_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "stored_objects_key_relative",
      sql`${t.key} !~ '^/' and ${t.key} !~ '(^|/)\\.\\.(/|$)' and ${t.key} !~ '\\\\'`,
    ),
    check(
      "stored_objects_deleted_at_matches_status",
      sql`(${t.status} = ${sql.raw(`'${StoredObjectStatus.enum.deleted}'`)}) = (${t.deletedAt} is not null)`,
    ),
  ],
);

export const humans = pgTable(
  "humans",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    /**
     * GitHub-style unique handle. The backfill migration makes this NOT NULL and
     * installs a BEFORE INSERT trigger that derives it from the email local part
     * (with -2, -3, … collision suffixes), so legacy and directly-seeded rows are
     * covered even though Drizzle's builder still permits omitting it.
     */
    handle: text("handle").$type<string>(),
    displayName: text("display_name"),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isSystemAdministrator: boolean("is_system_administrator").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),

    avatarObjectId: text("avatar_object_id").references(() => storedObjects.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    check("humans_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    check(
      "humans_handle_valid",
      sql`${t.handle} ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$' and char_length(${t.handle}) between 2 and 39`,
    ),
    uniqueIndex("humans_handle_unique").on(sql`lower(${t.handle})`),
    check(
      "humans_display_name_valid",
      sql`${t.displayName} is null or (btrim(${t.displayName}) <> '' and char_length(${t.displayName}) <= 120)`,
    ),
    uniqueIndex("one_human_per_avatar_object").on(t.avatarObjectId),
  ],
);

function sqlLiteralList(enumeration: { options: readonly string[] }): string {
  return enumeration.options.map((value) => `'${value}'`).join(", ");
}

const personalKindSql = sql.raw(`'${WorkspaceKind.enum.personal}'`);

const pendingStatusSql = sql.raw(`'${InvitationStatus.enum.pending}'`);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<WorkspaceKind>().notNull(),
    name: text("name").notNull(),
    personalOwnerHumanId: text("personal_owner_human_id").references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("workspace_kind", sql`${t.kind} in (${sql.raw(sqlLiteralList(WorkspaceKind))})`),

    check(
      "workspace_owner_matches_kind",
      sql`(${t.kind} = ${personalKindSql}) = (${t.personalOwnerHumanId} is not null)`,
    ),

    uniqueIndex("one_personal_workspace_per_human")
      .on(t.personalOwnerHumanId)
      .where(sql`${t.kind} = ${personalKindSql}`),
  ],
);

export const workspaceOwnershipGuards = pgTable("workspace_ownership_guards", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(0),
});

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    isOwner: boolean("is_owner").notNull().default(false),
    canCreateProjects: boolean("can_create_projects").notNull().default(false),
    canInviteMembers: boolean("can_invite_members").notNull().default(false),
    canRemoveMembers: boolean("can_remove_members").notNull().default(false),
    canManageMemberPermissions: boolean("can_manage_member_permissions").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    suspendedAt: timestamp("suspended_at", { withTimezone: true }),

    isFormerOwner: boolean("is_former_owner").notNull().default(false),
  },
  (t) => [
    uniqueIndex("one_membership_per_workspace_and_human").on(t.workspaceId, t.humanId),

    index("workspace_memberships_human_id").on(t.humanId),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),

    email: text("email").notNull(),
    status: text("status").$type<InvitationStatus>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByHumanId: text("invited_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status").$type<InvitationDelivery>(),
    deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),
  },
  (t) => [
    check("workspace_invitations_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    check(
      "workspace_invitations_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(InvitationStatus))})`,
    ),
    check(
      "workspace_invitations_delivery_status",
      sql`(${t.deliveryStatus} is null or ${t.deliveryStatus} in (${sql.raw(
        sqlLiteralList(InvitationDelivery),
      )}))`,
    ),

    uniqueIndex("one_pending_workspace_invitation_per_email")
      .on(t.workspaceId, t.email)
      .where(sql`${t.status} = ${pendingStatusSql}`),
  ],
);

export const workspaceEventTypes = [
  "workspace_created",
  "member_joined",
  "owner_appointed",
  "member_removed",
  "owner_removed",

  "member_left",
  "owner_left",
  "create_projects_granted",
  "create_projects_revoked",
  "invite_members_granted",
  "invite_members_revoked",
  "remove_members_granted",
  "remove_members_revoked",
  "manage_member_permissions_granted",
  "manage_member_permissions_revoked",

  "project_transfer_authorized",
  "project_transfer_received",
  "project_transferred_out",

  "workspace_ownership_recovered",
] as const;
export type WorkspaceEventType = (typeof workspaceEventTypes)[number];

export const workspaceEvents = pgTable(
  "workspace_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type").$type<WorkspaceEventType>().notNull(),

    actorHumanId: text("actor_human_id")
      .notNull()
      .references(() => humans.id),
    subjectHumanId: text("subject_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspace_event_type",
      sql`${t.type} in (${sql.raw(workspaceEventTypes.map((value) => `'${value}'`).join(", "))})`,
    ),
    index("workspace_events_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export const browserSessions = pgTable("browser_sessions", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const instanceSetup = pgTable(
  "instance_setup",
  {
    id: boolean("id").primaryKey(),
    administratorHumanId: text("administrator_human_id")
      .notNull()
      .references(() => humans.id),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_setup_singleton", sql`${t.id} = true`)],
);

export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: boolean("id").primaryKey(),
    smtpHost: text("smtp_host").notNull(),
    smtpPort: integer("smtp_port").notNull(),
    smtpSecurity: text("smtp_security").$type<SmtpSecurity>().notNull(),
    smtpUsername: text("smtp_username"),
    smtpPasswordEncrypted: text("smtp_password_encrypted"),
    smtpFrom: text("smtp_from").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByHumanId: text("updated_by_human_id")
      .notNull()
      .references(() => humans.id),
  },
  (t) => [
    check("instance_settings_singleton", sql`${t.id} = true`),

    check(
      "instance_settings_smtp_security",
      sql`${t.smtpSecurity} in (${sql.raw(sqlLiteralList(SmtpSecurity))})`,
    ),
  ],
);

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const accountRecoveryEventTypes = [
  "password_reset_requested",
  "password_reset_completed",
  "local_recovery_completed",

  "account_deactivated",
  "account_reactivated",

  "workspace_ownership_recovered",
] as const;
export type AccountRecoveryEventType = (typeof accountRecoveryEventTypes)[number];

export const accountRecoveryEvents = pgTable(
  "account_recovery_events",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),

    actorHumanId: text("actor_human_id").references(() => humans.id),
    type: text("type").$type<AccountRecoveryEventType>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "account_recovery_events_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList({ options: accountRecoveryEventTypes }))})`,
    ),
    index("account_recovery_events_human_created").on(t.humanId, t.createdAt),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),

    email: text("email").notNull(),
    status: text("status").$type<InvitationStatus>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedByHumanId: text("invited_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    deliveryStatus: text("delivery_status").$type<InvitationDelivery>(),
    deliveryAttemptedAt: timestamp("delivery_attempted_at", { withTimezone: true }),
  },
  (t) => [
    check("invitations_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),

    check("invitations_status", sql`${t.status} in (${sql.raw(sqlLiteralList(InvitationStatus))})`),
    check(
      "invitations_delivery_status",
      sql`(${t.deliveryStatus} is null or ${t.deliveryStatus} in (${sql.raw(
        sqlLiteralList(InvitationDelivery),
      )}))`,
    ),

    uniqueIndex("one_pending_invitation_per_email")
      .on(t.email)
      .where(sql`${t.status} = ${pendingStatusSql}`),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),

    key: text("key").notNull(),
    createdByHumanId: text("created_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextIssueNumber: integer("next_issue_number").notNull().default(1),

    fallbackPolicy: text("fallback_policy")
      .$type<FallbackPolicy>()
      .notNull()
      .default("require_human"),
  },
  (t) => [
    check("projects_key_format", sql`${t.key} ~ '^[A-Z][A-Z0-9]{1,9}$'`),
    check("projects_description_length", sql`char_length(${t.description}) <= 350`),
    check("projects_next_issue_number_positive", sql`${t.nextIssueNumber} > 0`),
    check(
      "projects_fallback_policy",
      sql`${t.fallbackPolicy} in (${sql.raw(sqlLiteralList(FallbackPolicy))})`,
    ),

    uniqueIndex("one_project_key_per_workspace").on(t.workspaceId, t.key),
    index("projects_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export const projectTransferAuthorizations = pgTable(
  "project_transfer_authorizations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceWorkspaceId: text("source_workspace_id")
      .notNull()
      .references(() => workspaces.id),
    destinationWorkspaceId: text("destination_workspace_id")
      .notNull()
      .references(() => workspaces.id),
    authorizedByHumanId: text("authorized_by_human_id")
      .notNull()
      .references(() => humans.id),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").$type<TransferAuthorizationStatus>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "project_transfer_authorizations_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(TransferAuthorizationStatus))})`,
    ),
    check(
      "project_transfer_authorizations_sides_differ",
      sql`${t.sourceWorkspaceId} <> ${t.destinationWorkspaceId}`,
    ),
    index("project_transfer_authorizations_project").on(t.projectId),
  ],
);

export const projectAccessGrants = pgTable(
  "project_access_grants",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    level: text("level").$type<ProjectAccessLevel>().notNull(),
    grantedByHumanId: text("granted_by_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("one_project_access_grant_per_human").on(t.projectId, t.humanId),

    check(
      "project_access_grants_level",
      sql`${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))})`,
    ),
    index("project_access_grants_human_id").on(t.humanId),
  ],
);

export const workspaceInvitationGrants = pgTable(
  "workspace_invitation_grants",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => workspaceInvitations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    level: text("level").$type<ProjectAccessLevel>().notNull(),
  },
  (t) => [
    uniqueIndex("one_invitation_grant_per_project").on(t.invitationId, t.projectId),
    check(
      "workspace_invitation_grants_level",
      sql`${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))})`,
    ),
  ],
);

export const projectAccessEvents = pgTable(
  "project_access_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),

    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actorHumanId: text("actor_human_id")
      .notNull()
      .references(() => humans.id),
    subjectHumanId: text("subject_human_id")
      .notNull()
      .references(() => humans.id),
    type: text("type").$type<ProjectAccessEventType>().notNull(),
    level: text("level").$type<ProjectAccessLevel>(),
    previousLevel: text("previous_level").$type<ProjectAccessLevel>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "project_access_events_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList(ProjectAccessEventType))})`,
    ),
    check(
      "project_access_events_level",
      sql`(${t.level} is null or ${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))}))`,
    ),
    check(
      "project_access_events_previous_level",
      sql`(${t.previousLevel} is null or ${t.previousLevel} in (${sql.raw(
        sqlLiteralList(ProjectAccessLevel),
      )}))`,
    ),

    check(
      "project_access_events_shape",
      sql`(
        (${t.type} = ${sql.raw(`'${ProjectAccessEventType.enum.project_access_granted}'`)}
          and ${t.level} is not null and ${t.previousLevel} is null)
        or (${t.type} = ${sql.raw(`'${ProjectAccessEventType.enum.project_access_level_changed}'`)}
          and ${t.level} is not null and ${t.previousLevel} is not null)
        or (${t.type} = ${sql.raw(`'${ProjectAccessEventType.enum.project_access_revoked}'`)}
          and ${t.level} is null and ${t.previousLevel} is not null)
      )`,
    ),
    index("project_access_events_project_created").on(t.projectId, t.createdAt),

    index("project_access_events_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("one_agent_name_per_human").on(t.humanId, t.name),
    index("agents_human_created").on(t.humanId, t.createdAt),
  ],
);

export const agentApiKeys = pgTable(
  "agent_api_keys",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdByHumanId: text("created_by_human_id")
      .notNull()
      .references(() => humans.id),
    validity: text("validity").$type<AgentKeyValidity>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    keyHint: text("key_hint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByHumanId: text("revoked_by_human_id").references(() => humans.id),

    replacesKeyId: text("replaces_key_id").references((): AnyPgColumn => agentApiKeys.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    check(
      "agent_api_keys_validity",
      sql`${t.validity} in (${sql.raw(sqlLiteralList(AgentKeyValidity))})`,
    ),
    index("agent_api_keys_workspace_created").on(t.workspaceId, t.createdAt),
    index("agent_api_keys_agent_created").on(t.agentId, t.createdAt),
  ],
);

export const agentApiKeyProjects = pgTable(
  "agent_api_key_projects",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => agentApiKeys.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    level: text("level").$type<ProjectAccessLevel>().notNull(),
  },
  (t) => [
    uniqueIndex("one_agent_key_project_per_project").on(t.keyId, t.projectId),
    check(
      "agent_api_key_projects_level",
      sql`${t.level} in (${sql.raw(sqlLiteralList(ProjectAccessLevel))})`,
    ),
  ],
);

export const agentKeyEvents = pgTable(
  "agent_key_events",
  {
    id: text("id").primaryKey(),
    keyId: text("key_id")
      .notNull()
      .references(() => agentApiKeys.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    type: text("type").$type<AgentKeyEventType>().notNull(),
    actorHumanId: text("actor_human_id")
      .notNull()
      .references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "agent_key_events_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList(AgentKeyEventType))})`,
    ),
    index("agent_key_events_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    harness: text("harness"),
    harnessVersion: text("harness_version"),
    nativeSessionId: text("native_session_id"),
    model: text("model"),
    status: text("status").$type<RunStatus>().notNull().default(RunStatus.enum.active),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason").$type<RunEndReason>(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  },
  (t) => [
    check("runs_status", sql`${t.status} in (${sql.raw(sqlLiteralList(RunStatus))})`),
    check(
      "runs_ended_reason",
      sql`${t.endedReason} is null or ${t.endedReason} in (${sql.raw(sqlLiteralList(RunEndReason))})`,
    ),
    uniqueIndex("one_run_per_agent_workspace_harness_session")
      .on(t.agentId, t.workspaceId, t.harness, t.nativeSessionId)
      .where(sql`${t.harness} is not null and ${t.nativeSessionId} is not null`),
    index("runs_workspace_created").on(t.workspaceId, t.createdAt),
    index("runs_agent_created").on(t.agentId, t.createdAt),
  ],
);

export const runModelChanges = pgTable(
  "run_model_changes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    fromModel: text("from_model"),
    toModel: text("to_model").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("run_model_changes_run_created").on(t.runId, t.createdAt)],
);

export const runChildren = pgTable(
  "run_children",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    agentType: text("agent_type"),
    childRunId: text("child_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    status: text("status").$type<RunStatus>().notNull().default(RunStatus.enum.active),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    check("run_children_status", sql`${t.status} in (${sql.raw(sqlLiteralList(RunStatus))})`),

    uniqueIndex("one_child_per_run_and_reported_identity")
      .on(t.runId, t.agentId, t.agentType, t.childRunId)
      .where(sql`${t.agentId} is not null or ${t.childRunId} is not null`),
    index("run_children_run_started").on(t.runId, t.startedAt),
  ],
);

export const issues = pgTable(
  "issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status").$type<IssueStatus>().notNull(),

    priority: text("priority").$type<IssuePriority>().notNull().default("none"),

    sortOrder: doublePrecision("sort_order").notNull(),

    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    updatedByHumanId: text("updated_by_human_id").references(() => humans.id),
    updatedByAgentId: text("updated_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),

    needsInput: boolean("needs_input").notNull().default(false),
    fallbackPolicyOverride: text("fallback_policy_override").$type<FallbackPolicy>(),

    assigneeType: text("assignee_type").$type<AssigneeType>(),
    assigneeId: text("assignee_id"),

    parentIssueId: text("parent_issue_id").references((): AnyPgColumn => issues.id),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByHumanId: text("deleted_by_human_id").references(() => humans.id),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "issues_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    check(
      "issues_updated_by_actor",
      sql`(${t.updatedByHumanId} is not null) <> (${t.updatedByAgentId} is not null)`,
    ),

    uniqueIndex("one_issue_number_per_project").on(t.projectId, t.number),

    index("issues_project_sort_order").on(t.projectId, t.sortOrder, t.createdAt),

    index("issues_assignee").on(t.assigneeType, t.assigneeId),
    check("issues_number_positive", sql`${t.number} > 0`),

    check("issues_status", sql`${t.status} in (${sql.raw(sqlLiteralList(IssueStatus))})`),
    check("issues_priority", sql`${t.priority} in (${sql.raw(sqlLiteralList(IssuePriority))})`),

    check("issues_assignee_pair", sql`(${t.assigneeType} is null) = (${t.assigneeId} is null)`),
    check(
      "issues_assignee_type",
      sql`(${t.assigneeType} is null or ${t.assigneeType} in (${sql.raw(
        sqlLiteralList(AssigneeType),
      )}))`,
    ),

    check(
      "issues_sort_order_finite",
      sql`${t.sortOrder} > '-Infinity'::double precision and ${t.sortOrder} < 'Infinity'::double precision`,
    ),
    check(
      "issues_fallback_policy_override",
      sql`(${t.fallbackPolicyOverride} is null or ${t.fallbackPolicyOverride} in (${sql.raw(
        sqlLiteralList(FallbackPolicy),
      )}))`,
    ),

    check(
      "issues_closed_at_matches_status",
      sql`(${t.status} in (${sql.raw(TERMINAL_ISSUE_STATUSES.map((status) => `'${status}'`).join(", "))})) = (${t.closedAt} is not null)`,
    ),
    check(
      "issues_no_self_parent",
      sql`${t.parentIssueId} is null or ${t.parentIssueId} <> ${t.id}`,
    ),

    check("issues_deleted_pair", sql`(${t.deletedAt} is null) = (${t.deletedByHumanId} is null)`),
    check(
      "issues_purged_requires_deleted",
      sql`${t.purgedAt} is null or ${t.deletedAt} is not null`,
    ),

    index("issues_parent").on(t.projectId, t.parentIssueId),
  ],
);

export const projectLabels = pgTable(
  "project_labels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("one_label_name_per_project").on(t.projectId, sql`lower(${t.name})`),
    check("project_labels_name_nonempty", sql`btrim(${t.name}) <> ''`),
    check("project_labels_color", sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    check(
      "project_labels_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    index("project_labels_project").on(t.projectId),
  ],
);

export const issueLabels = pgTable(
  "issue_labels",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => projectLabels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    index("issue_labels_label").on(t.labelId),
  ],
);

export const issueDependencies = pgTable(
  "issue_dependencies",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    blockedByIssueId: text("blocked_by_issue_id")
      .notNull()
      .references(() => issues.id),

    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("issue_dependencies_no_self_link", sql`${t.issueId} <> ${t.blockedByIssueId}`),
    check(
      "issue_dependencies_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    uniqueIndex("one_blocked_by_per_issue").on(t.issueId, t.blockedByIssueId),
    index("issue_dependencies_blocked_by").on(t.blockedByIssueId),
  ],
);

export const issueComments = pgTable(
  "issue_comments",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    body: text("body").notNull(),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "issue_comments_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    index("issue_comments_issue_created").on(t.issueId, t.createdAt),
  ],
);

export const issueLinks = pgTable(
  "issue_links",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    url: text("url").notNull(),
    title: text("title").notNull(),
    kind: text("kind").$type<IssueLinkKind>().notNull(),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "issue_links_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    check("issue_links_kind", sql`${t.kind} in (${sql.raw(sqlLiteralList(IssueLinkKind))})`),

    check("issue_links_url_http_s", sql`${t.url} ~* '^https?://'`),
    uniqueIndex("one_link_per_issue_and_url").on(t.issueId, t.url),
    index("issue_links_issue_created").on(t.issueId, t.createdAt),
  ],
);

export const workSessions = pgTable(
  "work_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    status: text("status")
      .$type<WorkSessionStatus>()
      .notNull()
      .default(WorkSessionStatus.enum.active),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    progress: text("progress").notNull().default(""),
    progressUpdatedAt: timestamp("progress_updated_at", { withTimezone: true }),

    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    stopRequestedByHumanId: text("stop_requested_by_human_id").references(() => humans.id),
    stopReason: text("stop_reason"),

    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsdMicros: integer("cost_usd_micros"),
    /** Set only by the FOR UPDATE-guarded rollup of non-empty hot stream chunks. */
    streamObjectId: text("stream_object_id").references(() => storedObjects.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "work_sessions_status",
      sql`${t.status} in (${sql.raw(sqlLiteralList(WorkSessionStatus))})`,
    ),

    check(
      "work_sessions_stop_request",
      sql`(
        (${t.stopRequestedAt} is null and ${t.stopRequestedByHumanId} is null and ${t.stopReason} is null)
        or (${t.stopRequestedAt} is not null and ${t.stopRequestedByHumanId} is not null)
      )`,
    ),

    check(
      "work_sessions_input_tokens_nonnegative",
      sql`${t.inputTokens} is null or ${t.inputTokens} >= 0`,
    ),
    check(
      "work_sessions_output_tokens_nonnegative",
      sql`${t.outputTokens} is null or ${t.outputTokens} >= 0`,
    ),
    check(
      "work_sessions_cost_usd_micros_nonnegative",
      sql`${t.costUsdMicros} is null or ${t.costUsdMicros} >= 0`,
    ),

    uniqueIndex("one_active_work_session_per_issue")
      .on(t.issueId)
      .where(sql`${t.status} = ${sql.raw(`'${WorkSessionStatus.enum.active}'`)}`),
    index("work_sessions_agent_created").on(t.agentId, t.createdAt),
    index("work_sessions_run_created").on(t.runId, t.createdAt),
    index("work_sessions_issue_created").on(t.issueId, t.createdAt),
  ],
);

export const workSessionActivities = pgTable(
  "work_session_activities",
  {
    id: text("id").primaryKey(),
    workSessionId: text("work_session_id")
      .notNull()
      .references(() => workSessions.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    kind: text("kind").$type<SessionActivityKind>().notNull(),
    summary: text("summary").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "work_session_activities_kind",
      sql`${t.kind} in (${sql.raw(sqlLiteralList(SessionActivityKind))})`,
    ),

    index("work_session_activities_session_created").on(t.workSessionId, t.createdAt),
  ],
);

/**
 * Ephemeral hot stream storage (#199). Idempotent on (work_session_id, seq);
 * pruned into an ObjectStore blob when the session ends or its lease expires.
 * `owner_only` rows are filtered server-side for every non-owner viewer.
 */
export const workSessionStreamChunks = pgTable(
  "work_session_stream_chunks",
  {
    workSessionId: text("work_session_id")
      .notNull()
      .references(() => workSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    visibility: text("visibility").notNull().default("project_readers"),
    payload: jsonb("payload").$type<StreamChunk>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workSessionId, t.seq] }),
    check("work_session_stream_chunks_seq_positive", sql`${t.seq} > 0`),
    check(
      "work_session_stream_chunks_kind",
      sql`${t.kind} in ('event', 'diagnostic', 'raw_output')`,
    ),
    check(
      "work_session_stream_chunks_visibility",
      sql`${t.visibility} in ('project_readers', 'owner_only')`,
    ),
  ],
);

export const questions = pgTable(
  "questions",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => workSessions.id),
    question: text("question").notNull(),
    proposedFallback: text("proposed_fallback").notNull(),
    status: text("status").$type<QuestionStatus>().notNull().default("open"),
    responseDeadlineAt: timestamp("response_deadline_at", { withTimezone: true }).notNull(),
    answer: text("answer"),
    answeredByHumanId: text("answered_by_human_id").references(() => humans.id),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    followUp: text("follow_up"),
    followUpByHumanId: text("follow_up_by_human_id").references(() => humans.id),
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("questions_status", sql`${t.status} in (${sql.raw(sqlLiteralList(QuestionStatus))})`),
    check("questions_deadline_after_creation", sql`${t.responseDeadlineAt} > ${t.createdAt}`),

    check(
      "questions_resolution_matches_status",
      sql`(
        (${t.status} = 'open' and ${t.answer} is null and ${t.answeredByHumanId} is null
          and ${t.answeredAt} is null and ${t.resolvedAt} is null
          and ${t.followUp} is null and ${t.followUpByHumanId} is null and ${t.followUpAt} is null)
        or (${t.status} = 'answered' and ${t.answer} is not null and ${t.answeredByHumanId} is not null
          and ${t.answeredAt} is not null and ${t.resolvedAt} is not null
          and ${t.followUp} is null and ${t.followUpByHumanId} is null and ${t.followUpAt} is null)
        or (${t.status} in ('paused', 'fallback_used') and ${t.answer} is null
          and ${t.answeredByHumanId} is null and ${t.answeredAt} is null and ${t.resolvedAt} is not null
          and ((${t.followUp} is null and ${t.followUpByHumanId} is null and ${t.followUpAt} is null)
            or (${t.followUp} is not null and ${t.followUpByHumanId} is not null and ${t.followUpAt} is not null)))
      )`,
    ),

    uniqueIndex("one_open_question_per_issue")
      .on(t.issueId)
      .where(sql`${t.status} in ('open', 'paused')`),
    index("questions_issue_created").on(t.issueId, t.createdAt),
    index("questions_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    createdByAgentId: text("created_by_agent_id").references(() => agents.id),
    updatedByHumanId: text("updated_by_human_id").references(() => humans.id),
    updatedByAgentId: text("updated_by_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByHumanId: text("deleted_by_human_id").references(() => humans.id),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "knowledge_entries_created_by_actor",
      sql`(${t.createdByHumanId} is not null) <> (${t.createdByAgentId} is not null)`,
    ),
    check(
      "knowledge_entries_updated_by_actor",
      sql`(${t.updatedByHumanId} is not null) <> (${t.updatedByAgentId} is not null)`,
    ),
    check(
      "knowledge_entries_deleted_pair",
      sql`(${t.deletedAt} is null) = (${t.deletedByHumanId} is null)`,
    ),
    check(
      "knowledge_entries_purged_requires_deleted",
      sql`${t.purgedAt} is null or ${t.deletedAt} is not null`,
    ),
    index("knowledge_entries_project_created").on(t.projectId, t.createdAt),
  ],
);

/** A project-scoped upload, paired with a stored_objects blob and an authenticated URL. */
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => storedObjects.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    uploadedByHumanId: text("uploaded_by_human_id").references(() => humans.id),
    uploadedByAgentId: text("uploaded_by_agent_id").references(() => agents.id),
    /** Set at upload; cleared to NULL when bound by #179, and set again when the last reference drops. */
    unreferencedAt: timestamp("unreferenced_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "attachments_uploaded_by_actor",
      sql`(${t.uploadedByHumanId} is not null) <> (${t.uploadedByAgentId} is not null)`,
    ),
    check("attachments_byte_size_positive", sql`${t.byteSize} > 0`),
    check(
      "attachments_filename_sanitized",
      sql`length(${t.filename}) between 1 and 255 and ${t.filename} !~ '[[:cntrl:]/\\\\]'`,
    ),
    index("attachments_project_created").on(t.projectId, t.createdAt),
    index("attachments_unreferenced").on(t.unreferencedAt),
  ],
);

/**
 * Which issue, comment, or knowledge entry uses an attachment URL. #179 writes
 * these rows on save; the cascade keeps cleanup from leaving foreign-key zombies.
 */
export const attachmentReferences = pgTable(
  "attachment_references",
  {
    id: text("id").primaryKey(),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    holderType: text("holder_type").$type<AttachmentHolderType>().notNull(),
    holderId: text("holder_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "attachment_references_holder_type",
      sql`${t.holderType} in (${sql.raw(sqlLiteralList(AttachmentHolderType))})`,
    ),
    uniqueIndex("one_reference_per_holder_attachment").on(t.holderType, t.holderId, t.attachmentId),
    index("attachment_references_attachment").on(t.attachmentId),
  ],
);

const projectActivityTypesSql = sql.raw(
  ProjectActivityType.options
    .filter((type) => type.startsWith("project_"))
    .map((type) => `'${type}'`)
    .join(", "),
);
const issueActivityTypesSql = sql.raw(
  ProjectActivityType.options
    .filter((type) => type.startsWith("issue_"))
    .map((type) => `'${type}'`)
    .join(", "),
);
const knowledgeActivityTypesSql = sql.raw(
  ProjectActivityType.options
    .filter((type) => type.startsWith("knowledge_"))
    .map((type) => `'${type}'`)
    .join(", "),
);

export const projectActivity = pgTable(
  "project_activity",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").$type<ProjectActivityType>().notNull(),

    actorHumanId: text("actor_human_id").references(() => humans.id),
    actorAgentId: text("actor_agent_id").references(() => agents.id),
    issueId: text("issue_id").references(() => issues.id),
    knowledgeEntryId: text("knowledge_entry_id").references(() => knowledgeEntries.id),
    summary: text("summary").notNull(),
    detail: jsonb("detail").$type<IssueActivityDetail>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "project_activity_actor",
      sql`(${t.actorHumanId} is not null) <> (${t.actorAgentId} is not null)`,
    ),

    check(
      "project_activity_type",
      sql`${t.type} in (${sql.raw(sqlLiteralList(ProjectActivityType))})`,
    ),
    check(
      "project_activity_target_matches_type",
      sql`(
        (${t.type} in (${projectActivityTypesSql}) and ${t.issueId} is null and ${t.knowledgeEntryId} is null)
        or (${t.type} in (${issueActivityTypesSql}) and ${t.issueId} is not null and ${t.knowledgeEntryId} is null)
        or (${t.type} in (${knowledgeActivityTypesSql}) and ${t.issueId} is null and ${t.knowledgeEntryId} is not null)
      )`,
    ),
    index("project_activity_project_created").on(t.projectId, t.createdAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
    activityId: text("activity_id")
      .notNull()
      .references(() => projectActivity.id),
    kind: text("kind").$type<NotificationKind>().notNull(),
    summary: text("summary").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("notifications_kind", sql`${t.kind} in (${sql.raw(sqlLiteralList(NotificationKind))})`),
    uniqueIndex("one_notification_per_human_and_activity").on(t.humanId, t.activityId),
    index("notifications_human_created").on(t.humanId, t.createdAt.desc()),
    index("notifications_human_unread")
      .on(t.humanId, t.createdAt.desc())
      .where(sql`${t.readAt} is null`),
  ],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    secretEncrypted: text("secret_encrypted").notNull(),
    allProjects: boolean("all_projects").notNull().default(true),
    allEvents: boolean("all_events").notNull().default(true),
    events: text("events")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    createdByHumanId: text("created_by_human_id").references(() => humans.id),
    updatedByHumanId: text("updated_by_human_id").references(() => humans.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("webhooks_url_scheme", sql`${t.url} ~ '^https?://'`),
    check("webhooks_consecutive_failures_nonnegative", sql`${t.consecutiveFailures} >= 0`),
    check(
      "webhooks_events_valid",
      sql`${t.events} <@ array[${sql.raw(
        ProjectActivityType.options.map((type) => `'${type}'`).join(", "),
      )}]::text[]`,
    ),
    check(
      "webhooks_disabled_fields",
      sql`(${t.enabled} = true and ${t.disabledAt} is null and ${t.disabledReason} is null)
        or (${t.enabled} = false and ${t.disabledAt} is not null and ${t.disabledReason} is not null)`,
    ),
    index("webhooks_workspace_created").on(t.workspaceId, t.createdAt),
  ],
);

export const webhookProjects = pgTable(
  "webhook_projects",
  {
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.webhookId, t.projectId] }),
    index("webhook_projects_project").on(t.projectId),
  ],
);

const webhookDeliveryStatuses = ["pending", "delivering", "delivered", "failed"] as const;
const webhookDeliveryStatusesSql = sql.raw(
  webhookDeliveryStatuses.map((status) => `'${status}'`).join(", "),
);
const webhookEventsSql = sql.raw(
  [...ProjectActivityType.options, "webhook.test"].map((event) => `'${event}'`).join(", "),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    activityId: text("activity_id").references(() => projectActivity.id),
    payload: jsonb("payload").notNull(),
    status: text("status").$type<(typeof webhookDeliveryStatuses)[number]>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastStatusCode: integer("last_status_code"),
    lastDurationMs: integer("last_duration_ms"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("webhook_deliveries_event", sql`${t.event} in (${webhookEventsSql})`),
    check(
      "webhook_deliveries_test_activity",
      sql`(${t.event} = 'webhook.test' and ${t.activityId} is null)
        or (${t.event} <> 'webhook.test' and ${t.activityId} is not null)`,
    ),
    check("webhook_deliveries_status", sql`${t.status} in (${webhookDeliveryStatusesSql})`),
    check("webhook_deliveries_attempt_count_nonnegative", sql`${t.attemptCount} >= 0`),
    check(
      "webhook_deliveries_last_duration_nonnegative",
      sql`${t.lastDurationMs} is null or ${t.lastDurationMs} >= 0`,
    ),
    check(
      "webhook_deliveries_delivering_lock",
      sql`${t.status} <> 'delivering' or ${t.lockedUntil} is not null`,
    ),
    check(
      "webhook_deliveries_delivered_at",
      sql`${t.status} <> 'delivered' or ${t.deliveredAt} is not null`,
    ),
    uniqueIndex("webhook_deliveries_webhook_activity")
      .on(t.webhookId, t.activityId)
      .where(sql`${t.activityId} is not null`),
    index("webhook_deliveries_pending_due")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("webhook_deliveries_delivering_lock_due")
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'delivering'`),
    index("webhook_deliveries_webhook_created").on(t.webhookId, t.createdAt.desc()),
    index("webhook_deliveries_created").on(t.createdAt),
  ],
);

/**
 * A machine enrolled once across the whole installation. Host credentials are
 * stored only as a SHA-256 digest, and revoking the host revokes every Runner
 * registered under it (issue #195, ADR-0010).
 */
export const runnerHosts = pgTable(
  "runner_hosts",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id),
    displayName: text("display_name").notNull(),
    platform: text("platform").notNull(),
    credentialHash: text("credential_hash").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "runner_hosts_display_name_valid",
      sql`btrim(${t.displayName}) <> '' and char_length(${t.displayName}) <= 120`,
    ),
    check("runner_hosts_platform_valid", sql`${t.platform} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check("runner_hosts_credential_hash_format", sql`${t.credentialHash} ~ '^[0-9a-f]{64}$'`),
    index("runner_hosts_human_id").on(t.humanId),
    index("runner_hosts_active_human")
      .on(t.humanId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * Verifier-bound device-code enrollment session. The CLI holds the raw device
 * code and verifier; only their digests are persisted. The exchange is single
 * use (`usedAt`) and expires ten minutes after creation.
 */
export const runnerDeviceCodes = pgTable(
  "runner_device_codes",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCode: text("user_code").notNull(),
    verifierHash: text("verifier_hash").notNull(),
    hostDisplayName: text("host_display_name").notNull(),
    platform: text("platform").notNull(),
    humanId: text("human_id").references(() => humans.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "runner_device_codes_device_code_hash_format",
      sql`${t.deviceCodeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("runner_device_codes_verifier_hash_format", sql`${t.verifierHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "runner_device_codes_user_code_format",
      sql`${t.userCode} ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'`,
    ),
    check(
      "runner_device_codes_failed_attempts_bounded",
      sql`${t.failedAttempts} >= 0 and ${t.failedAttempts} <= 5`,
    ),
    check(
      "runner_device_codes_human_when_approved",
      sql`${t.approvedAt} is null or ${t.humanId} is not null`,
    ),
    uniqueIndex("runner_device_codes_pending_user_code")
      .on(t.userCode)
      .where(sql`${t.usedAt} is null`),
    index("runner_device_codes_device_code_hash").on(t.deviceCodeHash),
  ],
);

/** Per-human counter for failed browser user-code entries (max five). */
export const runnerDeviceCodeAttempts = pgTable(
  "runner_device_code_attempts",
  {
    humanId: text("human_id")
      .primaryKey()
      .references(() => humans.id, { onDelete: "cascade" }),
    failedCount: integer("failed_count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "runner_device_code_attempts_count_bounded",
      sql`${t.failedCount} >= 0 and ${t.failedCount} <= 5`,
    ),
  ],
);

/**
 * A live `orrery-runner` process bound to one project checkout. Presence is
 * never stored as a boolean: it is derived in DB time from last_seen_at,
 * revocation, and the heartbeat-reported active session count.
 */
export const runners = pgTable(
  "runners",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => runnerHosts.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    displayName: text("display_name").notNull(),
    repoFingerprint: text("repo_fingerprint").notNull(),
    capabilities: jsonb("capabilities")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * The live Harness catalog the Runner published (issue #240): ACP
     * harnesses, models and per-model reasoning-effort levels. Separate from
     * `capabilities`, which stays a flat string list.
     */
    harnessCatalog: jsonb("harness_catalog").$type<HarnessCatalog | null>(),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    activeSlotCount: integer("active_slot_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "runners_display_name_valid",
      sql`btrim(${t.displayName}) <> '' and char_length(${t.displayName}) <= 120`,
    ),
    check("runners_repo_fingerprint_format", sql`${t.repoFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("runners_max_concurrency_bounded", sql`${t.maxConcurrency} between 1 and 64`),
    check(
      "runners_active_slot_count_bounded",
      sql`${t.activeSlotCount} >= 0 and ${t.activeSlotCount} <= ${t.maxConcurrency}`,
    ),
    index("runners_host_id").on(t.hostId),
    index("runners_workspace_id").on(t.workspaceId),
    index("runners_project_id").on(t.projectId),
    index("runners_active_last_seen")
      .on(t.lastSeenAt)
      .where(sql`${t.revokedAt} is null`),
    uniqueIndex("runners_one_per_host_workspace_project_fingerprint")
      .on(t.hostId, t.workspaceId, t.projectId, t.repoFingerprint)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * A human's delivery of one issue to one of their Runners. The dispatch is a
 * thin bridge: accepting it creates a Run and claims a Work session through
 * the existing services, and never writes issues.assignee (issue #196).
 */
export const runnerDispatches = pgTable(
  "runner_dispatches",
  {
    id: text("id").primaryKey(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    requestedByHumanId: text("requested_by_human_id")
      .notNull()
      .references(() => humans.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    dispatchAttemptId: text("dispatch_attempt_id").notNull(),
    /** Optional requester steering text, appended by the Runner after its preamble. */
    prompt: text("prompt"),
    /** Chosen Harness id (issue #241); null means the Runner's local default. */
    harness: text("harness"),
    /** Chosen model id; null means the Harness's cached default is passed. */
    model: text("model"),
    /** Chosen reasoning effort; null means no effort override. */
    effort: text("effort"),
    state: text("state").$type<DispatchState>().notNull().default("pending"),
    runId: text("run_id").references(() => runs.id),
    workSessionId: text("work_session_id").references(() => workSessions.id),
    lastUpSeq: integer("last_up_seq").notNull().default(0),
    lastDownSeq: integer("last_down_seq").notNull().default(0),
    branchName: text("branch_name"),
    dirtyWorktree: boolean("dirty_worktree").notNull().default(false),
    /** DB-time rate window for stream batch backpressure. */
    streamWindowStartedAt: timestamp("stream_window_started_at", { withTimezone: true }),
    streamBatchCount: integer("stream_batch_count").notNull().default(0),
    /** Set once when a missed heartbeat marks an active attempt uncertain. */
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    needsHumanResolution: boolean("needs_human_resolution").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "runner_dispatches_state",
      sql`${t.state} in (${sql.raw(sqlLiteralList(DispatchState))})`,
    ),
    check(
      "runner_dispatches_sequence_nonnegative",
      sql`${t.lastUpSeq} >= 0 and ${t.lastDownSeq} >= 0`,
    ),
    check("runner_dispatches_stream_batch_count_nonnegative", sql`${t.streamBatchCount} >= 0`),
    check(
      "runner_dispatches_prompt_bounded",
      sql`${t.prompt} is null or char_length(${t.prompt}) <= 16000`,
    ),
    check(
      "runner_dispatches_options_bounded",
      sql`(${t.harness} is null or char_length(${t.harness}) between 1 and 64)
          and (${t.model} is null or char_length(${t.model}) between 1 and 200)
          and (${t.effort} is null or char_length(${t.effort}) between 1 and 64)`,
    ),
    check(
      "runner_dispatches_accepted_fields",
      sql`(${t.state} = 'pending' and ${t.acceptedAt} is null and ${t.runId} is null and ${t.workSessionId} is null)
          or (${t.state} in ('active', 'uncertain') and ${t.acceptedAt} is not null and ${t.runId} is not null and ${t.workSessionId} is not null)
          or (${t.state} = 'ended' and (((${t.acceptedAt} is not null) and (${t.runId} is not null) and (${t.workSessionId} is not null))
            or ((${t.acceptedAt} is null) and (${t.runId} is null) and (${t.workSessionId} is null))))`,
    ),
    uniqueIndex("runner_dispatches_one_attempt").on(t.dispatchAttemptId),
    index("runner_dispatches_runner_created").on(t.runnerId, t.createdAt),
    index("runner_dispatches_issue_created").on(t.issueId, t.createdAt),
    index("runner_dispatches_pending_runner")
      .on(t.runnerId)
      .where(sql`${t.state} = 'pending'`),
  ],
);

/**
 * A short-lived, hash-only bearer credential bound to one Dispatch attempt.
 * The secret is returned once at acceptance; only its digest is stored.
 */
export const dispatchTokens = pgTable(
  "dispatch_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    runnerHostId: text("runner_host_id")
      .notNull()
      .references(() => runnerHosts.id, { onDelete: "cascade" }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    dispatchId: text("dispatch_id")
      .notNull()
      .references(() => runnerDispatches.id, { onDelete: "cascade" }),
    dispatchAttemptId: text("dispatch_attempt_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    workSessionId: text("work_session_id")
      .notNull()
      .references(() => workSessions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("dispatch_tokens_token_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    index("dispatch_tokens_hash_created").on(t.tokenHash),
    index("dispatch_tokens_dispatch_created").on(t.dispatchId, t.createdAt),
    index("dispatch_tokens_session_active")
      .on(t.workSessionId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * Durable per-runner command mailbox (#197, ADR-0010). A row is inserted inside
 * the same transaction as the domain write that triggered it; `pg_notify`
 * carries only the runner id as a latency doorbell, never the payload.
 */
export const runnerCommands = pgTable(
  "runner_commands",
  {
    id: text("id").primaryKey(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    dispatchId: text("dispatch_id")
      .notNull()
      .references(() => runnerDispatches.id, { onDelete: "cascade" }),
    dispatchAttemptId: text("dispatch_attempt_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").$type<RunnerCommandKind>().notNull(),
    payload: jsonb("payload").$type<RunnerCommandPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("one_runner_command_seq_per_runner").on(t.runnerId, t.seq),
    check("runner_commands_seq_positive", sql`${t.seq} > 0`),
    check(
      "runner_commands_kind",
      sql`${t.kind} in (${sql.raw(sqlLiteralList(RunnerCommandKind))})`,
    ),
    check("runner_commands_expires_after_created", sql`${t.expiresAt} > ${t.createdAt}`),
    index("runner_commands_runner_unacked")
      .on(t.runnerId, t.seq)
      .where(sql`${t.ackedAt} is null`),
    index("runner_commands_attempt_kind").on(t.dispatchAttemptId, t.kind),
  ],
);

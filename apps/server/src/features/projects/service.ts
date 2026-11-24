import { randomUUID } from "node:crypto";
import {
  avatarUrlFor,
  FallbackPolicy,
  ISSUE_SORT_STEP,
  IssueStatus,
  isTerminalIssueStatus,
  ProjectAccessEventType,
  ProjectAccessLevel,
  WorkspaceKind,
  type Actor,
  type AgentIdentity,
  type AddBlockedByRequest,
  type Assignee,
  type AssigneeType,
  type CreateIssueCommentRequest,
  type CreateIssueLinkRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectLabelRequest,
  type CreateProjectRequest,
  type Issue,
  type MentionCandidatesResponse,
  type IssueComment,
  type IssueDependency,
  type IssueDetail,
  type IssueLink,
  IssueLinkKind,
  IssueActivityDetail,
  IssuePriority,
  type KnowledgeEntry,
  type Project,
  type ProjectAccessGrant,
  type ProjectActivity,
  type ProjectActivityType,
  type ProjectLabel,
  type SetIssueFallbackPolicyRequest,
  type SetProjectAccessRequest,
  type SetProjectFallbackPolicyRequest,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
  type UpdateProjectLabelRequest,
  type UpdateProjectRequest,
} from "@orrery/contract";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { uniqueConstraintName } from "../../platform/errors.ts";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  humans,
  issueComments,
  issueDependencies,
  issueLabels,
  issueLinks,
  issues,
  knowledgeEntries,
  projectAccessEvents,
  projectAccessGrants,
  projectActivity,
  projectLabels,
  projects,
  questions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { attachmentHolderKey, type AttachmentSeams } from "../attachments/index.ts";
import { extractMentionHandles, newlyAddedMentions } from "../notifications/index.ts";
import type { NotifyActivity } from "../notifications/index.ts";
import type { EnqueueWebhookActivity } from "../webhooks/index.ts";

export type ProjectsErrorKind =
  | "not_signed_in"
  | "workspace_not_found"
  | "project_not_found"
  | "issue_not_found"
  | "issue_link_not_found"
  | "issue_link_exists"
  | "knowledge_entry_not_found"
  | "project_creation_not_allowed"
  | "insufficient_project_access"
  | "member_not_found"
  | "personal_project_access"
  | "workspace_owner_access"
  | "session_required"
  | "self_dependency"
  | "cross_project_dependency"
  | "dependency_cycle"
  | "assignee_not_found"
  | "project_key_taken"
  | "project_key_immutable"
  | "label_not_found"
  | "label_exists"
  | "self_parent"
  | "cross_project_parent"
  | "subtask_depth_exceeded"
  | "agents_cannot_delete_issues"
  | "issue_active_session_exists"
  | "issue_needs_input"
  | "issue_purged";

const messages = {
  not_signed_in: "Not signed in.",
  workspace_not_found: "This workspace does not exist.",
  project_not_found: "This project does not exist.",
  issue_not_found: "This issue does not exist.",
  issue_link_not_found: "This link does not exist on the issue.",
  issue_link_exists: "This URL is already attached to the issue.",
  knowledge_entry_not_found: "This knowledge entry does not exist.",
  project_creation_not_allowed: "You do not have Create projects in this workspace.",
  insufficient_project_access: "This project access level cannot do that.",
  member_not_found: "This person is not a member of the workspace.",
  personal_project_access: "Personal projects have no direct collaborators.",
  workspace_owner_access: "Workspace owners already have Manage access to every project.",
  session_required: "This agent holds no live work session for this issue.",
  self_dependency: "An issue cannot block itself.",
  cross_project_dependency: "Dependencies can only link issues in the same project.",
  dependency_cycle: "That dependency would create a cycle.",
  assignee_not_found: "No active member or registered agent in this workspace has that id.",
  project_key_taken: "Another project in this workspace already uses that key.",
  project_key_immutable: "A project's key cannot be changed after it is created.",
  label_not_found: "This label does not exist on the project.",
  label_exists: "A label with that name already exists in this project.",
  self_parent: "An issue cannot be its own parent.",
  cross_project_parent: "A subtask and its parent must belong to the same project.",
  subtask_depth_exceeded:
    "Maximum subtask depth is one: a subtask cannot have children, and an issue with subtasks cannot become a subtask.",
  agents_cannot_delete_issues: "Agents cannot delete issues; only a human can.",
  issue_active_session_exists:
    "This issue has an active work session; stop or release it before deleting the issue.",
  issue_needs_input:
    "This issue has an unanswered question; answer it before moving the issue to review or closing it.",
  issue_purged: "This issue's trash window has ended and it can no longer be restored.",
} as const satisfies Record<ProjectsErrorKind, string>;

const ACCESS_RANK: Record<ProjectAccessLevel, number> = {
  read: 1,
  contribute: 2,
  manage: 3,
};

const THIRTY_DAYS_AGO = sql`statement_timestamp() - interval '30 days'`;

function baseProjectKey(name: string): string {
  const initials = (name.match(/[A-Za-z]+/g) ?? []).map((word) => word[0]!.toUpperCase()).join("");
  if (initials.length === 0) return "PRJ";
  if (initials.length === 1) return `${initials}J`;
  return initials.slice(0, 8);
}

function availableProjectKey(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const text = String(suffix);
    const candidate = `${base.slice(0, 10 - text.length)}${text}`;
    if (!used.has(candidate)) return candidate;
  }
}

type AccessFacts = {
  workspaceKind: WorkspaceKind;
  personalOwnerHumanId: string | null;
  membershipIsOwner: boolean | null;
  grantLevel: ProjectAccessLevel | null;
};

function resolveAccessLevel(facts: AccessFacts, humanId: string): ProjectAccessLevel | null {
  if (facts.workspaceKind === WorkspaceKind.enum.personal) {
    return facts.personalOwnerHumanId === humanId ? ProjectAccessLevel.enum.manage : null;
  }
  if (facts.membershipIsOwner === null) return null;
  if (facts.membershipIsOwner) return ProjectAccessLevel.enum.manage;
  return facts.grantLevel;
}

export async function projectAccessCeilingInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
): Promise<Map<string, ProjectAccessLevel | null>> {
  const ceiling = new Map<string, ProjectAccessLevel | null>();
  if (projectIds.length === 0) return ceiling;

  const uniqueProjectIds = [...new Set(projectIds)];
  const [workspace] = await tx
    .select({
      kind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
    })
    .from(workspaces)
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),

        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (workspace === undefined) {
    for (const projectId of uniqueProjectIds) ceiling.set(projectId, null);
    return ceiling;
  }

  const rows = await tx
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      grantLevel: projectAccessGrants.level,
    })
    .from(projects)
    .leftJoin(
      projectAccessGrants,
      and(eq(projectAccessGrants.projectId, projects.id), eq(projectAccessGrants.humanId, humanId)),
    )
    .where(inArray(projects.id, uniqueProjectIds));

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const workspaceKind = WorkspaceKind.parse(workspace.kind);
  for (const projectId of uniqueProjectIds) {
    const row = rowsById.get(projectId);
    if (row === undefined || row.workspaceId !== workspaceId) {
      ceiling.set(projectId, null);
      continue;
    }
    ceiling.set(
      projectId,
      resolveAccessLevel(
        {
          workspaceKind,
          personalOwnerHumanId: workspace.personalOwnerHumanId,
          membershipIsOwner: workspace.membershipIsOwner,
          grantLevel: row.grantLevel === null ? null : ProjectAccessLevel.parse(row.grantLevel),
        },
        humanId,
      ),
    );
  }
  return ceiling;
}

export function projectAccessAtLeast(
  actual: ProjectAccessLevel,
  required: ProjectAccessLevel,
): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

function actorAccessLevel(
  facts: AccessFacts & { projectId: string; workspaceId: string },
  actor: WorkActor,
): ProjectAccessLevel | null {
  if (actor.kind === "human") return resolveAccessLevel(facts, actor.account.humanId);
  if (facts.workspaceId !== actor.identity.workspaceId) return null;
  return (
    actor.identity.projects.find((grant) => grant.projectId === facts.projectId)?.level ?? null
  );
}

function requireLevel(
  facts: AccessFacts & { projectId: string; workspaceId: string },
  actor: WorkActor,
  required: ProjectAccessLevel,
  missingKind: ProjectsErrorKind,
): ProjectAccessLevel {
  const level = actorAccessLevel(facts, actor);
  if (level === null) throw new ProjectsError(missingKind);
  if (!projectAccessAtLeast(level, required)) {
    throw new ProjectsError("insufficient_project_access");
  }
  return level;
}

export class ProjectsError extends Error {
  readonly kind: ProjectsErrorKind;

  constructor(kind: ProjectsErrorKind) {
    super(messages[kind]);
    this.name = "ProjectsError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new ProjectsError("not_signed_in");
  return account;
}

export type WorkActor =
  | { kind: "human"; account: SessionAccount }
  | { kind: "agent"; identity: AgentIdentity };

function requireActor(actor: WorkActor | null): WorkActor {
  if (actor === null) throw new ProjectsError("not_signed_in");
  return actor;
}

function humanIdOf(actor: WorkActor): string | null {
  return actor.kind === "human" ? actor.account.humanId : null;
}

function agentIdOf(actor: WorkActor): string | null {
  return actor.kind === "agent" ? actor.identity.agentId : null;
}

function humanIdMatch(actor: WorkActor, table: "membership" | "grant") {
  const humanId = humanIdOf(actor);
  if (humanId === null) return sql`false`;
  const column =
    table === "membership" ? workspaceMemberships.humanId : projectAccessGrants.humanId;

  return table === "membership"
    ? and(eq(column, humanId), isNull(workspaceMemberships.suspendedAt))
    : eq(column, humanId);
}

function agentSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
  return slug.length >= 2 ? slug : "agent";
}

function actorForWrite(actor: WorkActor): Actor {
  if (actor.kind === "human") {
    return {
      humanId: actor.account.humanId,
      email: actor.account.email,
      handle: actor.account.handle,
      displayName: actor.account.email,
      avatarUrl: actor.account.avatarUrl ?? null,
    };
  }
  return {
    agentId: actor.identity.agentId,
    agentName: actor.identity.name,
    displayName: actor.identity.name,
    avatarUrl: null,
  };
}

function actorFromRow(
  humanId: string | null,
  email: string | null,
  agentId: string | null,
  agentName: string | null,
  deactivatedAt: Date | null = null,
  avatarObjectId: string | null = null,
  handle: string | null = null,
): Actor {
  if (humanId !== null && email !== null) {
    const deactivated = deactivatedAt !== null;
    return {
      humanId,
      email,
      ...(handle === null ? {} : { handle }),
      displayName: deactivated ? `${email} (deactivated)` : email,
      ...(deactivated ? { deactivated: true } : {}),
      avatarUrl: avatarObjectId === null ? null : avatarUrlFor(humanId, avatarObjectId),
    };
  }
  if (agentId !== null && agentName !== null) {
    return { agentId, agentName, displayName: agentName, avatarUrl: null };
  }

  return { displayName: "Unknown author", avatarUrl: null };
}

function assigneeFromRow(row: {
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  assigneeHumanEmail: string | null;
  assigneeHumanDeactivatedAt: Date | null;
  assigneeHumanAvatarObjectId: string | null;
  assigneeAgentName: string | null;
}): Actor | null {
  if (row.assigneeType === "human" && row.assigneeId !== null && row.assigneeHumanEmail !== null) {
    return actorFromRow(
      row.assigneeId,
      row.assigneeHumanEmail,
      null,
      null,
      row.assigneeHumanDeactivatedAt,
      row.assigneeHumanAvatarObjectId,
    );
  }
  if (row.assigneeType === "agent" && row.assigneeId !== null && row.assigneeAgentName !== null) {
    return actorFromRow(null, null, row.assigneeId, row.assigneeAgentName);
  }
  return null;
}

const projectCreator = alias(humans, "project_creator");
const issueCreator = alias(humans, "issue_creator");
const issueEditor = alias(humans, "issue_editor");
const commentAuthor = alias(humans, "comment_author");
const linkCreator = alias(humans, "link_creator");
const knowledgeCreator = alias(humans, "knowledge_creator");
const knowledgeEditor = alias(humans, "knowledge_editor");
const activityActor = alias(humans, "activity_actor");
const accessGrantor = alias(humans, "access_grantor");
const labelCreator = alias(humans, "label_creator");

const issueAgentCreator = alias(agents, "issue_agent_creator");
const issueAgentEditor = alias(agents, "issue_agent_editor");

const assigneeHuman = alias(humans, "assignee_human");
const assigneeAgent = alias(agents, "assignee_agent");
const commentAgentAuthor = alias(agents, "comment_agent_author");
const linkAgentCreator = alias(agents, "link_agent_creator");
const knowledgeAgentCreator = alias(agents, "knowledge_agent_creator");
const knowledgeAgentEditor = alias(agents, "knowledge_agent_editor");
const activityAgentActor = alias(agents, "activity_agent_actor");
const labelAgentCreator = alias(agents, "label_agent_creator");

const dependencyHumanCreator = alias(humans, "dependency_human_creator");
const dependencyAgentCreator = alias(agents, "dependency_agent_creator");
const blockerIssue = alias(issues, "blocker_issue");

const projectColumns = {
  id: projects.id,
  workspaceId: projects.workspaceId,
  name: projects.name,
  description: projects.description,
  key: projects.key,
  createdAt: projects.createdAt,
  createdByHumanId: projects.createdByHumanId,
  createdByEmail: projectCreator.email,
  createdByHandle: projectCreator.handle,
  createdByDeactivatedAt: projectCreator.deactivatedAt,
  createdByAvatarObjectId: projectCreator.avatarObjectId,
  fallbackPolicy: projects.fallbackPolicy,
};

const issuePriorityRank = sql`case ${issues.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
const issueBoardOrder = [
  issuePriorityRank,
  asc(issues.sortOrder),
  asc(issues.createdAt),
  asc(issues.number),
];

const issueColumns = {
  id: issues.id,
  projectId: issues.projectId,
  number: issues.number,

  projectKey: projects.key,
  title: issues.title,
  body: issues.body,
  status: issues.status,
  priority: issues.priority,
  sortOrder: issues.sortOrder,
  needsInput: issues.needsInput,
  parentIssueId: issues.parentIssueId,
  assigneeType: issues.assigneeType,
  assigneeId: issues.assigneeId,
  assigneeHumanEmail: assigneeHuman.email,
  assigneeHumanDeactivatedAt: assigneeHuman.deactivatedAt,
  assigneeHumanAvatarObjectId: assigneeHuman.avatarObjectId,
  assigneeAgentName: assigneeAgent.name,
  fallbackPolicyOverride: issues.fallbackPolicyOverride,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  closedAt: issues.closedAt,

  deletedAt: issues.deletedAt,
  purgedAt: issues.purgedAt,
  createdByHumanId: issues.createdByHumanId,
  createdByEmail: issueCreator.email,
  createdByHandle: issueCreator.handle,
  createdByDeactivatedAt: issueCreator.deactivatedAt,
  createdByAvatarObjectId: issueCreator.avatarObjectId,
  createdByAgentId: issues.createdByAgentId,
  createdByAgentName: issueAgentCreator.name,
  updatedByHumanId: issues.updatedByHumanId,
  updatedByEmail: issueEditor.email,
  updatedByHandle: issueEditor.handle,
  updatedByDeactivatedAt: issueEditor.deactivatedAt,
  updatedByAvatarObjectId: issueEditor.avatarObjectId,
  updatedByAgentId: issues.updatedByAgentId,
  updatedByAgentName: issueAgentEditor.name,
};

const commentColumns = {
  id: issueComments.id,
  issueId: issueComments.issueId,
  body: issueComments.body,
  createdAt: issueComments.createdAt,
  authorHumanId: issueComments.createdByHumanId,
  authorEmail: commentAuthor.email,
  authorHandle: commentAuthor.handle,
  authorDeactivatedAt: commentAuthor.deactivatedAt,
  authorAvatarObjectId: commentAuthor.avatarObjectId,
  authorAgentId: issueComments.createdByAgentId,
  authorAgentName: commentAgentAuthor.name,
};

const linkColumns = {
  id: issueLinks.id,
  issueId: issueLinks.issueId,
  url: issueLinks.url,
  title: issueLinks.title,
  kind: issueLinks.kind,
  createdAt: issueLinks.createdAt,
  createdByHumanId: issueLinks.createdByHumanId,
  createdByEmail: linkCreator.email,
  createdByDeactivatedAt: linkCreator.deactivatedAt,
  createdByAvatarObjectId: linkCreator.avatarObjectId,
  createdByAgentId: issueLinks.createdByAgentId,
  createdByAgentName: linkAgentCreator.name,
};

const knowledgeColumns = {
  id: knowledgeEntries.id,
  projectId: knowledgeEntries.projectId,
  title: knowledgeEntries.title,
  body: knowledgeEntries.body,
  createdAt: knowledgeEntries.createdAt,
  updatedAt: knowledgeEntries.updatedAt,
  createdByHumanId: knowledgeEntries.createdByHumanId,
  createdByEmail: knowledgeCreator.email,
  createdByHandle: knowledgeCreator.handle,
  createdByDeactivatedAt: knowledgeCreator.deactivatedAt,
  createdByAvatarObjectId: knowledgeCreator.avatarObjectId,
  createdByAgentId: knowledgeEntries.createdByAgentId,
  createdByAgentName: knowledgeAgentCreator.name,
  updatedByHumanId: knowledgeEntries.updatedByHumanId,
  updatedByEmail: knowledgeEditor.email,
  updatedByHandle: knowledgeEditor.handle,
  updatedByDeactivatedAt: knowledgeEditor.deactivatedAt,
  updatedByAvatarObjectId: knowledgeEditor.avatarObjectId,
  updatedByAgentId: knowledgeEntries.updatedByAgentId,
  updatedByAgentName: knowledgeAgentEditor.name,
};

const dependencyColumns = {
  issueId: issueDependencies.issueId,
  blockedByIssueId: issueDependencies.blockedByIssueId,
  createdAt: issueDependencies.createdAt,
  createdByHumanId: issueDependencies.createdByHumanId,
  createdByEmail: dependencyHumanCreator.email,
  createdByDeactivatedAt: dependencyHumanCreator.deactivatedAt,
  createdByAvatarObjectId: dependencyHumanCreator.avatarObjectId,
  createdByAgentId: issueDependencies.createdByAgentId,
  createdByAgentName: dependencyAgentCreator.name,
};

const activityColumns = {
  id: projectActivity.id,
  projectId: projectActivity.projectId,
  type: projectActivity.type,
  summary: projectActivity.summary,
  detail: projectActivity.detail,
  issueId: projectActivity.issueId,
  knowledgeEntryId: projectActivity.knowledgeEntryId,
  createdAt: projectActivity.createdAt,
  actorHumanId: projectActivity.actorHumanId,
  actorEmail: activityActor.email,
  actorDeactivatedAt: activityActor.deactivatedAt,
  actorAvatarObjectId: activityActor.avatarObjectId,
  actorAgentId: projectActivity.actorAgentId,
  actorAgentName: activityAgentActor.name,
};

type ProjectRow = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  key: string;
  createdAt: Date;
  createdByHumanId: string;
  createdByEmail: string;
  createdByHandle: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAvatarObjectId: string | null;
  workspaceKind: WorkspaceKind;
  accessLevel: ProjectAccessLevel;
  fallbackPolicy: FallbackPolicy;
};

type ProjectGrantRow = {
  humanId: string;
  email: string;
  level: ProjectAccessLevel;
  grantedByHumanId: string;
  grantedByEmail: string;
  grantedByDeactivatedAt: Date | null;
  grantedByAvatarObjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type IssueRow = {
  id: string;
  projectId: string;
  number: number;
  projectKey: string;
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  sortOrder: number;
  needsInput: boolean;
  parentIssueId: string | null;
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  assigneeHumanEmail: string | null;
  assigneeHumanDeactivatedAt: Date | null;
  assigneeHumanAvatarObjectId: string | null;
  assigneeAgentName: string | null;
  fallbackPolicyOverride: FallbackPolicy | null;

  projectFallbackPolicy: FallbackPolicy;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  deletedAt: Date | null;
  purgedAt: Date | null;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByHandle: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAvatarObjectId: string | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
  updatedByHumanId: string | null;
  updatedByEmail: string | null;
  updatedByHandle: string | null;
  updatedByDeactivatedAt: Date | null;
  updatedByAvatarObjectId: string | null;
  updatedByAgentId: string | null;
  updatedByAgentName: string | null;
};

type IssueDependencyRow = {
  issueId: string;
  blockedByIssueId: string;
  createdAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAvatarObjectId: string | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
};

type CommentRow = {
  id: string;
  issueId: string;
  body: string;
  createdAt: Date;
  authorHumanId: string | null;
  authorEmail: string | null;
  authorHandle: string | null;
  authorDeactivatedAt: Date | null;
  authorAvatarObjectId: string | null;
  authorAgentId: string | null;
  authorAgentName: string | null;
};

type LinkRow = {
  id: string;
  issueId: string;
  url: string;
  title: string;
  kind: IssueLinkKind;
  createdAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAvatarObjectId: string | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
};

type KnowledgeRow = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByHandle: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAvatarObjectId: string | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
  updatedByHumanId: string | null;
  updatedByEmail: string | null;
  updatedByHandle: string | null;
  updatedByDeactivatedAt: Date | null;
  updatedByAvatarObjectId: string | null;
  updatedByAgentId: string | null;
  updatedByAgentName: string | null;
};

type ActivityRow = {
  id: string;
  projectId: string;
  type: ProjectActivityType;
  summary: string;
  detail: IssueActivityDetail | null;
  issueId: string | null;
  knowledgeEntryId: string | null;
  createdAt: Date;
  actorHumanId: string | null;
  actorEmail: string | null;
  actorDeactivatedAt: Date | null;
  actorAvatarObjectId: string | null;
  actorAgentId: string | null;
  actorAgentName: string | null;
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    key: row.key,
    createdAt: row.createdAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      null,
      null,
      row.createdByDeactivatedAt,
      row.createdByAvatarObjectId,
      row.createdByHandle,
    ),
    workspaceKind: row.workspaceKind,
    accessLevel: row.accessLevel,
    fallbackPolicy: row.fallbackPolicy,
  };
}

function toProjectGrant(row: ProjectGrantRow): ProjectAccessGrant {
  return {
    humanId: row.humanId,
    email: row.email,
    level: row.level,
    grantedBy: actorFromRow(
      row.grantedByHumanId,
      row.grantedByEmail,
      null,
      null,
      row.grantedByDeactivatedAt,
      row.grantedByAvatarObjectId,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIssue(row: IssueRow, labels: ProjectLabel[] = [], blockedByIds: string[] = []): Issue {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    identifier: `${row.projectKey}-${row.number}`,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    sortOrder: row.sortOrder,
    needsInput: row.needsInput,
    assignee: assigneeFromRow(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    fallbackPolicyOverride: row.fallbackPolicyOverride,
    effectiveFallbackPolicy: row.fallbackPolicyOverride ?? row.projectFallbackPolicy,
    parentIssueId: row.parentIssueId,
    labels,
    blockedByIds,
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
      row.createdByAvatarObjectId,
      row.createdByHandle,
    ),
    updatedBy: actorFromRow(
      row.updatedByHumanId,
      row.updatedByEmail,
      row.updatedByAgentId,
      row.updatedByAgentName,
      row.updatedByDeactivatedAt,
      row.updatedByAvatarObjectId,
      row.updatedByHandle,
    ),
  };
}

function toIssueDependency(row: IssueDependencyRow): IssueDependency {
  return {
    issueId: row.issueId,
    blockedByIssueId: row.blockedByIssueId,
    createdAt: row.createdAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
      row.createdByAvatarObjectId,
    ),
  };
}

type LabelRow = {
  id: string;
  projectId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
  createdByHumanId: string | null;
  createdByEmail: string | null;
  createdByDeactivatedAt: Date | null;
  createdByAvatarObjectId: string | null;
  createdByAgentId: string | null;
  createdByAgentName: string | null;
};

const labelColumns = {
  id: projectLabels.id,
  projectId: projectLabels.projectId,
  name: projectLabels.name,
  color: projectLabels.color,
  createdAt: projectLabels.createdAt,
  updatedAt: projectLabels.updatedAt,
  createdByHumanId: projectLabels.createdByHumanId,
  createdByEmail: labelCreator.email,
  createdByDeactivatedAt: labelCreator.deactivatedAt,
  createdByAvatarObjectId: labelCreator.avatarObjectId,
  createdByAgentId: projectLabels.createdByAgentId,
  createdByAgentName: labelAgentCreator.name,
};

function toProjectLabel(row: LabelRow): ProjectLabel {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
      row.createdByAvatarObjectId,
    ),
  };
}

function toComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issueId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    author: actorFromRow(
      row.authorHumanId,
      row.authorEmail,
      row.authorAgentId,
      row.authorAgentName,
      row.authorDeactivatedAt,
      row.authorAvatarObjectId,
      row.authorHandle,
    ),
    attachments: [],
  };
}

function toLink(row: LinkRow): IssueLink {
  return {
    id: row.id,
    issueId: row.issueId,
    url: row.url,
    title: row.title,
    kind: IssueLinkKind.parse(row.kind),
    createdAt: row.createdAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
      row.createdByAvatarObjectId,
    ),
  };
}

async function loadIssueLinks(tx: DbTransaction, issueId: string): Promise<IssueLink[]> {
  const rows = await tx
    .select(linkColumns)
    .from(issueLinks)
    .leftJoin(linkCreator, eq(linkCreator.id, issueLinks.createdByHumanId))
    .leftJoin(linkAgentCreator, eq(linkAgentCreator.id, issueLinks.createdByAgentId))
    .where(eq(issueLinks.issueId, issueId))
    .orderBy(issueLinks.createdAt, issueLinks.id);
  return rows.map(toLink);
}

function toKnowledge(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: actorFromRow(
      row.createdByHumanId,
      row.createdByEmail,
      row.createdByAgentId,
      row.createdByAgentName,
      row.createdByDeactivatedAt,
      row.createdByAvatarObjectId,
      row.createdByHandle,
    ),
    updatedBy: actorFromRow(
      row.updatedByHumanId,
      row.updatedByEmail,
      row.updatedByAgentId,
      row.updatedByAgentName,
      row.updatedByDeactivatedAt,
      row.updatedByAvatarObjectId,
      row.updatedByHandle,
    ),
    attachments: [],
  };
}

function toActivity(row: ActivityRow): ProjectActivity {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    summary: row.summary,
    detail: row.detail === null ? null : IssueActivityDetail.parse(row.detail),
    issueId: row.issueId,
    knowledgeEntryId: row.knowledgeEntryId,
    createdAt: row.createdAt.toISOString(),
    actor: actorFromRow(
      row.actorHumanId,
      row.actorEmail,
      row.actorAgentId,
      row.actorAgentName,
      row.actorDeactivatedAt,
      row.actorAvatarObjectId,
    ),
  };
}

type WorkspaceFacts = {
  id: string;
  kind: WorkspaceKind;
  name: string;
  isOwner: boolean;
  canCreateProjects: boolean;
};

async function readWorkspaceFacts(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<WorkspaceFacts> {
  const [row] = await tx
    .select({
      id: workspaces.id,
      kind: workspaces.kind,
      name: workspaces.name,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      membershipCanCreateProjects: workspaceMemberships.canCreateProjects,
    })
    .from(workspaces)
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),

        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("workspace_not_found");

  if (row.kind === WorkspaceKind.enum.personal) {
    if (row.personalOwnerHumanId !== humanId) throw new ProjectsError("workspace_not_found");
    return { ...row, isOwner: true, canCreateProjects: true };
  }

  if (row.membershipIsOwner === null) throw new ProjectsError("workspace_not_found");
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isOwner: row.membershipIsOwner,
    canCreateProjects: row.membershipIsOwner || row.membershipCanCreateProjects === true,
  };
}

async function requireProject(
  tx: DbTransaction,
  projectId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
) {
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...projectColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
    })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(projectCreator, eq(projectCreator.id, projects.createdByHumanId))
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(eq(projects.id, projectId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("project_not_found");
  const grantLevel = row.grantLevel === null ? null : ProjectAccessLevel.parse(row.grantLevel);
  const facts = {
    workspaceKind: WorkspaceKind.parse(row.workspaceKind),
    personalOwnerHumanId: row.personalOwnerHumanId,
    membershipIsOwner: row.membershipIsOwner,
    grantLevel,
    projectId: row.id,
    workspaceId: row.workspaceId,
  };
  return {
    ...row,
    ...facts,
    accessLevel: requireLevel(facts, actor, required, "project_not_found"),
  };
}

async function requireIssue(
  tx: DbTransaction,
  issueId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
  includeDeleted = false,
) {
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...issueColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
      workspaceId: projects.workspaceId,
      projectFallbackPolicy: projects.fallbackPolicy,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .leftJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
    .leftJoin(issueAgentCreator, eq(issueAgentCreator.id, issues.createdByAgentId))
    .leftJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
    .leftJoin(issueAgentEditor, eq(issueAgentEditor.id, issues.updatedByAgentId))
    .leftJoin(
      assigneeHuman,
      and(eq(assigneeHuman.id, issues.assigneeId), eq(issues.assigneeType, "human")),
    )
    .leftJoin(
      assigneeAgent,
      and(eq(assigneeAgent.id, issues.assigneeId), eq(issues.assigneeType, "agent")),
    )
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(
      includeDeleted
        ? eq(issues.id, issueId)
        : and(eq(issues.id, issueId), isNull(issues.deletedAt)),
    )
    .limit(1);

  if (row === undefined) throw new ProjectsError("issue_not_found");
  return { ...row, accessLevel: requireLevel(row, actor, required, "issue_not_found") };
}

async function loadLabelsForIssues(
  tx: DbTransaction,
  issueIds: readonly string[],
): Promise<Map<string, ProjectLabel[]>> {
  const grouped = new Map<string, ProjectLabel[]>();
  if (issueIds.length === 0) return grouped;
  const rows = await tx
    .select({ issueId: issueLabels.issueId, ...labelColumns })
    .from(issueLabels)
    .innerJoin(projectLabels, eq(projectLabels.id, issueLabels.labelId))
    .leftJoin(labelCreator, eq(labelCreator.id, projectLabels.createdByHumanId))
    .leftJoin(labelAgentCreator, eq(labelAgentCreator.id, projectLabels.createdByAgentId))
    .where(inArray(issueLabels.issueId, [...issueIds]))
    .orderBy(projectLabels.name, projectLabels.id);
  for (const row of rows) {
    const list = grouped.get(row.issueId) ?? [];
    list.push(toProjectLabel(row));
    grouped.set(row.issueId, list);
  }
  return grouped;
}

async function loadIssueLabels(tx: DbTransaction, issueId: string): Promise<ProjectLabel[]> {
  const grouped = await loadLabelsForIssues(tx, [issueId]);
  return grouped.get(issueId) ?? [];
}

async function loadBlockedByIdsForIssues(
  tx: DbTransaction,
  issueIds: readonly string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (issueIds.length === 0) return grouped;
  const rows = await tx
    .select({
      issueId: issueDependencies.issueId,
      blockedByIssueId: issueDependencies.blockedByIssueId,
    })
    .from(issueDependencies)
    .innerJoin(blockerIssue, eq(blockerIssue.id, issueDependencies.blockedByIssueId))
    .where(and(inArray(issueDependencies.issueId, [...issueIds]), isNull(blockerIssue.deletedAt)))
    .orderBy(issueDependencies.issueId, issueDependencies.blockedByIssueId);
  for (const row of rows) {
    const list = grouped.get(row.issueId) ?? [];
    list.push(row.blockedByIssueId);
    grouped.set(row.issueId, list);
  }
  return grouped;
}

async function loadBlockedByIds(tx: DbTransaction, issueId: string): Promise<string[]> {
  const grouped = await loadBlockedByIdsForIssues(tx, [issueId]);
  return grouped.get(issueId) ?? [];
}

async function requireProjectLabels(
  tx: DbTransaction,
  projectId: string,
  labelIds: ReadonlySet<string>,
): Promise<{ id: string; name: string; color: string }[]> {
  if (labelIds.size === 0) return [];
  const rows = await tx
    .select({ id: projectLabels.id, name: projectLabels.name, color: projectLabels.color })
    .from(projectLabels)
    .where(and(eq(projectLabels.projectId, projectId), inArray(projectLabels.id, [...labelIds])))
    .orderBy(projectLabels.name, projectLabels.id);
  if (rows.length !== labelIds.size) throw new ProjectsError("label_not_found");
  return rows;
}

async function requireLabel(
  tx: DbTransaction,
  labelId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
) {
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...labelColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
      workspaceId: projects.workspaceId,
    })
    .from(projectLabels)
    .innerJoin(projects, eq(projects.id, projectLabels.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .leftJoin(labelCreator, eq(labelCreator.id, projectLabels.createdByHumanId))
    .leftJoin(labelAgentCreator, eq(labelAgentCreator.id, projectLabels.createdByAgentId))
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(eq(projectLabels.id, labelId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("label_not_found");
  const facts = {
    workspaceKind: WorkspaceKind.parse(row.workspaceKind),
    personalOwnerHumanId: row.personalOwnerHumanId,
    membershipIsOwner: row.membershipIsOwner,
    grantLevel: row.grantLevel === null ? null : ProjectAccessLevel.parse(row.grantLevel),
    projectId: row.projectId,
    workspaceId: row.workspaceId,
  };
  return { ...row, ...facts, accessLevel: requireLevel(facts, actor, required, "label_not_found") };
}

async function requireParent(
  tx: DbTransaction,
  parentIssueId: string,
  projectId: string,
  issueId: string,
  actor: WorkActor,
) {
  if (issueId === parentIssueId) throw new ProjectsError("self_parent");
  const parent = await requireIssue(tx, parentIssueId, actor, ProjectAccessLevel.enum.read);
  if (parent.projectId !== projectId) throw new ProjectsError("cross_project_parent");
  if (parent.parentIssueId !== null) throw new ProjectsError("subtask_depth_exceeded");
  return parent;
}

async function lockSubtaskWrite(
  tx: DbTransaction,
  projectId: string,
  issueId: string,
  parentIssueId: string,
) {
  await lockProjectForMutation(tx, projectId);
  await tx
    .select({ id: issues.id })
    .from(issues)
    .where(inArray(issues.id, [issueId, parentIssueId].toSorted()))
    .orderBy(issues.id)
    .for("update");
}

async function validateParent(
  tx: DbTransaction,
  projectId: string,
  issueId: string,
  parentIssueId: string,
): Promise<void> {
  if (issueId === parentIssueId) throw new ProjectsError("self_parent");
  const [parent] = await tx
    .select({ projectId: issues.projectId, parentIssueId: issues.parentIssueId })
    .from(issues)

    .where(and(eq(issues.id, parentIssueId), isNull(issues.deletedAt)))
    .limit(1);
  if (parent === undefined) throw new ProjectsError("issue_not_found");
  if (parent.projectId !== projectId) throw new ProjectsError("cross_project_parent");
  if (parent.parentIssueId !== null) throw new ProjectsError("subtask_depth_exceeded");
  const [child] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.parentIssueId, issueId))
    .limit(1);
  if (child !== undefined) throw new ProjectsError("subtask_depth_exceeded");
}

async function validateAssignee(
  tx: DbTransaction,
  workspaceId: string,
  assignee: Assignee,
): Promise<Actor> {
  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (workspace === undefined) throw new ProjectsError("assignee_not_found");

  let targetHumanId: string;
  let resolved: Actor;
  if (assignee.type === "human") {
    const [human] = await tx
      .select({ id: humans.id, email: humans.email, avatarObjectId: humans.avatarObjectId })
      .from(humans)
      .where(and(eq(humans.id, assignee.id), isNull(humans.deactivatedAt)))
      .limit(1)
      .for("key share");
    if (human === undefined) throw new ProjectsError("assignee_not_found");
    targetHumanId = human.id;
    resolved = {
      humanId: human.id,
      email: human.email,
      displayName: human.email,
      avatarUrl:
        human.avatarObjectId === null ? null : avatarUrlFor(human.id, human.avatarObjectId),
    };
  } else {
    const [agent] = await tx
      .select({ id: agents.id, humanId: agents.humanId, name: agents.name })
      .from(agents)
      .where(eq(agents.id, assignee.id))
      .limit(1);
    if (agent === undefined) throw new ProjectsError("assignee_not_found");

    const [key] = await tx
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(
        and(
          eq(agentApiKeys.agentId, agent.id),
          eq(agentApiKeys.workspaceId, workspaceId),
          isNull(agentApiKeys.revokedAt),
          or(
            isNull(agentApiKeys.expiresAt),
            gt(agentApiKeys.expiresAt, sql`statement_timestamp()`),
          ),
        ),
      )
      .limit(1)
      .for("share");
    if (key === undefined) throw new ProjectsError("assignee_not_found");
    const [owner] = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(and(eq(humans.id, agent.humanId), isNull(humans.deactivatedAt)))
      .limit(1)
      .for("key share");
    if (owner === undefined) throw new ProjectsError("assignee_not_found");
    targetHumanId = agent.humanId;
    resolved = {
      agentId: agent.id,
      agentName: agent.name,
      displayName: agent.name,
      avatarUrl: null,
    };
  }

  if (workspace.personalOwnerHumanId !== targetHumanId) {
    const [membership] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.humanId, targetHumanId),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .limit(1)
      .for("key share");
    if (membership === undefined) throw new ProjectsError("assignee_not_found");
  }
  return resolved;
}

async function requireKnowledge(
  tx: DbTransaction,
  entryId: string,
  actor: WorkActor,
  required: ProjectAccessLevel,
) {
  const membershipMatch = humanIdMatch(actor, "membership");
  const grantMatch = humanIdMatch(actor, "grant");
  const [row] = await tx
    .select({
      ...knowledgeColumns,
      workspaceKind: workspaces.kind,
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipIsOwner: workspaceMemberships.isOwner,
      grantLevel: projectAccessGrants.level,
      workspaceId: projects.workspaceId,
    })
    .from(knowledgeEntries)
    .innerJoin(projects, eq(projects.id, knowledgeEntries.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .leftJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
    .leftJoin(
      knowledgeAgentCreator,
      eq(knowledgeAgentCreator.id, knowledgeEntries.createdByAgentId),
    )
    .leftJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
    .leftJoin(knowledgeAgentEditor, eq(knowledgeAgentEditor.id, knowledgeEntries.updatedByAgentId))
    .leftJoin(
      workspaceMemberships,
      and(eq(workspaceMemberships.workspaceId, projects.workspaceId), membershipMatch),
    )
    .leftJoin(projectAccessGrants, and(eq(projectAccessGrants.projectId, projects.id), grantMatch))
    .where(eq(knowledgeEntries.id, entryId))
    .limit(1);

  if (row === undefined) throw new ProjectsError("knowledge_entry_not_found");
  return { ...row, accessLevel: requireLevel(row, actor, required, "knowledge_entry_not_found") };
}

type RecordActivityInput =
  | {
      projectId: string;
      type:
        | "project_created"
        | "project_renamed"
        | "project_fallback_policy_changed"
        | "project_label_created"
        | "project_label_edited"
        | "project_label_deleted";
      actor: WorkActor;
      summary: string;
      detail?: IssueActivityDetail;
    }
  | {
      projectId: string;
      type:
        | "issue_created"
        | "issue_edited"
        | "issue_commented"
        | "issue_closed"
        | "issue_reopened"
        | "issue_fallback_policy_override_changed"
        | "issue_dependency_added"
        | "issue_dependency_removed"
        | "issue_link_added"
        | "issue_link_removed"
        | "issue_label_added"
        | "issue_label_removed"
        | "issue_parent_changed"
        | "issue_deleted"
        | "issue_restored";
      actor: WorkActor;
      summary: string;
      issueId: string;
      detail?: IssueActivityDetail;
      /** Handles newly introduced by this edit; delivery is gated on live project Read access. */
      mentionHandles?: readonly string[];
    }
  | {
      projectId: string;
      type: "knowledge_created" | "knowledge_edited";
      actor: WorkActor;
      summary: string;
      knowledgeEntryId: string;
      detail?: IssueActivityDetail;
    };

async function insertActivityRow(
  tx: DbTransaction,
  input: RecordActivityInput,
  onActivity: EnqueueWebhookActivity,
  notifyActivity: NotifyActivity,
) {
  const activityId = randomUUID();
  await tx.insert(projectActivity).values({
    id: activityId,
    projectId: input.projectId,
    type: input.type,
    actorHumanId: humanIdOf(input.actor),
    actorAgentId: agentIdOf(input.actor),
    summary: input.summary,
    detail: input.detail ?? null,
    createdAt: sql`statement_timestamp()`,
    ...("issueId" in input ? { issueId: input.issueId } : {}),
    ...("knowledgeEntryId" in input ? { knowledgeEntryId: input.knowledgeEntryId } : {}),
  });
  await onActivity(tx, activityId);
  if (
    "mentionHandles" in input &&
    input.mentionHandles !== undefined &&
    input.mentionHandles.length > 0
  ) {
    await notifyActivity(tx, {
      activityId,
      projectId: input.projectId,
      issueId: input.issueId,
      kind: "issue_mentioned",
      summary: input.summary,
      actorHumanId: humanIdOf(input.actor),
      actorAgentId: agentIdOf(input.actor),
      mentionHandles: input.mentionHandles,
    });
  }
}

type AccessEventInput = {
  projectId: string;

  workspaceId: string;
  actorHumanId: string;
  subjectHumanId: string;
  type: ProjectAccessEventType;
  level: ProjectAccessLevel | null;
  previousLevel: ProjectAccessLevel | null;
};

async function recordAccessEvents(tx: DbTransaction, inputs: readonly AccessEventInput[]) {
  if (inputs.length === 0) return;
  await tx.insert(projectAccessEvents).values(
    inputs.map((input) => ({
      id: randomUUID(),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      actorHumanId: input.actorHumanId,
      subjectHumanId: input.subjectHumanId,
      type: input.type,
      level: input.level,
      previousLevel: input.previousLevel,
      createdAt: sql`statement_timestamp()`,
    })),
  );
}

async function recordAccessEvent(tx: DbTransaction, input: AccessEventInput) {
  await recordAccessEvents(tx, [input]);
}

async function revokeMemberProjectAccessInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  actorHumanId: string,
) {
  const grants = await tx
    .select({
      id: projectAccessGrants.id,
      projectId: projectAccessGrants.projectId,
      level: projectAccessGrants.level,
    })
    .from(projectAccessGrants)
    .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
    .where(and(eq(projects.workspaceId, workspaceId), eq(projectAccessGrants.humanId, humanId)));

  if (grants.length === 0) return;

  await tx.delete(projectAccessGrants).where(
    inArray(
      projectAccessGrants.id,
      grants.map((grant) => grant.id),
    ),
  );
  await recordAccessEvents(
    tx,
    grants.map((grant) => ({
      projectId: grant.projectId,
      workspaceId,
      actorHumanId,
      subjectHumanId: humanId,
      type: ProjectAccessEventType.enum.project_access_revoked,
      level: null,
      previousLevel: ProjectAccessLevel.parse(grant.level),
    })),
  );
}

async function applyInvitationGrantsInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  grantedByHumanId: string,
  offered: readonly { projectId: string; level: ProjectAccessLevel }[],
): Promise<string[]> {
  if (offered.length === 0) return [];

  await lockWorkspaceOwnershipWrites(tx);
  const projectIds = [...new Set(offered.map((grant) => grant.projectId))];
  const currentProjects = await tx
    .select({ id: projects.id, workspaceId: projects.workspaceId })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const currentWorkspaceByProject = new Map(
    currentProjects.map((project) => [project.id, project.workspaceId]),
  );
  const invalid = projectIds.filter(
    (projectId) => currentWorkspaceByProject.get(projectId) !== workspaceId,
  );
  if (invalid.length > 0) return invalid;

  const existing = await tx
    .select({ projectId: projectAccessGrants.projectId, level: projectAccessGrants.level })
    .from(projectAccessGrants)
    .where(
      and(
        inArray(projectAccessGrants.projectId, projectIds),
        eq(projectAccessGrants.humanId, humanId),
      ),
    );
  const levelByProject = new Map(
    existing.map((grant) => [grant.projectId, ProjectAccessLevel.parse(grant.level)]),
  );

  const planned: {
    projectId: string;
    nextLevel: ProjectAccessLevel;
    currentLevel: ProjectAccessLevel | null;
  }[] = [];
  for (const offer of offered) {
    const currentLevel = levelByProject.get(offer.projectId) ?? null;
    const nextLevel =
      currentLevel === null || ACCESS_RANK[offer.level] > ACCESS_RANK[currentLevel]
        ? offer.level
        : currentLevel;
    if (nextLevel === currentLevel) continue;
    planned.push({ projectId: offer.projectId, nextLevel, currentLevel });
    levelByProject.set(offer.projectId, nextLevel);
  }
  if (planned.length === 0) return [];

  const finalLevels = new Map<string, ProjectAccessLevel>();
  for (const grant of planned) finalLevels.set(grant.projectId, grant.nextLevel);
  await tx
    .insert(projectAccessGrants)
    .values(
      [...finalLevels].map(([projectId, level]) => ({
        id: randomUUID(),
        projectId,
        humanId,
        level,
        grantedByHumanId,
        createdAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      })),
    )
    .onConflictDoUpdate({
      target: [projectAccessGrants.projectId, projectAccessGrants.humanId],
      set: {
        level: sql`excluded.level`,
        grantedByHumanId,
        updatedAt: sql`statement_timestamp()`,
      },
    });
  await recordAccessEvents(
    tx,
    planned.map((grant) => ({
      projectId: grant.projectId,
      workspaceId,
      actorHumanId: grantedByHumanId,
      subjectHumanId: humanId,
      type:
        grant.currentLevel === null
          ? ProjectAccessEventType.enum.project_access_granted
          : ProjectAccessEventType.enum.project_access_level_changed,
      level: grant.nextLevel,
      previousLevel: grant.currentLevel,
    })),
  );
  return [];
}

async function lockWorkspaceOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
}

async function lockProjectForMutation(tx: DbTransaction, projectId: string) {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
}

async function lockIssueForMutation(tx: DbTransaction, issueId: string) {
  await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
}

const grantColumns = {
  humanId: projectAccessGrants.humanId,
  email: humans.email,
  level: projectAccessGrants.level,
  grantedByHumanId: projectAccessGrants.grantedByHumanId,
  grantedByEmail: accessGrantor.email,
  grantedByDeactivatedAt: accessGrantor.deactivatedAt,
  grantedByAvatarObjectId: accessGrantor.avatarObjectId,
  createdAt: projectAccessGrants.createdAt,
  updatedAt: projectAccessGrants.updatedAt,
};

async function readProjectGrant(tx: DbTransaction, projectId: string, humanId: string) {
  const [row] = await tx
    .select(grantColumns)
    .from(projectAccessGrants)
    .innerJoin(humans, eq(humans.id, projectAccessGrants.humanId))
    .innerJoin(accessGrantor, eq(accessGrantor.id, projectAccessGrants.grantedByHumanId))
    .where(
      and(eq(projectAccessGrants.projectId, projectId), eq(projectAccessGrants.humanId, humanId)),
    )
    .limit(1);
  return row;
}

export type WorkSessionGate = (
  tx: DbTransaction,
  agentId: string,
  workspaceId: string,
  issueId: string,
) => Promise<boolean>;

export type IssueSessionGate = (tx: DbTransaction, issueId: string) => Promise<boolean>;

export type ReleaseIssueWorkSessions = (
  tx: DbTransaction,
  issueId: string,
  liveOutcome?: "released" | "completed",
) => Promise<void>;

export interface ProjectsDeps {
  db: PostgresJsDatabase;
  sessionGate: WorkSessionGate;
  issueSessionGate?: IssueSessionGate;
  releaseIssueWorkSessions?: ReleaseIssueWorkSessions | undefined;

  evaluateQuestionDeadline?: ((tx: DbTransaction, issueId: string) => Promise<void>) | undefined;
  onActivity?: EnqueueWebhookActivity | undefined;
  /** Late-bound because the notifications feature is built after projects. */
  notifyActivity?: NotifyActivity | undefined;
  /** Wired by the feature registry; absent in service-level tests that do not use attachments. */
  attachmentSeams?: AttachmentSeams | undefined;
}

async function freezeDueQuestions(
  tx: DbTransaction,
  issueIds: readonly string[],
  evaluateQuestionDeadline: ProjectsDeps["evaluateQuestionDeadline"],
): Promise<void> {
  if (evaluateQuestionDeadline === undefined || issueIds.length === 0) return;
  const ids = [...new Set(issueIds)].toSorted();
  await tx
    .select({ id: issues.id })
    .from(issues)
    .where(inArray(issues.id, ids))
    .orderBy(issues.id)
    .for("update");
  for (const id of ids) await evaluateQuestionDeadline(tx, id);
}

export interface ProjectsService {
  listProjects(actor: WorkActor | null, workspaceId: string): Promise<Project[]>;
  getProject(actor: WorkActor | null, projectId: string): Promise<Project>;
  createProject(
    account: SessionAccount | null,
    workspaceId: string,
    input: CreateProjectRequest,
  ): Promise<Project>;
  updateProject(
    account: SessionAccount | null,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project>;
  listProjectAccess(
    account: SessionAccount | null,
    projectId: string,
  ): Promise<ProjectAccessGrant[]>;
  projectAccessHumanIds(account: SessionAccount | null, projectId: string): Promise<string[]>;
  setProjectAccess(
    account: SessionAccount | null,
    projectId: string,
    input: SetProjectAccessRequest,
  ): Promise<ProjectAccessGrant>;

  setProjectFallbackPolicy(
    account: SessionAccount | null,
    projectId: string,
    input: SetProjectFallbackPolicyRequest,
  ): Promise<Project>;
  setIssueFallbackPolicyOverride(
    account: SessionAccount | null,
    issueId: string,
    input: SetIssueFallbackPolicyRequest,
  ): Promise<Issue>;
  removeProjectAccess(
    account: SessionAccount | null,
    projectId: string,
    humanId: string,
  ): Promise<void>;

  revokeMemberProjectAccess(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    actorHumanId: string,
  ): Promise<void>;

  applyInvitationGrants(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    grantedByHumanId: string,
    offered: readonly { projectId: string; level: ProjectAccessLevel }[],
  ): Promise<string[]>;

  projectAccessCeiling(
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    projectIds: readonly string[],
  ): Promise<Map<string, ProjectAccessLevel | null>>;
  listIssues(actor: WorkActor | null, projectId: string): Promise<Issue[]>;
  getIssue(actor: WorkActor | null, issueId: string): Promise<IssueDetail>;

  deleteIssue(actor: WorkActor | null, issueId: string): Promise<void>;
  restoreIssue(actor: WorkActor | null, issueId: string): Promise<Issue>;
  listTrash(actor: WorkActor | null, projectId: string): Promise<Issue[]>;
  purgeExpiredTrash(): Promise<number>;
  createIssue(
    actor: WorkActor | null,
    projectId: string,
    input: CreateIssueRequest,
  ): Promise<Issue>;
  updateIssue(actor: WorkActor | null, issueId: string, input: UpdateIssueRequest): Promise<Issue>;

  listLabels(actor: WorkActor | null, projectId: string): Promise<ProjectLabel[]>;
  createLabel(
    actor: WorkActor | null,
    projectId: string,
    input: CreateProjectLabelRequest,
  ): Promise<ProjectLabel>;
  updateLabel(
    actor: WorkActor | null,
    labelId: string,
    input: UpdateProjectLabelRequest,
  ): Promise<ProjectLabel>;
  deleteLabel(actor: WorkActor | null, labelId: string): Promise<void>;
  attachLabel(actor: WorkActor | null, issueId: string, labelId: string): Promise<Issue>;
  detachLabel(actor: WorkActor | null, issueId: string, labelId: string): Promise<Issue>;

  addBlockedBy(
    actor: WorkActor | null,
    issueId: string,
    input: AddBlockedByRequest,
  ): Promise<IssueDependency>;
  removeBlockedBy(
    actor: WorkActor | null,
    issueId: string,
    blockedByIssueId: string,
  ): Promise<void>;
  listBlockedBy(actor: WorkActor | null, issueId: string): Promise<Issue[]>;
  listBlocking(actor: WorkActor | null, issueId: string): Promise<Issue[]>;
  listComments(actor: WorkActor | null, issueId: string): Promise<IssueComment[]>;
  createComment(
    actor: WorkActor | null,
    issueId: string,
    input: CreateIssueCommentRequest,
  ): Promise<IssueComment>;
  addIssueLink(
    actor: WorkActor | null,
    issueId: string,
    input: CreateIssueLinkRequest,
  ): Promise<IssueLink>;
  removeIssueLink(actor: WorkActor | null, issueId: string, linkId: string): Promise<void>;
  listActivity(actor: WorkActor | null, projectId: string): Promise<ProjectActivity[]>;
  listIssueActivity(actor: WorkActor | null, issueId: string): Promise<ProjectActivity[]>;
  listKnowledge(actor: WorkActor | null, projectId: string): Promise<KnowledgeEntry[]>;
  getKnowledge(actor: WorkActor | null, entryId: string): Promise<KnowledgeEntry>;
  createKnowledge(
    actor: WorkActor | null,
    projectId: string,
    input: CreateKnowledgeEntryRequest,
  ): Promise<KnowledgeEntry>;
  updateKnowledge(
    actor: WorkActor | null,
    entryId: string,
    input: UpdateKnowledgeEntryRequest,
  ): Promise<KnowledgeEntry>;
  listMentionCandidates(
    actor: WorkActor | null,
    projectId: string,
  ): Promise<MentionCandidatesResponse>;
}

export function createProjectsService({
  db,
  sessionGate,
  issueSessionGate = async () => false,
  releaseIssueWorkSessions = async () => {},
  evaluateQuestionDeadline,
  onActivity = async () => {},
  notifyActivity = async () => {},
  attachmentSeams,
}: ProjectsDeps): ProjectsService {
  const recordActivity = (tx: DbTransaction, input: RecordActivityInput) =>
    insertActivityRow(tx, input, onActivity, notifyActivity);

  const metadataFor = async (
    tx: DbTransaction,
    holderType: "issue" | "comment" | "knowledge",
    holderId: string,
  ) => {
    if (attachmentSeams === undefined) return [];
    const grouped = await attachmentSeams.listMetadata(tx, [{ holderType, holderId }]);
    return grouped.get(attachmentHolderKey(holderType, holderId)) ?? [];
  };

  const syncBody = (tx: DbTransaction, input: Parameters<AttachmentSeams["syncReferences"]>[1]) =>
    attachmentSeams?.syncReferences(tx, input) ?? Promise.resolve();

  async function readIssues(
    actor: WorkActor,
    projectId: string,
    scope: "active" | "trash" = "active",
  ): Promise<Issue[]> {
    return db.transaction(
      async (tx) => {
        await requireProject(
          tx,
          projectId,
          actor,
          scope === "trash" ? ProjectAccessLevel.enum.manage : ProjectAccessLevel.enum.read,
        );
        const rows = await tx
          .select({ ...issueColumns, projectFallbackPolicy: projects.fallbackPolicy })
          .from(issues)
          .innerJoin(projects, eq(projects.id, issues.projectId))
          .leftJoin(issueCreator, eq(issueCreator.id, issues.createdByHumanId))
          .leftJoin(issueAgentCreator, eq(issueAgentCreator.id, issues.createdByAgentId))
          .leftJoin(issueEditor, eq(issueEditor.id, issues.updatedByHumanId))
          .leftJoin(issueAgentEditor, eq(issueAgentEditor.id, issues.updatedByAgentId))
          .leftJoin(
            assigneeHuman,
            and(eq(assigneeHuman.id, issues.assigneeId), eq(issues.assigneeType, "human")),
          )
          .leftJoin(
            assigneeAgent,
            and(eq(assigneeAgent.id, issues.assigneeId), eq(issues.assigneeType, "agent")),
          )
          .where(
            scope === "trash"
              ? and(
                  eq(issues.projectId, projectId),
                  isNotNull(issues.deletedAt),
                  isNull(issues.purgedAt),

                  gt(issues.deletedAt, THIRTY_DAYS_AGO),
                )
              : and(eq(issues.projectId, projectId), isNull(issues.deletedAt)),
          )
          .orderBy(...issueBoardOrder);
        const labels = await loadLabelsForIssues(
          tx,
          rows.map((row) => row.id),
        );
        const blockedBy = await loadBlockedByIdsForIssues(
          tx,
          rows.map((row) => row.id),
        );
        return rows.map((row) =>
          toIssue(row, labels.get(row.id) ?? [], blockedBy.get(row.id) ?? []),
        );
      },
      { accessMode: "read only" },
    );
  }
  return {
    async listProjects(actorArg, workspaceId) {
      const actor = requireActor(actorArg);

      if (actor.kind === "agent" && workspaceId !== actor.identity.workspaceId) {
        throw new ProjectsError("workspace_not_found");
      }
      return db.transaction(
        async (tx) => {
          const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;
          const workspace = await readWorkspaceFacts(tx, workspaceId, humanId);
          const rows = await tx
            .select({
              ...projectColumns,
              workspaceKind: workspaces.kind,
              personalOwnerHumanId: workspaces.personalOwnerHumanId,
              membershipIsOwner: workspaceMemberships.isOwner,
              grantLevel: projectAccessGrants.level,
            })
            .from(projects)
            .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
            .innerJoin(projectCreator, eq(projectCreator.id, projects.createdByHumanId))
            .leftJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, projects.workspaceId),
                eq(workspaceMemberships.humanId, humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .leftJoin(
              projectAccessGrants,
              and(
                eq(projectAccessGrants.projectId, projects.id),
                eq(projectAccessGrants.humanId, humanId),
              ),
            )
            .where(
              workspace.kind === WorkspaceKind.enum.personal
                ? eq(projects.workspaceId, workspaceId)
                : workspace.isOwner
                  ? eq(projects.workspaceId, workspaceId)
                  : and(
                      eq(projects.workspaceId, workspaceId),
                      isNotNull(projectAccessGrants.level),
                    ),
            )
            .orderBy(projects.createdAt, projects.id);

          return rows.flatMap((row) => {
            const facts = { ...row, projectId: row.id, workspaceId: row.workspaceId };
            const accessLevel = actorAccessLevel(facts, actor);
            return accessLevel === null ? [] : [toProject({ ...row, accessLevel })];
          });
        },
        { accessMode: "read only" },
      );
    },

    async getProject(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) =>
          toProject(await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read)),
        { accessMode: "read only" },
      );
    },

    async createProject(account, workspaceId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      const id = randomUUID();
      return db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);
        const workspace = await readWorkspaceFacts(tx, workspaceId, actor.humanId);
        if (!workspace.canCreateProjects) {
          throw new ProjectsError("project_creation_not_allowed");
        }

        const existing = await tx
          .select({ key: projects.key })
          .from(projects)
          .where(eq(projects.workspaceId, workspaceId));
        const used = new Set(existing.map((row) => row.key));
        const key = input.key ?? availableProjectKey(baseProjectKey(input.name), used);
        if (used.has(key)) throw new ProjectsError("project_key_taken");
        const description = input.description ?? "";
        let created:
          | {
              id: string;
              workspaceId: string;
              name: string;
              description: string;
              key: string;
              createdAt: Date;
            }
          | undefined;
        try {
          [created] = await tx
            .insert(projects)
            .values({
              id,
              workspaceId,
              name: input.name,
              description,
              key,
              createdByHumanId: actor.humanId,
              createdAt: sql`statement_timestamp()`,
            })
            .returning({
              id: projects.id,
              workspaceId: projects.workspaceId,
              name: projects.name,
              description: projects.description,
              key: projects.key,
              createdAt: projects.createdAt,
            });
        } catch (error) {
          if (uniqueConstraintName(error) === "one_project_key_per_workspace") {
            throw new ProjectsError("project_key_taken");
          }
          throw error;
        }
        if (created === undefined) throw new Error("the project was not created");

        if (workspace.kind === WorkspaceKind.enum.shared && !workspace.isOwner) {
          await tx.insert(projectAccessGrants).values({
            id: randomUUID(),
            projectId: id,
            humanId: actor.humanId,
            level: ProjectAccessLevel.enum.manage,
            grantedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          });
          await recordAccessEvent(tx, {
            projectId: id,
            workspaceId,
            actorHumanId: actor.humanId,
            subjectHumanId: actor.humanId,
            type: ProjectAccessEventType.enum.project_access_granted,
            level: ProjectAccessLevel.enum.manage,
            previousLevel: null,
          });
        }

        await recordActivity(tx, {
          projectId: id,
          type: "project_created",
          actor: workActor,
          summary: input.name,
        });
        return {
          id: created.id,
          workspaceId: created.workspaceId,
          name: created.name,
          description: created.description,
          key: created.key,
          createdAt: created.createdAt.toISOString(),
          createdBy: actorForWrite(workActor),
          workspaceKind: workspace.kind,
          accessLevel: ProjectAccessLevel.enum.manage,
          fallbackPolicy: FallbackPolicy.enum.require_human,
        };
      });
    },

    async updateProject(account, projectId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        await lockProjectForMutation(tx, projectId);
        const current = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );

        if (input.key !== undefined && input.key !== current.key) {
          throw new ProjectsError("project_key_immutable");
        }
        const nextDescription = input.description ?? current.description;
        const nameChanged = input.name !== current.name;
        const descriptionChanged = nextDescription !== current.description;
        if (!nameChanged && !descriptionChanged) return toProject(current);
        const [updated] = await tx
          .update(projects)
          .set({ name: input.name, description: nextDescription })
          .where(eq(projects.id, projectId))
          .returning({
            name: projects.name,
            description: projects.description,
            createdAt: projects.createdAt,
          });
        if (updated === undefined) throw new ProjectsError("project_not_found");
        if (nameChanged) {
          await recordActivity(tx, {
            projectId,
            type: "project_renamed",
            actor: workActor,
            summary: updated.name,
          });
        }
        return toProject({ ...current, name: updated.name, description: updated.description });
      });
    },

    async setProjectFallbackPolicy(account, projectId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        await lockProjectForMutation(tx, projectId);
        const current = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );

        const due = await tx
          .select({ issueId: questions.issueId })
          .from(questions)
          .innerJoin(issues, eq(issues.id, questions.issueId))
          .where(
            and(
              eq(issues.projectId, projectId),
              isNull(issues.deletedAt),
              eq(questions.status, "open"),
              lte(questions.responseDeadlineAt, sql`statement_timestamp()`),
            ),
          )
          .orderBy(issues.id);
        await freezeDueQuestions(
          tx,
          due.map((row) => row.issueId),
          evaluateQuestionDeadline,
        );
        if (current.fallbackPolicy === input.fallbackPolicy) return toProject(current);
        const [updated] = await tx
          .update(projects)
          .set({ fallbackPolicy: input.fallbackPolicy })
          .where(eq(projects.id, projectId))
          .returning({ fallbackPolicy: projects.fallbackPolicy });
        if (updated === undefined) throw new ProjectsError("project_not_found");
        await recordActivity(tx, {
          projectId,
          type: "project_fallback_policy_changed",
          actor: workActor,
          summary: `Fallback policy changed to ${updated.fallbackPolicy}`,
        });
        return toProject({ ...current, fallbackPolicy: updated.fallbackPolicy });
      });
    },

    async setIssueFallbackPolicyOverride(account, issueId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .limit(1);
        // Lock projects before issues, matching transfers.accept and
        // setProjectFallbackPolicy: the override is compared with the project
        // fallback policy, which must not change concurrently.
        if (target !== undefined) await lockProjectForMutation(tx, target.projectId);
        await lockIssueForMutation(tx, issueId);

        await evaluateQuestionDeadline?.(tx, issueId);

        const current = await requireIssue(
          tx,
          issueId,
          workActor,
          ProjectAccessLevel.enum.contribute,
        );
        const override = input.override;
        const currentEffective = current.fallbackPolicyOverride ?? current.projectFallbackPolicy;
        const nextEffective = override ?? current.projectFallbackPolicy;
        const loosens =
          override === FallbackPolicy.enum.fallback_allowed ||
          (nextEffective === FallbackPolicy.enum.fallback_allowed &&
            currentEffective === FallbackPolicy.enum.require_human);
        if (loosens && !projectAccessAtLeast(current.accessLevel, ProjectAccessLevel.enum.manage)) {
          throw new ProjectsError("insufficient_project_access");
        }
        if (current.fallbackPolicyOverride === override) {
          return toIssue(
            current,
            await loadIssueLabels(tx, issueId),
            await loadBlockedByIds(tx, issueId),
          );
        }
        const [updated] = await tx
          .update(issues)
          .set({
            fallbackPolicyOverride: override,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(issues.id, issueId))
          .returning({ fallbackPolicyOverride: issues.fallbackPolicyOverride });
        if (updated === undefined) throw new ProjectsError("issue_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_fallback_policy_override_changed",
          actor: workActor,
          issueId,
          summary: `Fallback policy override ${override === null ? "cleared" : `set to ${override}`}`,
        });
        return toIssue(
          { ...current, fallbackPolicyOverride: updated.fallbackPolicyOverride },
          await loadIssueLabels(tx, issueId),
          await loadBlockedByIds(tx, issueId),
        );
      });
    },

    async listProjectAccess(account, projectId) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(
        async (tx) => {
          const project = await requireProject(
            tx,
            projectId,
            workActor,
            ProjectAccessLevel.enum.manage,
          );
          if (project.workspaceKind === WorkspaceKind.enum.personal) return [];
          const rows = await tx
            .select(grantColumns)
            .from(projectAccessGrants)
            .innerJoin(humans, eq(humans.id, projectAccessGrants.humanId))
            .innerJoin(accessGrantor, eq(accessGrantor.id, projectAccessGrants.grantedByHumanId))
            .innerJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, project.workspaceId),
                eq(workspaceMemberships.humanId, projectAccessGrants.humanId),
                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .where(
              and(
                eq(projectAccessGrants.projectId, projectId),
                eq(workspaceMemberships.isOwner, false),
              ),
            )
            .orderBy(projectAccessGrants.createdAt, projectAccessGrants.humanId);
          return rows.map(toProjectGrant);
        },
        { accessMode: "read only" },
      );
    },

    async projectAccessHumanIds(account, projectId) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(
        async (tx) => {
          const project = await requireProject(
            tx,
            projectId,
            workActor,
            ProjectAccessLevel.enum.contribute,
          );
          if (project.workspaceKind === WorkspaceKind.enum.personal) return [];
          const rows = await tx
            .select({ humanId: projectAccessGrants.humanId })
            .from(projectAccessGrants)
            .innerJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, project.workspaceId),
                eq(workspaceMemberships.humanId, projectAccessGrants.humanId),
              ),
            )
            .where(
              and(
                eq(projectAccessGrants.projectId, projectId),
                isNull(workspaceMemberships.suspendedAt),
                eq(workspaceMemberships.isOwner, false),
              ),
            )
            .orderBy(projectAccessGrants.humanId);
          return rows.map((row) => row.humanId);
        },
        { accessMode: "read only" },
      );
    },

    async setProjectAccess(account, projectId, input) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      return db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );
        if (project.workspaceKind === WorkspaceKind.enum.personal) {
          throw new ProjectsError("personal_project_access");
        }

        const [target] = await tx
          .select({
            humanId: humans.id,
            email: humans.email,
            isOwner: workspaceMemberships.isOwner,
          })
          .from(workspaceMemberships)
          .innerJoin(humans, eq(humans.id, workspaceMemberships.humanId))
          .where(
            and(
              eq(workspaceMemberships.workspaceId, project.workspaceId),
              eq(humans.email, input.email),
              isNull(workspaceMemberships.suspendedAt),
              isNull(humans.deactivatedAt),
            ),
          )
          .limit(1);
        if (target === undefined) throw new ProjectsError("member_not_found");
        if (target.isOwner) throw new ProjectsError("workspace_owner_access");

        const [current] = await tx
          .select({ level: projectAccessGrants.level })
          .from(projectAccessGrants)
          .where(
            and(
              eq(projectAccessGrants.projectId, projectId),
              eq(projectAccessGrants.humanId, target.humanId),
            ),
          )
          .limit(1);

        if (current?.level === input.level) {
          const existing = await readProjectGrant(tx, projectId, target.humanId);
          if (existing === undefined) throw new Error("the access grant disappeared");
          return toProjectGrant(existing);
        }

        await tx
          .insert(projectAccessGrants)
          .values({
            id: randomUUID(),
            projectId,
            humanId: target.humanId,
            level: input.level,
            grantedByHumanId: actor.humanId,
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .onConflictDoUpdate({
            target: [projectAccessGrants.projectId, projectAccessGrants.humanId],
            set: {
              level: input.level,
              grantedByHumanId: actor.humanId,
              updatedAt: sql`statement_timestamp()`,
            },
          });

        await recordAccessEvent(tx, {
          projectId,
          workspaceId: project.workspaceId,
          actorHumanId: actor.humanId,
          subjectHumanId: target.humanId,
          type:
            current === undefined
              ? ProjectAccessEventType.enum.project_access_granted
              : ProjectAccessEventType.enum.project_access_level_changed,
          level: input.level,
          previousLevel: current === undefined ? null : ProjectAccessLevel.parse(current.level),
        });

        const saved = await readProjectGrant(tx, projectId, target.humanId);
        if (saved === undefined) throw new Error("the access grant was not saved");
        return toProjectGrant(saved);
      });
    },

    async removeProjectAccess(account, projectId, humanId) {
      const actor = requireAccount(account);
      const workActor: WorkActor = { kind: "human", account: actor };
      await db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          workActor,
          ProjectAccessLevel.enum.manage,
        );
        if (project.workspaceKind === WorkspaceKind.enum.personal) {
          throw new ProjectsError("personal_project_access");
        }

        const [targetMembership] = await tx
          .select({ isOwner: workspaceMemberships.isOwner })
          .from(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, project.workspaceId),
              eq(workspaceMemberships.humanId, humanId),
              isNull(workspaceMemberships.suspendedAt),
            ),
          )
          .limit(1);
        if (targetMembership?.isOwner === true) {
          throw new ProjectsError("workspace_owner_access");
        }

        const [current] = await tx
          .select({ level: projectAccessGrants.level })
          .from(projectAccessGrants)
          .where(
            and(
              eq(projectAccessGrants.projectId, projectId),
              eq(projectAccessGrants.humanId, humanId),
            ),
          )
          .limit(1);
        if (current === undefined) return;

        await tx
          .delete(projectAccessGrants)
          .where(
            and(
              eq(projectAccessGrants.projectId, projectId),
              eq(projectAccessGrants.humanId, humanId),
            ),
          );
        await recordAccessEvent(tx, {
          projectId,
          workspaceId: project.workspaceId,
          actorHumanId: actor.humanId,
          subjectHumanId: humanId,
          type: ProjectAccessEventType.enum.project_access_revoked,
          level: null,
          previousLevel: ProjectAccessLevel.parse(current.level),
        });
      });
    },

    revokeMemberProjectAccess(tx, workspaceId, humanId, actorHumanId) {
      return revokeMemberProjectAccessInTransaction(tx, workspaceId, humanId, actorHumanId);
    },

    applyInvitationGrants(tx, workspaceId, humanId, grantedByHumanId, offered) {
      return applyInvitationGrantsInTransaction(
        tx,
        workspaceId,
        humanId,
        grantedByHumanId,
        offered,
      );
    },

    projectAccessCeiling(tx, workspaceId, humanId, projectIds) {
      return projectAccessCeilingInTransaction(tx, workspaceId, humanId, projectIds);
    },

    async listIssues(actorArg, projectId) {
      return readIssues(requireActor(actorArg), projectId);
    },

    async getIssue(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const labels = await loadIssueLabels(tx, issueId);
          const blockedByIds = await loadBlockedByIds(tx, issueId);
          return {
            ...toIssue(issue, labels, blockedByIds),
            links: await loadIssueLinks(tx, issueId),
            attachments: await metadataFor(tx, "issue", issueId),
          };
        },
        { accessMode: "read only" },
      );
    },

    async deleteIssue(actorArg, issueId) {
      const actor = requireActor(actorArg);

      if (actor.kind !== "human") throw new ProjectsError("agents_cannot_delete_issues");
      return db.transaction(async (tx) => {
        await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, issueId))
          .limit(1)
          .for("update");

        if (await issueSessionGate(tx, issueId)) {
          throw new ProjectsError("issue_active_session_exists");
        }
        const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        await tx
          .update(issues)
          .set({
            deletedAt: sql`statement_timestamp()`,
            deletedByHumanId: actor.account.humanId,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(issues.id, issueId));
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_deleted",
          actor,
          issueId,
          summary: current.title,
        });
      });
    },

    async restoreIssue(actorArg, issueId) {
      const actor = requireActor(actorArg);

      if (actor.kind !== "human") throw new ProjectsError("insufficient_project_access");
      return db.transaction(async (tx) => {
        await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.manage, true);
        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.id, issueId))
          .limit(1)
          .for("update");
        const current = await requireIssue(
          tx,
          issueId,
          actor,
          ProjectAccessLevel.enum.manage,
          true,
        );
        if (current.deletedAt === null) throw new ProjectsError("issue_not_found");

        const [expired] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, issueId), sql`${issues.deletedAt} <= ${THIRTY_DAYS_AGO}`))
          .limit(1);
        if (current.purgedAt !== null || expired !== undefined) {
          throw new ProjectsError("issue_purged");
        }
        const [restored] = await tx
          .update(issues)
          .set({
            deletedAt: null,
            deletedByHumanId: null,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(issues.id, issueId))
          .returning({ updatedAt: issues.updatedAt });
        if (restored === undefined) throw new ProjectsError("issue_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_restored",
          actor,
          issueId,
          summary: current.title,
        });
        return toIssue(
          { ...current, updatedAt: restored.updatedAt },
          await loadIssueLabels(tx, issueId),
          await loadBlockedByIds(tx, issueId),
        );
      });
    },

    async listTrash(actorArg, projectId) {
      const actor = requireActor(actorArg);

      if (actor.kind !== "human") throw new ProjectsError("insufficient_project_access");
      return readIssues(actor, projectId, "trash");
    },

    async purgeExpiredTrash() {
      return db.transaction(async (tx) => {
        const expired = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              isNotNull(issues.deletedAt),
              isNull(issues.purgedAt),
              sql`${issues.deletedAt} <= ${THIRTY_DAYS_AGO}`,
            ),
          )
          .orderBy(issues.id)
          .for("update", { skipLocked: true });
        const expiredIds = expired.map((row) => row.id);
        // Collect every holder across the whole batch before locking any
        // attachment row: a per-issue purge could lock B from issue 1 then A
        // from issue 2 (A < B) and AB-BA deadlock against a save. One batch call
        // locks all candidates in a single ascending id order.
        const attachmentHolders: { holderType: "issue" | "comment"; holderId: string }[] = [];
        if (expiredIds.length > 0) {
          // Comments are hard-deleted, so collect their holder ids before the
          // rows vanish. References from both the issue and its comments have to
          // be dropped before the zero-reference check.
          const comments = await tx
            .select({ id: issueComments.id })
            .from(issueComments)
            .where(inArray(issueComments.issueId, expiredIds));
          await tx.delete(issueComments).where(inArray(issueComments.issueId, expiredIds));
          attachmentHolders.push(
            ...expiredIds.map((issueId) => ({ holderType: "issue" as const, holderId: issueId })),
            ...comments.map((comment) => ({
              holderType: "comment" as const,
              holderId: comment.id,
            })),
          );
          await tx.delete(issueLinks).where(inArray(issueLinks.issueId, expiredIds));
          await tx.delete(issueLabels).where(inArray(issueLabels.issueId, expiredIds));
          await tx
            .delete(issueDependencies)
            .where(
              or(
                inArray(issueDependencies.issueId, expiredIds),
                inArray(issueDependencies.blockedByIssueId, expiredIds),
              ),
            );
          await tx
            .update(issues)
            .set({
              title: "[deleted]",
              body: "",
              parentIssueId: null,
              assigneeType: null,
              assigneeId: null,
              purgedAt: sql`statement_timestamp()`,
            })
            .where(inArray(issues.id, expiredIds));
        }
        if (attachmentSeams !== undefined && attachmentHolders.length > 0) {
          await attachmentSeams.purgeHolders(tx, attachmentHolders);
        }

        if (expiredIds.length > 0) {
          await tx
            .update(issues)
            .set({ parentIssueId: null })
            .where(inArray(issues.parentIssueId, expiredIds));
        }
        return expired.length;
      });
    },

    async listMentionCandidates(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const project = await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
          const workspaceKind = WorkspaceKind.parse(project.workspaceKind);
          const personalOwnerHumanId = project.personalOwnerHumanId;

          const humanRows = await tx
            .select({
              id: humans.id,
              email: humans.email,
              handle: humans.handle,
              displayName: humans.displayName,
              avatarObjectId: humans.avatarObjectId,
              membershipIsOwner: workspaceMemberships.isOwner,
              grantLevel: projectAccessGrants.level,
            })
            .from(humans)
            .leftJoin(
              workspaceMemberships,
              and(
                eq(workspaceMemberships.workspaceId, project.workspaceId),
                eq(workspaceMemberships.humanId, humans.id),
                isNull(workspaceMemberships.suspendedAt),
              ),
            )
            .leftJoin(
              projectAccessGrants,
              and(
                eq(projectAccessGrants.projectId, projectId),
                eq(projectAccessGrants.humanId, humans.id),
              ),
            )
            .where(
              and(
                isNull(humans.deactivatedAt),
                personalOwnerHumanId === null
                  ? isNotNull(workspaceMemberships.id)
                  : or(isNotNull(workspaceMemberships.id), eq(humans.id, personalOwnerHumanId)),
              ),
            );

          // The same rows cover every agent owner: a shared-workspace owner must
          // hold an active membership, and a personal project only admits its
          // personal owner, so an owner missing here has no ceiling.
          const levelByHumanId = new Map<string, ProjectAccessLevel | null>();
          for (const human of humanRows) {
            levelByHumanId.set(
              human.id,
              resolveAccessLevel(
                {
                  workspaceKind,
                  personalOwnerHumanId,
                  membershipIsOwner: human.membershipIsOwner,
                  grantLevel:
                    human.grantLevel === null ? null : ProjectAccessLevel.parse(human.grantLevel),
                },
                human.id,
              ),
            );
          }

          const humansOut: MentionCandidatesResponse["humans"] = [];
          for (const human of humanRows) {
            const level = levelByHumanId.get(human.id) ?? null;
            if (level === null || !projectAccessAtLeast(level, ProjectAccessLevel.enum.read)) {
              continue;
            }
            if (human.handle === null) continue;
            humansOut.push({
              type: "human",
              id: human.id,
              handle: human.handle,
              email: human.email,
              displayName: human.displayName ?? human.email,
              avatarUrl:
                human.avatarObjectId === null ? null : avatarUrlFor(human.id, human.avatarObjectId),
            });
          }
          humansOut.sort((a, b) => a.handle.localeCompare(b.handle));

          const agentRows = await tx
            .selectDistinct({ id: agents.id, name: agents.name, humanId: agents.humanId })
            .from(agents)
            // An agent owned by a deactivated Human is not a mention candidate, even
            // when its key and project grant are otherwise live.
            .innerJoin(humans, and(eq(humans.id, agents.humanId), isNull(humans.deactivatedAt)))
            .innerJoin(
              agentApiKeys,
              and(
                eq(agentApiKeys.agentId, agents.id),
                eq(agentApiKeys.workspaceId, project.workspaceId),
                isNull(agentApiKeys.revokedAt),
                or(isNull(agentApiKeys.expiresAt), gt(agentApiKeys.expiresAt, sql`now()`)),
              ),
            )
            .innerJoin(
              agentApiKeyProjects,
              and(
                eq(agentApiKeyProjects.keyId, agentApiKeys.id),
                eq(agentApiKeyProjects.projectId, projectId),
              ),
            );
          const agentsOut: MentionCandidatesResponse["agents"] = [];
          for (const row of agentRows) {
            const level = levelByHumanId.get(row.humanId) ?? null;
            if (level === null || !projectAccessAtLeast(level, ProjectAccessLevel.enum.read)) {
              continue;
            }
            agentsOut.push({
              type: "agent",
              id: row.id,
              name: row.name,
              slug: agentSlug(row.name),
              avatarUrl: null,
            });
          }
          agentsOut.sort((a, b) => a.slug.localeCompare(b.slug));
          return { humans: humansOut, agents: agentsOut };
        },
        { accessMode: "read only" },
      );
    },

    async createIssue(actorArg, projectId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        // transfers.accept holds this row FOR UPDATE until it commits the new
        // workspace, key and access grants. Lock first so the access check and
        // every value derived from project cannot use a pre-transfer snapshot.
        await lockProjectForMutation(tx, projectId);
        const project = await requireProject(
          tx,
          projectId,
          actor,
          ProjectAccessLevel.enum.contribute,
        );
        const [counter] = await tx
          .update(projects)
          .set({ nextIssueNumber: sql`${projects.nextIssueNumber} + 1` })
          .where(eq(projects.id, projectId))
          .returning({ number: sql<number>`${projects.nextIssueNumber} - 1` });
        if (counter === undefined) throw new ProjectsError("project_not_found");

        const resolvedAssignee =
          input.assignee === undefined || input.assignee === null
            ? null
            : await validateAssignee(tx, project.workspaceId, input.assignee);
        const requestedLabelIds = new Set(input.labelIds ?? []);
        const labels = await requireProjectLabels(tx, projectId, requestedLabelIds);

        const id = randomUUID();

        const status = input.status ?? IssueStatus.enum.todo;
        const parentIssueId = input.parentIssueId ?? null;
        if (parentIssueId !== null) {
          await requireParent(tx, parentIssueId, projectId, id, actor);

          await lockSubtaskWrite(tx, projectId, id, parentIssueId);
          await validateParent(tx, projectId, id, parentIssueId);
        }
        const [created] = await tx
          .insert(issues)
          .values({
            id,
            projectId,
            number: counter.number,
            parentIssueId,
            title: input.title,
            body: input.body ?? "",
            status,
            closedAt: isTerminalIssueStatus(status) ? sql`statement_timestamp()` : null,
            priority: input.priority ?? IssuePriority.enum.none,
            sortOrder: input.sortOrder ?? counter.number * ISSUE_SORT_STEP,
            assigneeType: input.assignee?.type ?? null,
            assigneeId: input.assignee?.id ?? null,
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .returning({
            id: issues.id,
            projectId: issues.projectId,
            number: issues.number,
            title: issues.title,
            body: issues.body,
            status: issues.status,
            priority: issues.priority,
            sortOrder: issues.sortOrder,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
            closedAt: issues.closedAt,
          });
        if (created === undefined) throw new Error("the issue was not created");
        await recordActivity(tx, {
          projectId,
          type: "issue_created",
          actor,
          issueId: id,
          summary: input.title,
          mentionHandles: extractMentionHandles(input.body ?? ""),
        });
        for (const label of labels) {
          await tx.insert(issueLabels).values({ issueId: id, labelId: label.id });
          await recordActivity(tx, {
            projectId,
            type: "issue_label_added",
            actor,
            issueId: id,
            summary: `${input.title} labelled ${label.name}`,
            detail: {
              kind: "label_added",
              label: { id: label.id, name: label.name, color: label.color },
            },
          });
        }
        await syncBody(tx, {
          holderType: "issue",
          holderId: id,
          projectId,
          body: input.body ?? "",
        });
        const author = actorForWrite(actor);
        return {
          id: created.id,
          projectId: created.projectId,
          number: created.number,
          identifier: `${project.key}-${created.number}`,
          title: created.title,
          body: created.body,
          status: IssueStatus.parse(created.status),
          priority: created.priority,
          sortOrder: created.sortOrder,
          needsInput: false,
          assignee: resolvedAssignee,
          parentIssueId,
          labels: await loadIssueLabels(tx, id),
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          closedAt: created.closedAt === null ? null : created.closedAt.toISOString(),
          createdBy: author,
          updatedBy: author,
          fallbackPolicyOverride: null,
          effectiveFallbackPolicy: project.fallbackPolicy,
          blockedByIds: [],
        };
      });
    },

    async updateIssue(actorArg, issueId, input) {
      const actor = requireActor(actorArg);

      const target = await db.transaction(
        async (tx) => {
          const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
          return { workspaceId: issue.workspaceId, projectId: issue.projectId };
        },
        { accessMode: "read only" },
      );
      return db.transaction(async (tx) => {
        const resolvedAssignee =
          input.assignee === undefined || input.assignee === null
            ? null
            : await validateAssignee(tx, target.workspaceId, input.assignee);

        const requestedParent = input.parentIssueId;
        if (requestedParent !== undefined && requestedParent !== null) {
          await requireParent(tx, requestedParent, target.projectId, issueId, actor);
          await lockSubtaskWrite(tx, target.projectId, issueId, requestedParent);
        } else {
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.id, issueId))
            .for("update");
        }
        const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        let parentChanged = false;
        if (requestedParent !== undefined && requestedParent !== null) {
          await validateParent(tx, current.projectId, issueId, requestedParent);
          parentChanged = requestedParent !== current.parentIssueId;
        } else if (requestedParent === null) {
          parentChanged = current.parentIssueId !== null;
        }

        if (
          input.assignee !== undefined &&
          input.assignee !== null &&
          current.workspaceId !== target.workspaceId
        ) {
          throw new ProjectsError("issue_not_found");
        }

        let currentStatus = current.status;
        let currentNeedsInput = current.needsInput;
        let currentClosedAt = current.closedAt;
        if (input.status !== undefined && evaluateQuestionDeadline !== undefined) {
          await evaluateQuestionDeadline(tx, issueId);
          const [fresh] = await tx
            .select({
              status: issues.status,
              needsInput: issues.needsInput,
              closedAt: issues.closedAt,
            })
            .from(issues)
            .where(eq(issues.id, issueId))
            .limit(1);
          if (fresh !== undefined) {
            currentStatus = fresh.status;
            currentNeedsInput = fresh.needsInput;
            currentClosedAt = fresh.closedAt;
          }
        }

        if (
          actor.kind === "agent" &&
          !(await sessionGate(tx, actor.identity.agentId, actor.identity.workspaceId, issueId))
        ) {
          throw new ProjectsError("session_required");
        }
        const title = input.title ?? current.title;
        const body = input.body ?? current.body;
        const status = input.status ?? currentStatus;
        const priority = input.priority ?? current.priority;
        const sortOrder = input.sortOrder ?? current.sortOrder;

        const assigneeType =
          input.assignee === undefined ? current.assigneeType : (input.assignee?.type ?? null);
        const assigneeId =
          input.assignee === undefined ? current.assigneeId : (input.assignee?.id ?? null);
        const titleChanged = title !== current.title;
        const bodyChanged = body !== current.body;
        const statusChanged = status !== currentStatus;
        const priorityChanged = priority !== current.priority;
        const orderChanged = sortOrder !== current.sortOrder;
        const assigneeChanged =
          assigneeType !== current.assigneeType || assigneeId !== current.assigneeId;

        const terminalNow = isTerminalIssueStatus(status);
        const wasTerminal = isTerminalIssueStatus(currentStatus);

        if (statusChanged && currentNeedsInput && status !== IssueStatus.enum.todo) {
          throw new ProjectsError("issue_needs_input");
        }

        if (
          !titleChanged &&
          !bodyChanged &&
          !statusChanged &&
          !priorityChanged &&
          !orderChanged &&
          !assigneeChanged &&
          !parentChanged
        ) {
          return toIssue(
            {
              ...current,
              status: currentStatus,
              needsInput: currentNeedsInput,
              closedAt: currentClosedAt,
            },
            await loadIssueLabels(tx, issueId),
            await loadBlockedByIds(tx, issueId),
          );
        }

        const closedAt = terminalNow
          ? wasTerminal
            ? currentClosedAt
            : sql`statement_timestamp()`
          : null;
        const [updated] = await tx
          .update(issues)
          .set({
            title,
            body,
            status,
            priority,
            sortOrder,
            assigneeType,
            assigneeId,

            parentIssueId: requestedParent === undefined ? current.parentIssueId : requestedParent,
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            updatedAt: sql`statement_timestamp()`,
            closedAt,
          })
          .where(eq(issues.id, issueId))
          .returning({
            updatedAt: issues.updatedAt,
            closedAt: issues.closedAt,
          });
        if (updated === undefined) throw new ProjectsError("issue_not_found");

        if (statusChanged && status !== IssueStatus.enum.in_progress) {
          const completedByAgent =
            actor.kind === "agent" && (terminalNow || status === IssueStatus.enum.review);
          await releaseIssueWorkSessions(tx, issueId, completedByAgent ? "completed" : "released");
        }

        const workflowMove = statusChanged && !terminalNow && !wasTerminal;
        const editChanges: Extract<IssueActivityDetail, { kind: "issue_edited" }>["changes"] = [];
        if (workflowMove) {
          editChanges.push({ kind: "status", from: currentStatus, to: status });
        }
        if (priorityChanged) {
          editChanges.push({ kind: "priority", from: current.priority, to: priority });
        }
        if (assigneeChanged) {
          editChanges.push({
            kind: "assignee",
            from: assigneeFromRow(current),
            to: input.assignee === undefined ? null : resolvedAssignee,
          });
        }
        if (titleChanged || bodyChanged || priorityChanged || assigneeChanged || workflowMove) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: "issue_edited",
            actor,
            issueId,
            summary: title,
            ...(bodyChanged ? { mentionHandles: newlyAddedMentions(current.body, body) } : {}),
            ...(editChanges.length > 0
              ? { detail: { kind: "issue_edited" as const, changes: editChanges } }
              : {}),
          });
        }
        if (statusChanged && (terminalNow || wasTerminal)) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: terminalNow ? "issue_closed" : "issue_reopened",
            actor,
            issueId,
            summary: title,
            detail: terminalNow
              ? { kind: "issue_closed" as const, from: currentStatus, to: status }
              : { kind: "issue_reopened" as const, from: currentStatus, to: status },
          });
        }
        if (parentChanged) {
          await recordActivity(tx, {
            projectId: current.projectId,
            type: "issue_parent_changed",
            actor,
            issueId,
            summary: title,
            detail: {
              kind: "parent_changed",
              from: current.parentIssueId,
              to: requestedParent === undefined ? current.parentIssueId : requestedParent,
            },
          });
        }
        // The issue row is already locked and written in this transaction, so
        // locking its attachments now keeps the global lock order intact.
        await syncBody(tx, {
          holderType: "issue",
          holderId: issueId,
          projectId: current.projectId,
          body,
        });
        return {
          id: current.id,
          projectId: current.projectId,
          number: current.number,
          identifier: `${current.projectKey}-${current.number}`,
          title,
          body,
          status: IssueStatus.parse(status),
          priority,
          sortOrder,
          needsInput: currentNeedsInput,
          assignee: assigneeChanged
            ? input.assignee === null
              ? null
              : resolvedAssignee
            : assigneeFromRow(current),
          parentIssueId: requestedParent === undefined ? current.parentIssueId : requestedParent,
          labels: await loadIssueLabels(tx, issueId),
          createdAt: current.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          closedAt: updated.closedAt === null ? null : updated.closedAt.toISOString(),
          createdBy: actorFromRow(
            current.createdByHumanId,
            current.createdByEmail,
            current.createdByAgentId,
            current.createdByAgentName,
            undefined,
            current.createdByAvatarObjectId,
            current.createdByHandle,
          ),
          updatedBy: actorForWrite(actor),
          fallbackPolicyOverride: current.fallbackPolicyOverride,
          effectiveFallbackPolicy: current.fallbackPolicyOverride ?? current.projectFallbackPolicy,
          blockedByIds: await loadBlockedByIds(tx, issueId),
        };
      });
    },

    async addBlockedBy(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      const blockedByIssueId = input.blockedByIssueId;
      return db.transaction(async (tx) => {
        let current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        if (issueId === blockedByIssueId) throw new ProjectsError("self_dependency");
        let blocker = await requireIssue(tx, blockedByIssueId, actor, ProjectAccessLevel.enum.read);
        if (blocker.projectId !== current.projectId) {
          throw new ProjectsError("cross_project_dependency");
        }

        // Lock projects before issues, matching transfers.accept's order, then
        // re-check access: a transfer may have committed between the reads
        // above and the locks, revoking the actor's source-workspace grant.
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, current.projectId))
          .for("update");

        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(inArray(issues.id, [issueId, blockedByIssueId].toSorted()))
          .orderBy(issues.id)
          .for("update");

        current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        blocker = await requireIssue(tx, blockedByIssueId, actor, ProjectAccessLevel.enum.read);
        if (blocker.projectId !== current.projectId) {
          throw new ProjectsError("cross_project_dependency");
        }

        const [existing] = await tx
          .select(dependencyColumns)
          .from(issueDependencies)
          .leftJoin(
            dependencyHumanCreator,
            eq(dependencyHumanCreator.id, issueDependencies.createdByHumanId),
          )
          .leftJoin(
            dependencyAgentCreator,
            eq(dependencyAgentCreator.id, issueDependencies.createdByAgentId),
          )
          .where(
            and(
              eq(issueDependencies.issueId, issueId),
              eq(issueDependencies.blockedByIssueId, blockedByIssueId),
            ),
          )
          .limit(1);
        if (existing !== undefined) return toIssueDependency(existing);

        const visited = new Set<string>([blockedByIssueId]);
        let frontier: string[] = [blockedByIssueId];
        while (frontier.length > 0) {
          const rows = await tx
            .select({ next: issueDependencies.blockedByIssueId })
            .from(issueDependencies)
            .where(inArray(issueDependencies.issueId, frontier));
          const next: string[] = [];
          for (const row of rows) {
            if (row.next === issueId) throw new ProjectsError("dependency_cycle");
            if (!visited.has(row.next)) {
              visited.add(row.next);
              next.push(row.next);
            }
          }
          frontier = next;
        }

        const [inserted] = await tx
          .insert(issueDependencies)
          .values({
            id: randomUUID(),
            issueId,
            blockedByIssueId,
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
          })
          .returning({ createdAt: issueDependencies.createdAt });
        if (inserted === undefined) throw new Error("the dependency was not created");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_dependency_added",
          actor,
          issueId,
          summary: `${current.title} blocked by ${blocker.title}`,
          detail: {
            kind: "issue_dependency_added",
            issueId,
            blockedByIssueId,
            title: blocker.title,
          },
        });
        return {
          issueId,
          blockedByIssueId,
          createdAt: inserted.createdAt.toISOString(),
          createdBy: actorForWrite(actor),
        };
      });
    },

    async removeBlockedBy(actorArg, issueId, blockedByIssueId) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await lockIssueForMutation(tx, issueId);
        const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const [blocker] = await tx
          .select({ title: issues.title })
          .from(issues)
          .where(eq(issues.id, blockedByIssueId))
          .limit(1);
        const deleted = await tx
          .delete(issueDependencies)
          .where(
            and(
              eq(issueDependencies.issueId, issueId),
              eq(issueDependencies.blockedByIssueId, blockedByIssueId),
            ),
          )
          .returning({ issueId: issueDependencies.issueId });
        if (deleted.length === 0) return;
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "issue_dependency_removed",
          actor,
          issueId,
          summary: `${current.title} no longer blocked by ${blocker?.title ?? blockedByIssueId}`,
          detail: {
            kind: "issue_dependency_removed",
            issueId,
            blockedByIssueId,
            title: blocker?.title ?? blockedByIssueId,
          },
        });
      });
    },

    async listBlockedBy(actorArg, issueId) {
      const actor = requireActor(actorArg);
      const found = await db.transaction(
        async (tx) => {
          const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select({ id: issueDependencies.blockedByIssueId })
            .from(issueDependencies)
            .where(eq(issueDependencies.issueId, issueId));
          return { projectId: current.projectId, ids: rows.map((row) => row.id) };
        },
        { accessMode: "read only" },
      );
      if (found.ids.length === 0) return [];
      const blockers = new Set(found.ids);
      return (await readIssues(actor, found.projectId)).filter((issue) => blockers.has(issue.id));
    },

    async listBlocking(actorArg, issueId) {
      const actor = requireActor(actorArg);
      const found = await db.transaction(
        async (tx) => {
          const current = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select({ id: issueDependencies.issueId })
            .from(issueDependencies)
            .where(eq(issueDependencies.blockedByIssueId, issueId));
          return { projectId: current.projectId, ids: rows.map((row) => row.id) };
        },
        { accessMode: "read only" },
      );
      if (found.ids.length === 0) return [];
      const dependants = new Set(found.ids);
      return (await readIssues(actor, found.projectId)).filter((issue) => dependants.has(issue.id));
    },

    async listComments(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(commentColumns)
            .from(issueComments)
            .leftJoin(commentAuthor, eq(commentAuthor.id, issueComments.createdByHumanId))
            .leftJoin(commentAgentAuthor, eq(commentAgentAuthor.id, issueComments.createdByAgentId))
            .where(eq(issueComments.issueId, issueId))
            .orderBy(issueComments.createdAt, issueComments.id);
          const grouped =
            attachmentSeams === undefined || rows.length === 0
              ? null
              : await attachmentSeams.listMetadata(
                  tx,
                  rows.map((row) => ({ holderType: "comment", holderId: row.id })),
                );
          return rows.map((row) => {
            const comment = toComment(row);
            comment.attachments = grouped?.get(attachmentHolderKey("comment", row.id)) ?? [];
            return comment;
          });
        },
        { accessMode: "read only" },
      );
    },

    async createComment(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        // transfers.accept locks projects before issues; locking the issue
        // serializes this write with a transfer and makes the access check
        // below observe the committed workspace and grants.
        await lockIssueForMutation(tx, issueId);
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const id = randomUUID();
        const [created] = await tx
          .insert(issueComments)
          .values({
            id,
            issueId,
            body: input.body,
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
          })
          .returning({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
          });
        if (created === undefined) throw new Error("the comment was not created");
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_commented",
          actor,
          issueId,
          summary: issue.title,
          mentionHandles: extractMentionHandles(input.body),
        });
        await syncBody(tx, {
          holderType: "comment",
          holderId: id,
          projectId: issue.projectId,
          body: input.body,
        });
        return {
          id: created.id,
          issueId: created.issueId,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          author: actorForWrite(actor),
          attachments: await metadataFor(tx, "comment", id),
        };
      });
    },

    async addIssueLink(actorArg, issueId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await lockIssueForMutation(tx, issueId);
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        let created:
          | {
              id: string;
              issueId: string;
              url: string;
              title: string;
              kind: IssueLinkKind;
              createdAt: Date;
            }
          | undefined;
        try {
          [created] = await tx
            .insert(issueLinks)
            .values({
              id: randomUUID(),
              issueId,
              url: input.url,
              title: input.title,
              kind: input.kind,
              createdByHumanId: humanIdOf(actor),
              createdByAgentId: agentIdOf(actor),
              createdAt: sql`statement_timestamp()`,
            })
            .returning({
              id: issueLinks.id,
              issueId: issueLinks.issueId,
              url: issueLinks.url,
              title: issueLinks.title,
              kind: issueLinks.kind,
              createdAt: issueLinks.createdAt,
            });
        } catch (error) {
          if (uniqueConstraintName(error) === "one_link_per_issue_and_url") {
            throw new ProjectsError("issue_link_exists");
          }
          throw error;
        }
        if (created === undefined) throw new Error("the link was not created");
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_link_added",
          actor,
          issueId,
          summary: `${issue.title} — ${input.title}`,
          detail: {
            kind: "issue_link_added",
            linkId: created.id,
            url: created.url,
            title: created.title,
          },
        });
        return {
          id: created.id,
          issueId: created.issueId,
          url: created.url,
          title: created.title,
          kind: IssueLinkKind.parse(created.kind),
          createdAt: created.createdAt.toISOString(),
          createdBy: actorForWrite(actor),
        };
      });
    },

    async removeIssueLink(actorArg, issueId, linkId) {
      const actor = requireActor(actorArg);
      await db.transaction(async (tx) => {
        await lockIssueForMutation(tx, issueId);
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const [removed] = await tx
          .delete(issueLinks)
          .where(and(eq(issueLinks.id, linkId), eq(issueLinks.issueId, issueId)))
          .returning({ id: issueLinks.id, url: issueLinks.url, title: issueLinks.title });
        if (removed === undefined) throw new ProjectsError("issue_link_not_found");
        await recordActivity(tx, {
          projectId: issue.projectId,
          type: "issue_link_removed",
          actor,
          issueId,
          summary: `${issue.title} — ${removed.title}`,
          detail: {
            kind: "issue_link_removed",
            linkId: removed.id,
            url: removed.url,
            title: removed.title,
          },
        });
      });
    },

    async listActivity(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(activityColumns)
            .from(projectActivity)
            .leftJoin(activityActor, eq(activityActor.id, projectActivity.actorHumanId))
            .leftJoin(activityAgentActor, eq(activityAgentActor.id, projectActivity.actorAgentId))
            .where(eq(projectActivity.projectId, projectId))
            .orderBy(projectActivity.createdAt, projectActivity.id);
          return rows.map(toActivity);
        },
        { accessMode: "read only" },
      );
    },

    async listIssueActivity(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(activityColumns)
            .from(projectActivity)
            .leftJoin(activityActor, eq(activityActor.id, projectActivity.actorHumanId))
            .leftJoin(activityAgentActor, eq(activityAgentActor.id, projectActivity.actorAgentId))
            .where(eq(projectActivity.issueId, issue.id))
            .orderBy(projectActivity.createdAt, projectActivity.id);
          return rows.map(toActivity);
        },
        { accessMode: "read only" },
      );
    },

    async listKnowledge(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(knowledgeColumns)
            .from(knowledgeEntries)
            .leftJoin(knowledgeCreator, eq(knowledgeCreator.id, knowledgeEntries.createdByHumanId))
            .leftJoin(
              knowledgeAgentCreator,
              eq(knowledgeAgentCreator.id, knowledgeEntries.createdByAgentId),
            )
            .leftJoin(knowledgeEditor, eq(knowledgeEditor.id, knowledgeEntries.updatedByHumanId))
            .leftJoin(
              knowledgeAgentEditor,
              eq(knowledgeAgentEditor.id, knowledgeEntries.updatedByAgentId),
            )
            .where(eq(knowledgeEntries.projectId, projectId))
            .orderBy(knowledgeEntries.createdAt, knowledgeEntries.id);
          const grouped =
            attachmentSeams === undefined || rows.length === 0
              ? null
              : await attachmentSeams.listMetadata(
                  tx,
                  rows.map((row) => ({ holderType: "knowledge", holderId: row.id })),
                );
          return rows.map((row) => {
            const entry = toKnowledge(row);
            entry.attachments = grouped?.get(attachmentHolderKey("knowledge", row.id)) ?? [];
            return entry;
          });
        },
        { accessMode: "read only" },
      );
    },

    async getKnowledge(actorArg, entryId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const entry = await requireKnowledge(tx, entryId, actor, ProjectAccessLevel.enum.read);
          return {
            ...toKnowledge(entry),
            attachments: await metadataFor(tx, "knowledge", entryId),
          };
        },
        { accessMode: "read only" },
      );
    },

    async createKnowledge(actorArg, projectId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await lockProjectForMutation(tx, projectId);
        await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.contribute);
        const id = randomUUID();
        const [created] = await tx
          .insert(knowledgeEntries)
          .values({
            id,
            projectId,
            title: input.title,
            body: input.body ?? "",
            createdByHumanId: humanIdOf(actor),
            createdByAgentId: agentIdOf(actor),
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          })
          .returning({
            id: knowledgeEntries.id,
            projectId: knowledgeEntries.projectId,
            title: knowledgeEntries.title,
            body: knowledgeEntries.body,
            createdAt: knowledgeEntries.createdAt,
            updatedAt: knowledgeEntries.updatedAt,
          });
        if (created === undefined) throw new Error("the knowledge entry was not created");
        await recordActivity(tx, {
          projectId,
          type: "knowledge_created",
          actor,
          knowledgeEntryId: id,
          summary: input.title,
        });
        await syncBody(tx, {
          holderType: "knowledge",
          holderId: id,
          projectId,
          body: input.body ?? "",
        });
        const author = actorForWrite(actor);
        return {
          id: created.id,
          projectId: created.projectId,
          title: created.title,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          createdBy: author,
          updatedBy: author,
          attachments: await metadataFor(tx, "knowledge", id),
        };
      });
    },

    async updateKnowledge(actorArg, entryId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ projectId: knowledgeEntries.projectId })
          .from(knowledgeEntries)
          .where(eq(knowledgeEntries.id, entryId))
          .limit(1);
        // Lock the parent project before the entry and its authorization read,
        // matching transfers.accept's projects -> child lock order.
        if (target !== undefined) await lockProjectForMutation(tx, target.projectId);
        await tx
          .select({ id: knowledgeEntries.id })
          .from(knowledgeEntries)
          .where(eq(knowledgeEntries.id, entryId))
          .for("update");
        const current = await requireKnowledge(
          tx,
          entryId,
          actor,
          ProjectAccessLevel.enum.contribute,
        );
        const title = input.title ?? current.title;
        const body = input.body ?? current.body;
        if (title === current.title && body === current.body) {
          const unchanged = toKnowledge(current);
          unchanged.attachments = await metadataFor(tx, "knowledge", entryId);
          return unchanged;
        }
        const [updated] = await tx
          .update(knowledgeEntries)
          .set({
            title,
            body,
            updatedByHumanId: humanIdOf(actor),
            updatedByAgentId: agentIdOf(actor),
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(knowledgeEntries.id, entryId))
          .returning({ updatedAt: knowledgeEntries.updatedAt });
        if (updated === undefined) throw new ProjectsError("knowledge_entry_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "knowledge_edited",
          actor,
          knowledgeEntryId: entryId,
          summary: title,
        });
        await syncBody(tx, {
          holderType: "knowledge",
          holderId: entryId,
          projectId: current.projectId,
          body,
        });
        return {
          id: current.id,
          projectId: current.projectId,
          title,
          body,
          createdAt: current.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
          createdBy: actorFromRow(
            current.createdByHumanId,
            current.createdByEmail,
            current.createdByAgentId,
            current.createdByAgentName,
            undefined,
            current.createdByAvatarObjectId,
            current.createdByHandle,
          ),
          updatedBy: actorForWrite(actor),
          attachments: await metadataFor(tx, "knowledge", entryId),
        };
      });
    },

    async listLabels(actorArg, projectId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.read);
          const rows = await tx
            .select(labelColumns)
            .from(projectLabels)
            .leftJoin(labelCreator, eq(labelCreator.id, projectLabels.createdByHumanId))
            .leftJoin(labelAgentCreator, eq(labelAgentCreator.id, projectLabels.createdByAgentId))
            .where(eq(projectLabels.projectId, projectId))
            .orderBy(projectLabels.name, projectLabels.id);
          return rows.map(toProjectLabel);
        },
        { accessMode: "read only" },
      );
    },

    async createLabel(actorArg, projectId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await lockProjectForMutation(tx, projectId);
        await requireProject(tx, projectId, actor, ProjectAccessLevel.enum.contribute);

        const [existing] = await tx
          .select({ id: projectLabels.id })
          .from(projectLabels)
          .where(
            and(
              eq(projectLabels.projectId, projectId),
              sql`lower(${projectLabels.name}) = lower(${input.name})`,
            ),
          )
          .limit(1);
        if (existing !== undefined) throw new ProjectsError("label_exists");
        const id = randomUUID();
        let created:
          | {
              id: string;
              projectId: string;
              name: string;
              color: string;
              createdAt: Date;
              updatedAt: Date;
            }
          | undefined;
        try {
          [created] = await tx
            .insert(projectLabels)
            .values({
              id,
              projectId,
              name: input.name,
              color: input.color,
              createdByHumanId: humanIdOf(actor),
              createdByAgentId: agentIdOf(actor),
              createdAt: sql`statement_timestamp()`,
              updatedAt: sql`statement_timestamp()`,
            })
            .returning({
              id: projectLabels.id,
              projectId: projectLabels.projectId,
              name: projectLabels.name,
              color: projectLabels.color,
              createdAt: projectLabels.createdAt,
              updatedAt: projectLabels.updatedAt,
            });
        } catch (error) {
          if (uniqueConstraintName(error) === "one_label_name_per_project") {
            throw new ProjectsError("label_exists");
          }
          throw error;
        }
        if (created === undefined) throw new Error("the label was not created");
        await recordActivity(tx, {
          projectId,
          type: "project_label_created",
          actor,
          summary: created.name,
        });
        return {
          id: created.id,
          projectId: created.projectId,
          name: created.name,
          color: created.color,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          createdBy: actorForWrite(actor),
        };
      });
    },

    async updateLabel(actorArg, labelId, input) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ projectId: projectLabels.projectId })
          .from(projectLabels)
          .where(eq(projectLabels.id, labelId))
          .limit(1);
        // Lock the parent project before the label and its authorization read,
        // matching transfers.accept's projects -> child lock order.
        if (target !== undefined) await lockProjectForMutation(tx, target.projectId);
        await tx
          .select({ id: projectLabels.id })
          .from(projectLabels)
          .where(eq(projectLabels.id, labelId))
          .for("update");
        const current = await requireLabel(tx, labelId, actor, ProjectAccessLevel.enum.contribute);
        const name = input.name ?? current.name;
        const color = input.color ?? current.color;
        if (name === current.name && color === current.color) return toProjectLabel(current);
        let updated: { updatedAt: Date } | undefined;
        try {
          [updated] = await tx
            .update(projectLabels)
            .set({
              name,
              color,
              updatedAt: sql`statement_timestamp()`,
            })
            .where(eq(projectLabels.id, labelId))
            .returning({ updatedAt: projectLabels.updatedAt });
        } catch (error) {
          if (uniqueConstraintName(error) === "one_label_name_per_project") {
            throw new ProjectsError("label_exists");
          }
          throw error;
        }
        if (updated === undefined) throw new ProjectsError("label_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "project_label_edited",
          actor,
          summary: name,
        });
        return {
          ...toProjectLabel(current),
          name,
          color,
          updatedAt: updated.updatedAt.toISOString(),
        };
      });
    },

    async deleteLabel(actorArg, labelId) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        const [target] = await tx
          .select({ projectId: projectLabels.projectId })
          .from(projectLabels)
          .where(eq(projectLabels.id, labelId))
          .limit(1);
        // Lock the parent project before the authorization read, matching
        // transfers.accept's projects -> child lock order.
        if (target !== undefined) await lockProjectForMutation(tx, target.projectId);
        const current = await requireLabel(tx, labelId, actor, ProjectAccessLevel.enum.contribute);

        const deleted = await tx
          .delete(projectLabels)
          .where(eq(projectLabels.id, labelId))
          .returning({ id: projectLabels.id });
        if (deleted.length === 0) throw new ProjectsError("label_not_found");
        await recordActivity(tx, {
          projectId: current.projectId,
          type: "project_label_deleted",
          actor,
          summary: current.name,
        });
      });
    },

    async attachLabel(actorArg, issueId, labelId) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await lockIssueForMutation(tx, issueId);
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const [label] = await tx
          .select({
            projectId: projectLabels.projectId,
            name: projectLabels.name,
            color: projectLabels.color,
          })
          .from(projectLabels)
          .where(eq(projectLabels.id, labelId))
          .limit(1);
        if (label === undefined || label.projectId !== issue.projectId) {
          throw new ProjectsError("label_not_found");
        }
        const inserted = await tx
          .insert(issueLabels)
          .values({ issueId, labelId })
          .onConflictDoNothing()
          .returning({ labelId: issueLabels.labelId });
        if (inserted.length > 0) {
          await recordActivity(tx, {
            projectId: issue.projectId,
            type: "issue_label_added",
            actor,
            issueId,
            summary: `${issue.title} labelled ${label.name}`,
            detail: {
              kind: "label_added",
              label: { id: labelId, name: label.name, color: label.color },
            },
          });
        }
        return {
          ...toIssue(
            issue,
            await loadIssueLabels(tx, issueId),
            await loadBlockedByIds(tx, issueId),
          ),
        };
      });
    },

    async detachLabel(actorArg, issueId, labelId) {
      const actor = requireActor(actorArg);
      return db.transaction(async (tx) => {
        await lockIssueForMutation(tx, issueId);
        const issue = await requireIssue(tx, issueId, actor, ProjectAccessLevel.enum.contribute);
        const [label] = await tx
          .select({
            projectId: projectLabels.projectId,
            name: projectLabels.name,
            color: projectLabels.color,
          })
          .from(projectLabels)
          .where(eq(projectLabels.id, labelId))
          .limit(1);
        if (label === undefined || label.projectId !== issue.projectId) {
          throw new ProjectsError("label_not_found");
        }
        const removed = await tx
          .delete(issueLabels)
          .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, labelId)))
          .returning({ labelId: issueLabels.labelId });
        if (removed.length > 0) {
          await recordActivity(tx, {
            projectId: issue.projectId,
            type: "issue_label_removed",
            actor,
            issueId,
            summary: `${issue.title} unlabelled ${label.name}`,
            detail: {
              kind: "label_removed",
              label: { id: labelId, name: label.name, color: label.color },
            },
          });
        }
        return {
          ...toIssue(
            issue,
            await loadIssueLabels(tx, issueId),
            await loadBlockedByIds(tx, issueId),
          ),
        };
      });
    },
  };
}

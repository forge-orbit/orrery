import { z } from "zod";
import { AttachmentMetadata } from "./attachments.ts";
import { AvatarUrl } from "./auth.ts";
import { Email, Handle, Timestamp, WorkspaceKind } from "./common.ts";








export const ProjectAccessLevel = z
  .enum(["read", "contribute", "manage"])
  .meta({ id: "ProjectAccessLevel" });
export type ProjectAccessLevel = z.infer<typeof ProjectAccessLevel>;





export const IssueStatus = z
  .enum(["backlog", "todo", "in_progress", "review", "done", "cancelled"])
  .meta({ id: "IssueStatus" });
export type IssueStatus = z.infer<typeof IssueStatus>;


export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
export function isTerminalIssueStatus(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}



export const IssuePriority = z.enum(["urgent", "high", "medium", "low", "none"]).meta({
  id: "IssuePriority",
});
export type IssuePriority = z.infer<typeof IssuePriority>;




export const IssueSortOrder = z.number().finite().meta({ id: "IssueSortOrder" });
export type IssueSortOrder = z.infer<typeof IssueSortOrder>;





export const AssigneeType = z.enum(["human", "agent"]).meta({ id: "AssigneeType" });
export type AssigneeType = z.infer<typeof AssigneeType>;

export const Assignee = z
  .object({
    type: AssigneeType,
    id: z.string().trim().min(1).max(200),
  })
  .meta({ id: "Assignee" });
export type Assignee = z.infer<typeof Assignee>;



export const ISSUE_SORT_STEP = 65535;






export const FallbackPolicy = z
  .enum(["require_human", "fallback_allowed"])
  .meta({ id: "FallbackPolicy" });
export type FallbackPolicy = z.infer<typeof FallbackPolicy>;


export const FallbackPolicyOverride = FallbackPolicy.nullable().meta({
  id: "FallbackPolicyOverride",
});
export type FallbackPolicyOverride = z.infer<typeof FallbackPolicyOverride>;



export const ProjectActivityType = z
  .enum([
    "project_created",
    "project_renamed",
    "project_fallback_policy_changed",
    "issue_created",
    "issue_edited",
    "issue_commented",
    
    
    
    "issue_review_handoff",
    "issue_closed",
    "issue_reopened",
    "issue_dependency_added",
    "issue_dependency_removed",
    "issue_link_added",
    "issue_link_removed",
    "issue_question_asked",
    "issue_question_answered",
    "issue_question_paused",
    "issue_question_fallback_used",
    "issue_question_follow_up",
    "issue_fallback_policy_override_changed",
    "issue_stop_requested",
    "issue_session_expired",
    
    
    "project_label_created",
    "project_label_edited",
    "project_label_deleted",
    "issue_label_added",
    "issue_label_removed",
    "issue_parent_changed",
    
    
    "issue_deleted",
    "issue_restored",
    "knowledge_created",
    "knowledge_edited",
    "knowledge_deleted",
    "knowledge_restored",
  ])
  .meta({ id: "ProjectActivityType" });
export type ProjectActivityType = z.infer<typeof ProjectActivityType>;







export const Actor = z
  .object({
    humanId: z.string().nullable().optional(),
    email: Email.nullable().optional(),
    handle: Handle.nullable().optional(),
    agentId: z.string().nullable().optional(),
    agentName: z.string().nullable().optional(),
    displayName: z.string(),
    deactivated: z.boolean().optional(),
    /** The human's current profile photo; null for agents and humans without one. */
    avatarUrl: AvatarUrl.nullable(),
  })
  .meta({ id: "Actor" });
export type Actor = z.infer<typeof Actor>;



export const IssueAssignee = Actor.nullable().meta({ id: "IssueAssignee" });
export type IssueAssignee = z.infer<typeof IssueAssignee>;



export const ProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Use 2-10 uppercase letters or digits, starting with a letter.")
  .meta({ id: "ProjectKey" });
export type ProjectKey = z.infer<typeof ProjectKey>;

export const ProjectDescription = z
  .string()
  .trim()
  .max(500, "Keep the description under 500 characters.")
  .meta({ id: "ProjectDescription" });
export type ProjectDescription = z.infer<typeof ProjectDescription>;

export const Project = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    description: z.string(),

    key: ProjectKey,
    createdAt: Timestamp,
    createdBy: Actor,


    workspaceKind: WorkspaceKind,


    accessLevel: ProjectAccessLevel,

    fallbackPolicy: FallbackPolicy,
  })
  .meta({ id: "Project" });
export type Project = z.infer<typeof Project>;

export const ProjectsResponse = z.array(Project).meta({ id: "ProjectsResponse" });
export type ProjectsResponse = z.infer<typeof ProjectsResponse>;

export const CreateProjectRequest = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(120),
    description: ProjectDescription.optional(),


    key: ProjectKey.optional(),
  })
  .meta({ id: "CreateProjectRequest" });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;





export const UpdateProjectRequest = z
  .object({
    name: z.string().trim().min(1, "Name the project.").max(120),
    description: ProjectDescription.optional(),
    key: ProjectKey.optional(),
  })
  .meta({ id: "UpdateProjectRequest" });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;



export const SetProjectFallbackPolicyRequest = z
  .object({ fallbackPolicy: FallbackPolicy })
  .meta({ id: "SetProjectFallbackPolicyRequest" });
export type SetProjectFallbackPolicyRequest = z.infer<typeof SetProjectFallbackPolicyRequest>;




export const ProjectAccessGrant = z
  .object({
    humanId: z.string(),
    email: Email,
    level: ProjectAccessLevel,
    grantedBy: Actor,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ProjectAccessGrant" });
export type ProjectAccessGrant = z.infer<typeof ProjectAccessGrant>;

export const ProjectAccessGrantsResponse = z
  .array(ProjectAccessGrant)
  .meta({ id: "ProjectAccessGrantsResponse" });
export type ProjectAccessGrantsResponse = z.infer<typeof ProjectAccessGrantsResponse>;

export const ProjectAccessHumanIds = z
  .array(z.string())
  .meta({ id: "ProjectAccessHumanIds" });
export type ProjectAccessHumanIds = z.infer<typeof ProjectAccessHumanIds>;

/** A workspace member who could still be granted access to a project. */
export const ProjectAccessCandidate = z
  .object({
    humanId: z.string(),
    email: Email,
    displayName: z.string().nullable(),
    avatarUrl: AvatarUrl.nullable(),
  })
  .meta({ id: "ProjectAccessCandidate" });
export type ProjectAccessCandidate = z.infer<typeof ProjectAccessCandidate>;

export const ProjectAccessCandidatesResponse = z
  .array(ProjectAccessCandidate)
  .meta({ id: "ProjectAccessCandidatesResponse" });
export type ProjectAccessCandidatesResponse = z.infer<typeof ProjectAccessCandidatesResponse>;




export const SetProjectAccessRequest = z
  .object({
    email: Email,
    level: ProjectAccessLevel,
  })
  .meta({ id: "SetProjectAccessRequest" });
export type SetProjectAccessRequest = z.infer<typeof SetProjectAccessRequest>;




export const ProjectAccessEventType = z
  .enum(["project_access_granted", "project_access_level_changed", "project_access_revoked"])
  .meta({ id: "ProjectAccessEventType" });
export type ProjectAccessEventType = z.infer<typeof ProjectAccessEventType>;




export const LabelColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color such as #ff0000.")
  .meta({ id: "LabelColor" });
export type LabelColor = z.infer<typeof LabelColor>;

export const ProjectLabel = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    color: LabelColor,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "ProjectLabel" });
export type ProjectLabel = z.infer<typeof ProjectLabel>;

export const ProjectLabelsResponse = z
  .array(ProjectLabel)
  .meta({ id: "ProjectLabelsResponse" });
export type ProjectLabelsResponse = z.infer<typeof ProjectLabelsResponse>;

export const CreateProjectLabelRequest = z
  .object({
    name: z.string().trim().min(1, "Name the label.").max(50),
    color: LabelColor,
  })
  .meta({ id: "CreateProjectLabelRequest" });
export type CreateProjectLabelRequest = z.infer<typeof CreateProjectLabelRequest>;



export const UpdateProjectLabelRequest = z
  .object({
    name: z.string().trim().min(1, "Name the label.").max(50).optional(),
    color: LabelColor.optional(),
  })
  .meta({ id: "UpdateProjectLabelRequest" });
export type UpdateProjectLabelRequest = z.infer<typeof UpdateProjectLabelRequest>;





export const Issue = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.int().positive(),
    identifier: z.string(),
    title: z.string(),
    body: z.string(),
    status: IssueStatus,
    priority: IssuePriority,
    sortOrder: IssueSortOrder,
    
    
    needsInput: z.boolean(),
    
    
    assignee: IssueAssignee,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    closedAt: Timestamp.nullable(),
    createdBy: Actor,
    updatedBy: Actor,
    
    
    fallbackPolicyOverride: FallbackPolicyOverride,
    effectiveFallbackPolicy: FallbackPolicy,
    
    
    
    parentIssueId: z.string().nullable(),
    labels: z.array(ProjectLabel),
    /** Ids of issues that currently block this one. Loaded with the issue list. */
    blockedByIds: z.array(z.string()),
  })
  .meta({ id: "Issue" });
export type Issue = z.infer<typeof Issue>;

export const IssuesResponse = z.array(Issue).meta({ id: "IssuesResponse" });
export type IssuesResponse = z.infer<typeof IssuesResponse>;




export const IssueLinkKind = z.enum(["pr", "commit", "doc", "link"]).meta({ id: "IssueLinkKind" });
export type IssueLinkKind = z.infer<typeof IssueLinkKind>;




export const IssueLinkUrl = z
  .url()
  .max(2048)
  .refine(
    (value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    },
    { message: "Only http and https links are allowed." },
  )
  .meta({ id: "IssueLinkUrl" });
export type IssueLinkUrl = z.infer<typeof IssueLinkUrl>;

export const IssueLink = z
  .object({
    id: z.string(),
    issueId: z.string(),
    url: IssueLinkUrl,
    title: z.string(),
    kind: IssueLinkKind,
    createdAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "IssueLink" });
export type IssueLink = z.infer<typeof IssueLink>;

export const CreateIssueLinkRequest = z
  .object({
    url: IssueLinkUrl,
    title: z.string().trim().min(1, "Give the link a title.").max(200),
    kind: IssueLinkKind,
  })
  .meta({ id: "CreateIssueLinkRequest" });
export type CreateIssueLinkRequest = z.infer<typeof CreateIssueLinkRequest>;



export const IssueDetail = Issue.extend({
  links: z.array(IssueLink),
  attachments: z.array(AttachmentMetadata),
}).meta({ id: "IssueDetail" });
export type IssueDetail = z.infer<typeof IssueDetail>;



export const IssueBody = z.string().max(100_000).meta({ id: "IssueBody" });
export type IssueBody = z.infer<typeof IssueBody>;

export const CreateIssueRequest = z
  .object({
    title: z.string().trim().min(1, "Give the issue a title.").max(200),
    body: IssueBody.optional(),
    
    status: IssueStatus.optional(),
    priority: IssuePriority.optional(),
    sortOrder: IssueSortOrder.optional(),
    
    assignee: Assignee.nullable().optional(),
    labelIds: z.array(z.string().trim().min(1).max(200)).optional(),
    
    parentIssueId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .meta({ id: "CreateIssueRequest" });
export type CreateIssueRequest = z.infer<typeof CreateIssueRequest>;




export const UpdateIssueRequest = z
  .object({
    title: z.string().trim().min(1, "Give the issue a title.").max(200).optional(),
    body: IssueBody.optional(),
    status: IssueStatus.optional(),
    priority: IssuePriority.optional(),
    sortOrder: IssueSortOrder.optional(),
    
    
    assignee: Assignee.nullable().optional(),
    
    parentIssueId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .meta({ id: "UpdateIssueRequest" });
export type UpdateIssueRequest = z.infer<typeof UpdateIssueRequest>;





export const SetIssueFallbackPolicyRequest = z
  .object({ override: FallbackPolicyOverride })
  .meta({ id: "SetIssueFallbackPolicyRequest" });
export type SetIssueFallbackPolicyRequest = z.infer<typeof SetIssueFallbackPolicyRequest>;




export const IssueDependency = z
  .object({
    issueId: z.string(),
    blockedByIssueId: z.string(),
    createdAt: Timestamp,
    createdBy: Actor,
  })
  .meta({ id: "IssueDependency" });
export type IssueDependency = z.infer<typeof IssueDependency>;



export const AddBlockedByRequest = z
  .object({
    blockedByIssueId: z.string().trim().min(1, "Choose the blocking issue.").max(200),
  })
  .meta({ id: "AddBlockedByRequest" });
export type AddBlockedByRequest = z.infer<typeof AddBlockedByRequest>;

export const IssueComment = z
  .object({
    id: z.string(),
    issueId: z.string(),
    body: z.string(),
    createdAt: Timestamp,
    author: Actor,
    attachments: z.array(AttachmentMetadata),
  })
  .meta({ id: "IssueComment" });
export type IssueComment = z.infer<typeof IssueComment>;

export const IssueCommentsResponse = z
  .array(IssueComment)
  .meta({ id: "IssueCommentsResponse" });
export type IssueCommentsResponse = z.infer<typeof IssueCommentsResponse>;

export const CreateIssueCommentRequest = z
  .object({
    body: z.string().trim().min(1, "Write a comment.").max(20_000),
  })
  .meta({ id: "CreateIssueCommentRequest" });
export type CreateIssueCommentRequest = z.infer<typeof CreateIssueCommentRequest>;




export const KnowledgeEntry = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    body: z.string(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    createdBy: Actor,
    updatedBy: Actor,
    attachments: z.array(AttachmentMetadata),
  })
  .meta({ id: "KnowledgeEntry" });
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

export const KnowledgeEntriesResponse = z
  .array(KnowledgeEntry)
  .meta({ id: "KnowledgeEntriesResponse" });
export type KnowledgeEntriesResponse = z.infer<typeof KnowledgeEntriesResponse>;

export const KnowledgeBody = z.string().max(100_000).meta({ id: "KnowledgeBody" });
export type KnowledgeBody = z.infer<typeof KnowledgeBody>;

export const CreateKnowledgeEntryRequest = z
  .object({
    title: z.string().trim().min(1, "Give the entry a title.").max(200),
    body: KnowledgeBody.optional(),
  })
  .meta({ id: "CreateKnowledgeEntryRequest" });
export type CreateKnowledgeEntryRequest = z.infer<typeof CreateKnowledgeEntryRequest>;

export const UpdateKnowledgeEntryRequest = z
  .object({
    title: z.string().trim().min(1, "Give the entry a title.").max(200).optional(),
    body: KnowledgeBody.optional(),
  })
  .meta({ id: "UpdateKnowledgeEntryRequest" });
export type UpdateKnowledgeEntryRequest = z.infer<typeof UpdateKnowledgeEntryRequest>;



export const ActivityLabel = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
  })
  .meta({ id: "ActivityLabel" });
export type ActivityLabel = z.infer<typeof ActivityLabel>;

const ActivityChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), from: IssueStatus, to: IssueStatus }),
  z.object({ kind: z.literal("priority"), from: IssuePriority, to: IssuePriority }),
  z.object({ kind: z.literal("assignee"), from: IssueAssignee, to: IssueAssignee }),
]);

const ActivityIssueReference = z.object({
  issueId: z.string(),
  blockedByIssueId: z.string(),
  title: z.string(),
});

const ActivityLinkReference = z.object({
  linkId: z.string(),
  url: z.string(),
  title: z.string(),
});

export const IssueActivityDetail = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("issue_edited"), changes: z.array(ActivityChange).min(1) }),
    z.object({ kind: z.literal("label_added"), label: ActivityLabel }),
    z.object({ kind: z.literal("label_removed"), label: ActivityLabel }),
    z.object({ kind: z.literal("issue_closed"), from: IssueStatus, to: IssueStatus }),
    z.object({ kind: z.literal("issue_reopened"), from: IssueStatus, to: IssueStatus }),
    z.object({
      kind: z.literal("parent_changed"),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
    z.object({ kind: z.literal("issue_dependency_added"), ...ActivityIssueReference.shape }),
    z.object({ kind: z.literal("issue_dependency_removed"), ...ActivityIssueReference.shape }),
    z.object({ kind: z.literal("issue_link_added"), ...ActivityLinkReference.shape }),
    z.object({ kind: z.literal("issue_link_removed"), ...ActivityLinkReference.shape }),
  ])
  .meta({ id: "IssueActivityDetail" });
export type IssueActivityDetail = z.infer<typeof IssueActivityDetail>;

export const ProjectActivity = z
  .object({
    id: z.string(),
    projectId: z.string(),
    type: ProjectActivityType,
    summary: z.string(),
    issueId: z.string().nullable(),
    knowledgeEntryId: z.string().nullable(),
    createdAt: Timestamp,
    actor: Actor,
    /** Structured lifecycle details; null for activity recorded before #178. */
    detail: IssueActivityDetail.nullable(),
  })
  .meta({ id: "ProjectActivity" });
export type ProjectActivity = z.infer<typeof ProjectActivity>;

export const ProjectActivityResponse = z
  .array(ProjectActivity)
  .meta({ id: "ProjectActivityResponse" });
export type ProjectActivityResponse = z.infer<typeof ProjectActivityResponse>;

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AddBlockedByRequest,
  CreateIssueCommentRequest,
  CreateIssueLinkRequest,
  CreateIssueRequest,
  CreateKnowledgeEntryRequest,
  CreateProjectLabelRequest,
  CreateProjectRequest,
  Issue,
  IssueComment,
  IssueCommentsResponse,
  IssueDependency,
  IssueDetail,
  IssueLink,
  IssuesResponse,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Project,
  ProjectAccessGrant,
  ProjectAccessGrantsResponse,
  ProjectAccessHumanIds,
  ProjectActivityResponse,
  ProjectLabel,
  ProjectLabelsResponse,
  ProjectsResponse,
  SetIssueFallbackPolicyRequest,
  SetProjectAccessRequest,
  SetProjectFallbackPolicyRequest,
  UpdateIssueRequest,
  UpdateKnowledgeEntryRequest,
  UpdateProjectLabelRequest,
  UpdateProjectRequest,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import type { WorkActor } from "./service.ts";
import { ProjectsError, type ProjectsErrorKind, type ProjectsService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const projectParams = z.object({ projectId: z.string().min(1).max(200) });
const issueParams = z.object({ issueId: z.string().min(1).max(200) });
const dependencyParams = issueParams.extend({
  blockedByIssueId: z.string().min(1).max(200),
});
const linkParams = issueParams.extend({ linkId: z.string().min(1).max(200) });
const labelParams = z.object({ labelId: z.string().min(1).max(200) });
const issueLabelParams = issueParams.extend({ labelId: z.string().min(1).max(200) });
const knowledgeParams = z.object({ entryId: z.string().min(1).max(200) });
const accessParams = projectParams.extend({ humanId: z.string().min(1).max(200) });

const listProjects = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/projects",
  summary: "The projects the caller can access in a workspace",
  description:
    "A personal workspace's owner sees its projects. A shared workspace's owner sees every project; an ordinary member sees only the projects explicitly granted to them. Membership alone never reveals a project. A workspace outside the caller's access answers exactly like a missing one. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The accessible projects in the workspace",
      content: { "application/json": { schema: ProjectsResponse } },
    },
    400: problem("The workspace id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No workspace with this id is accessible to the caller"),
  },
});

const createProject = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/projects",
  summary: "Create a project in a workspace",
  description:
    "A personal workspace's owner or a shared workspace's owner can always create a project. A shared member needs the Create projects capability; the member who creates a project receives Manage on it. The project belongs to the workspace, its creator is recorded as authorship, and the creation is recorded in the project's activity. Supply a workspace-unique uppercase key or let the server derive one from the name.",
  request: {
    params: workspaceParams,
    body: { required: true, content: { "application/json": { schema: CreateProjectRequest } } },
  },
  responses: {
    201: {
      description: "The project, created in the workspace",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("The caller does not have Create projects in this workspace"),
    404: problem("No workspace with this id is accessible to the caller"),
    409: problem("Another project in this workspace already uses that key"),
  },
});

const updateProject = createRoute({
  method: "patch",
  path: "/api/projects/{projectId}",
  summary: "Configure a project",
  description:
    "Manage access may rename the project. A request that does not change the name returns the project unchanged and records no event. A project's key is immutable and cannot be changed here.",
  request: {
    params: projectParams,
    body: { required: true, content: { "application/json": { schema: UpdateProjectRequest } } },
  },
  responses: {
    200: {
      description: "The project after the change",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem("Read or Contribute access cannot configure the project"),
    404: problem("No project with this id is accessible to the caller"),
    409: problem("A project's key cannot be changed after it is created"),
  },
});

const setProjectFallbackPolicy = createRoute({
  method: "patch",
  path: "/api/projects/{projectId}/fallback-policy",
  summary: "Set a project's fallback policy",
  description:
    "Human, Manage only. `require_human` (the default) pauses a question at its one-hour deadline; `fallback_allowed` authorizes returning the agent's proposed fallback and lets work continue. No agent key is accepted: an agent cannot authorize its own fallback. A real change is recorded in the project's activity.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: SetProjectFallbackPolicyRequest } },
    },
  },
  responses: {
    200: {
      description: "The project with its new fallback policy",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Manage access is required to set the project fallback policy"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listProjectAccess = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/access",
  summary: "The explicit access grants on a project",
  description:
    "Manage only. Workspace owners have implicit Manage and are not listed; a personal project has no collaborators and answers with an empty list.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's explicit grants",
      content: { "application/json": { schema: ProjectAccessGrantsResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    403: problem("Read or Contribute access cannot manage project access"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const projectAccessHumanIds = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/access/humans",
  summary: "The Humans who currently hold project access",
  description:
    "Read access is enough: the assignee picker uses these ids to warn that a workspace Member without a grant will not see the issue in My Work. Workspace owners have implicit access and are not listed. A caller without access to the project gets the same 404 as a missing project.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The human ids with an active grant",
      content: { "application/json": { schema: ProjectAccessHumanIds } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const setProjectAccess = createRoute({
  method: "patch",
  path: "/api/projects/{projectId}/access",
  summary: "Grant or change a member's project access",
  description:
    "Manage only. The target must be a current member of the project's shared workspace. The level is one of Read, Contribute, or Manage; a real change records an attributed access event in the same transaction.",
  request: {
    params: projectParams,
    body: { required: true, content: { "application/json": { schema: SetProjectAccessRequest } } },
  },
  responses: {
    200: {
      description: "The grant after the change",
      content: { "application/json": { schema: ProjectAccessGrant } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in"),
    403: problem(
      "Read or Contribute access cannot manage project access, or the project is personal",
    ),
    404: problem("No accessible project or workspace member"),
    409: problem("Workspace owners already have Manage access to every project"),
  },
});

const removeProjectAccess = createRoute({
  method: "delete",
  path: "/api/projects/{projectId}/access/{humanId}",
  summary: "Revoke a member's project access",
  description:
    "Manage only. Revoking is idempotent: a person with no grant is already in the desired state. A real revocation records an attributed access event.",
  request: { params: accessParams },
  responses: {
    204: { description: "The grant was removed" },
    400: problem("The project or member id is invalid"),
    401: problem("Not signed in"),
    403: problem(
      "Read or Contribute access cannot manage project access, or the project is personal",
    ),
    404: problem("No project with this id is accessible to the caller"),
    409: problem("Workspace owners already have Manage access to every project"),
  },
});

const getProject = createRoute({
  method: "get",
  path: "/api/projects/{projectId}",
  summary: "One project the caller can access",
  description:
    "A project's own view. A project outside the caller's access answers exactly like a missing one, so ids cannot be enumerated. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project",
      content: { "application/json": { schema: Project } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listIssues = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/issues",
  summary: "The issues in a project",
  description:
    "Every issue in the project, oldest number first, with its author and last editor.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's issues",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createIssue = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/issues",
  summary: "Create an issue in a project",
  description:
    "Contribute or Manage. The issue gets the project's next local number, starts ready work, and records its creator. Optional `assignee` (a human or agent in the workspace) and `labelIds` (labels in the project) are validated and applied in the same transaction as the issue, so an invalid value creates nothing. An optional `parentIssueId` creates a one-level subtask in the same project; it cannot be self, cross-project, or a second nesting level. The creation is recorded in the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: {
    params: projectParams,
    body: { required: true, content: { "application/json": { schema: CreateIssueRequest } } },
  },
  responses: {
    201: {
      description: "The issue, open",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The request is invalid, or the parent is itself or in another project"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot create an issue"),
    404: problem(
      "No project, parent issue, assignee, or label with this id is accessible to the caller",
    ),
    409: problem("The parent already has a parent, or has subtasks of its own"),
  },
});

const getIssue = createRoute({
  method: "get",
  path: "/api/issues/{issueId}",
  summary: "One issue the caller can access",
  description:
    "The issue's title, Markdown body, status, authorship, and structured links (each with its kind). A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue with its links",
      content: { "application/json": { schema: IssueDetail } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const deleteIssue = createRoute({
  method: "delete",
  path: "/api/issues/{issueId}",
  summary: "Move an issue to the project's trash",
  description:
    "Human Contribute or Manage only. Agents cannot delete issues. A soft-deleted issue leaves the board, ready work and blocker checks immediately and can be restored by a Project manager within 30 days. An issue with a live work session cannot be trashed; a lapsed lease is expired first. Trashing records issue_deleted in the project activity in the same transaction.",
  request: { params: issueParams },
  responses: {
    204: { description: "The issue was moved to trash" },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Read access cannot delete issues, and agents cannot delete issues"),
    404: problem("No active issue with this id is accessible to the caller"),
    409: problem("The issue has an active work session"),
  },
});

const restoreIssue = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/restore",
  summary: "Restore a trashed issue",
  description:
    "Human Manage (Project manager) only. Restores an issue from trash within 30 days, clearing its deletion metadata and recording issue_restored in the project activity in the same transaction. An already purged tombstone, or one past the 30-day boundary in database time, answers 409. Agents and members below Manage answer 403; non-members answer 404.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The restored issue",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The issue id is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Only a Project manager can restore a trashed issue"),
    404: problem("No issue with this id is accessible to the caller"),
    409: problem("The issue has already been purged"),
  },
});

const listTrash = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/trash",
  summary: "The project's recoverable trashed issues",
  description:
    "Manage only. Lists soft-deleted issues that have not been purged, so a Project manager can decide what to restore. Purged tombstones never appear here. An agent key is rejected exactly like a human without Manage.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The recoverable trashed issues",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem("Not signed in"),
    403: problem("Only a Project manager can read the trash"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const updateIssue = createRoute({
  method: "patch",
  path: "/api/issues/{issueId}",
  summary: "Edit, close, or reopen an issue",
  description:
    'Contribute or Manage. Every field is optional. A title, body, assignee or priority change records an edit; a status change records a close or a reopen; `parentIssueId` sets or clears a one-level parent in the same project. Set `assignee` to `{"type":"human"|"agent","id":"..."}` or null to clear it; the identity must be an active member or a registered agent in the workspace. A request that changes nothing returns the issue unchanged and records no event. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key\'s effective project access.',
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: UpdateIssueRequest } } },
  },
  responses: {
    200: {
      description: "The issue after the change",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The request is invalid, or the parent is itself or in another project"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change the issue"),
    404: problem(
      "No issue with this id is accessible to the caller, or the assignee is unknown or inactive in the workspace",
    ),
    409: problem(
      "The parent already has a parent or has subtasks of its own, the agent holds no live work session for this issue, or an unanswered question blocks moving the issue to review or closing it",
    ),
  },
});

const listLabels = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/labels",
  summary: "The project's labels",
  description:
    "Read access is enough. Lists the project-scoped labels with their names, hex colors and creators. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's labels",
      content: { "application/json": { schema: ProjectLabelsResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createLabel = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/labels",
  summary: "Create a project-scoped label",
  description:
    "Contribute or Manage. A name is unique per project ignoring case, and a color is a six-digit hex value. The creation is recorded in the project's activity. A workspace-scoped agent API key is accepted on this project-work route.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: CreateProjectLabelRequest } },
    },
  },
  responses: {
    201: {
      description: "The label, created",
      content: { "application/json": { schema: ProjectLabel } },
    },
    400: problem("The request is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot create a label"),
    404: problem("No project with this id is accessible to the caller"),
    409: problem("A label with that name already exists in this project"),
  },
});

const updateLabel = createRoute({
  method: "patch",
  path: "/api/labels/{labelId}",
  summary: "Rename or recolor a project label",
  description:
    "Contribute or Manage. Both fields are optional; a request that changes nothing records no event. A new name must stay unique in the project ignoring case. A workspace-scoped agent API key is accepted on this project-work route.",
  request: {
    params: labelParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateProjectLabelRequest } },
    },
  },
  responses: {
    200: {
      description: "The label after the change",
      content: { "application/json": { schema: ProjectLabel } },
    },
    400: problem("The request is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change a label"),
    404: problem("No label with this id is accessible to the caller"),
    409: problem("A label with that name already exists in this project"),
  },
});

const deleteLabel = createRoute({
  method: "delete",
  path: "/api/labels/{labelId}",
  summary: "Delete a project label",
  description:
    "Contribute or Manage. Deleting detaches the label from every issue. A workspace-scoped agent API key is accepted on this project-work route.",
  request: { params: labelParams },
  responses: {
    204: { description: "The label is gone" },
    400: problem("The label id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot delete a label"),
    404: problem("No label with this id is accessible to the caller"),
  },
});

const attachIssueLabel = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/labels/{labelId}",
  summary: "Attach a label to an issue",
  description:
    "Contribute or Manage. The label must belong to the issue's project. Attaching a label that is already attached is a no-op. Answers with the issue and its labels. A workspace-scoped agent API key is accepted on this project-work route.",
  request: { params: issueLabelParams },
  responses: {
    201: {
      description: "The issue with its labels",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The issue or label id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change an issue's labels"),
    404: problem("No issue or label with this id is accessible to the caller"),
  },
});

const detachIssueLabel = createRoute({
  method: "delete",
  path: "/api/issues/{issueId}/labels/{labelId}",
  summary: "Detach a label from an issue",
  description:
    "Contribute or Manage. Detaching a label that is not attached is a no-op. Answers with the issue and its labels. A workspace-scoped agent API key is accepted on this project-work route.",
  request: { params: issueLabelParams },
  responses: {
    200: {
      description: "The issue with its labels",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The issue or label id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change an issue's labels"),
    404: problem("No issue or label with this id is accessible to the caller"),
  },
});

const setIssueFallbackPolicyOverride = createRoute({
  method: "patch",
  path: "/api/issues/{issueId}/fallback-policy",
  summary: "Set or clear an issue's fallback policy override",
  description:
    "Human, Contribute or Manage. `require_human` tightens an issue below a fallback_allowed project and needs only Contribute. Loosening — an explicit `fallback_allowed` override, or clearing a `require_human` override under a fallback_allowed project — needs Manage. `null` clears the override so the issue uses its project's policy. No agent key is accepted, and the fallback never grants project access: fenced writes still check the current access ceiling.",
  request: {
    params: issueParams,
    body: {
      required: true,
      content: { "application/json": { schema: SetIssueFallbackPolicyRequest } },
    },
  },
  responses: {
    200: {
      description: "The issue with its override and effective fallback policy",
      content: { "application/json": { schema: Issue } },
    },
    400: problem("The request is invalid"),
    401: problem("Not signed in as a human"),
    403: problem("Contribute access, or Manage to loosen, is required"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const addBlockedBy = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/blocked-by",
  summary: "Record that an issue is blocked by another issue in the same project",
  description:
    "Contribute or Manage. The edge is added in one transaction with an activity event; a self-link, a cross-project link, and a cycle are refused. Re-adding an existing edge is a no-op. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: {
    params: issueParams,
    body: { required: true, content: { "application/json": { schema: AddBlockedByRequest } } },
  },
  responses: {
    201: {
      description: "The dependency edge, written",
      content: { "application/json": { schema: IssueDependency } },
    },
    400: problem(
      "The request is invalid, the issue blocks itself, or the two issues are in different projects",
    ),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change dependencies"),
    404: problem("No issue with either id is accessible to the caller"),
    409: problem("That dependency would create a cycle"),
  },
});

const removeBlockedBy = createRoute({
  method: "delete",
  path: "/api/issues/{issueId}/blocked-by/{blockedByIssueId}",
  summary: "Remove a blocked_by relation from an issue",
  description:
    "Contribute or Manage. Removing an edge that is not there is a no-op. A real removal is recorded in the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: dependencyParams },
  responses: {
    204: { description: "The relation is no longer in place" },
    400: problem("The issue ids are invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot change dependencies"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listBlockedBy = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/blocked-by",
  summary: "The issues that block an issue",
  description:
    "Read access is enough. Lists the issue's prerequisites, open or closed, in issue-number order. An issue with any blocker that is not closed is omitted from ready work. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issues that block this one",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listBlocking = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/blocking",
  summary: "The issues that an issue blocks",
  description:
    "Read access is enough. Lists the issue's dependants, open or closed, in issue-number order. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issues this one blocks",
      content: { "application/json": { schema: IssuesResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listComments = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/comments",
  summary: "The comments on an issue",
  description:
    "The issue's comments in the order they were written, each with its author.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue's comments",
      content: { "application/json": { schema: IssueCommentsResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const listIssueActivity = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/activity",
  summary: "An issue's lifecycle activity",
  description:
    "Read access is enough. Lists this issue's structured lifecycle events in the order they happened, each with its actor and, for events recorded after #178, structured detail. Historical rows without detail keep their summary. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The issue's activity",
      content: { "application/json": { schema: ProjectActivityResponse } },
    },
    400: problem("The issue id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const createComment = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/comments",
  summary: "Comment on an issue",
  description:
    "Contribute or Manage. A comment needs no work session (#20), only project access. It records its author and appears in the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: {
    params: issueParams,
    body: {
      required: true,
      content: { "application/json": { schema: CreateIssueCommentRequest } },
    },
  },
  responses: {
    201: {
      description: "The comment, written",
      content: { "application/json": { schema: IssueComment } },
    },
    400: problem("The request is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot comment"),
    404: problem("No issue with this id is accessible to the caller"),
  },
});

const createIssueLink = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/links",
  summary: "Attach a structured link to an issue",
  description:
    "Contribute or Manage. Attaches an http or https URL classified as a PR, commit, doc, or general link. The same URL cannot be attached twice to one issue. Like a comment, a link needs no work session, and it is recorded in the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: {
    params: issueParams,
    body: {
      required: true,
      content: { "application/json": { schema: CreateIssueLinkRequest } },
    },
  },
  responses: {
    201: {
      description: "The link, attached",
      content: { "application/json": { schema: IssueLink } },
    },
    400: problem("The request is invalid, or the URL scheme is not http or https"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot attach a link"),
    404: problem("No issue with this id is accessible to the caller"),
    409: problem("This URL is already attached to the issue"),
  },
});

const removeIssueLink = createRoute({
  method: "delete",
  path: "/api/issues/{issueId}/links/{linkId}",
  summary: "Remove a structured link from an issue",
  description:
    "Contribute or Manage. Removes one link by id from an issue and records the removal in the project's activity. Removing a link that is not attached is a 404, not a silent no-op. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: linkParams },
  responses: {
    204: { description: "The link was removed" },
    400: problem("The issue or link id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot remove a link"),
    404: problem("No issue or link with this id is accessible to the caller"),
  },
});

const listActivity = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/activity",
  summary: "A project's activity",
  description:
    "Project creation, issue creation, edits, comments, closes, reopens, and knowledge creation and edits, in the order they happened, each with the human who caused it. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's activity",
      content: { "application/json": { schema: ProjectActivityResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const listKnowledge = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/knowledge",
  summary: "The basic Markdown knowledge entries in a project",
  description:
    "A title and a Markdown body per entry, with who created and last edited it. This is the basic entry from #26, not the full vault editor (#6). A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: projectParams },
  responses: {
    200: {
      description: "The project's knowledge entries",
      content: { "application/json": { schema: KnowledgeEntriesResponse } },
    },
    400: problem("The project id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const createKnowledge = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/knowledge",
  summary: "Create a basic Markdown knowledge entry",
  description:
    "Contribute or Manage. Stores the title and Markdown body as written, records the creator, and adds a creation event to the project's activity. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "application/json": { schema: CreateKnowledgeEntryRequest } },
    },
  },
  responses: {
    201: {
      description: "The knowledge entry",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The request is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot create knowledge"),
    404: problem("No project with this id is accessible to the caller"),
  },
});

const getKnowledge = createRoute({
  method: "get",
  path: "/api/knowledge/{entryId}",
  summary: "One knowledge entry the caller can access",
  description:
    "The entry's title, Markdown body, and authorship.A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: { params: knowledgeParams },
  responses: {
    200: {
      description: "The knowledge entry",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The entry id is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    404: problem("No knowledge entry with this id is accessible to the caller"),
  },
});

const updateKnowledge = createRoute({
  method: "patch",
  path: "/api/knowledge/{entryId}",
  summary: "Edit a basic Markdown knowledge entry",
  description:
    "Contribute or Manage. Every field is optional. A real change records the editor and adds an edit event; a no-op returns the entry unchanged. A workspace-scoped agent API key sent as `Authorization: Bearer <key>` is accepted on this project-work route and acts as the agent the key identifies, with the key's effective project access.",
  request: {
    params: knowledgeParams,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateKnowledgeEntryRequest } },
    },
  },
  responses: {
    200: {
      description: "The knowledge entry after the change",
      content: { "application/json": { schema: KnowledgeEntry } },
    },
    400: problem("The request is invalid"),
    401: problem(
      "Not signed in, or the agent key is invalid, revoked, expired, or unusable in its workspace",
    ),
    403: problem("Read access cannot edit knowledge"),
    404: problem("No knowledge entry with this id is accessible to the caller"),
  },
});

export const routes = [
  listProjects,
  createProject,
  getProject,
  updateProject,
  setProjectFallbackPolicy,
  listProjectAccess,
  projectAccessHumanIds,
  setProjectAccess,
  removeProjectAccess,
  listIssues,
  createIssue,
  getIssue,
  deleteIssue,
  restoreIssue,
  listTrash,
  updateIssue,
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  attachIssueLabel,
  detachIssueLabel,
  setIssueFallbackPolicyOverride,
  addBlockedBy,
  removeBlockedBy,
  listBlockedBy,
  listBlocking,
  listComments,
  listIssueActivity,
  createComment,
  createIssueLink,
  removeIssueLink,
  listActivity,
  listKnowledge,
  createKnowledge,
  getKnowledge,
  updateKnowledge,
];

const statusFor = {
  not_signed_in: 401,
  workspace_not_found: 404,
  project_not_found: 404,
  issue_not_found: 404,
  issue_link_not_found: 404,
  issue_link_exists: 409,
  knowledge_entry_not_found: 404,
  project_creation_not_allowed: 403,
  insufficient_project_access: 403,
  member_not_found: 404,
  personal_project_access: 403,
  workspace_owner_access: 409,
  session_required: 409,
  self_dependency: 400,
  cross_project_dependency: 400,
  dependency_cycle: 409,
  assignee_not_found: 404,
  project_key_taken: 409,
  project_key_immutable: 409,
  label_not_found: 404,
  label_exists: 409,
  self_parent: 400,
  cross_project_parent: 400,
  subtask_depth_exceeded: 409,
  agents_cannot_delete_issues: 403,
  issue_active_session_exists: 409,
  issue_needs_input: 409,
  issue_purged: 409,
} as const satisfies Record<ProjectsErrorKind, number>;

function isKind<K extends readonly ProjectsErrorKind[]>(
  error: ProjectsError,
  kinds: K,
): error is ProjectsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

const workspaceListKinds = ["not_signed_in", "workspace_not_found"] as const;
const workspaceCreateKinds = [
  ...workspaceListKinds,
  "project_creation_not_allowed",
  "project_key_taken",
] as const;
const projectReadKinds = ["not_signed_in", "project_not_found"] as const;
const projectWriteKinds = [...projectReadKinds, "insufficient_project_access"] as const;

const projectUpdateKinds = [...projectWriteKinds, "project_key_immutable"] as const;
const accessKinds = [
  ...projectWriteKinds,
  "member_not_found",
  "personal_project_access",
  "workspace_owner_access",
] as const;
const issueReadKinds = ["not_signed_in", "issue_not_found"] as const;
const issueWriteKinds = [
  ...issueReadKinds,
  "insufficient_project_access",
  "session_required",
  "issue_needs_input",
  "assignee_not_found",
  "self_parent",
  "cross_project_parent",
  "subtask_depth_exceeded",
] as const;

const issueDeleteKinds = [
  ...issueReadKinds,
  "insufficient_project_access",
  "agents_cannot_delete_issues",
  "issue_active_session_exists",
] as const;
const issueRestoreKinds = [
  ...issueReadKinds,
  "insufficient_project_access",
  "issue_purged",
] as const;
const trashListKinds = [
  "not_signed_in",
  "project_not_found",
  "insufficient_project_access",
] as const;

const issueCreateKinds = [
  ...projectWriteKinds,
  "issue_not_found",
  "assignee_not_found",
  "label_not_found",
  "self_parent",
  "cross_project_parent",
  "subtask_depth_exceeded",
] as const;
const labelReadKinds = ["not_signed_in", "project_not_found"] as const;
const labelWriteKinds = [...labelReadKinds, "insufficient_project_access", "label_exists"] as const;
const labelByIdWriteKinds = [
  "not_signed_in",
  "label_not_found",
  "insufficient_project_access",
  "label_exists",
] as const;
const labelByIdDeleteKinds = [
  "not_signed_in",
  "label_not_found",
  "insufficient_project_access",
] as const;
const issueLabelWriteKinds = [
  "not_signed_in",
  "issue_not_found",
  "label_not_found",
  "insufficient_project_access",
] as const;

const commentWriteKinds = [...issueReadKinds, "insufficient_project_access"] as const;

const dependencyWriteKinds = [
  ...issueReadKinds,
  "insufficient_project_access",
  "self_dependency",
  "cross_project_dependency",
  "dependency_cycle",
] as const;
const linkAddKinds = [...commentWriteKinds, "issue_link_exists"] as const;
const linkRemoveKinds = [...commentWriteKinds, "issue_link_not_found"] as const;
const knowledgeReadKinds = ["not_signed_in", "knowledge_entry_not_found"] as const;
const knowledgeWriteKinds = [...knowledgeReadKinds, "insufficient_project_access"] as const;

function failure<K extends readonly ProjectsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (isAgentError(error)) {
    return problemResponse(c, {
      status: 401,
      code: error.kind,
      title: error.message,
    });
  }
  if (error instanceof ProjectsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createProjectsRest(
  service: ProjectsService,
  sessionReader: SessionReader,
  agentAuthenticator: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  const workActor = async (c: Context): Promise<WorkActor | null> => {
    const identity = await agentAuthenticator(c.req.raw);
    if (identity !== null) return { kind: "agent", identity };
    const account = await sessionReader(c);
    return account === null ? null : { kind: "human", account };
  };

  app.openapi(listProjects, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.listProjects(await workActor(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error, workspaceListKinds);
    }
  });

  app.openapi(createProject, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(
        await service.createProject(await sessionReader(c), workspaceId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, workspaceCreateKinds);
    }
  });

  app.openapi(getProject, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.getProject(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(updateProject, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.updateProject(await sessionReader(c), projectId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, projectUpdateKinds);
    }
  });

  app.openapi(setProjectFallbackPolicy, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.setProjectFallbackPolicy(
          await sessionReader(c),
          projectId,
          c.req.valid("json"),
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(listProjectAccess, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listProjectAccess(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(projectAccessHumanIds, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.projectAccessHumanIds(await sessionReader(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(setProjectAccess, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.setProjectAccess(await sessionReader(c), projectId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, accessKinds);
    }
  });

  app.openapi(removeProjectAccess, async (c) => {
    try {
      const { projectId, humanId } = c.req.valid("param");
      await service.removeProjectAccess(await sessionReader(c), projectId, humanId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, accessKinds);
    }
  });

  app.openapi(listIssues, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listIssues(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(createIssue, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createIssue(await workActor(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, issueCreateKinds);
    }
  });

  app.openapi(getIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.getIssue(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });

  app.openapi(deleteIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      await service.deleteIssue(await workActor(c), issueId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, issueDeleteKinds);
    }
  });

  app.openapi(restoreIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.restoreIssue(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueRestoreKinds);
    }
  });

  app.openapi(listTrash, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listTrash(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, trashListKinds);
    }
  });

  app.openapi(updateIssue, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.updateIssue(await workActor(c), issueId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, issueWriteKinds);
    }
  });

  app.openapi(listLabels, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listLabels(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, labelReadKinds);
    }
  });

  app.openapi(createLabel, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createLabel(await workActor(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, labelWriteKinds);
    }
  });

  app.openapi(updateLabel, async (c) => {
    try {
      const { labelId } = c.req.valid("param");
      return c.json(
        await service.updateLabel(await workActor(c), labelId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, labelByIdWriteKinds);
    }
  });

  app.openapi(deleteLabel, async (c) => {
    try {
      const { labelId } = c.req.valid("param");
      await service.deleteLabel(await workActor(c), labelId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, labelByIdDeleteKinds);
    }
  });

  app.openapi(attachIssueLabel, async (c) => {
    try {
      const { issueId, labelId } = c.req.valid("param");
      return c.json(await service.attachLabel(await workActor(c), issueId, labelId), 201);
    } catch (error) {
      return failure(c, error, issueLabelWriteKinds);
    }
  });

  app.openapi(detachIssueLabel, async (c) => {
    try {
      const { issueId, labelId } = c.req.valid("param");
      return c.json(await service.detachLabel(await workActor(c), issueId, labelId), 200);
    } catch (error) {
      return failure(c, error, issueLabelWriteKinds);
    }
  });

  app.openapi(setIssueFallbackPolicyOverride, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.setIssueFallbackPolicyOverride(
          await sessionReader(c),
          issueId,
          c.req.valid("json"),
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, commentWriteKinds);
    }
  });

  app.openapi(addBlockedBy, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.addBlockedBy(await workActor(c), issueId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, dependencyWriteKinds);
    }
  });

  app.openapi(removeBlockedBy, async (c) => {
    try {
      const { issueId, blockedByIssueId } = c.req.valid("param");
      await service.removeBlockedBy(await workActor(c), issueId, blockedByIssueId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, commentWriteKinds);
    }
  });

  app.openapi(listBlockedBy, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.listBlockedBy(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });

  app.openapi(listBlocking, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.listBlocking(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });
  app.openapi(listComments, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.listComments(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });

  app.openapi(listIssueActivity, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(await service.listIssueActivity(await workActor(c), issueId), 200);
    } catch (error) {
      return failure(c, error, issueReadKinds);
    }
  });

  app.openapi(createComment, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.createComment(await workActor(c), issueId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, commentWriteKinds);
    }
  });

  app.openapi(createIssueLink, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        await service.addIssueLink(await workActor(c), issueId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, linkAddKinds);
    }
  });

  app.openapi(removeIssueLink, async (c) => {
    try {
      const { issueId, linkId } = c.req.valid("param");
      await service.removeIssueLink(await workActor(c), issueId, linkId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, linkRemoveKinds);
    }
  });

  app.openapi(listActivity, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listActivity(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(listKnowledge, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(await service.listKnowledge(await workActor(c), projectId), 200);
    } catch (error) {
      return failure(c, error, projectReadKinds);
    }
  });

  app.openapi(createKnowledge, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      return c.json(
        await service.createKnowledge(await workActor(c), projectId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error, projectWriteKinds);
    }
  });

  app.openapi(getKnowledge, async (c) => {
    try {
      const { entryId } = c.req.valid("param");
      return c.json(await service.getKnowledge(await workActor(c), entryId), 200);
    } catch (error) {
      return failure(c, error, knowledgeReadKinds);
    }
  });

  app.openapi(updateKnowledge, async (c) => {
    try {
      const { entryId } = c.req.valid("param");
      return c.json(
        await service.updateKnowledge(await workActor(c), entryId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error, knowledgeWriteKinds);
    }
  });

  return app;
}

import {
  Issue,
  IssueComment,
  IssueDependency,
  IssueLink,
  KnowledgeEntry,
  Project,
  ProjectAccessGrant,
  ProjectLabel,
  type CreateIssueCommentRequest,
  type CreateIssueLinkRequest,
  type CreateIssueRequest,
  type CreateKnowledgeEntryRequest,
  type CreateProjectLabelRequest,
  type CreateProjectRequest,
  type SetProjectAccessRequest,
  type SetProjectFallbackPolicyRequest,
  type UpdateIssueRequest,
  type UpdateKnowledgeEntryRequest,
  type UpdateProjectLabelRequest,
  type UpdateProjectRequest,
} from "@orrery/contract";
import { deleteJson, deleteRequest, patchJson, post, postJson } from "../../lib/api.ts";

export function deleteProject(projectId: string): Promise<void> {
  return deleteRequest(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function restoreProject(projectId: string): Promise<Project> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/restore`, {}, (value) =>
    Project.parse(value),
  );
}

export function createProject(workspaceId: string, input: CreateProjectRequest): Promise<Project> {
  return postJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input, (value) =>
    Project.parse(value),
  );
}

export function updateProject(projectId: string, input: UpdateProjectRequest): Promise<Project> {
  return patchJson(`/api/projects/${encodeURIComponent(projectId)}`, input, (value) =>
    Project.parse(value),
  );
}

export function setProjectFallbackPolicy(
  projectId: string,
  input: SetProjectFallbackPolicyRequest,
): Promise<Project> {
  return patchJson(
    `/api/projects/${encodeURIComponent(projectId)}/fallback-policy`,
    input,
    (value) => Project.parse(value),
  );
}

export function setProjectAccess(
  projectId: string,
  input: SetProjectAccessRequest,
): Promise<ProjectAccessGrant> {
  return patchJson(`/api/projects/${encodeURIComponent(projectId)}/access`, input, (value) =>
    ProjectAccessGrant.parse(value),
  );
}

export function removeProjectAccess(projectId: string, humanId: string): Promise<void> {
  return deleteRequest(
    `/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(humanId)}`,
  );
}

export function createIssue(projectId: string, input: CreateIssueRequest): Promise<Issue> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/issues`, input, (value) =>
    Issue.parse(value),
  );
}

export function updateIssue(issueId: string, input: UpdateIssueRequest): Promise<Issue> {
  return patchJson(`/api/issues/${encodeURIComponent(issueId)}`, input, (value) =>
    Issue.parse(value),
  );
}

export function deleteIssue(issueId: string): Promise<void> {
  return deleteRequest(`/api/issues/${encodeURIComponent(issueId)}`);
}

export function restoreIssue(issueId: string): Promise<Issue> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/restore`, {}, (value) =>
    Issue.parse(value),
  );
}

export function createProjectLabel(
  projectId: string,
  input: CreateProjectLabelRequest,
): Promise<ProjectLabel> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/labels`, input, (value) =>
    ProjectLabel.parse(value),
  );
}

export function updateProjectLabel(
  labelId: string,
  input: UpdateProjectLabelRequest,
): Promise<ProjectLabel> {
  return patchJson(`/api/labels/${encodeURIComponent(labelId)}`, input, (value) =>
    ProjectLabel.parse(value),
  );
}

export function deleteProjectLabel(labelId: string): Promise<void> {
  return deleteRequest(`/api/labels/${encodeURIComponent(labelId)}`);
}

export function attachIssueLabel(issueId: string, labelId: string): Promise<Issue> {
  return postJson(
    `/api/issues/${encodeURIComponent(issueId)}/labels/${encodeURIComponent(labelId)}`,
    {},
    (value) => Issue.parse(value),
  );
}

export function detachIssueLabel(issueId: string, labelId: string): Promise<Issue> {
  return deleteJson(
    `/api/issues/${encodeURIComponent(issueId)}/labels/${encodeURIComponent(labelId)}`,
    (value) => Issue.parse(value),
  );
}

export function addBlockedBy(issueId: string, blockedByIssueId: string): Promise<IssueDependency> {
  return postJson(
    `/api/issues/${encodeURIComponent(issueId)}/blocked-by`,
    { blockedByIssueId },
    (value) => IssueDependency.parse(value),
  );
}

export function removeBlockedBy(issueId: string, blockedByIssueId: string): Promise<void> {
  return deleteRequest(
    `/api/issues/${encodeURIComponent(issueId)}/blocked-by/${encodeURIComponent(blockedByIssueId)}`,
  );
}

export function createIssueComment(
  issueId: string,
  input: CreateIssueCommentRequest,
): Promise<IssueComment> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, input, (value) =>
    IssueComment.parse(value),
  );
}

export function addIssueLink(issueId: string, input: CreateIssueLinkRequest): Promise<IssueLink> {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/links`, input, (value) =>
    IssueLink.parse(value),
  );
}

export function removeIssueLink(issueId: string, linkId: string): Promise<void> {
  return deleteRequest(
    `/api/issues/${encodeURIComponent(issueId)}/links/${encodeURIComponent(linkId)}`,
  );
}

export function createKnowledgeEntry(
  projectId: string,
  input: CreateKnowledgeEntryRequest,
): Promise<KnowledgeEntry> {
  return postJson(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, input, (value) =>
    KnowledgeEntry.parse(value),
  );
}

export function updateKnowledgeEntry(
  entryId: string,
  input: UpdateKnowledgeEntryRequest,
): Promise<KnowledgeEntry> {
  return patchJson(`/api/knowledge/${encodeURIComponent(entryId)}`, input, (value) =>
    KnowledgeEntry.parse(value),
  );
}

export function deleteKnowledgeEntry(entryId: string): Promise<void> {
  return deleteRequest(`/api/knowledge/${encodeURIComponent(entryId)}`);
}

export function restoreKnowledgeEntry(entryId: string): Promise<KnowledgeEntry> {
  return post(`/api/knowledge/${encodeURIComponent(entryId)}/restore`, (value) =>
    KnowledgeEntry.parse(value),
  );
}

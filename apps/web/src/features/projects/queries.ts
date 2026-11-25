import {
  IssueCommentsResponse,
  IssueDetail,
  IssuesResponse,
  MentionCandidatesResponse,
  KnowledgeEntriesResponse,
  KnowledgeEntry,
  Project,
  ProjectAccessCandidatesResponse,
  ProjectAccessGrantsResponse,
  ProjectAccessHumanIds,
  ProjectActivityResponse,
  ProjectLabelsResponse,
  ProjectsResponse,
  ReadyWorkResponse,
  type ReadyWorkFilter,
} from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export const projectsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "projects"],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, (value) =>
        ProjectsResponse.parse(value),
      ),
  });

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}`, (value) => Project.parse(value)),
  });

export const projectAccessQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "access"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/access`, (value) =>
        ProjectAccessGrantsResponse.parse(value),
      ),
  });

export const projectAccessCandidatesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "access", "candidates"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/access/candidates`, (value) =>
        ProjectAccessCandidatesResponse.parse(value),
      ),
  });

export const projectAccessHumanIdsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "access", "human-ids"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/access/humans`, (value) =>
        ProjectAccessHumanIds.parse(value),
      ),
  });

export const projectLabelsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "labels"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/labels`, (value) =>
        ProjectLabelsResponse.parse(value),
      ),
  });

export const projectTrashQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "trash"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/trash`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const issuesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "issues"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/issues`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const mentionCandidatesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "mention-candidates"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/mention-candidates`, (value) =>
        MentionCandidatesResponse.parse(value),
      ),
  });

export const readyWorkQuery = (projectId: string, filter?: ReadyWorkFilter) =>
  queryOptions({
    queryKey: ["projects", projectId, "ready-work", filter ?? "all"],
    queryFn: () =>
      getJson(
        `/api/projects/${encodeURIComponent(projectId)}/ready-work?filter=${filter ?? "all"}`,
        (value) => ReadyWorkResponse.parse(value),
      ),
  });

export const issueQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}`, (value) => IssueDetail.parse(value)),
  });

export const issueBlockedByQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "blocked-by"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/blocked-by`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const issueBlockingQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "blocking"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/blocking`, (value) =>
        IssuesResponse.parse(value),
      ),
  });

export const issueCommentsQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "comments"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/comments`, (value) =>
        IssueCommentsResponse.parse(value),
      ),
  });

export const issueActivityQuery = (issueId: string) =>
  queryOptions({
    queryKey: ["issues", issueId, "activity"],
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/activity`, (value) =>
        ProjectActivityResponse.parse(value),
      ),
  });

export const projectActivityQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "activity"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/activity`, (value) =>
        ProjectActivityResponse.parse(value),
      ),
  });

export const knowledgeEntriesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "knowledge"],
    queryFn: () =>
      getJson(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, (value) =>
        KnowledgeEntriesResponse.parse(value),
      ),
  });

export const knowledgeEntryQuery = (entryId: string) =>
  queryOptions({
    queryKey: ["knowledge", entryId],
    queryFn: () =>
      getJson(`/api/knowledge/${encodeURIComponent(entryId)}`, (value) =>
        KnowledgeEntry.parse(value),
      ),
  });

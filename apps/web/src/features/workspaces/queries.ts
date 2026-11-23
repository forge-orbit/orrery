import {
  HumanSuggestionsResponse,
  InvitationSummaries,
  Workspace,
  WorkspaceInvitationPreview,
  WorkspaceMembersResponse,
  WorkspacesResponse,
} from "@orrery/contract";
import type { InvitationSummary } from "@orrery/contract";
import type { Workspace as WorkspaceResource } from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: async (): Promise<WorkspaceResource[]> => {
    const res = await fetch("/api/workspaces");

    if (res.status === 401) return [];
    if (!res.ok) throw new Error(`Workspaces check failed (${res.status}).`);
    return WorkspacesResponse.parse(await res.json());
  },
});

export const workspaceQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}`, (value) =>
        Workspace.parse(value),
      ),
  });

export const workspaceMembersQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "members"],
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, (value) =>
        WorkspaceMembersResponse.parse(value),
      ),
  });

export const humanSuggestionsQuery = (workspaceId: string, query: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "human-suggestions", query],
    queryFn: () =>
      getJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/human-suggestions?q=${encodeURIComponent(query)}`,
        (value) => HumanSuggestionsResponse.parse(value),
      ),
    enabled: query.trim().length > 0,
  });

export const workspaceInvitationsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["workspaces", workspaceId, "invitations"],
    queryFn: async (): Promise<InvitationSummary[]> =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`, (value) =>
        InvitationSummaries.parse(value),
      ),
  });

export const workspaceInvitationPreviewQuery = (token: string) =>
  queryOptions({
    queryKey: ["workspace-invitation", token],
    queryFn: () =>
      getJson(`/api/workspace-invitations/preview?token=${encodeURIComponent(token)}`, (value) =>
        WorkspaceInvitationPreview.parse(value),
      ),
  });

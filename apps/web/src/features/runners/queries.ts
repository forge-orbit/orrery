import {
  DeviceCodePreview,
  IssueDispatchesResponse,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "../../lib/api.ts";

export function workspaceRunnersQueryKey(workspaceId: string) {
  return ["workspaces", workspaceId, "runners"] as const;
}

export function workspaceRunnersQuery(workspaceId: string, live = false) {
  return queryOptions({
    queryKey: workspaceRunnersQueryKey(workspaceId),
    queryFn: () =>
      getJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/runners`, (value) =>
        WorkspaceRunnersFleet.parse(value),
      ),
    refetchInterval: live ? 4_000 : false,
  });
}

export function issueDispatchesQueryKey(issueId: string) {
  return ["issues", issueId, "dispatches"] as const;
}

export function issueDispatchesQuery(issueId: string) {
  return queryOptions({
    queryKey: issueDispatchesQueryKey(issueId),
    queryFn: () =>
      getJson(`/api/issues/${encodeURIComponent(issueId)}/dispatches`, (value) =>
        IssueDispatchesResponse.parse(value),
      ),
  });
}

export function deviceCodePreviewQuery(userCode: string) {
  return queryOptions({
    queryKey: ["runners", "device-code", userCode] as const,
    queryFn: () =>
      getJson(`/api/runners/device-codes/${encodeURIComponent(userCode)}`, (value) =>
        DeviceCodePreview.parse(value),
      ),
    retry: false,
  });
}

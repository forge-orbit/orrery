import {
  DeviceCodePreview,
  IssueDispatchesResponse,
  StreamResponse,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ApiProblemError, getJson } from "../../lib/api.ts";
import { accumulateStream, type StreamAccumulator } from "./stream.ts";

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

export function streamQueryKey(runnerId: string, dispatchId: string, replay = false) {
  return ["runners", runnerId, "dispatches", dispatchId, replay ? "replay" : "live"] as const;
}

/**
 * Cursor-accumulating stream poll. The cursor lives in the Query cache entry
 * itself, so successive refetches ask for `?afterSeq=N` without a React effect.
 * `replay` fetches the rolled-up ObjectStore stream from seq 0 once the
 * session has ended and never polls.
 */
export function streamQuery(
  queryClient: QueryClient,
  runnerId: string,
  dispatchId: string,
  options: { active?: boolean; replay?: boolean; enabled?: boolean | undefined } = {},
) {
  const key = streamQueryKey(runnerId, dispatchId, options.replay === true);
  return queryOptions({
    queryKey: key,
    enabled: options.enabled ?? options.active !== false,
    queryFn: async (): Promise<StreamAccumulator> => {
      const previous =
        options.replay === true ? undefined : queryClient.getQueryData<StreamAccumulator>(key);
      const afterSeq = options.replay === true ? 0 : (previous?.cursor ?? 0);
      const value = await getJson(
        `/api/runners/${encodeURIComponent(runnerId)}/dispatches/${encodeURIComponent(dispatchId)}/stream?afterSeq=${afterSeq}`,
        (raw) => StreamResponse.parse(raw),
      );
      return accumulateStream(previous, value);
    },
    refetchInterval:
      options.replay === true
        ? false
        : (query) => {
            const error = query.state.error;
            if (error instanceof ApiProblemError && error.status >= 400 && error.status < 500) {
              return false;
            }
            return query.state.data?.rolledUp === true ? false : 2_000;
          },
    retry: 1,
  });
}

/** A one-second tick owned by Query, so countdowns update without a React effect. */
export function studioNowQuery() {
  return queryOptions({
    queryKey: ["studio", "clock"] as const,
    queryFn: () => Date.now(),
    refetchInterval: 1_000,
    staleTime: 0,
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

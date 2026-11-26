import type { CatalogProbeRequest, CreateDispatchRequest } from "@orrery/contract";
import {
  ApproveDeviceCodeResponse,
  CatalogProbeResponse,
  Dispatch,
  RevokeRunnerHostResponse,
} from "@orrery/contract";
import { post, postJson } from "../../lib/api.ts";

export function approveDeviceCode(userCode: string) {
  return post(`/api/runners/device-codes/${encodeURIComponent(userCode)}/approve`, (value) =>
    ApproveDeviceCodeResponse.parse(value),
  );
}

export function revokeRunnerHost(hostId: string) {
  return post(`/api/runner-hosts/${encodeURIComponent(hostId)}/revoke`, (value) =>
    RevokeRunnerHostResponse.parse(value),
  );
}

export function createDispatch(issueId: string, input: CreateDispatchRequest) {
  return postJson(`/api/issues/${encodeURIComponent(issueId)}/dispatches`, input, (value) =>
    Dispatch.parse(value),
  );
}

/** Ask the Runner to discover one model's efforts or refresh its whole catalog. */
export function probeRunnerCatalog(runnerId: string, input: CatalogProbeRequest) {
  return postJson(`/api/runners/${encodeURIComponent(runnerId)}/catalog/probe`, input, (value) =>
    CatalogProbeResponse.parse(value),
  );
}

/** Explicitly settle a dispatch that is waiting for human resolution. */
export function resolveUncertainDispatch(dispatchId: string, outcome: "released" | "completed") {
  return postJson(
    `/api/runners/dispatches/${encodeURIComponent(dispatchId)}/resolve`,
    { outcome },
    (value) => Dispatch.parse(value),
  );
}

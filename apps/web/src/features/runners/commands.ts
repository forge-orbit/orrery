import type { CreateDispatchRequest } from "@orrery/contract";
import { ApproveDeviceCodeResponse, Dispatch, RevokeRunnerHostResponse } from "@orrery/contract";
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

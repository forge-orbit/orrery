import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  AckCommandsRequest,
  AckCommandsResponse,
  ApproveDeviceCodeResponse,
  AutoClaimRequest,
  AutoClaimResponse,
  CatalogProbeRequest,
  CatalogProbeResponse,
  CommandsQuery,
  CreateDeviceCodeRequest,
  CreateDispatchRequest,
  DispatchId,
  DeviceCodePreview,
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
  ExchangeDeviceCodeRequest,
  IssueDispatchesResponse,
  IssueResolveRequest,
  IssueResolveResponse,
  HarnessCatalog,
  RunnerDispatchRequest,
  RunnerOfflineResponse,
  HeartbeatRequest,
  HostCredentialResponse,
  ReconnectRequest,
  ReconnectResponse,
  RegisterRunnerRequest,
  ResolveUncertainRequest,
  RevokeRunnerHostResponse,
  Runner,
  RunnerCommandsResponse,
  RunnerHostId,
  RunnerId,
  StreamBatchRequest,
  StreamBatchResponse,
  StreamQuery,
  StreamResponse,
  UserCode,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { readBearerToken } from "../agents/index.ts";
import { RunnersError, type RunnersErrorKind, type RunnersService } from "./service.ts";

const userCodeParams = z.object({ userCode: UserCode });
const hostParams = z.object({ hostId: RunnerHostId });
const runnerParams = z.object({ runnerId: RunnerId });
const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const issueParams = z.object({ issueId: z.string().min(1).max(200) });
const acceptParams = z.object({ runnerId: RunnerId, dispatchId: DispatchId });
const resolveParams = z.object({ dispatchId: DispatchId });

const dispatchErrors = {
  400: problem("The dispatch request is invalid"),
  401: problem("Not signed in, or the Runner host credential is invalid"),
  403: problem("Only the Runner host owner may dispatch to this Runner"),
  404: problem("No such issue, Runner or Dispatch is accessible"),
  409: problem("The Runner is unavailable or the issue is not claimable"),
  429: problem("Too many failed dispatch attempts; try again later"),
};

const enrollErrors = {
  400: problem("The enrollment request is invalid"),
  401: problem("Not signed in, the host credential was revoked, or the Runner lost access"),
  403: problem("The device verifier does not match this enrollment"),
  404: problem("No such device code, host, Agent or Runner exists"),
  409: problem("The device code is pending, expired, used, or the host has no default Agent"),
  429: problem("Too many incorrect user codes; try again in ten minutes"),
};

const createDeviceCode = createRoute({
  method: "post",
  path: "/api/runners/device-codes",
  summary: "Begin a verifier-bound Runner host enrollment",
  description:
    "Creates a ten-minute, single-use device-code session. The verifier hash binds the later exchange; only digests are stored.",
  request: {
    body: { content: { "application/json": { schema: CreateDeviceCodeRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The device code, user code and browser verification URI",
      content: { "application/json": { schema: DeviceCodeResponse } },
    },
    ...enrollErrors,
  },
});

const previewDeviceCode = createRoute({
  method: "get",
  path: "/api/runners/device-codes/{userCode}",
  summary: "Preview a device code for browser approval",
  description: "Read-only: a GET can never approve an enrollment or reveal a credential.",
  request: { params: userCodeParams },
  responses: {
    200: {
      description: "The requesting host's display name and platform",
      content: { "application/json": { schema: DeviceCodePreview } },
    },
    ...enrollErrors,
  },
});

const approveDeviceCode = createRoute({
  method: "post",
  path: "/api/runners/device-codes/{userCode}/approve",
  summary: "Approve a Runner host enrollment",
  description:
    "Requires an authenticated human POST. Binds the host to the approving human across the installation; records up to five failed user-code attempts.",
  request: { params: userCodeParams },
  responses: {
    200: {
      description: "The approved host's display name and platform",
      content: { "application/json": { schema: ApproveDeviceCodeResponse } },
    },
    ...enrollErrors,
  },
});

const exchangeDeviceCode = createRoute({
  method: "post",
  path: "/api/runners/device-codes/token",
  summary: "Exchange an approved device code for a host credential",
  description:
    "Verifier-bound, one-time exchange. Returns the long-lived host credential, which is never stored in plaintext.",
  request: {
    body: {
      content: { "application/json": { schema: ExchangeDeviceCodeRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The host credential",
      content: { "application/json": { schema: HostCredentialResponse } },
    },
    ...enrollErrors,
  },
});

const registerRunner = createRoute({
  method: "post",
  path: "/api/runners/register",
  summary: "Register a project-bound Runner",
  description:
    "Authenticates with a host credential. Sends only an opaque repository fingerprint; raw local paths are never accepted or stored.",
  request: {
    body: { content: { "application/json": { schema: RegisterRunnerRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The registered Runner",
      content: { "application/json": { schema: Runner } },
    },
    ...enrollErrors,
  },
});

const updateRunnerCatalog = createRoute({
  method: "put",
  path: "/api/runners/{runnerId}/catalog",
  summary: "Publish a Runner's live Harness catalog",
  description:
    "Runner host credential only. The submitted catalog is merged with the stored one so a slower startup probe or later refresh never regresses a previously known model's effort levels; heartbeats keep carrying only `activeSlotCount`.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: HarnessCatalog } }, required: true },
  },
  responses: {
    200: {
      description: "The Runner with the merged Harness catalog",
      content: { "application/json": { schema: Runner } },
    },
    ...enrollErrors,
  },
});

const heartbeat = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/heartbeat",
  summary: "Heartbeat a Runner in database time",
  description:
    "A 401 means the host or human was revoked; the CLI must stop local operation immediately.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: HeartbeatRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The Runner with derived DB-time presence",
      content: { "application/json": { schema: Runner } },
    },
    ...enrollErrors,
  },
});

const probeCatalogErrors = {
  400: problem("The catalog probe request is invalid"),
  401: problem("Not signed in"),
  403: problem("Only the human who owns this Runner host may probe its catalog"),
  404: problem("No such Runner is accessible"),
  409: problem("The Runner is offline or unavailable"),
  429: {
    ...problem("This catalog probe was requested too recently"),
    headers: z.object({ "Retry-After": z.string() }),
  },
};

const probeCatalog = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/catalog/probe",
  summary: "Request an on-demand Harness catalog probe",
  description:
    "Owner-only. Enqueues a short-lived probe_model or probe_catalog command on the Runner's durable outbox and rings the pg_notify doorbell; a per-runner/harness/model cooldown applies.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: CatalogProbeRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The enqueued probe command",
      content: { "application/json": { schema: CatalogProbeResponse } },
    },
    ...probeCatalogErrors,
  },
});
const listWorkspaceRunners = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/runners",
  summary: "List a workspace's Runners Fleet",
  description: "Runners grouped under their Runner host with live, DB-time presence.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace Runners Fleet",
      content: { "application/json": { schema: WorkspaceRunnersFleet } },
    },
    ...enrollErrors,
  },
});

const revokeRunnerHost = createRoute({
  method: "post",
  path: "/api/runner-hosts/{hostId}/revoke",
  summary: "Revoke a Runner host and all its Runners",
  description: "Only the human who owns the host may revoke it.",
  request: { params: hostParams },
  responses: {
    200: {
      description: "The revoked host and the number of Runners invalidated",
      content: { "application/json": { schema: RevokeRunnerHostResponse } },
    },
    ...enrollErrors,
  },
});

const createDispatch = createRoute({
  method: "post",
  path: "/api/issues/{issueId}/dispatches",
  summary: "Delegate an issue to one of your online Runners",
  description:
    "Owner-only: the selected Runner host must belong to the signed-in human. The issue's assignee is never changed.",
  request: {
    params: issueParams,
    body: { content: { "application/json": { schema: CreateDispatchRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The pending Dispatch",
      content: { "application/json": { schema: Dispatch } },
    },
    ...dispatchErrors,
  },
});

const listIssueDispatches = createRoute({
  method: "get",
  path: "/api/issues/{issueId}/dispatches",
  summary: "List the signed-in human's dispatches for an issue",
  request: { params: issueParams },
  responses: {
    200: {
      description: "The human's dispatches for this issue",
      content: { "application/json": { schema: IssueDispatchesResponse } },
    },
    ...dispatchErrors,
  },
});

const readDispatchErrors = {
  400: problem("The dispatch request is invalid"),
  401: problem("Not signed in, or the Runner host credential is invalid"),
  404: problem("No such Dispatch is accessible"),
};

const readDispatchRoute = createRoute({
  method: "get",
  path: "/api/runners/dispatches/{dispatchId}",
  summary: "Read one Dispatch's metadata, including its custom prompt",
  description:
    "A human with project Read access or the Runner host may read it; workspace members without project Read access receive 404.",
  request: { params: resolveParams },
  responses: {
    200: {
      description: "The Dispatch",
      content: { "application/json": { schema: Dispatch } },
    },
    ...readDispatchErrors,
  },
});

const acceptDispatch = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/dispatches/{dispatchId}/accept",
  summary: "Accept a Dispatch from a Runner host",
  description:
    "Authenticates with the `orr_rh_...` host credential. Registers the Run, claims the Work session and returns the single-use `orr_dt_...` Dispatch token in one transaction.",
  request: { params: acceptParams },
  responses: {
    200: {
      description: "The accepted Dispatch, Run, Work session and Dispatch token",
      content: { "application/json": { schema: DispatchAcceptance } },
    },
    ...dispatchErrors,
  },
});

const pollCommands = createRoute({
  method: "get",
  path: "/api/runners/{runnerId}/commands",
  summary: "Read a Runner's durable command outbox",
  description:
    "Authenticates the host credential and live ACLs on every poll. Queries unacknowledged, unexpired commands with seq > afterSeq before waiting on pg_notify; Accept: text/event-stream returns one SSE batch.",
  request: { params: runnerParams, query: CommandsQuery },
  responses: {
    200: {
      description: "Commands after the supplied sequence cursor",
      content: {
        "application/json": { schema: RunnerCommandsResponse },
        "text/event-stream": { schema: RunnerCommandsResponse },
      },
    },
    ...enrollErrors,
  },
});

const ackCommands = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/commands/ack",
  summary: "Acknowledge commands up to a sequence cursor",
  description: "Marks every unacknowledged command with seq <= upToSeq acknowledged.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: AckCommandsRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The acknowledged cursor",
      content: { "application/json": { schema: AckCommandsResponse } },
    },
    ...enrollErrors,
  },
});

// 429 is a native backpressure response: the header is part of the contract.
const streamErrors = {
  400: problem("The stream batch or cursor is invalid"),
  401: problem("Not signed in, or the Runner host credential is invalid"),
  403: problem("The viewer cannot read this project"),
  404: problem("No such Runner or Dispatch is accessible"),
  409: problem("The attempt fenced by dispatchAttemptId is not active"),
  429: {
    ...problem("Backpressure: retry after the Retry-After interval"),
    headers: z.object({ "Retry-After": z.string() }),
  },
};

const ingestStream = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/dispatches/{dispatchId}/stream",
  summary: "Flush an idempotent stream batch from the local spool",
  description:
    "Runner host credential only. Chunks are keyed by (work session, seq); replaying fromSeq..toSeq returns the contiguous ackedSeq or 429 Retry-After backpressure.",
  request: {
    params: acceptParams,
    body: { content: { "application/json": { schema: StreamBatchRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The contiguous acknowledged sequence",
      content: { "application/json": { schema: StreamBatchResponse } },
    },
    ...streamErrors,
  },
});

const readStream = createRoute({
  method: "get",
  path: "/api/runners/{runnerId}/dispatches/{dispatchId}/stream",
  summary: "Read the live or archived session stream after a sequence cursor",
  description:
    "A human with project Read access or the Runner host may poll ?afterSeq=N. owner_only raw chunks are removed server-side for every viewer who is not the Runner host owner, including administrators.",
  request: { params: acceptParams, query: StreamQuery },
  responses: {
    200: {
      description: "The visible chunks and the next cursor",
      content: { "application/json": { schema: StreamResponse } },
    },
    ...streamErrors,
  },
});

const autoClaimErrors = {
  400: problem("The auto-claim request is invalid"),
  401: problem("The Runner host credential is invalid or was revoked"),
  403: problem("The Runner host cannot contribute to this project"),
  404: problem("No such Runner is accessible"),
  409: problem("The Runner lost workspace or project access"),
  429: problem("Too many dispatch attempts; try again later"),
};

const resolveErrorsHost = {
  400: problem("The issue target is invalid"),
  401: problem("The Runner host credential is invalid or was revoked"),
  403: problem("The Runner host cannot contribute to this project"),
  404: problem("No such issue or workspace is accessible with Contribute access"),
  409: problem("The issue key is ambiguous; pass a workspace"),
  429: problem("Too many resolution attempts; try again later"),
};

const offlineErrors = {
  400: problem("The offline report is invalid"),
  401: problem("The Runner host credential is invalid or was revoked"),
  403: problem("The Runner host cannot access this workspace"),
  404: problem("No such Runner is accessible"),
  409: problem("The Runner lost workspace or project access"),
  429: problem("Too many offline reports; try again later"),
};

const reconnectErrors = {
  400: problem("The reconnect report is invalid"),
  401: problem("The Runner host credential is invalid or was revoked"),
  403: problem("The Runner host cannot access this workspace"),
  404: problem("No such Runner is accessible"),
  409: problem("The Runner lost workspace or project access"),
  429: problem("Too many reconnect reports; try again later"),
};

const resolveErrors = {
  400: problem("The resolution request is invalid"),
  401: problem("Not signed in"),
  403: problem("Only the requester, host owner or a project manager may resolve"),
  404: problem("No such Dispatch is accessible to you"),
  409: problem("The Dispatch is not uncertain"),
  429: problem("Too many resolution attempts; try again later"),
};

const autoClaim = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/auto-claim",
  summary: "Atomically claim the next ready issue for a Runner",
  description:
    "Runner host credential only. Applies Orrery's readiness and claim rules within one transaction; `assignedToMe` never claims unassigned issues. A null dispatch means no work is ready or every slot is occupied.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: AutoClaimRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The claimed Dispatch, or null when nothing is dispatchable",
      content: { "application/json": { schema: AutoClaimResponse } },
    },
    ...autoClaimErrors,
  },
});

const createRunnerDispatch = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/dispatches",
  summary: "Create a Dispatch for an explicitly resolved issue",
  description:
    "Runner host credential only. Used by the ephemeral one-shot `orrery-runner work` flow; shares the human delegation Dispatch creation path.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: RunnerDispatchRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The pending Dispatch",
      content: { "application/json": { schema: Dispatch } },
    },
    ...autoClaimErrors,
  },
});

const resolveIssue = createRoute({
  method: "post",
  path: "/api/runners/issue-resolve",
  summary: "Resolve a one-shot issue target for the enrolled Runner host",
  description:
    "Accepts a UUID, a URL or a `KEY-42` issue key. Requires Contribute access and fails with an ambiguity problem listing workspaces when a key matches more than one.",
  request: {
    body: { content: { "application/json": { schema: IssueResolveRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The unambiguous issue scope",
      content: { "application/json": { schema: IssueResolveResponse } },
    },
    ...resolveErrorsHost,
  },
});

const markRunnerOffline = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/offline",
  summary: "Mark an ephemeral Runner offline during one-shot teardown",
  description:
    "Runner host credential only. Revokes the single-use Runner and its Dispatch tokens so no credential outlives the one-shot process.",
  request: { params: runnerParams },
  responses: {
    200: {
      description: "The revoked Runner id",
      content: { "application/json": { schema: RunnerOfflineResponse } },
    },
    ...offlineErrors,
  },
});

const reconnectRunner = createRoute({
  method: "post",
  path: "/api/runners/{runnerId}/reconnect",
  summary: "Reconcile active dispatch attempts after a Runner reconnects",
  description:
    "An uncertain attempt absent from activeAttempts stays uncertain and blocks further dispatch until explicit human resolution.",
  request: {
    params: runnerParams,
    body: { content: { "application/json": { schema: ReconnectRequest } }, required: true },
  },
  responses: {
    200: {
      description: "One resolution per active or uncertain dispatch",
      content: { "application/json": { schema: ReconnectResponse } },
    },
    ...reconnectErrors,
  },
});

const resolveUncertain = createRoute({
  method: "post",
  path: "/api/runners/dispatches/{dispatchId}/resolve",
  summary: "Explicitly resolve an uncertain Dispatch",
  description:
    "Only a human who owns the request/host or has project Manage access may settle an uncertain attempt, releasing its claim before any re-dispatch.",
  request: {
    params: resolveParams,
    body: { content: { "application/json": { schema: ResolveUncertainRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The settled Dispatch",
      content: { "application/json": { schema: Dispatch } },
    },
    ...resolveErrors,
  },
});

const bearer = (c: Context) => readBearerToken(c.req.raw.headers.get("authorization")) ?? undefined;

type Status = 400 | 401 | 403 | 404 | 409 | 429;
const statusFor = {
  not_signed_in: 401,
  device_code_invalid: 404,
  device_code_expired: 409,
  device_code_pending: 409,
  device_code_used: 409,
  invalid_verifier: 403,
  too_many_attempts: 409,
  device_code_rate_limited: 429,
  invalid_credential: 401,
  runner_revoked: 401,
  slot_count_invalid: 400,
  workspace_not_found: 404,
  project_not_found: 404,
  host_not_found: 404,
  runner_not_found: 404,
  agent_not_found: 404,
  no_default_agent: 409,
  issue_not_found: 404,
  issue_ambiguous: 409,
  runner_forbidden: 403,
  runner_unavailable: 409,
  runner_not_for_issue: 409,
  harness_unavailable: 409,
  catalog_too_large: 400,
  insufficient_dispatch_access: 403,
  dispatch_not_found: 404,
  dispatch_not_pending: 409,
  dispatch_uncertain: 409,
  dispatch_not_uncertain: 409,
  issue_not_claimable: 409,
  issue_not_dispatchable: 409,
  stream_unavailable: 409,
  stream_attempt_mismatch: 409,
  stream_batch_out_of_range: 400,
  stream_batch_too_large: 400,
  stream_rate_limited: 429,
  stream_rollup_failed: 409,
  probe_rate_limited: 429,
} as const satisfies Record<RunnersErrorKind, Status>;

function failure(c: Context, error: unknown) {
  if (error instanceof RunnersError) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    });
  }
  throw error;
}

/** `getDispatch` only emits validation, credential and non-enumeration failures. */
function readDispatchFailure(c: Context, error: unknown) {
  if (!(error instanceof RunnersError)) throw error;
  const status = statusFor[error.kind];
  if (status !== 400 && status !== 401 && status !== 404) throw error;
  return problemResponse(c, {
    status,
    code: error.kind,
    title: error.message,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

function streamFailure(c: Context, error: unknown) {
  if (error instanceof RunnersError && error.kind === "stream_rate_limited") {
    c.header("Retry-After", String(error.retryAfter ?? 60));
  }
  return failure(c, error);
}

function probeFailure(c: Context, error: unknown) {
  if (error instanceof RunnersError && error.kind === "probe_rate_limited") {
    c.header("Retry-After", String(error.retryAfter ?? 30));
  }
  return failure(c, error);
}

export const routes = [
  createDeviceCode,
  previewDeviceCode,
  approveDeviceCode,
  exchangeDeviceCode,
  registerRunner,
  updateRunnerCatalog,
  heartbeat,
  probeCatalog,
  listWorkspaceRunners,
  revokeRunnerHost,
  createDispatch,
  listIssueDispatches,
  readDispatchRoute,
  acceptDispatch,
  pollCommands,
  ackCommands,
  ingestStream,
  readStream,
  autoClaim,
  createRunnerDispatch,
  resolveIssue,
  markRunnerOffline,
  reconnectRunner,
  resolveUncertain,
];

export function createRunnersRest(service: RunnersService, sessionReader: SessionReader) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  app.openapi(createDeviceCode, async (c) => {
    try {
      return c.json(await service.createDeviceCode(c.req.valid("json")), 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(previewDeviceCode, async (c) => {
    try {
      return c.json(await service.previewDeviceCode(c.req.valid("param").userCode), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(approveDeviceCode, async (c) => {
    try {
      const { userCode } = c.req.valid("param");
      return c.json(await service.approveDeviceCode(await sessionReader(c), userCode), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(exchangeDeviceCode, async (c) => {
    try {
      return c.json(await service.exchangeDeviceCode(c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(registerRunner, async (c) => {
    try {
      return c.json(await service.registerRunner(bearer(c), c.req.valid("json")), 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(updateRunnerCatalog, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(
        await service.updateRunnerCatalog(bearer(c), runnerId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(heartbeat, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(await service.heartbeat(bearer(c), runnerId, c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(probeCatalog, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(
        await service.probeCatalog(await sessionReader(c), runnerId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return probeFailure(c, error);
    }
  });

  app.openapi(listWorkspaceRunners, async (c) => {
    try {
      const { workspaceId } = c.req.valid("param");
      return c.json(await service.listWorkspaceRunners(await sessionReader(c), workspaceId), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(revokeRunnerHost, async (c) => {
    try {
      const { hostId } = c.req.valid("param");
      return c.json(await service.revokeRunnerHost(await sessionReader(c), hostId), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(createDispatch, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json(
        await service.createDispatch(await sessionReader(c), issueId, body.runnerId, body),
        201,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(listIssueDispatches, async (c) => {
    try {
      const { issueId } = c.req.valid("param");
      return c.json(
        { dispatches: await service.listIssueDispatches(await sessionReader(c), issueId) },
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(readDispatchRoute, async (c) => {
    try {
      const { dispatchId } = c.req.valid("param");
      return c.json(await service.getDispatch(bearer(c), await sessionReader(c), dispatchId), 200);
    } catch (error) {
      return readDispatchFailure(c, error);
    }
  });

  app.openapi(acceptDispatch, async (c) => {
    try {
      const { runnerId, dispatchId } = c.req.valid("param");
      return c.json(await service.acceptDispatch(bearer(c), runnerId, dispatchId), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(pollCommands, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      const { afterSeq, waitMs } = c.req.valid("query");
      const result = await service.pollCommands(
        bearer(c),
        runnerId,
        afterSeq,
        waitMs,
        c.req.raw.signal,
      );
      if (c.req.header("accept")?.includes("text/event-stream")) {
        const body = `event: commands\ndata: ${JSON.stringify(result)}\n\n`;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      return c.json(result, 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(ackCommands, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(
        await service.ackCommands(bearer(c), runnerId, c.req.valid("json").upToSeq),
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(autoClaim, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(await service.autoClaim(bearer(c), runnerId, c.req.valid("json").filter), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(createRunnerDispatch, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(
        await service.createRunnerDispatch(bearer(c), runnerId, c.req.valid("json")),
        201,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(resolveIssue, async (c) => {
    try {
      const { target, workspace } = c.req.valid("json");
      return c.json(
        await service.resolveIssue(bearer(c), {
          target,
          ...(workspace === undefined ? {} : { workspace }),
        }),
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(markRunnerOffline, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(await service.markRunnerOffline(bearer(c), runnerId), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(ingestStream, async (c) => {
    try {
      const { runnerId, dispatchId } = c.req.valid("param");
      return c.json(
        await service.ingestStream(bearer(c), runnerId, dispatchId, c.req.valid("json")),
        200,
      );
    } catch (error) {
      return streamFailure(c, error);
    }
  });

  app.openapi(readStream, async (c) => {
    try {
      const { runnerId, dispatchId } = c.req.valid("param");
      return c.json(
        await service.readStream(
          bearer(c),
          await sessionReader(c),
          runnerId,
          dispatchId,
          c.req.valid("query").afterSeq,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(reconnectRunner, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(await service.reconnectRunner(bearer(c), runnerId, c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.openapi(resolveUncertain, async (c) => {
    try {
      const { dispatchId } = c.req.valid("param");
      return c.json(
        await service.resolveUncertainDispatch(
          await sessionReader(c),
          dispatchId,
          c.req.valid("json").outcome,
        ),
        200,
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}

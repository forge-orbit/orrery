import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ApproveDeviceCodeResponse,
  CreateDeviceCodeRequest,
  DeviceCodePreview,
  DeviceCodeResponse,
  ExchangeDeviceCodeRequest,
  HeartbeatRequest,
  HostCredentialResponse,
  RegisterRunnerRequest,
  RevokeRunnerHostResponse,
  Runner,
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
const hostParams = z.object({ hostId: z.string().min(1).max(200) });
const runnerParams = z.object({ runnerId: z.string().min(1).max(200) });
const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });

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
} as const satisfies Record<RunnersErrorKind, Status>;

function failure(c: Context, error: unknown) {
  if (error instanceof RunnersError) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export const routes = [
  createDeviceCode,
  previewDeviceCode,
  approveDeviceCode,
  exchangeDeviceCode,
  registerRunner,
  heartbeat,
  listWorkspaceRunners,
  revokeRunnerHost,
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

  app.openapi(heartbeat, async (c) => {
    try {
      const { runnerId } = c.req.valid("param");
      return c.json(await service.heartbeat(bearer(c), runnerId, c.req.valid("json")), 200);
    } catch (error) {
      return failure(c, error);
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

  return app;
}

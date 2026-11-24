import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  CreateWebhookRequest,
  UpdateWebhookRequest,
  Webhook,
  WebhookDeliveriesResponse,
  WebhookDelivery,
  WebhooksResponse,
  WebhookWithSecret,
} from "@orrery/contract";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import {
  agentErrorStatus,
  assertDispatchRestAllowed,
  isAgentError,
  type AgentAuthenticator,
} from "../agents/index.ts";
import type { WorkActor } from "../projects/index.ts";
import { WebhooksError, type WebhooksErrorKind, type WebhooksService } from "./service.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1).max(200) });
const webhookParams = workspaceParams.extend({ webhookId: z.string().min(1).max(200) });

const baseErrors = {
  400: problem("The request parameters or payload are invalid"),
  401: problem("Not signed in, or the agent key is invalid or revoked"),
  403: problem("Only a workspace owner may manage webhooks"),
  404: problem("No such workspace or webhook is accessible to the caller"),
};

const conflictError = {
  409: problem("The webhook limit was reached or no encryption key is configured"),
};

const listWebhooks = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/webhooks",
  summary: "List a workspace's outgoing webhooks",
  description: "Workspace owners only. Agents and non-owners are rejected; outsiders see 404.",
  request: { params: workspaceParams },
  responses: {
    200: {
      description: "The workspace's webhooks",
      content: { "application/json": { schema: WebhooksResponse } },
    },
    ...baseErrors,
  },
});

const createWebhook = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/webhooks",
  summary: "Create an outgoing webhook",
  description:
    "Requires ORRERY_ENCRYPTION_KEY. The signing secret is returned once here and is never stored in plaintext or returned again.",
  request: {
    params: workspaceParams,
    body: { content: { "application/json": { schema: CreateWebhookRequest } }, required: true },
  },
  responses: {
    201: {
      description: "The created webhook and its one-time signing secret",
      content: { "application/json": { schema: WebhookWithSecret } },
    },
    ...baseErrors,
    ...conflictError,
  },
});

const updateWebhook = createRoute({
  method: "patch",
  path: "/api/workspaces/{workspaceId}/webhooks/{webhookId}",
  summary: "Update an outgoing webhook",
  description:
    "Re-enabling clears disabledAt, disabledReason, and the consecutive failure count. Disabling records a reason.",
  request: {
    params: webhookParams,
    body: { content: { "application/json": { schema: UpdateWebhookRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The updated webhook",
      content: { "application/json": { schema: Webhook } },
    },
    ...baseErrors,
  },
});

const rotateWebhookSecret = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/webhooks/{webhookId}/rotate-secret",
  summary: "Rotate a webhook signing secret",
  description: "The new signing secret is returned once here. Requires ORRERY_ENCRYPTION_KEY.",
  request: { params: webhookParams },
  responses: {
    200: {
      description: "The webhook and its new one-time signing secret",
      content: { "application/json": { schema: WebhookWithSecret } },
    },
    ...baseErrors,
    ...conflictError,
  },
});

const deleteWebhook = createRoute({
  method: "delete",
  path: "/api/workspaces/{workspaceId}/webhooks/{webhookId}",
  summary: "Delete an outgoing webhook",
  request: { params: webhookParams },
  responses: {
    204: { description: "The webhook and its deliveries are deleted" },
    ...baseErrors,
  },
});

const testWebhook = createRoute({
  method: "post",
  path: "/api/workspaces/{workspaceId}/webhooks/{webhookId}/test",
  summary: "Enqueue a synthetic webhook.test delivery",
  description: "A test delivery never increments the consecutive failure count.",
  request: { params: webhookParams },
  responses: {
    201: {
      description: "The enqueued test delivery",
      content: { "application/json": { schema: WebhookDelivery } },
    },
    ...baseErrors,
  },
});

const listWebhookDeliveries = createRoute({
  method: "get",
  path: "/api/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries",
  summary: "List a webhook's latest 50 delivery attempts",
  request: { params: webhookParams },
  responses: {
    200: {
      description: "The latest deliveries, newest first",
      content: { "application/json": { schema: WebhookDeliveriesResponse } },
    },
    ...baseErrors,
  },
});

export const routes = [
  listWebhooks,
  createWebhook,
  updateWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  testWebhook,
  listWebhookDeliveries,
];

const statusFor = {
  not_signed_in: 401,
  agents_cannot_manage_webhooks: 403,
  not_workspace_member: 404,
  not_workspace_owner: 403,
  webhook_not_found: 404,
  webhook_limit_reached: 409,
  encryption_key_missing: 409,
  invalid_webhook_scope: 400,
} as const satisfies Record<WebhooksErrorKind, number>;

const kindsBase = [
  "not_signed_in",
  "agents_cannot_manage_webhooks",
  "not_workspace_member",
  "not_workspace_owner",
  "webhook_not_found",
] as const;
const kindsCreate = [
  ...kindsBase,
  "webhook_limit_reached",
  "encryption_key_missing",
  "invalid_webhook_scope",
] as const;
const kindsUpdate = [...kindsBase, "invalid_webhook_scope"] as const;
const kindsRotate = [...kindsBase, "encryption_key_missing"] as const;

function isKind<K extends readonly WebhooksErrorKind[]>(
  error: WebhooksError,
  kinds: K,
): error is WebhooksError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

function failure<K extends readonly WebhooksErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (isAgentError(error)) {
    return problemResponse(c, {
      status: agentErrorStatus(error.kind),
      code: error.kind,
      title: error.message,
    });
  }
  if (error instanceof WebhooksError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

export function createWebhooksRest(
  service: WebhooksService,
  sessionReader: SessionReader,
  authenticate: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  const workActor = async (c: Context): Promise<WorkActor | null> => {
    const identity = await authenticate(c.req.raw);
    if (identity !== null) {
      assertDispatchRestAllowed(identity, c.req.method, c.req.path);
      return { kind: "agent", identity };
    }
    const account = await sessionReader(c);
    return account === null ? null : { kind: "human", account };
  };

  app.openapi(listWebhooks, async (c) => {
    try {
      return c.json(await service.list(await workActor(c), c.req.valid("param").workspaceId), 200);
    } catch (error) {
      return failure(c, error, kindsBase);
    }
  });

  app.openapi(createWebhook, async (c) => {
    try {
      return c.json(
        await service.create(
          await workActor(c),
          c.req.valid("param").workspaceId,
          c.req.valid("json"),
        ),
        201,
      );
    } catch (error) {
      return failure(c, error, kindsCreate);
    }
  });

  app.openapi(updateWebhook, async (c) => {
    try {
      const params = c.req.valid("param");
      return c.json(
        await service.update(
          await workActor(c),
          params.workspaceId,
          params.webhookId,
          c.req.valid("json"),
        ),
        200,
      );
    } catch (error) {
      return failure(c, error, kindsUpdate);
    }
  });

  app.openapi(rotateWebhookSecret, async (c) => {
    try {
      const params = c.req.valid("param");
      return c.json(
        await service.rotateSecret(await workActor(c), params.workspaceId, params.webhookId),
        200,
      );
    } catch (error) {
      return failure(c, error, kindsRotate);
    }
  });

  app.openapi(deleteWebhook, async (c) => {
    try {
      const params = c.req.valid("param");
      await service.remove(await workActor(c), params.workspaceId, params.webhookId);
      return c.body(null, 204);
    } catch (error) {
      return failure(c, error, kindsBase);
    }
  });

  app.openapi(testWebhook, async (c) => {
    try {
      const params = c.req.valid("param");
      return c.json(
        await service.test(await workActor(c), params.workspaceId, params.webhookId),
        201,
      );
    } catch (error) {
      return failure(c, error, kindsBase);
    }
  });

  app.openapi(listWebhookDeliveries, async (c) => {
    try {
      const params = c.req.valid("param");
      return c.json(
        await service.deliveries(await workActor(c), params.workspaceId, params.webhookId),
        200,
      );
    } catch (error) {
      return failure(c, error, kindsBase);
    }
  });

  return app;
}

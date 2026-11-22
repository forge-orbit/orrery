import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AvatarUploadRequest, SessionResponse } from "@orrery/contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import type { SessionAccount, SessionReader } from "../accounts/index.ts";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import {
  AvatarsError,
  type AvatarActor,
  type AvatarsErrorKind,
  type AvatarsService,
} from "./service.ts";

const putAvatar = createRoute({
  method: "put",
  path: "/api/account/avatar",
  summary: "Upload or replace the signed-in human's profile photo",
  description:
    "Accepts a multipart JPEG, PNG or WebP file up to 5 MB. The server validates magic bytes, strips all metadata, center-crops to 256x256 WebP, and returns the updated account with a cache-busting avatarUrl.",
  request: {
    body: {
      required: true,
      content: { "multipart/form-data": { schema: AvatarUploadRequest } },
    },
  },
  responses: {
    200: {
      description: "The updated account, including the new avatarUrl",
      content: { "application/json": { schema: SessionResponse } },
    },
    400: problem("The upload is missing or is not a valid image"),
    401: problem("No valid session"),
    403: problem("The account cannot change its photo"),
    413: problem("The file is larger than 5 MB"),
    415: problem("The file type is not supported"),
  },
});

const deleteAvatar = createRoute({
  method: "delete",
  path: "/api/account/avatar",
  summary: "Remove the signed-in human's profile photo",
  description:
    "Clears the human's avatar in the same transaction that marks the old object deleted, returns the updated account with avatarUrl: null, and then best-effort removes the blob and its object row.",
  responses: {
    200: {
      description: "The updated account, with no avatarUrl",
      content: { "application/json": { schema: SessionResponse } },
    },
    401: problem("No valid session"),
    403: problem("The account cannot change its photo"),
  },
});

const avatarHeaders = z.object({
  ETag: z.string(),
  "Cache-Control": z.string(),
  "X-Content-Type-Options": z.string(),
});

const getAvatar = createRoute({
  method: "get",
  path: "/api/humans/{humanId}/avatar",
  summary: "Serve a human's profile photo to someone who shares a workspace with them",
  description:
    "Requires a browser session or an agent API key. The caller must be the human or share a workspace with them; everyone else gets the same 404 as a missing photo. A matching `?v=<objectId>` allows immutable caching, and `If-None-Match` returns 304.",
  request: {
    params: z.object({ humanId: z.string().min(1) }),
    query: z.object({ v: z.string().optional() }),
  },
  responses: {
    200: {
      description: "The 256x256 WebP avatar",
      headers: avatarHeaders,
    },
    304: {
      description: "The avatar has not changed",
      headers: avatarHeaders.omit({ "X-Content-Type-Options": true }),
    },
    401: problem("No valid session"),
    404: problem("No such visible avatar"),
  },
});

export const routes = [putAvatar, deleteAvatar, getAvatar];

const statusFor = {
  not_signed_in: 401,
  account_deactivated: 403,
  invalid_upload: 400,
  unsupported_image_type: 415,
  invalid_image: 400,
  payload_too_large: 413,
  avatar_not_found: 404,
  avatar_not_visible: 404,
} as const satisfies Record<AvatarsErrorKind, ContentfulStatusCode>;

function isKind<K extends readonly AvatarsErrorKind[]>(
  error: AvatarsError,
  kinds: K,
): error is AvatarsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

/** The one Problem mapping for every avatar failure, used by handlers and the size guard. */
function failure<K extends readonly AvatarsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (error instanceof AvatarsError && isKind(error, kinds)) {
    return problemResponse(c, {
      status: statusFor[error.kind],
      code: error.kind,
      title: error.message,
    });
  }
  throw error;
}

const uploadKinds = [
  "not_signed_in",
  "account_deactivated",
  "invalid_upload",
  "unsupported_image_type",
  "invalid_image",
  "payload_too_large",
] as const;
const removeKinds = ["not_signed_in", "account_deactivated"] as const;
const readKinds = ["not_signed_in", "avatar_not_found", "avatar_not_visible"] as const;

function sessionBody(account: SessionAccount, avatarUrl: string | null) {
  return {
    email: account.email,
    displayName: account.displayName ?? null,
    emailVerified: account.emailVerifiedAt !== null,
    avatarUrl,
  };
}

export function createAvatarsRest(
  service: AvatarsService,
  sessionReader: SessionReader,
  authenticate: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  // Runs before the multipart validator: reject oversized requests without buffering them.
  app.use("/api/account/avatar", async (c, next) => {
    try {
      service.assertContentLength(c.req.header("content-length") ?? null);
      await next();
      return undefined;
    } catch (error) {
      return failure(c, error, uploadKinds);
    }
  });

  app.openapi(putAvatar, async (c) => {
    try {
      const account = service.requireHuman(await sessionReader(c));
      const data = await service.readUpload(c.req.valid("form").file);
      const result = await service.upload(account.humanId, data);
      return c.json(sessionBody(account, result.avatarUrl), 200);
    } catch (error) {
      return failure(c, error, uploadKinds);
    }
  });

  app.openapi(deleteAvatar, async (c) => {
    try {
      const account = service.requireHuman(await sessionReader(c));
      await service.remove(account.humanId);
      return c.json(sessionBody(account, null), 200);
    } catch (error) {
      return failure(c, error, removeKinds);
    }
  });

  app.openapi(getAvatar, async (c) => {
    const { humanId } = c.req.valid("param");
    const { v } = c.req.valid("query");
    let actor: AvatarActor | null = null;

    try {
      const account = await sessionReader(c);
      if (account !== null) {
        actor = { kind: "human", humanId: account.humanId };
      } else {
        try {
          const identity = await authenticate(c.req.raw);
          if (identity !== null) {
            actor = {
              kind: "agent",
              humanId: identity.humanId,
              workspaceId: identity.workspaceId,
            };
          }
        } catch (error) {
          if (isAgentError(error)) {
            return problemResponse(c, {
              status: 401,
              code: error.kind,
              title: error.message,
            });
          }
          throw error;
        }
      }

      const avatar = await service.read(actor, humanId, v, c.req.header("if-none-match"));
      if (avatar.notModified) {
        return new Response(null, {
          status: 304,
          headers: { etag: avatar.etag, "cache-control": avatar.cacheControl },
        });
      }
      return new Response(new Uint8Array(avatar.data ?? new Uint8Array()), {
        status: 200,
        headers: {
          "content-type": "image/webp",
          etag: avatar.etag,
          "cache-control": avatar.cacheControl,
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return failure(c, error, readKinds);
    }
  });

  return app;
}

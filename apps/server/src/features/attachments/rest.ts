import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Attachment, AttachmentUploadRequest } from "@orrery/contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  problemContent as problem,
  problemResponse,
  validationHook,
} from "../../platform/problem.ts";
import type { SessionReader } from "../accounts/index.ts";
import { isAgentError, type AgentAuthenticator } from "../agents/index.ts";
import type { WorkActor } from "../projects/index.ts";
import { AttachmentsError, type AttachmentsErrorKind, type AttachmentsService } from "./service.ts";

const projectParams = z.object({ projectId: z.string().min(1) });
const attachmentParams = projectParams.extend({ attachmentId: z.string().min(1) });

const postAttachment = createRoute({
  method: "post",
  path: "/api/projects/{projectId}/attachments",
  summary: "Upload a project-scoped attachment",
  description:
    "A Human with Contribute/Manage access or an Agent with an effective Contribute/Manage grant uploads one multipart file. Magic bytes are sniffed, inline raster images are re-encoded without EXIF, and the pending-to-active promotion plus the attachments row commit before the downloadUrl is returned.",
  request: {
    params: projectParams,
    body: {
      required: true,
      content: { "multipart/form-data": { schema: AttachmentUploadRequest } },
    },
  },
  responses: {
    201: {
      description: "The uploaded attachment metadata",
      content: { "application/json": { schema: Attachment } },
    },
    400: problem("The upload is missing or is not a valid image"),
    401: problem("No valid session or agent key"),
    403: problem("The caller cannot contribute to this project"),
    404: problem("No accessible project with this id"),
    409: problem("The upload expired before it could be activated"),
    413: problem("The file is larger than the configured limit"),
    415: problem("The file type is not supported"),
  },
});

const downloadHeaders = z.object({
  "Content-Type": z.string(),
  "Content-Disposition": z.string(),
  "Content-Length": z.string(),
  "Cache-Control": z.string(),
  "X-Content-Type-Options": z.string(),
});

const getAttachment = createRoute({
  method: "get",
  path: "/api/projects/{projectId}/attachments/{attachmentId}",
  summary: "Download a project-scoped attachment",
  description:
    "Requires project Read access for a Human session or Agent API key. Inline images are served with immutable caching; every other file (including SVG) is forced to a download with X-Content-Type-Options: nosniff.",
  request: { params: attachmentParams },
  responses: {
    200: { description: "The attachment bytes", headers: downloadHeaders },
    401: problem("No valid session or agent key"),
    403: problem("The caller cannot read this project"),
    404: problem("No such attachment in this project"),
  },
});

export const routes = [postAttachment, getAttachment];

const statusFor = {
  not_signed_in: 401,
  project_not_found: 404,
  insufficient_project_access: 403,
  attachment_not_found: 404,
  invalid_upload: 400,
  unsupported_file_type: 415,
  invalid_image: 400,
  payload_too_large: 413,
  attachment_upload_expired: 409,
} as const satisfies Record<AttachmentsErrorKind, ContentfulStatusCode>;

function isKind<K extends readonly AttachmentsErrorKind[]>(
  error: AttachmentsError,
  kinds: K,
): error is AttachmentsError & { kind: K[number] } {
  return kinds.some((kind) => kind === error.kind);
}

/** The one Problem mapping for every attachment failure, including the size guard. */
function failure<K extends readonly AttachmentsErrorKind[]>(c: Context, error: unknown, kinds: K) {
  if (isAgentError(error)) {
    return problemResponse(c, { status: 401, code: error.kind, title: error.message });
  }
  if (error instanceof AttachmentsError && isKind(error, kinds)) {
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
  "project_not_found",
  "insufficient_project_access",
  "invalid_upload",
  "unsupported_file_type",
  "invalid_image",
  "payload_too_large",
  "attachment_upload_expired",
] as const;
const downloadKinds = [
  "not_signed_in",
  "project_not_found",
  "insufficient_project_access",
  "attachment_not_found",
] as const;

export function createAttachmentsRest(
  service: AttachmentsService,
  sessionReader: SessionReader,
  authenticate: AgentAuthenticator,
) {
  const app = new OpenAPIHono({ defaultHook: validationHook });

  const workActor = async (c: Context): Promise<WorkActor | null> => {
    const identity = await authenticate(c.req.raw);
    if (identity !== null) return { kind: "agent", identity };
    const account = await sessionReader(c);
    return account === null ? null : { kind: "human", account };
  };

  // Runs before the multipart validator: reject oversized requests without buffering them.
  app.use("/api/projects/:projectId/attachments", async (c, next) => {
    try {
      service.assertContentLength(c.req.header("content-length") ?? null);
      await next();
      return undefined;
    } catch (error) {
      return failure(c, error, uploadKinds);
    }
  });

  app.openapi(postAttachment, async (c) => {
    try {
      const { projectId } = c.req.valid("param");
      const result = await service.upload(await workActor(c), projectId, c.req.valid("form").file);
      return c.json(result, 201);
    } catch (error) {
      return failure(c, error, uploadKinds);
    }
  });

  app.openapi(getAttachment, async (c) => {
    try {
      const { projectId, attachmentId } = c.req.valid("param");
      const served = await service.download(await workActor(c), projectId, attachmentId);
      const safeName = served.filename.replace(/["\\\r\n]/g, "_");
      return new Response(new Uint8Array(served.data), {
        status: 200,
        headers: {
          "content-type": served.contentType,
          "content-disposition": `${served.inline ? "inline" : "attachment"}; filename="${safeName}"`,
          "content-length": String(served.data.byteLength),
          "cache-control": served.inline
            ? "private, max-age=31536000, immutable"
            : "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return failure(c, error, downloadKinds);
    }
  });

  return app;
}

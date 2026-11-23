import { z } from "zod";
import { Timestamp } from "./common.ts";

/** The holder kinds that can bind an attachment reference (#179 syncs these on save). */
export const AttachmentHolderType = z
  .enum(["issue", "comment", "knowledge"])
  .meta({ id: "AttachmentHolderType" });
export type AttachmentHolderType = z.infer<typeof AttachmentHolderType>;

/** Multipart body of `POST /api/projects/:projectId/attachments`. Bytes are sniffed server-side. */
export const AttachmentUploadRequest = z
  .object({ file: z.any() })
  .meta({
    id: "AttachmentUploadRequest",
    description: "One image (10 MB) or downloadable file (25 MB by default).",
  });
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequest>;

/** Lightweight metadata returned after upload; never inline binary data. */
export const Attachment = z
  .object({
    id: z.string(),
    projectId: z.string(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number().int().positive(),
    inline: z.boolean(),
    downloadUrl: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: "Attachment" });
export type Attachment = z.infer<typeof Attachment>;

/** Stable, authenticated URL shape embedded in Markdown. */
export const attachmentUrlFor = (projectId: string, attachmentId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`;

/** True only for Orrery attachment URLs; arbitrary external image URLs stay inert text. */
export function isAttachmentUrl(url: string): boolean {
  return /^\/api\/projects\/[^/?#]+\/attachments\/[^/?#]+$/i.test(url);
}

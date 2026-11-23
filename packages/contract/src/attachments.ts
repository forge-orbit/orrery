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

/** Lightweight metadata embedded in issue, comment, and knowledge responses; never binary data. */
export const AttachmentMetadata = z
  .object({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number().int().positive(),
    downloadUrl: z.string(),
  })
  .meta({ id: "AttachmentMetadata" });
export type AttachmentMetadata = z.infer<typeof AttachmentMetadata>;

/** Metadata returned after upload; the extra fields describe the upload itself. */
export const Attachment = AttachmentMetadata.extend({
  projectId: z.string(),
  inline: z.boolean(),
  createdAt: Timestamp,
}).meta({ id: "Attachment" });
export type Attachment = z.infer<typeof Attachment>;

/** Stable, authenticated URL shape embedded in Markdown. */
export const attachmentUrlFor = (projectId: string, attachmentId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`;

/** True only for Orrery attachment URLs; arbitrary external image URLs stay inert text. */
export function isAttachmentUrl(url: string): boolean {
  return /^\/api\/projects\/[A-Za-z0-9_-]+\/attachments\/[A-Za-z0-9_-]+$/.test(url);
}

/** The project and attachment ids carried by a validated Orrery attachment URL. */
export function parseAttachmentUrl(url: string): { projectId: string; attachmentId: string } | null {
  if (!isAttachmentUrl(url)) return null;
  const parts = url.split("/");
  return { projectId: parts[3] ?? "", attachmentId: parts[5] ?? "" };
}

/**
 * Every distinct Orrery attachment URL mentioned in a Markdown body, in first-seen
 * order. Link destinations (`![alt](url)`, `[name](url "title")`) and bare URLs
 * are both recognised; the strict `isAttachmentUrl` matcher decides what counts.
 * Unknown, reclaimed, and cross-project URLs remain in the text but are never
 * returned, so a save never rejects or rewrites Markdown because of a dead link.
 */
export function extractAttachmentUrls(markdown: string): string[] {
  const candidates = markdown.match(/\/api\/projects\/[^\s"'<>)\]}]+/g) ?? [];
  const urls = new Set<string>();
  for (const candidate of candidates) {
    const url = candidate.replace(/[.,;:!?]+$/, "");
    if (isAttachmentUrl(url)) urls.add(url);
  }
  return [...urls];
}

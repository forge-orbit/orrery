import { createHash, randomUUID } from "node:crypto";
import { File } from "node:buffer";
import {
  Attachment,
  attachmentUrlFor,
  extractAttachmentUrls,
  parseAttachmentUrl,
  type AgentIdentity,
  type AttachmentHolderType,
  type AttachmentMetadata,
  type ProjectAccessLevel,
  type Attachment as AttachmentResponse,
} from "@orrery/contract";
import { and, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import sharp from "sharp";
import {
  attachmentReferences,
  attachments,
  humans,
  projects,
  storedObjects,
} from "../../db/schema.ts";
import type { Config } from "../../platform/config.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { discardObject, isDeleted, type ObjectRow } from "../../platform/object-sweep.ts";
import type { ObjectStore } from "../../platform/storage.ts";
import type { WorkActor } from "../projects/index.ts";

export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
/** Room for multipart boundaries and headers; the bytes are still bounded after parsing. */
export const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

export type AttachmentsErrorKind =
  | "not_signed_in"
  | "project_not_found"
  | "insufficient_project_access"
  | "attachment_not_found"
  | "invalid_upload"
  | "unsupported_file_type"
  | "invalid_image"
  | "payload_too_large"
  | "attachment_upload_expired";

const messages: Record<AttachmentsErrorKind, string> = {
  not_signed_in: "Sign in to attach files.",
  project_not_found: "No project with this id is accessible to you.",
  insufficient_project_access: "You do not have access to attach files in this project.",
  attachment_not_found: "No such attachment in this project.",
  invalid_upload: "Choose a file to upload.",
  unsupported_file_type: "This file type is not supported.",
  invalid_image: "The file is not a valid image.",
  payload_too_large: "The file is too large to upload.",
  attachment_upload_expired: "This upload expired before it could be attached. Try again.",
};

export class AttachmentsError extends Error {
  readonly kind: AttachmentsErrorKind;

  constructor(kind: AttachmentsErrorKind) {
    super(messages[kind]);
    this.name = "AttachmentsError";
    this.kind = kind;
  }
}

export interface ServedAttachment {
  data: Buffer;
  filename: string;
  contentType: string;
  inline: boolean;
}

/** An issue, comment, or knowledge entry that can bind an attachment reference. */
export interface AttachmentHolder {
  holderType: AttachmentHolderType;
  holderId: string;
}

export interface SyncReferencesInput extends AttachmentHolder {
  projectId: string;
  body: string;
}

/** Key used to group attachment metadata by the holder that references it. */
export const attachmentHolderKey = (holderType: AttachmentHolderType, holderId: string): string =>
  `${holderType}:${holderId}`;

export type AttachmentMetadataByHolder = Map<string, AttachmentMetadata[]>;

export interface AttachmentsService {
  assertContentLength(contentLength: string | null): void;
  upload(actor: WorkActor | null, projectId: string, file: unknown): Promise<AttachmentResponse>;
  download(
    actor: WorkActor | null,
    projectId: string,
    attachmentId: string,
  ): Promise<ServedAttachment>;
  /** Must run inside the holder's write transaction, after the holder row is written. */
  syncReferences(tx: DbTransaction, input: SyncReferencesInput): Promise<void>;
  /** Attachment metadata for each holder, keyed by `attachmentHolderKey`. */
  listMetadata(
    tx: DbTransaction,
    holders: readonly AttachmentHolder[],
  ): Promise<AttachmentMetadataByHolder>;
  /** Lock and delete trash attachments in one ordered pass; return blobs for the caller's final object pass. */
  purgeForTrash(
    tx: DbTransaction,
    holders: readonly AttachmentHolder[],
    projectIds: readonly string[],
  ): Promise<string[]>;
  /** One guarded 24-hour grace sweep tick; returns the number of attachments reclaimed. */
  sweepUnreferenced(): Promise<number>;
}

export interface AttachmentsDeps {
  db: PostgresJsDatabase;
  store: ObjectStore;
  maxAttachmentBytes: Config["ORRERY_MAX_ATTACHMENT_BYTES"];
  projectAccessCeiling: (
    tx: DbTransaction,
    workspaceId: string,
    humanId: string,
    projectIds: readonly string[],
  ) => Promise<Map<string, ProjectAccessLevel | null>>;
  projectAccessAtLeast: (actual: ProjectAccessLevel, required: ProjectAccessLevel) => boolean;
  /** Re-resolves the agent key inside the calling transaction, refusing stale identity state. */
  agentProjectAccess: (
    tx: DbTransaction,
    identity: AgentIdentity,
    workspaceId: string,
    projectId: string,
  ) => Promise<ProjectAccessLevel | null>;
}

type UploadFormat =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "text/x-log"
  | "text/x-patch"
  | "application/json"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/zip"
  | "application/gzip"
  | "image/svg+xml";

const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** MIME hints are resolved directly, so extensionless clipboard files still work. */
const MIME_TYPES: Record<string, UploadFormat> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
  "application/pdf": "application/pdf",
  "text/plain": "text/plain",
  "text/markdown": "text/markdown",
  "text/x-markdown": "text/markdown",
  "text/csv": "text/csv",
  "text/x-log": "text/x-log",
  "text/x-patch": "text/x-patch",
  "text/x-diff": "text/x-patch",
  "application/x-patch": "text/x-patch",
  "application/json": "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip": "application/zip",
  "application/gzip": "application/gzip",
  "image/svg+xml": "image/svg+xml",
};

/** Declared MIME is only a hint: the bytes decide what the upload really is. */
const EXTENSION_TYPES: Record<string, UploadFormat> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/x-log",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  patch: "text/x-patch",
  diff: "text/x-patch",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  gz: "application/gzip",
  svg: "image/svg+xml",
};

const ZIP_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const ZIP_ENTRIES: Partial<Record<UploadFormat, string>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word/document.xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xl/workbook.xml",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "ppt/presentation.xml",
};

const TEXT_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/x-log",
  "text/x-patch",
]);

/** Strip paths and control characters so a filename can never escape its object key. */
export function sanitizeFilename(name: string): string {
  const leaf = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = leaf
    // eslint-disable-next-line no-control-regex -- intentional: strip untrusted control characters.
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 255) || "upload";
}

function sniffImage(bytes: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (
    bytes.length >= 6 &&
    (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return "gif";
  }
  return null;
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isSvg(bytes: Buffer): boolean {
  const head = bytes
    .subarray(0, 2048)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  return /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(head);
}

function declaredFormat(filename: string, declared: string): UploadFormat | null {
  const normalized = declared.toLowerCase().split(";")[0]?.trim() ?? "";
  // An extension refines generic browser MIMEs (e.g. .log sent as text/plain);
  // when there is no extension, the declared MIME must carry the format.
  const extension = filename.includes(".") ? (filename.split(".").pop() ?? "").toLowerCase() : "";
  if (Object.hasOwn(EXTENSION_TYPES, extension)) return EXTENSION_TYPES[extension] ?? null;
  return MIME_TYPES[normalized] ?? null;
}

export function matchesMagic(bytes: Buffer, format: UploadFormat): boolean {
  const image = sniffImage(bytes);
  if (image !== null) {
    return (
      (format === "image/png" && image === "png") ||
      (format === "image/jpeg" && image === "jpeg") ||
      (format === "image/webp" && image === "webp") ||
      (format === "image/gif" && image === "gif")
    );
  }
  if (INLINE_TYPES.has(format)) return false;
  if (format === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (format === "application/gzip")
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (format === "image/svg+xml") return isSvg(bytes);
  if (format === "application/json") {
    const text = decodeUtf8(bytes);
    if (text === null) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  if (ZIP_TYPES.has(format)) {
    const signature = bytes.subarray(0, 4);
    const zip =
      signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
      signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
      signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    const entry = ZIP_ENTRIES[format];
    return zip && (entry === undefined || bytes.includes(Buffer.from(entry)));
  }
  if (TEXT_TYPES.has(format)) {
    const text = decodeUtf8(bytes);
    if (text === null) return false;
    const hasControlByte = Array.from(text).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
    });
    return !hasControlByte && !/^\s*(<\?xml|<html|<svg)/i.test(text);
  }
  return false;
}

export function isInlineContentType(contentType: string): boolean {
  return INLINE_TYPES.has(contentType);
}

async function normalizeImage(bytes: Buffer, format: UploadFormat): Promise<Buffer> {
  if (format === "image/gif") {
    // Validate the frames but keep the original bytes: re-encoding an animated
    // GIF through sharp can flatten it into a single frame.
    try {
      const meta = await sharp(bytes, { animated: true, failOn: "error" }).metadata();
      if ((meta.pages ?? 0) < 1) throw new AttachmentsError("invalid_image");
    } catch (error) {
      if (error instanceof AttachmentsError) throw error;
      throw new AttachmentsError("invalid_image");
    }
    return bytes;
  }
  const edge = format === "image/png" ? "png" : format === "image/jpeg" ? "jpeg" : "webp";
  try {
    // Re-encoding strips EXIF/IPTC/XMP; GIF stays untouched.
    return await sharp(bytes, { animated: edge === "webp", failOn: "error" })
      .rotate()
      .toFormat(edge, edge === "webp" ? { quality: 90 } : {})
      .toBuffer();
  } catch {
    throw new AttachmentsError("invalid_image");
  }
}

function holderConditions(holders: readonly AttachmentHolder[]) {
  const unique = [
    ...new Map(holders.map((h) => [attachmentHolderKey(h.holderType, h.holderId), h])).values(),
  ];
  return unique.map((holder) =>
    and(
      eq(attachmentReferences.holderType, holder.holderType),
      eq(attachmentReferences.holderId, holder.holderId),
    ),
  );
}

/**
 * Delete the attachment rows with no remaining references and mark their blobs
 * deleted. Reference rows cascade with each attachment, and the shared orphan
 * sweep can then remove the blob and stored_objects row with no FK violations.
 */
async function reclaimMany(
  tx: DbTransaction,
  candidates: readonly { id: string; objectId: string }[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  // Re-verify under the row locks: a save that won the race already cleared
  // unreferenced_at and inserted its reference row.
  const remaining = await tx
    .selectDistinct({ id: attachmentReferences.attachmentId })
    .from(attachmentReferences)
    .where(
      inArray(
        attachmentReferences.attachmentId,
        candidates.map((row) => row.id),
      ),
    );
  const referenced = new Set(remaining.map((row) => row.id));
  const reclaimable = candidates.filter((row) => !referenced.has(row.id));
  if (reclaimable.length === 0) return 0;

  await tx.delete(attachments).where(
    inArray(
      attachments.id,
      reclaimable.map((row) => row.id),
    ),
  );
  await tx
    .update(storedObjects)
    .set({ status: "deleted", deletedAt: sql`statement_timestamp()` })
    .where(
      and(
        inArray(storedObjects.id, [...new Set(reclaimable.map((row) => row.objectId))]),
        eq(storedObjects.status, "active"),
      ),
    );
  return reclaimable.length;
}

export function createAttachmentsService({
  db,
  store,
  maxAttachmentBytes,
  projectAccessCeiling,
  projectAccessAtLeast,
  agentProjectAccess,
}: AttachmentsDeps): AttachmentsService {
  function assertContentLength(contentLength: string | null): void {
    if (contentLength === null) return;
    const length = Number(contentLength);
    if (!Number.isFinite(length)) return;
    if (length > Math.max(MAX_INLINE_IMAGE_BYTES, maxAttachmentBytes) + MULTIPART_OVERHEAD_BYTES) {
      throw new AttachmentsError("payload_too_large");
    }
  }

  async function requireAccess(
    tx: DbTransaction,
    actor: WorkActor | null,
    projectId: string,
    required: ProjectAccessLevel,
  ): Promise<void> {
    if (actor === null) throw new AttachmentsError("not_signed_in");
    const [project] = await tx
      .select({ workspaceId: projects.workspaceId })
      .from(projects)
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);
    if (project === undefined) throw new AttachmentsError("project_not_found");

    let level: ProjectAccessLevel | null = null;
    if (actor.kind === "agent") {
      // The identity was resolved before the upload began; only the database can
      // say whether its key, owner, membership and grants are still live.
      level = await agentProjectAccess(tx, actor.identity, project.workspaceId, projectId);
    } else {
      const [account] = await tx
        .select({ id: humans.id })
        .from(humans)
        .where(and(eq(humans.id, actor.account.humanId), isNull(humans.deactivatedAt)))
        .limit(1);
      if (account === undefined) throw new AttachmentsError("not_signed_in");
      const ceiling = await projectAccessCeiling(tx, project.workspaceId, actor.account.humanId, [
        projectId,
      ]);
      level = ceiling.get(projectId) ?? null;
    }
    if (level === null) throw new AttachmentsError("project_not_found");
    if (!projectAccessAtLeast(level, required)) {
      throw new AttachmentsError("insufficient_project_access");
    }
  }

  return {
    assertContentLength,

    async upload(actor, projectId, file) {
      if (actor === null) throw new AttachmentsError("not_signed_in");
      // Authorize before buffering bytes or running sharp, so read-only, revoked,
      // and cross-project callers never make the server decode their payload.
      await db.transaction((tx) => requireAccess(tx, actor, projectId, "contribute"));
      if (!(file instanceof File)) throw new AttachmentsError("invalid_upload");
      const filename = sanitizeFilename(file.name);
      const original = Buffer.from(await file.arrayBuffer());
      const format = declaredFormat(filename, file.type);
      if (format === null) throw new AttachmentsError("unsupported_file_type");

      const inline = INLINE_TYPES.has(format);
      const cap = inline ? MAX_INLINE_IMAGE_BYTES : maxAttachmentBytes;
      if (original.byteLength > cap) throw new AttachmentsError("payload_too_large");
      if (original.byteLength === 0) throw new AttachmentsError("invalid_upload");
      if (!matchesMagic(original, format)) throw new AttachmentsError("unsupported_file_type");

      const data = inline ? await normalizeImage(original, format) : original;
      const uploadedByHumanId = actor.kind === "human" ? actor.account.humanId : null;
      const uploadedByAgentId = actor.kind === "agent" ? actor.identity.agentId : null;

      const objectId = randomUUID();
      const extension = filename.includes(".")
        ? (filename.split(".").pop() ?? "").toLowerCase()
        : "bin";
      const key = `attachments/${projectId}/${objectId}.${extension}`;
      const sha256 = createHash("sha256").update(data).digest("hex");

      await db.insert(storedObjects).values({
        id: objectId,
        key,
        status: "pending",
        contentType: format,
        byteSize: data.byteLength,
        sha256,
      });

      let createdAt: Date = new Date();
      try {
        await store.put(key, data, format);
        await db.transaction(async (tx) => {
          // Recheck inside the committing transaction: a revoked grant must not
          // win by racing the upload.
          await requireAccess(tx, actor, projectId, "contribute");
          const [activated] = await tx
            .update(storedObjects)
            .set({ status: "active", deletedAt: null })
            .where(and(eq(storedObjects.id, objectId), eq(storedObjects.status, "pending")))
            .returning({ id: storedObjects.id });
          if (activated === undefined) throw new AttachmentsError("attachment_upload_expired");
          const [created] = await tx
            .insert(attachments)
            .values({
              // The attachment id is the permanent id embedded in Markdown URLs.
              id: objectId,
              projectId,
              objectId,
              filename,
              contentType: format,
              byteSize: data.byteLength,
              uploadedByHumanId,
              uploadedByAgentId,
              unreferencedAt: sql`now()`,
            })
            .returning({ createdAt: attachments.createdAt });
          if (created !== undefined) createdAt = created.createdAt;
        });
      } catch (error) {
        // Claim first: the sweep may already have taken this row, and activating
        // a claimed row after a post-commit failure would resurrect a deleted blob.
        const pending: ObjectRow[] = await db
          .update(storedObjects)
          .set({ status: "deleted", deletedAt: sql`now()` })
          .where(and(eq(storedObjects.id, objectId), eq(storedObjects.status, "pending")))
          .returning({ id: storedObjects.id, key: storedObjects.key })
          .catch(() => []);
        const claimed = pending[0];
        if (claimed !== undefined) await discardObject(db, store, claimed, isDeleted);
        throw error;
      }

      return Attachment.parse({
        id: objectId,
        projectId,
        filename,
        contentType: format,
        byteSize: data.byteLength,
        inline,
        downloadUrl: attachmentUrlFor(projectId, objectId),
        createdAt: createdAt.toISOString(),
      });
    },

    async download(actor, projectId, attachmentId) {
      await db.transaction((tx) => requireAccess(tx, actor, projectId, "read"));
      const [row] = await db
        .select({
          key: storedObjects.key,
          status: storedObjects.status,
          contentType: attachments.contentType,
          filename: attachments.filename,
        })
        .from(attachments)
        .innerJoin(storedObjects, eq(storedObjects.id, attachments.objectId))
        .where(and(eq(attachments.id, attachmentId), eq(attachments.projectId, projectId)))
        .limit(1);
      if (row === undefined || row.status !== "active") {
        throw new AttachmentsError("attachment_not_found");
      }

      const stored = await store.get(row.key);
      if (stored === null) throw new AttachmentsError("attachment_not_found");
      const inline = isInlineContentType(row.contentType);
      return {
        data: stored.data,
        filename: row.filename,
        contentType: inline ? row.contentType : "application/octet-stream",
        inline,
      };
    },

    async syncReferences(tx, input) {
      // Only same-project, still-active attachments are bound. Everything else
      // stays in the Markdown as inert text; saves are never rejected or rewritten.
      const wanted = new Set<string>();
      for (const url of extractAttachmentUrls(input.body)) {
        const parsed = parseAttachmentUrl(url);
        if (parsed !== null && parsed.projectId === input.projectId) {
          wanted.add(parsed.attachmentId);
        }
      }

      const existing = await tx
        .select({ attachmentId: attachmentReferences.attachmentId })
        .from(attachmentReferences)
        .where(
          and(
            eq(attachmentReferences.holderType, input.holderType),
            eq(attachmentReferences.holderId, input.holderId),
          ),
        );
      const existingIds = existing.map((row) => row.attachmentId);

      // The holder row has already been written by the caller; attachments come
      // next in ascending id order so every save/purge shares one lock order.
      // Lock the union of added AND dropped candidates up front: leaving dropped
      // rows for the trailing UPDATE would lock B before A when an edit drops A
      // and adds B with A < B, deadlocking against a purge that locks in id order.
      const candidateIds = [...new Set([...wanted, ...existingIds])].toSorted();
      const locked = candidateIds.length
        ? await tx
            .select({
              id: attachments.id,
              projectId: attachments.projectId,
              status: storedObjects.status,
            })
            .from(attachments)
            .innerJoin(storedObjects, eq(storedObjects.id, attachments.objectId))
            .where(inArray(attachments.id, candidateIds))
            .orderBy(attachments.id)
            .for("update", { of: attachments })
        : [];
      const bindableIds = locked
        .filter(
          (row) =>
            row.projectId === input.projectId && row.status === "active" && wanted.has(row.id),
        )
        .map((row) => row.id);
      const bindableSet = new Set(bindableIds);
      const dropped = existingIds.filter((id) => !bindableSet.has(id));

      const stale = [...new Set([...existingIds, ...wanted].filter((id) => !bindableSet.has(id)))];
      if (stale.length > 0) {
        await tx
          .delete(attachmentReferences)
          .where(
            and(
              eq(attachmentReferences.holderType, input.holderType),
              eq(attachmentReferences.holderId, input.holderId),
              inArray(attachmentReferences.attachmentId, stale),
            ),
          );
      }
      const added = bindableIds.filter((id) => !existingIds.includes(id));
      if (added.length > 0) {
        // The unique (holder type, holder id, attachment id) index absorbs a URL
        // pasted twice in one body and any repeat of a concurrent save.
        await tx
          .insert(attachmentReferences)
          .values(
            added.map((attachmentId) => ({
              id: randomUUID(),
              attachmentId,
              holderType: input.holderType,
              holderId: input.holderId,
            })),
          )
          .onConflictDoNothing();
      }

      if (bindableIds.length > 0) {
        await tx
          .update(attachments)
          .set({ unreferencedAt: null })
          .where(inArray(attachments.id, bindableIds));
      }
      if (dropped.length > 0) {
        // A fresh grace window starts only when this holder's drop left the
        // attachment with no references at all.
        await tx
          .update(attachments)
          .set({ unreferencedAt: sql`statement_timestamp()` })
          .where(
            and(
              inArray(attachments.id, [...new Set(dropped)]),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(attachmentReferences)
                  .where(eq(attachmentReferences.attachmentId, attachments.id)),
              ),
            ),
          );
      }
    },

    async listMetadata(tx, holders) {
      const conditions = holderConditions(holders);
      const grouped = new Map<string, AttachmentMetadata[]>();
      if (conditions.length === 0) return grouped;
      const rows = await tx
        .select({
          holderType: attachmentReferences.holderType,
          holderId: attachmentReferences.holderId,
          id: attachments.id,
          projectId: attachments.projectId,
          filename: attachments.filename,
          contentType: attachments.contentType,
          byteSize: attachments.byteSize,
        })
        .from(attachmentReferences)
        .innerJoin(attachments, eq(attachments.id, attachmentReferences.attachmentId))
        .innerJoin(storedObjects, eq(storedObjects.id, attachments.objectId))
        .innerJoin(projects, eq(projects.id, attachments.projectId))
        .where(
          and(or(...conditions), eq(storedObjects.status, "active"), isNull(projects.deletedAt)),
        )
        .orderBy(attachmentReferences.holderType, attachmentReferences.holderId, attachments.id);
      for (const row of rows) {
        const key = attachmentHolderKey(row.holderType, row.holderId);
        const list = grouped.get(key) ?? [];
        list.push({
          id: row.id,
          filename: row.filename,
          contentType: row.contentType,
          byteSize: row.byteSize,
          downloadUrl: attachmentUrlFor(row.projectId, row.id),
        });
        grouped.set(key, list);
      }
      return grouped;
    },

    async purgeForTrash(tx, holders, projectIds) {
      const conditions = holderConditions(holders);
      const targetConditions = [];
      if (projectIds.length > 0) {
        targetConditions.push(inArray(attachments.projectId, projectIds));
      }
      if (conditions.length > 0) targetConditions.push(or(...conditions));
      if (targetConditions.length === 0) return [];

      // The caller locks projects, their holders and work sessions first. Lock
      // holder and project attachments together here, before any stored_objects
      // row is touched by the caller.
      const rows = await tx
        .select({
          id: attachments.id,
          objectId: attachments.objectId,
          projectId: attachments.projectId,
        })
        .from(attachments)
        .leftJoin(attachmentReferences, eq(attachments.id, attachmentReferences.attachmentId))
        .where(or(...targetConditions))
        .orderBy(attachments.id)
        .for("update", { of: attachments });
      const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()];
      if (conditions.length > 0) {
        await tx.delete(attachmentReferences).where(or(...conditions));
      }

      const projectIdSet = new Set(projectIds);
      const projectRows = uniqueRows.filter((row) => projectIdSet.has(row.projectId));
      const holderRows = uniqueRows.filter((row) => !projectIdSet.has(row.projectId));
      const remaining =
        holderRows.length === 0
          ? []
          : await tx
              .selectDistinct({ id: attachmentReferences.attachmentId })
              .from(attachmentReferences)
              .where(
                inArray(
                  attachmentReferences.attachmentId,
                  holderRows.map((row) => row.id),
                ),
              );
      const referencedIds = new Set(remaining.map((row) => row.id));
      const reclaimableHolderRows = holderRows.filter((row) => !referencedIds.has(row.id));
      const rowsToDelete = [...projectRows, ...reclaimableHolderRows];
      const attachmentIds = [...new Set(rowsToDelete.map((row) => row.id))].toSorted();
      if (attachmentIds.length > 0) {
        await tx.delete(attachments).where(inArray(attachments.id, attachmentIds));
      }

      // The project service combines these with released session stream objects
      // and locks/updates all stored_objects in one final ordered pass.
      return [...new Set(rowsToDelete.map((row) => row.objectId))].toSorted();
    },

    async sweepUnreferenced() {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: attachments.id, objectId: attachments.objectId })
          .from(attachments)
          .where(
            and(
              isNotNull(attachments.unreferencedAt),
              sql`${attachments.unreferencedAt} <= statement_timestamp() - interval '24 hours'`,
            ),
          )
          .orderBy(attachments.id)
          .for("update");
        return reclaimMany(tx, rows);
      });
    },
  };
}

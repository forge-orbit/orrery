import { createHash, randomUUID } from "node:crypto";
import { File } from "node:buffer";
import { avatarUrlFor } from "@orrery/contract";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import sharp from "sharp";
import {
  accountRecoveryEvents,
  humans,
  storedObjects,
  workspaceMemberships,
} from "../../db/schema.ts";
import type { ObjectStore } from "../../platform/storage.ts";
import type { SessionAccount } from "../accounts/index.ts";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Room for multipart boundaries and headers; the bytes are still bounded after parsing. */
export const MULTIPART_OVERHEAD_BYTES = 16 * 1024;
export const AVATAR_SIZE = 256;

export type AvatarsErrorKind =
  | "not_signed_in"
  | "account_deactivated"
  | "invalid_upload"
  | "unsupported_image_type"
  | "invalid_image"
  | "payload_too_large"
  | "avatar_not_found"
  | "avatar_not_visible";

const messages: Record<AvatarsErrorKind, string> = {
  not_signed_in: "Sign in to manage your profile photo.",
  account_deactivated: "This account cannot change its profile photo.",
  invalid_upload: "Choose an image file to upload.",
  unsupported_image_type: "Upload a JPEG, PNG or WebP image. SVG files are not supported.",
  invalid_image: "The file is not a valid image.",
  payload_too_large: "The image must be 5 MB or smaller.",
  avatar_not_found: "This human has no profile photo.",
  avatar_not_visible: "No such profile photo.",
};

export class AvatarsError extends Error {
  readonly kind: AvatarsErrorKind;

  constructor(kind: AvatarsErrorKind) {
    super(messages[kind]);
    this.name = "AvatarsError";
    this.kind = kind;
  }
}

export type AvatarActor =
  | { kind: "human"; humanId: string }
  | { kind: "agent"; humanId: string; workspaceId: string };

export interface AvatarResult {
  objectId: string;
  avatarUrl: string;
}

export interface ServedAvatar {
  etag: string;
  cacheControl: string;
  notModified: boolean;
  data?: Buffer;
}

export interface AvatarsService {
  requireHuman(account: SessionAccount | null): SessionAccount;
  assertContentLength(contentLength: string | null): void;
  readUpload(file: unknown): Promise<Buffer>;
  upload(humanId: string, data: Buffer): Promise<AvatarResult>;
  remove(humanId: string): Promise<void>;
  sweepOrphans(): Promise<number>;
  read(
    actor: AvatarActor | null,
    humanId: string,
    version?: string,
    ifNoneMatch?: string,
  ): Promise<ServedAvatar>;
}

export interface AvatarsDeps {
  db: PostgresJsDatabase;
  store: ObjectStore;
}

type SniffedFormat = "jpeg" | "png" | "webp";

function sniff(bytes: Buffer): SniffedFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

async function normalize(bytes: Buffer): Promise<{ data: Buffer; sha256: string }> {
  if (bytes.byteLength > MAX_AVATAR_BYTES) throw new AvatarsError("payload_too_large");
  const head = bytes.subarray(0, 1024).toString("utf8").toLowerCase();
  if (head.includes("<svg") || bytes.subarray(0, 5).toString("utf8").startsWith("<?xml")) {
    throw new AvatarsError("unsupported_image_type");
  }
  if (sniff(bytes) === null) throw new AvatarsError("unsupported_image_type");

  try {
    const data = await sharp(bytes, { failOn: "error" })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 85 })
      .toBuffer();
    return { data, sha256: createHash("sha256").update(data).digest("hex") };
  } catch {
    throw new AvatarsError("invalid_image");
  }
}

export function avatarKey(humanId: string, objectId: string): string {
  return `avatars/${humanId}/${objectId}.webp`;
}

type ObjectRow = { id: string; key: string };

const isDeleted = sql`${storedObjects.status} = 'deleted'`;
/** A `pending` row older than 15 minutes is assumed to belong to a crashed upload. */
const isOrphan = sql`${isDeleted} or (${storedObjects.status} = 'pending' and ${storedObjects.createdAt} < statement_timestamp() - interval '15 minutes')`;

/**
 * Delete the blob first and only hard-delete its metadata row once the blob is
 * gone. A failed backend delete leaves the row for the next sweep, so a transient
 * storage error can never turn into a lost audit trail or an untracked blob.
 */
async function discardObject(
  db: PostgresJsDatabase,
  store: ObjectStore,
  row: ObjectRow,
  stillEligible: SQL,
): Promise<boolean> {
  try {
    await store.delete(row.key);
  } catch {
    return false;
  }
  try {
    await db.delete(storedObjects).where(and(eq(storedObjects.id, row.id), stillEligible));
  } catch {
    return false;
  }
  return true;
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag);
}

export function createAvatarsService({ db, store }: AvatarsDeps): AvatarsService {
  return {
    requireHuman(account) {
      if (account === null) throw new AvatarsError("not_signed_in");
      return account;
    },

    assertContentLength(contentLength) {
      if (contentLength === null) return;
      const length = Number(contentLength);
      if (!Number.isFinite(length)) return;
      if (length > MAX_AVATAR_BYTES + MULTIPART_OVERHEAD_BYTES) {
        throw new AvatarsError("payload_too_large");
      }
    },

    async readUpload(file) {
      if (!(file instanceof File)) throw new AvatarsError("invalid_upload");
      const data = Buffer.from(await file.arrayBuffer());
      if (data.byteLength > MAX_AVATAR_BYTES) throw new AvatarsError("payload_too_large");
      return data;
    },

    async upload(humanId, data) {
      const normalized = await normalize(data);
      const objectId = randomUUID();
      const key = avatarKey(humanId, objectId);

      await db.insert(storedObjects).values({
        id: objectId,
        key,
        status: "pending",
        contentType: "image/webp",
        byteSize: normalized.data.byteLength,
        sha256: normalized.sha256,
      });

      const replaced: { row: ObjectRow | null } = { row: null };
      try {
        await store.put(key, normalized.data, "image/webp");
        await db.transaction(async (tx) => {
          const [human] = await tx
            .select({ avatarObjectId: humans.avatarObjectId, deactivatedAt: humans.deactivatedAt })
            .from(humans)
            .where(eq(humans.id, humanId))
            .for("update");
          if (human === undefined || human.deactivatedAt !== null) {
            throw new AvatarsError("account_deactivated");
          }

          await tx
            .update(storedObjects)
            .set({ status: "active", deletedAt: null })
            .where(eq(storedObjects.id, objectId));
          await tx.update(humans).set({ avatarObjectId: objectId }).where(eq(humans.id, humanId));
          if (human.avatarObjectId !== null && human.avatarObjectId !== objectId) {
            const [old] = await tx
              .update(storedObjects)
              .set({ status: "deleted", deletedAt: sql`now()` })
              .where(
                and(eq(storedObjects.id, human.avatarObjectId), eq(storedObjects.status, "active")),
              )
              .returning({ id: storedObjects.id, key: storedObjects.key });
            replaced.row = old ?? null;
          }
        });
      } catch (error) {
        // Claim the row before touching the blob. If the transaction actually
        // committed and the error came from the connection afterwards, the row is
        // `active` and this UPDATE matches nothing — the live blob must stay.
        const pending = await db
          .update(storedObjects)
          .set({ status: "deleted", deletedAt: sql`now()` })
          .where(and(eq(storedObjects.id, objectId), eq(storedObjects.status, "pending")))
          .returning({ id: storedObjects.id, key: storedObjects.key })
          .catch(() => []);
        const claimed = pending[0];
        if (claimed !== undefined) await discardObject(db, store, claimed, isDeleted);
        throw error;
      }

      if (replaced.row !== null) await discardObject(db, store, replaced.row, isDeleted);
      return { objectId, avatarUrl: avatarUrlFor(humanId, objectId) };
    },

    async remove(humanId) {
      const removed: { row: ObjectRow | null } = { row: null };
      await db.transaction(async (tx) => {
        const [human] = await tx
          .select({ avatarObjectId: humans.avatarObjectId, deactivatedAt: humans.deactivatedAt })
          .from(humans)
          .where(eq(humans.id, humanId))
          .for("update");
        if (human === undefined || human.deactivatedAt !== null) {
          throw new AvatarsError("account_deactivated");
        }
        if (human.avatarObjectId === null) return;

        await tx.update(humans).set({ avatarObjectId: null }).where(eq(humans.id, humanId));
        const [old] = await tx
          .update(storedObjects)
          .set({ status: "deleted", deletedAt: sql`now()` })
          .where(
            and(eq(storedObjects.id, human.avatarObjectId), eq(storedObjects.status, "active")),
          )
          .returning({ id: storedObjects.id, key: storedObjects.key });
        removed.row = old ?? null;
      });
      if (removed.row !== null) await discardObject(db, store, removed.row, isDeleted);
    },

    async sweepOrphans() {
      const rows = await db
        .select({ id: storedObjects.id, key: storedObjects.key })
        .from(storedObjects)
        .where(isOrphan)
        .orderBy(storedObjects.id);
      let reclaimed = 0;
      for (const row of rows) {
        if (await discardObject(db, store, row, isOrphan)) reclaimed++;
      }
      return reclaimed;
    },

    async read(actor, humanId, version, ifNoneMatch) {
      if (actor === null) throw new AvatarsError("not_signed_in");
      if (!(await canReadAvatar(db, actor, humanId))) {
        throw new AvatarsError("avatar_not_visible");
      }

      const [row] = await db
        .select({
          objectId: humans.avatarObjectId,
          sha256: storedObjects.sha256,
        })
        .from(humans)
        .leftJoin(storedObjects, eq(storedObjects.id, humans.avatarObjectId))
        .where(eq(humans.id, humanId))
        .limit(1);
      if (row === undefined || row.objectId === null || row.sha256 === null) {
        throw new AvatarsError("avatar_not_found");
      }

      const etag = `"${row.sha256}"`;
      const cacheControl =
        version === row.objectId ? "private, max-age=31536000, immutable" : "private, no-cache";
      if (etagMatches(ifNoneMatch, etag)) {
        return { etag, cacheControl, notModified: true };
      }

      const stored = await store.get(avatarKey(humanId, row.objectId));
      if (stored === null) throw new AvatarsError("avatar_not_found");
      return { data: stored.data, etag, cacheControl, notModified: false };
    },
  };
}

async function canReadAvatar(
  db: PostgresJsDatabase,
  actor: AvatarActor,
  humanId: string,
): Promise<boolean> {
  if (actor.kind === "human" && actor.humanId === humanId) return true;

  const [target] = await db
    .select({ deactivatedAt: humans.deactivatedAt })
    .from(humans)
    .where(eq(humans.id, humanId))
    .limit(1);
  if (target === undefined) return false;

  // Deactivation suspends shared memberships and leaves them suspended after
  // reactivation. Those historical memberships still identify past work, so they
  // continue to authorise avatar reads for active members of the same workspace.
  const historicalMembership =
    target.deactivatedAt !== null ||
    (
      await db
        .select({ id: accountRecoveryEvents.id })
        .from(accountRecoveryEvents)
        .where(
          and(
            eq(accountRecoveryEvents.humanId, humanId),
            eq(accountRecoveryEvents.type, "account_deactivated"),
          ),
        )
        .limit(1)
    ).length > 0;

  const targetConditions: SQL[] = [eq(workspaceMemberships.humanId, humanId)];
  if (!historicalMembership) targetConditions.push(isNull(workspaceMemberships.suspendedAt));

  if (actor.kind === "human") {
    const [shared] = await db
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.humanId, actor.humanId),
          isNull(workspaceMemberships.suspendedAt),
          inArray(
            workspaceMemberships.workspaceId,
            db
              .select({ workspaceId: workspaceMemberships.workspaceId })
              .from(workspaceMemberships)
              .where(and(...targetConditions)),
          ),
        ),
      )
      .limit(1);
    return shared !== undefined;
  }

  // An agent acts only within the workspace its key was issued for, even when the
  // target is the human who owns the agent.
  const [membership] = await db
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(and(...targetConditions, eq(workspaceMemberships.workspaceId, actor.workspaceId)))
    .limit(1);
  return membership !== undefined;
}

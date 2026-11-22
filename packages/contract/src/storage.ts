import { z } from "zod";

/** Lifecycle of a tracked blob: reserved before upload, live while referenced, soft-deleted after. */
export const StoredObjectStatus = z
  .enum(["pending", "active", "deleted"])
  .meta({ id: "StoredObjectStatus" });
export type StoredObjectStatus = z.infer<typeof StoredObjectStatus>;

/** Multipart body of `PUT /api/account/avatar`. The server sniffs the bytes, not the declared type. */
export const AvatarUploadRequest = z
  .object({ file: z.any() })
  .meta({ id: "AvatarUploadRequest", description: "A JPEG, PNG or WebP image of at most 5 MB." });
export type AvatarUploadRequest = z.infer<typeof AvatarUploadRequest>;

/** The stable, cache-bustable URL for a Human's current avatar. */
export const avatarUrlFor = (humanId: string, objectId: string): string =>
  `/api/humans/${encodeURIComponent(humanId)}/avatar?v=${encodeURIComponent(objectId)}`;

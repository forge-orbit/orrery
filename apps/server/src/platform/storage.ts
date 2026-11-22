import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./config.ts";

export interface StoredObject {
  data: Buffer;
  /** Backends that store content type (e.g. S3) may return it; the local one does not. */
  contentType?: string;
}

export interface ObjectMeta {
  key: string;
  byteSize: number;
  sha256: string;
  contentType?: string;
}

export interface HealthResult {
  ok: boolean;
  reason?: string;
}

/**
 * Language-neutral object storage seam. Keys are relative POSIX-style paths and
 * are identical on every backend (e.g. `avatars/<humanId>/<objectId>.webp`).
 * The bytes are the only thing persisted under a key: metadata belongs in
 * `stored_objects`, so an object copied in by `rclone`/`aws s3 sync` is readable.
 */
export interface ObjectStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<ObjectMeta>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectMeta | null>;
  delete(key: string): Promise<boolean>;
  checkHealth(): Promise<HealthResult>;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Reject anything that could address a path outside the object root. */
export function assertObjectKey(key: string): void {
  const invalid =
    key.length === 0 ||
    key.length > 1024 ||
    isAbsolute(key) ||
    key.includes("\\") ||
    key.includes("\u0000") ||
    !KEY_PATTERN.test(key) ||
    key.split("/").some((part) => part === "" || part === "." || part === "..");
  if (invalid) throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLocalObjectStore(dataDir: string): ObjectStore {
  const root = resolve(dataDir, "objects");

  function pathFor(key: string): string {
    assertObjectKey(key);
    const path = resolve(root, ...key.split("/"));
    const inside = relative(root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
    }
    return path;
  }

  async function readBytes(key: string): Promise<Buffer | null> {
    try {
      return await readFile(pathFor(key));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  return {
    // Content type is kept in `stored_objects`; the local driver stores only the bytes.
    async put(key, data, _contentType) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });

      const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, data, { flag: "wx" });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return {
        key,
        byteSize: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    },

    async get(key) {
      const data = await readBytes(key);
      return data === null ? null : { data };
    },

    async head(key) {
      const target = pathFor(key);
      let info;
      try {
        info = await stat(target);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (!info.isFile()) return null;
      const data = await readBytes(key);
      if (data === null) return null;
      return { key, byteSize: info.size, sha256: createHash("sha256").update(data).digest("hex") };
    },

    async delete(key) {
      const target = pathFor(key);
      try {
        await unlink(target);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },

    async checkHealth() {
      try {
        await mkdir(root, { recursive: true });
        const info = await stat(root);
        if (!info.isDirectory())
          return { ok: false, reason: "object storage root is not a directory" };
        const probe = join(root, `.health-${randomUUID()}`);
        try {
          await writeFile(probe, "ok", { flag: "wx" });
          await unlink(probe);
        } catch (error) {
          await rm(probe, { force: true });
          return {
            ok: false,
            reason: `object storage is not writable: ${messageOf(error)}`,
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `object storage is unavailable: ${messageOf(error)}`,
        };
      }
    },
  };
}

export function createObjectStore(
  config: Pick<Config, "ORRERY_STORAGE_DRIVER" | "ORRERY_DATA_DIR">,
): ObjectStore {
  switch (config.ORRERY_STORAGE_DRIVER) {
    case "local":
      return createLocalObjectStore(config.ORRERY_DATA_DIR);
    default:
      throw new Error(`Unsupported object storage driver: ${String(config.ORRERY_STORAGE_DRIVER)}`);
  }
}

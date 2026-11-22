import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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

export interface S3StoreConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * A missing key is a normal read miss; a missing bucket is a storage/configuration
 * error and must propagate, so it is never folded into "not found".
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "NoSuchBucket") return false;
  if ("name" in error && (error.name === "NoSuchKey" || error.name === "NotFound")) return true;
  return (
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 404
  );
}

/**
 * S3-compatible adapter. The object key is used verbatim as the S3 key, so
 * `<bucket>/<key>` mirrors local `<dataDir>/objects/<key>` byte for byte and an
 * `aws s3 sync` / `rclone sync` copy needs no database changes. No sidecar or
 * metadata files are written: the content type and checksums live in
 * `stored_objects`, so a blob copied in by another backend stays readable.
 */
export function createS3ObjectStore(config: S3StoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  /**
   * Some S3 providers answer a plain 404 for both a missing key and a missing
   * bucket, so confirm the bucket before treating a 404 as a harmless miss.
   */
  async function isMissingKey(error: unknown): Promise<boolean> {
    if (!isNotFound(error)) return false;
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      return true;
    } catch (bucketError) {
      throw new Error(
        `S3 bucket ${config.bucket} is unavailable at ${config.endpoint}: ${messageOf(bucketError)}`,
        { cause: bucketError },
      );
    }
  }

  async function readObject(key: string): Promise<Buffer | null> {
    assertObjectKey(key);
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return response.Body === undefined
        ? null
        : Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (await isMissingKey(error)) return null;
      throw error;
    }
  }

  return {
    async put(key, data, contentType) {
      assertObjectKey(key);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
      return {
        key,
        byteSize: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    },

    async get(key) {
      const data = await readObject(key);
      return data === null ? null : { data };
    },

    // Read the bytes so the checksum comes from the object itself, never from
    // metadata that an external `sync` would leave behind.
    async head(key) {
      const data = await readObject(key);
      return data === null
        ? null
        : {
            key,
            byteSize: data.byteLength,
            sha256: createHash("sha256").update(data).digest("hex"),
          };
    },

    async delete(key) {
      assertObjectKey(key);
      // HEAD only: existence is all we need, and a missing key is a normal no-op.
      try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (error) {
        if (await isMissingKey(error)) return false;
        throw error;
      }
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    },

    async checkHealth() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `S3 bucket ${config.bucket} is unreachable at ${config.endpoint}: ${messageOf(error)}`,
        };
      }
    },
  };
}

export function createObjectStore(
  config: Pick<
    Config,
    | "ORRERY_STORAGE_DRIVER"
    | "ORRERY_DATA_DIR"
    | "ORRERY_S3_ENDPOINT"
    | "ORRERY_S3_BUCKET"
    | "ORRERY_S3_REGION"
    | "ORRERY_S3_ACCESS_KEY_ID"
    | "ORRERY_S3_SECRET_ACCESS_KEY"
    | "ORRERY_S3_FORCE_PATH_STYLE"
  >,
): ObjectStore {
  switch (config.ORRERY_STORAGE_DRIVER) {
    case "local":
      return createLocalObjectStore(config.ORRERY_DATA_DIR);
    case "s3": {
      // loadConfig() enforces these; keep the factory safe for direct callers too.
      const {
        ORRERY_S3_ENDPOINT: endpoint,
        ORRERY_S3_BUCKET: bucket,
        ORRERY_S3_ACCESS_KEY_ID: accessKeyId,
        ORRERY_S3_SECRET_ACCESS_KEY: secretAccessKey,
      } = config;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "S3 storage requires ORRERY_S3_ENDPOINT, ORRERY_S3_BUCKET, " +
            "ORRERY_S3_ACCESS_KEY_ID and ORRERY_S3_SECRET_ACCESS_KEY",
        );
      }
      return createS3ObjectStore({
        endpoint,
        bucket,
        region: config.ORRERY_S3_REGION,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: config.ORRERY_S3_FORCE_PATH_STYLE,
      });
    }
    default:
      throw new Error(`Unsupported object storage driver: ${String(config.ORRERY_STORAGE_DRIVER)}`);
  }
}

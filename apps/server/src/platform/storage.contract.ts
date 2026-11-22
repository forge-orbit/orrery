import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ObjectStore } from "./storage.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface ContractStore {
  store: ObjectStore;
  /** Present when the adapter writes blobs to disk (the local driver). */
  root?: string;
  /** Write bytes at the exact key without using ObjectStore.put (e.g. `aws s3 sync`). */
  writeRaw: (key: string, data: Uint8Array) => Promise<void>;
  /** Read the raw bytes at the key straight from the backend, bypassing ObjectStore.get. */
  readRaw: (key: string) => Promise<Uint8Array | null>;
}

/**
 * The behaviour every ObjectStore adapter must share. Run this unchanged against
 * the local temp-dir adapter and against the S3 adapter backed by a real RustFS
 * container. Filesystem-only assertions are conditional on a `root` being present.
 */
export function objectStoreContract(makeStore: () => Promise<ContractStore>): void {
  describe("ObjectStore contract", () => {
    it("puts, gets, heads and deletes a key round-trip", async () => {
      const { store } = await makeStore();
      const key = `contract/${randomUUID()}.bin`;
      const data = bytes("orrery object store contract payload");

      const written = await store.put(key, data, "application/octet-stream");
      expect(written).toMatchObject({
        key,
        byteSize: data.byteLength,
        sha256: sha256(data),
      });

      const fetched = await store.get(key);
      expect(fetched).not.toBeNull();
      expect(Buffer.from(fetched?.data ?? []).toString("utf8")).toBe(
        Buffer.from(data).toString("utf8"),
      );
      expect(fetched?.contentType).toBeUndefined();

      expect(await store.head(key)).toEqual(written);

      expect(await store.delete(key)).toBe(true);
      expect(await store.get(key)).toBeNull();
      expect(await store.head(key)).toBeNull();
      expect(await store.delete(key)).toBe(false);
    });

    it("overwrites a key so readers see only the newest bytes", async () => {
      const { store } = await makeStore();
      const key = `contract/${randomUUID()}.bin`;
      const first = bytes("first");
      const second = bytes("the second, longer payload");

      await store.put(key, first, "text/plain");
      await store.put(key, second, "text/plain");

      const fetched = await store.get(key);
      expect(Buffer.from(fetched?.data ?? []).toString("utf8")).toBe(
        Buffer.from(second).toString("utf8"),
      );
      expect(await store.head(key)).toMatchObject({
        byteSize: second.byteLength,
        sha256: sha256(second),
      });
    });

    it("stores only the blob at the exact relative key", async () => {
      const { store, root, readRaw } = await makeStore();
      const key = `avatars/${randomUUID()}/avatar.webp`;
      const data = bytes("nested");

      await store.put(key, data, "image/webp");

      // Every backend addresses the object by this one relative key and needs no
      // index to read it back.
      expect(Buffer.from((await store.get(key))?.data ?? []).toString("utf8")).toBe("nested");
      // Read straight from the backend: the put must land at this exact key.
      expect(Buffer.from((await readRaw(key)) ?? []).toString("utf8")).toBe("nested");
      expect(await store.head(key)).toEqual({
        key,
        byteSize: data.byteLength,
        sha256: sha256(data),
      });
      // Filesystem drivers additionally prove there is exactly one file at that path.
      expect(root === undefined ? null : (await readFile(join(root, key))).toString("utf8")).toBe(
        root === undefined ? null : "nested",
      );
      expect(root === undefined ? null : await readdir(dirname(join(root, key)))).toEqual(
        root === undefined ? null : ["avatar.webp"],
      );
    });

    it("reads a blob copied directly into the key path, with no sidecar metadata", async () => {
      const { store, readRaw, writeRaw } = await makeStore();
      const key = `avatars/${randomUUID()}/synced.webp`;
      const data = bytes("synced from another backend");
      await writeRaw(key, data);

      expect(Buffer.from((await readRaw(key)) ?? []).toString("utf8")).toBe(
        Buffer.from(data).toString("utf8"),
      );
      const fetched = await store.get(key);
      expect(Buffer.from(fetched?.data ?? []).toString("utf8")).toBe(
        Buffer.from(data).toString("utf8"),
      );
      expect(await store.head(key)).toMatchObject({
        key,
        byteSize: data.byteLength,
        sha256: sha256(data),
      });
    });

    it("rejects keys that could escape the object root", async () => {
      const { store } = await makeStore();
      const data = bytes("escape attempt");
      for (const key of [
        "",
        "/absolute.bin",
        "../escape.bin",
        "avatars/../../escape.bin",
        "avatars/./avatar.webp",
        "avatars//avatar.webp",
        "avatars\\escape.webp",
        "avatars/\u0000.webp",
      ]) {
        await expect(store.put(key, data, "application/octet-stream")).rejects.toThrow(
          /object key/i,
        );
      }
    });

    it("reports health as ok for a writable root", async () => {
      const { store } = await makeStore();
      expect(await store.checkHealth()).toMatchObject({ ok: true });
    });
  });
}

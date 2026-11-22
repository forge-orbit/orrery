import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalObjectStore } from "./storage.ts";
import { objectStoreContract } from "./storage.contract.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orrery-storage-contract-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

objectStoreContract(async () => {
  const objects = join(root, "objects");
  return {
    store: createLocalObjectStore(root),
    root: objects,
    writeRaw: async (key, data) => {
      const target = join(objects, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    readRaw: async (key) => readFile(join(objects, key)),
  };
});

describe("LocalObjectStore health", () => {
  it("fails health when the object root is not a directory", async () => {
    const blocker = join(root, "not-a-directory");
    await writeFile(blocker, "occupied");
    const store = createLocalObjectStore(blocker);
    const health = await store.checkHealth();
    expect(health).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/object storage/i),
    });
  });

  it("creates the object root on first write", async () => {
    const store = createLocalObjectStore(root);
    const key = "deeply/nested/key.webp";
    await store.put(key, new Uint8Array([1, 2, 3]), "image/webp");
    expect((await store.head(key))?.byteSize).toBe(3);
  });

  it("leaves no temporary files behind after a write", async () => {
    const store = createLocalObjectStore(root);
    await store.put("clean/key.webp", new Uint8Array([1]), "image/webp");
    const entries = await readdir(join(root, "objects", "clean"));
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });
});

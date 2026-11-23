import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storedObjects } from "../db/schema.ts";
import { createDb, type Database } from "./db.ts";
import { migrate } from "./migrate.ts";
import { createLocalObjectStore, type ObjectStore } from "./storage.ts";
import { discardObject, isDeleted, sweepOrphanObjects } from "./object-sweep.ts";

describe("shared stored_objects orphan sweep", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let dataDir: string;
  let store: ObjectStore;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    const migrationsDir = new URL("../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "orrery-object-sweep-"));
    store = createLocalObjectStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await database.db.execute(sql`delete from stored_objects`);
  });

  async function reserve(key: string, createdAt = sql`statement_timestamp()`) {
    const id = randomUUID();
    const bytes = Buffer.from(`bytes-for-${key}`);
    await database.db.insert(storedObjects).values({
      id,
      key,
      status: "pending",
      contentType: "application/octet-stream",
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt,
    });
    await store.put(key, bytes, "application/octet-stream");
    return id;
  }

  it("reclaims stale pending objects from every feature prefix in one pass", async () => {
    const staleAvatar = await reserve(
      `avatars/${randomUUID()}/${randomUUID()}.webp`,
      sql`statement_timestamp() - interval '16 minutes'`,
    );
    const staleAttachment = await reserve(
      `attachments/${randomUUID()}/${randomUUID()}.bin`,
      sql`statement_timestamp() - interval '20 minutes'`,
    );
    const fresh = await reserve(`attachments/${randomUUID()}/${randomUUID()}.bin`);

    expect(await sweepOrphanObjects(database.db, store)).toBe(2);

    expect(
      await database.db.select().from(storedObjects).where(eq(storedObjects.id, fresh)),
    ).toHaveLength(1);
    expect(
      await database.db.select().from(storedObjects).where(eq(storedObjects.status, "deleted")),
    ).toHaveLength(0);
    expect(await store.head(`avatars/stale`)).toBeNull();
    expect(await store.head(`attachments/stale`)).toBeNull();

    for (const id of [staleAvatar, staleAttachment]) {
      const [row] = await database.db.select().from(storedObjects).where(eq(storedObjects.id, id));
      expect(row).toBeUndefined();
    }
  });

  it("keeps a deleted row for the next sweep when the blob delete fails", async () => {
    const key = `attachments/${randomUUID()}/${randomUUID()}.bin`;
    const id = await reserve(key);
    await database.db
      .update(storedObjects)
      .set({ status: "deleted", deletedAt: sql`now()` })
      .where(eq(storedObjects.id, id));

    const failingStore: ObjectStore = {
      ...store,
      async delete() {
        throw new Error("injected delete failure");
      },
    };
    expect(await sweepOrphanObjects(database.db, failingStore)).toBe(0);
    const [claimed] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.id, id));
    expect(claimed?.status).toBe("deleted");
    expect((await stat(join(dataDir, "objects", key))).isFile()).toBe(true);

    expect(await sweepOrphanObjects(database.db, store)).toBe(1);
    expect(await store.head(key)).toBeNull();
  });

  it("reports only rows it actually hard-deleted", async () => {
    const key = `attachments/${randomUUID()}/${randomUUID()}.bin`;
    const id = await reserve(key);
    const [row] = await database.db.select().from(storedObjects).where(eq(storedObjects.id, id));
    expect(row).toBeDefined();

    expect(await discardObject(database.db, store, { id: row!.id, key: row!.key }, isDeleted)).toBe(
      false,
    );
    await database.db
      .update(storedObjects)
      .set({ status: "deleted", deletedAt: sql`now()` })
      .where(eq(storedObjects.id, id));
    expect(await discardObject(database.db, store, { id: row!.id, key: row!.key }, isDeleted)).toBe(
      true,
    );
    expect(
      await database.db
        .select()
        .from(storedObjects)
        .where(and(eq(storedObjects.id, id), eq(storedObjects.status, "deleted"))),
    ).toHaveLength(0);
  });
});

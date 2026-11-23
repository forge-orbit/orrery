import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { storedObjects } from "../db/schema.ts";
import type { Logger } from "./log.ts";
import type { ObjectStore } from "./storage.ts";

export type ObjectRow = { id: string; key: string };

export const isDeleted = sql`${storedObjects.status} = 'deleted'`;

/**
 * Delete the blob first and only hard-delete its metadata row once the blob is
 * gone. A failed backend delete leaves the row for the next sweep, so a transient
 * storage error can never turn into a lost audit trail or an untracked blob.
 * Callers must claim the row (move it out of `pending`) before calling this, so
 * an in-flight upload can never activate a row whose blob is being removed.
 */
export async function discardObject(
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
    const deleted = await db
      .delete(storedObjects)
      .where(and(eq(storedObjects.id, row.id), stillEligible))
      .returning({ id: storedObjects.id });
    return deleted.length > 0;
  } catch {
    return false;
  }
}

/**
 * Shared claim-first orphan sweep for every stored_objects consumer (avatars,
 * attachments, ...). Claim stale pending rows in Postgres before touching any
 * blob, then discard the whole deleted set in one ordered pass so every row is
 * handled exactly once.
 */
export async function sweepOrphanObjects(
  db: PostgresJsDatabase,
  store: ObjectStore,
): Promise<number> {
  await db
    .update(storedObjects)
    .set({ status: "deleted", deletedAt: sql`now()` })
    .where(
      and(
        eq(storedObjects.status, "pending"),
        lt(storedObjects.createdAt, sql`statement_timestamp() - interval '15 minutes'`),
      ),
    );
  const rows = await db
    .select({ id: storedObjects.id, key: storedObjects.key })
    .from(storedObjects)
    .where(eq(storedObjects.status, "deleted"))
    .orderBy(storedObjects.id);
  let reclaimed = 0;
  for (const row of rows) {
    if (await discardObject(db, store, row, isDeleted)) reclaimed++;
  }
  return reclaimed;
}

/** One guarded background tick for the shared sweep; safe to call once at startup. */
export function startObjectSweeps(db: PostgresJsDatabase, store: ObjectStore, log: Logger): void {
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepOrphanObjects(db, store)
      .catch((error: unknown) => {
        log.warn("object storage orphan sweep failed", { error: String(error) });
      })
      .finally(() => {
        sweeping = false;
      });
  }, 60 * 1000);
  timer.unref();
}

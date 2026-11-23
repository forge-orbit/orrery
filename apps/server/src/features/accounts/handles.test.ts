import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { browserSessions, humans } from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

describe("human handles", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
    await migrate(database.sql, migrationsDir);
  }, 120_000);

  afterEach(async () => {
    // Raw SQL here clears tables directly so each test starts from an empty DB,
    // bypassing feature services that would themselves allocate handles.
    await database.sql`delete from browser_sessions`;
    await database.sql`delete from workspaces`;
    await database.sql`delete from humans`;
  });

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
  });

  const insertHuman = (email: string, handle?: string) =>
    database.db
      .insert(humans)
      .values({
        id: randomUUID(),
        email,
        passwordHash: "hash",
        ...(handle === undefined ? {} : { handle }),
      })
      .returning({ id: humans.id, handle: humans.handle });

  it("derives a lowercase handle from the email local part", async () => {
    const [row] = await insertHuman("alice.smith@example.com");
    expect(row?.handle).toBe("alice-smith");
  });

  it("appends -2, -3 on collision", async () => {
    expect((await insertHuman("alex@example.com"))[0]?.handle).toBe("alex");
    // This local part derives to "alex-2" and deliberately occupies the first suffix.
    expect((await insertHuman("alex.2@example.com"))[0]?.handle).toBe("alex-2");
    expect((await insertHuman("alex@other.example"))[0]?.handle).toBe("alex-3");
  });

  it("serializes concurrent inserts that derive the same handle", async () => {
    // Two separate connections race on the base "alex"; the advisory lock in
    // orrery_human_handle_for() must make one take "alex" and the other "alex-2".
    const rows = await Promise.all([insertHuman("alex@a.example"), insertHuman("alex@b.example")]);
    const handles = rows.map((row) => row[0]?.handle);
    expect(handles).toContain("alex");
    expect(handles).toContain("alex-2");
  });

  it("keeps an explicitly chosen handle and rejects a duplicate", async () => {
    await insertHuman("one@example.com", "custom-handle");
    const message = await rejectionMessage(insertHuman("two@example.com", "custom-handle"));
    expect(message).toMatch(/humans_handle_unique/);
  });

  it("rejects a handle outside the required format", async () => {
    const message = await rejectionMessage(insertHuman("one@example.com", "Bad_Handle"));
    expect(message).toMatch(/humans_handle_valid/);
  });

  it("derivation skips handles already held by other rows", async () => {
    const [first] = await insertHuman("sam@example.com");
    const [second] = await insertHuman("sam@other.example");
    expect(first?.handle).toBe("sam");
    expect(second?.handle).toBe("sam-2");
    // Raw SQL calls the migration's SQL function directly; Drizzle has no helper
    // for a scalar function call like this.
    const [next] = await Promise.resolve(database.sql<{ handle: string }[]>`
      select orrery_human_handle_for('sam@example.com') as handle
    `);
    expect(next?.handle).toBe("sam-3");
  });

  it("normalizes awkward local parts to a valid 2-39 character handle", async () => {
    expect((await insertHuman("a+tag@example.com"))[0]?.handle).toBe("a-tag");
    expect((await insertHuman("___@example.com"))[0]?.handle).toBe("user");
  });

  it("enforces NOT NULL and a case-insensitive unique index in Postgres", async () => {
    // Raw SQL reads pg_indexes / information_schema to assert the database
    // constraints themselves, not an ORM model of them.
    const [index] = await Promise.resolve(database.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = 'humans_handle_unique'
    `);
    expect(index?.indexdef).toContain("lower(handle)");
    const [column] = await Promise.resolve(database.sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_name = 'humans' and column_name = 'handle'
    `);
    expect(column?.is_nullable).toBe("NO");
  });

  it("rejects a 1-character handle with a 400 at the HTTP seam", async () => {
    const [human] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email: "profile@example.com", passwordHash: "hash" })
      .returning({ id: humans.id });
    if (human === undefined) throw new Error("failed to seed human");
    const token = randomUUID();
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: human.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const app = createApp({
      features: [
        createAccountsFeature({
          db: database.db,
          setupSecret: "handles-test-secret",
          publicUrl: "http://orrery.test",
        }),
      ],
      publicUrl: "http://orrery.test",
      log: createLogger("error"),
    });
    const res = await app.request("/api/account/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: `orrery_session=${token}` },
      body: JSON.stringify({ handle: "a" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });
});

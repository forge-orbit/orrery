import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../../platform/db.ts";
import { migrate } from "../../platform/migrate.ts";

const MIGRATIONS = new URL("../../../../../db/migrations", import.meta.url).pathname;

const isKeyMigration = (file: string) => /^003[234]_/.test(file);

describe("project key migration", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let staged: string;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    staged = await mkdtemp(join(tmpdir(), "orrery-key-migration-"));
    for (const file of await readdir(MIGRATIONS)) {
      if (!file.endsWith(".sql") || isKeyMigration(file) || file === "0059_fearless_skin.sql") {
        continue;
      }
      const body = await readFile(join(MIGRATIONS, file), "utf8");
      await writeFile(join(staged, file), body);
    }
    await migrate(database.sql, staged);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
    await rm(staged, { recursive: true, force: true });
  });

  it("derives valid, workspace-unique keys for every legacy project", async () => {
    const human = randomUUID();
    const otherHuman = randomUUID();
    await database.sql`insert into humans (id, email, password_hash) values (${human}, ${`legacy-${human}@example.com`}, 'scrypt$anything')`;
    await database.sql`insert into humans (id, email, password_hash) values (${otherHuman}, ${`legacy-${otherHuman}@example.com`}, 'scrypt$anything')`;
    const first = randomUUID();
    const second = randomUUID();
    await database.sql`insert into workspaces (id, kind, name, personal_owner_human_id) values (${first}, 'personal', ${`Legacy ${first}`}, ${human})`;
    await database.sql`insert into workspaces (id, kind, name, personal_owner_human_id) values (${second}, 'personal', ${`Legacy ${second}`}, ${otherHuman})`;

    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    await database.sql`insert into projects (id, workspace_id, name, created_by_human_id, created_at) values (${a}, ${first}, 'Alpha Beta', ${human}, now())`;
    await database.sql`insert into projects (id, workspace_id, name, created_by_human_id, created_at) values (${b}, ${first}, 'Alpha Beta', ${human}, now() + interval '1 second')`;
    await database.sql`insert into projects (id, workspace_id, name, created_by_human_id, created_at) values (${c}, ${second}, 'Alpha Beta', ${human}, now())`;

    const numeric = randomUUID();
    await database.sql`insert into projects (id, workspace_id, name, created_by_human_id, created_at) values (${numeric}, ${first}, '1234', ${human}, now() + interval '2 seconds')`;

    for (const file of await readdir(MIGRATIONS)) {
      if (!file.endsWith(".sql") || !isKeyMigration(file)) continue;
      const body = await readFile(join(MIGRATIONS, file), "utf8");
      await writeFile(join(staged, file), body);
    }
    await migrate(database.sql, staged);

    const rows = await database.sql<{ id: string; workspace_id: string; key: string }[]>`
      select id, workspace_id, key from projects
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    const inFirst = rows
      .filter((row) => row.workspace_id === first)
      .map((row) => row.key)
      .toSorted();
    expect(new Set(inFirst).size).toBe(3);
    expect(inFirst).toContain("AB");
    expect(inFirst).toContain("AB2");
    expect(rows.find((row) => row.id === c)?.key).toBe("AB");
    expect(rows.find((row) => row.id === numeric)?.key).toBe("PRJ");
  });
});

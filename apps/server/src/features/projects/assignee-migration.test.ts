import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../../platform/db.ts";
import { migrate } from "../../platform/migrate.ts";

const MIGRATIONS = new URL("../../../../../db/migrations", import.meta.url).pathname;

const isAssigneeMigration = (file: string) => file.startsWith("0064_");

async function stageUnless(staged: string, skip: (file: string) => boolean) {
  for (const file of await readdir(MIGRATIONS)) {
    if (!file.endsWith(".sql") || skip(file)) continue;
    await writeFile(join(staged, file), await readFile(join(MIGRATIONS, file), "utf8"));
  }
}

describe("human-only assignee migration", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let staged: string;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:18").start();
    database = createDb(pg.getConnectionUri());
    staged = await mkdtemp(join(tmpdir(), "orrery-assignee-migration-"));
    await stageUnless(staged, isAssigneeMigration);
    await migrate(database.sql, staged);
  }, 120_000);

  afterAll(async () => {
    await database?.sql.end();
    await pg?.stop();
    await rm(staged, { recursive: true, force: true });
  });

  it("maps human assignments to the human and agent assignments to agents.human_id", async () => {
    const humanId = randomUUID();
    const agentOwnerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await database.sql`insert into humans (id, email, password_hash) values (${humanId}, ${`legacy-${humanId}@example.com`}, 'scrypt$anything')`;
    await database.sql`insert into humans (id, email, password_hash) values (${agentOwnerId}, ${`owner-${agentOwnerId}@example.com`}, 'scrypt$anything')`;
    await database.sql`insert into workspaces (id, kind, name, personal_owner_human_id) values (${workspaceId}, 'personal', ${`Legacy ${workspaceId}`}, ${humanId})`;
    await database.sql`insert into projects (id, workspace_id, name, key, created_by_human_id) values (${projectId}, ${workspaceId}, 'Legacy', 'LEG', ${humanId})`;

    const agentId = randomUUID();
    await database.sql`insert into agents (id, human_id, name) values (${agentId}, ${agentOwnerId}, 'Legacy Builder')`;

    let nextNumber = 1;
    const insertIssue = async (assigneeType: string | null, assigneeId: string | null) => {
      const id = randomUUID();
      const number = nextNumber++;
      await database.sql`
        insert into issues (id, project_id, number, title, status, sort_order, created_by_human_id, updated_by_human_id, assignee_type, assignee_id)
        values (${id}, ${projectId}, ${number}, 'Legacy issue', 'todo', ${number * 65535}, ${humanId}, ${humanId}, ${assigneeType}, ${assigneeId})`;
      return id;
    };
    const humanIssue = await insertIssue("human", humanId);
    const agentIssue = await insertIssue("agent", agentId);
    const missingAgentIssue = await insertIssue("agent", randomUUID());
    const missingHumanIssue = await insertIssue("human", randomUUID());

    const activityId = randomUUID();
    await database.sql`
      insert into project_activity (id, project_id, type, actor_human_id, issue_id, summary, detail)
      values (${activityId}, ${projectId}, 'issue_edited', ${humanId}, ${humanIssue}, 'Legacy issue',
        ${JSON.stringify({
          kind: "issue_edited",
          changes: [
            {
              kind: "assignee",
              from: {
                agentId: randomUUID(),
                agentName: "Legacy Builder",
                displayName: "Legacy Builder",
                avatarUrl: null,
              },
              to: null,
            },
          ],
        })}::jsonb)`;

    await stageUnless(staged, (file) => !isAssigneeMigration(file));
    await migrate(database.sql, staged);

    const rows = await database.sql<{ id: string; assignee_human_id: string | null }[]>`
      select id, assignee_human_id from issues`;
    const byId = new Map(rows.map((row) => [row.id, row.assignee_human_id]));
    expect(byId.get(humanIssue)).toBe(humanId);
    expect(byId.get(agentIssue)).toBe(agentOwnerId);
    expect(byId.get(missingAgentIssue)).toBeNull();
    expect(byId.get(missingHumanIssue)).toBeNull();

    const columns = await database.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'issues' and column_name in ('assignee_type', 'assignee_id')`;
    expect(columns).toEqual([]);

    const [activity] = await database.sql<{ detail: unknown }[]>`
      select detail from project_activity where id = ${activityId}`;
    expect(activity?.detail).toMatchObject({
      changes: [{ kind: "assignee", from: { agentName: "Legacy Builder" }, to: null }],
    });
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  KnowledgeEntriesResponse,
  ProjectAccessLevel,
  WorkspaceKind,
  projectTools,
} from "@orrery/contract";
import type { AgentIdentity } from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  browserSessions,
  humans,
  knowledgeEntries,
  projectAccessGrants,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database, type DbTransaction } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import type { AttachmentSeams } from "../attachments/index.ts";
import { createProjectsFeature, type ProjectsService } from "./index.ts";
import { ProjectsError, type WorkActor } from "./service.ts";

const silentLogger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from humans`);
  });
});

type Fixture = {
  managerHumanId: string;
  contributorHumanId: string;
  readerHumanId: string;
  workspaceId: string;
  projectId: string;
};

async function seed(): Promise<Fixture> {
  const managerHumanId = randomUUID();
  const contributorHumanId = randomUUID();
  const readerHumanId = randomUUID();
  await database.db.insert(humans).values([
    { id: managerHumanId, email: `${managerHumanId}@example.com`, passwordHash: "x" },
    { id: contributorHumanId, email: `${contributorHumanId}@example.com`, passwordHash: "x" },
    { id: readerHumanId, email: `${readerHumanId}@example.com`, passwordHash: "x" },
  ]);
  const workspaceId = randomUUID();
  await database.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      kind: WorkspaceKind.enum.shared,
      name: "Team",
      personalOwnerHumanId: null,
    });
    await tx.insert(workspaceMemberships).values([
      { id: randomUUID(), workspaceId, humanId: managerHumanId, isOwner: true },
      { id: randomUUID(), workspaceId, humanId: contributorHumanId, isOwner: false },
      { id: randomUUID(), workspaceId, humanId: readerHumanId, isOwner: false },
    ]);
  });
  const projectId = randomUUID();
  await database.db.insert(projects).values({
    id: projectId,
    workspaceId,
    name: "Knowledge project",
    key: "KNW",
    createdByHumanId: managerHumanId,
  });
  await database.db.insert(projectAccessGrants).values([
    {
      id: randomUUID(),
      projectId,
      humanId: contributorHumanId,
      level: ProjectAccessLevel.enum.contribute,
      grantedByHumanId: managerHumanId,
    },
    {
      id: randomUUID(),
      projectId,
      humanId: readerHumanId,
      level: ProjectAccessLevel.enum.read,
      grantedByHumanId: managerHumanId,
    },
  ]);
  return { managerHumanId, contributorHumanId, readerHumanId, workspaceId, projectId };
}

function humanActor(humanId: string): WorkActor {
  return {
    kind: "human",
    account: {
      humanId,
      email: `${humanId}@example.com`,
      isSystemAdministrator: false,
      emailVerifiedAt: null,
    },
  };
}

function agentIdentity(f: Fixture): AgentIdentity {
  return {
    agentId: randomUUID(),
    name: "Worker",
    humanId: f.managerHumanId,
    keyId: randomUUID(),
    workspaceId: f.workspaceId,
    validity: "never",
    projects: [
      {
        projectId: f.projectId,
        projectName: "Knowledge project",
        level: ProjectAccessLevel.enum.manage,
      },
    ],
  };
}

function makeService(attachmentSeams?: AttachmentSeams) {
  return createProjectsFeature({
    db: database.db,
    sessionReader: async () => null,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
    issueSessionGate: async (_tx: DbTransaction, _issueId: string) => true,
    ...(attachmentSeams === undefined ? {} : { attachmentSeams }),
  }).service;
}

async function createEntry(service: ProjectsService, actor: WorkActor, f: Fixture) {
  return service.createKnowledge(actor, f.projectId, {
    title: "Runbook",
    body: "secret body",
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => (error instanceof ProjectsError ? error.kind : undefined),
  );
}

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

async function humanCookie(humanId: string): Promise<string> {
  const token = randomUUID();
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId,
    tokenHash: tokenHash(token),
    createdAt: sql`statement_timestamp()`,
    expiresAt: sql`statement_timestamp() + interval '1 hour'`,
  });
  return `orrery_session=${token}`;
}

describe("knowledge trash", () => {
  it("scrubs no knowledge delete or restore tool into the agent MCP surface", () => {
    const names = projectTools.map((tool) => tool.name);
    expect(names.some((name) => name.includes("delete_knowledge"))).toBe(false);
    expect(names.some((name) => name.includes("restore_knowledge"))).toBe(false);
    expect(names.some((name) => name.includes("knowledge_trash"))).toBe(false);
  });

  it("trashes only for human Contribute, records activity, and hides the entry", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.managerHumanId);
    const contributor = humanActor(f.contributorHumanId);
    const reader = humanActor(f.readerHumanId);
    const entry = await createEntry(service, manager, f);

    expect(await kindOf(service.deleteKnowledge(agentActor(f), entry.id))).toBe(
      "agents_cannot_delete_knowledge",
    );
    expect(await kindOf(service.deleteKnowledge(reader, entry.id))).toBe(
      "insufficient_project_access",
    );

    await service.deleteKnowledge(contributor, entry.id);
    const row = first(
      await database.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, entry.id)),
    );
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByHumanId).toBe(f.contributorHumanId);
    expect(row.purgedAt).toBeNull();

    expect(await service.listKnowledge(manager, f.projectId)).toHaveLength(0);
    expect(await kindOf(service.getKnowledge(manager, entry.id))).toBe("knowledge_entry_not_found");
    expect(await kindOf(service.deleteKnowledge(manager, entry.id))).toBe(
      "knowledge_entry_not_found",
    );
    expect(await kindOf(service.updateKnowledge(manager, entry.id, { title: "nope" }))).toBe(
      "knowledge_entry_not_found",
    );

    expect(await kindOf(service.listKnowledgeTrash(contributor, f.projectId))).toBe(
      "insufficient_project_access",
    );
    expect(await kindOf(service.listKnowledgeTrash(agentActor(f), f.projectId))).toBe(
      "insufficient_project_access",
    );
    expect(await service.listKnowledgeTrash(manager, f.projectId)).toHaveLength(1);

    const activity = await service.listActivity(manager, f.projectId);
    const deleted = activity.find((event) => event.type === "knowledge_deleted");
    expect(deleted).toMatchObject({
      knowledgeEntryId: entry.id,
      summary: "Runbook",
      actor: { humanId: f.contributorHumanId },
    });
  });

  it("restores only for human Manage, within 30 days, with activity", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.managerHumanId);
    const contributor = humanActor(f.contributorHumanId);
    const entry = await createEntry(service, manager, f);

    expect(await kindOf(service.restoreKnowledge(manager, entry.id))).toBe(
      "knowledge_entry_not_found",
    );
    await service.deleteKnowledge(manager, entry.id);

    expect(await kindOf(service.restoreKnowledge(agentActor(f), entry.id))).toBe(
      "insufficient_project_access",
    );
    expect(await kindOf(service.restoreKnowledge(contributor, entry.id))).toBe(
      "insufficient_project_access",
    );
    expect(await kindOf(service.restoreKnowledge(manager, "not-an-entry"))).toBe(
      "knowledge_entry_not_found",
    );

    const restored = await service.restoreKnowledge(manager, entry.id);
    expect(restored.id).toBe(entry.id);
    expect(restored.title).toBe("Runbook");
    const row = first(
      await database.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, entry.id)),
    );
    expect(row.deletedAt).toBeNull();
    expect(row.deletedByHumanId).toBeNull();
    expect(await service.listKnowledge(manager, f.projectId)).toHaveLength(1);
    expect(await service.listKnowledgeTrash(manager, f.projectId)).toHaveLength(0);
    expect((await service.listActivity(manager, f.projectId)).map((event) => event.type)).toContain(
      "knowledge_restored",
    );

    const stale = await createEntry(service, manager, f);
    await service.deleteKnowledge(manager, stale.id);
    await database.db.execute(
      sql`update knowledge_entries set deleted_at = statement_timestamp() - interval '31 days' where id = ${stale.id}`,
    );
    expect((await service.listKnowledgeTrash(manager, f.projectId)).map((e) => e.id)).not.toContain(
      stale.id,
    );
    expect(await kindOf(service.restoreKnowledge(manager, stale.id))).toBe(
      "knowledge_entry_purged",
    );
  });

  it("keeps attachment references while trashed and purges them with the entry", async () => {
    const f = await seed();
    const purged: { holderType: string; holderId: string }[] = [];
    const service = makeService({
      syncReferences: async () => {},
      listMetadata: async () => new Map(),
      purgeHolders: async (_tx, holders) => {
        purged.push(...holders);
      },
      purgeProjectAttachments: async () => {},
    });
    const manager = humanActor(f.managerHumanId);
    const entry = await createEntry(service, manager, f);

    await service.deleteKnowledge(manager, entry.id);
    expect(purged).toHaveLength(0);

    await service.restoreKnowledge(manager, entry.id);
    expect(purged).toHaveLength(0);

    await service.deleteKnowledge(manager, entry.id);
    await database.db.execute(
      sql`update knowledge_entries set deleted_at = statement_timestamp() - interval '31 days' where id = ${entry.id}`,
    );
    expect(await service.purgeExpiredTrash()).toBe(1);
    expect(purged).toEqual([{ holderType: "knowledge", holderId: entry.id }]);

    const row = first(
      await database.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, entry.id)),
    );
    expect(row.title).toBe("[deleted]");
    expect(row.body).toBe("");
    expect(row.purgedAt).not.toBeNull();
    expect(await service.listKnowledgeTrash(manager, f.projectId)).toHaveLength(0);
    expect(await kindOf(service.restoreKnowledge(manager, entry.id))).toBe(
      "knowledge_entry_purged",
    );
    expect(await service.purgeExpiredTrash()).toBe(0);
  });

  it("exposes REST trash routes with the right Problem codes", async () => {
    const f = await seed();
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: "s",
      publicUrl: "http://orrery.test",
    });
    const service = makeService();
    const identity = agentIdentity(f);
    const feature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async (request) =>
        request.headers.get("authorization")?.startsWith("Bearer ") === true ? identity : null,
      sessionGate: async () => true,
      issueSessionGate: async () => true,
    });
    const app = createApp({
      features: [accounts, feature],
      publicUrl: "http://orrery.test",
      log: silentLogger,
    });
    const manager = humanActor(f.managerHumanId);
    const entry = await createEntry(service, manager, f);

    const agentTrash = await app.request(`/api/projects/${f.projectId}/knowledge/trash`, {
      headers: { authorization: `Bearer agent-key` },
    });
    expect(agentTrash.status).toBe(403);
    expect(await agentTrash.json()).toMatchObject({ code: "insufficient_project_access" });

    const agentDelete = await app.request(`/api/knowledge/${entry.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer agent-key` },
    });
    expect(agentDelete.status).toBe(403);
    expect(await agentDelete.json()).toMatchObject({ code: "agents_cannot_delete_knowledge" });

    const agentRestore = await app.request(`/api/knowledge/${entry.id}/restore`, {
      method: "POST",
      headers: { authorization: `Bearer agent-key` },
    });
    expect(agentRestore.status).toBe(403);

    const cookie = await humanCookie(f.managerHumanId);

    const deleted = await app.request(`/api/knowledge/${entry.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);

    const hidden = await app.request(`/api/knowledge/${entry.id}`, { headers: { cookie } });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ code: "knowledge_entry_not_found" });

    const trash = await app.request(`/api/projects/${f.projectId}/knowledge/trash`, {
      headers: { cookie },
    });
    expect(trash.status).toBe(200);
    expect(KnowledgeEntriesResponse.parse(await trash.json())).toHaveLength(1);

    const restored = await app.request(`/api/knowledge/${entry.id}/restore`, {
      method: "POST",
      headers: { cookie },
    });
    expect(restored.status).toBe(200);

    const unknownRestore = await app.request(`/api/knowledge/${randomUUID()}/restore`, {
      method: "POST",
      headers: { cookie },
    });
    expect(unknownRestore.status).toBe(404);

    const purgedEntry = await createEntry(service, manager, f);
    await service.deleteKnowledge(manager, purgedEntry.id);
    await database.db.execute(
      sql`update knowledge_entries set deleted_at = statement_timestamp() - interval '31 days' where id = ${purgedEntry.id}`,
    );
    const gone = await app.request(`/api/knowledge/${purgedEntry.id}/restore`, {
      method: "POST",
      headers: { cookie },
    });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "knowledge_entry_purged" });
  });
});

function agentActor(f: Fixture): WorkActor {
  return { kind: "agent", identity: agentIdentity(f) };
}

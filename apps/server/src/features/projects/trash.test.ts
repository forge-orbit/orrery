import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  IssuesResponse,
  ProjectAccessLevel,
  ProjectLabel,
  WorkspaceKind,
  projectTools,
} from "@orrery/contract";
import type { AgentIdentity } from "@orrery/contract";
import { and, eq, gt, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  attachmentReferences,
  attachments,
  browserSessions,
  dispatchTokens,
  humans,
  issueComments,
  issueDependencies,
  issueLabels,
  issueLinks,
  issues,
  knowledgeEntries,
  notifications,
  projectAccessGrants,
  projectAccessEvents,
  projectActivity,
  projectLabels,
  projectTransferAuthorizations,
  projects,
  runnerDispatches,
  runnerHosts,
  runners,
  runs,
  storedObjects,
  webhookProjects,
  webhooks,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaceEvents,
  workspaces,
  workSessions,
} from "../../db/schema.ts";
import { createDb, type Database, type DbTransaction } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { sweepOrphanObjects } from "../../platform/object-sweep.ts";
import type { ObjectMeta, ObjectStore, StoredObject } from "../../platform/storage.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createAttachmentsFeature, type AttachmentSeams } from "../attachments/index.ts";
import { InboxError, createInboxFeature } from "../inbox/index.ts";
import { SessionsError, createSessionsFeature } from "../work-sessions/index.ts";
import { createProjectsFeature } from "./index.ts";
import {
  ProjectsError,
  projectAccessAtLeast,
  projectAccessCeilingInTransaction,
  type WorkActor,
} from "./service.ts";

const silentLogger = createLogger("error");

function objectMetadata(key: string, data: Uint8Array): ObjectMeta {
  return {
    key,
    byteSize: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function memoryObjectStore() {
  const blobs = new Map<string, Buffer>();
  const store: ObjectStore = {
    async put(key, data) {
      const bytes = Buffer.from(data);
      blobs.set(key, bytes);
      return objectMetadata(key, bytes);
    },
    async get(key): Promise<StoredObject | null> {
      const data = blobs.get(key);
      return data === undefined ? null : { data: Buffer.from(data) };
    },
    async head(key) {
      const data = blobs.get(key);
      return data === undefined ? null : objectMetadata(key, data);
    },
    async delete(key) {
      return blobs.delete(key);
    },
    async checkHealth() {
      return { ok: true };
    },
  };
  return { blobs, store };
}

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
    await tx.execute(sql`delete from notifications`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from webhook_projects`);
    await tx.execute(sql`delete from dispatch_tokens`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from work_session_activities`);
    await tx.execute(sql`delete from questions`);
    await tx.execute(sql`delete from runner_dispatches`);
    await tx.execute(sql`delete from project_transfer_authorizations`);
    await tx.execute(sql`update work_sessions set stream_object_id = null`);
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from runners`);
    await tx.execute(sql`delete from runner_hosts`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from attachment_references`);
    await tx.execute(sql`delete from attachments`);
    await tx.execute(sql`delete from stored_objects`);
    await tx.execute(sql`delete from issue_dependencies`);
    await tx.execute(sql`delete from issue_labels`);
    await tx.execute(sql`delete from issue_links`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from project_labels`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from webhooks`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from humans`);
  });
});

type Fixture = {
  humanId: string;
  workspaceId: string;
  projectId: string;
  otherHumanId: string;
};

async function seed(): Promise<Fixture> {
  const humanId = randomUUID();
  const otherHumanId = randomUUID();
  await database.db.insert(humans).values([
    { id: humanId, email: `${humanId}@example.com`, passwordHash: "x" },
    { id: otherHumanId, email: `${otherHumanId}@example.com`, passwordHash: "x" },
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
      { id: randomUUID(), workspaceId, humanId, isOwner: true },
      { id: randomUUID(), workspaceId, humanId: otherHumanId, isOwner: false },
    ]);
  });
  const projectId = randomUUID();
  await database.db.insert(projects).values({
    id: projectId,
    workspaceId,
    name: "Trash project",
    key: "TRH",
    createdByHumanId: humanId,
  });
  return { humanId, workspaceId, projectId, otherHumanId };
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

function agentActor(identity: AgentIdentity): WorkActor {
  return { kind: "agent", identity };
}

function sessionAccount(humanId: string) {
  return {
    humanId,
    email: `${humanId}@example.com`,
    isSystemAdministrator: false,
    emailVerifiedAt: null,
  };
}

function agentIdentity(f: Fixture, projectId = f.projectId): AgentIdentity {
  return {
    agentId: randomUUID(),
    name: "Worker",
    humanId: f.humanId,
    keyId: randomUUID(),
    workspaceId: f.workspaceId,
    validity: "never",
    projects: [{ projectId, projectName: "Trash project", level: ProjectAccessLevel.enum.manage }],
  };
}

async function liveSessionGate(tx: DbTransaction, issueId: string) {
  await tx
    .update(workSessions)
    .set({
      status: "expired",
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        sql`${workSessions.leaseExpiresAt} <= statement_timestamp()`,
      ),
    );
  const rows = await tx
    .select({ id: workSessions.id })
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function makeService(
  gate: (tx: DbTransaction, issueId: string) => Promise<boolean> = liveSessionGate,
  attachmentSeams?: AttachmentSeams,
) {
  return createProjectsFeature({
    db: database.db,
    sessionReader: async () => null,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,

    issueSessionGate: gate,
    ...(attachmentSeams === undefined ? {} : { attachmentSeams }),
  }).service;
}

async function createIssue(
  service: ReturnType<typeof makeService>,
  actor: WorkActor,
  projectId: string,
) {
  return service.createIssue(actor, projectId, { title: "Trash me", body: "secret body" });
}

async function insertLiveSession(f: Fixture, issueId: string, lease: "live" | "lapsed" = "live") {
  const agentId = randomUUID();
  const runId = randomUUID();
  const workSessionId = randomUUID();
  await database.db.insert(agents).values({
    id: agentId,
    humanId: f.humanId,
    name: `agent-${agentId}`,
  });
  await database.db.insert(runs).values({
    id: runId,
    agentId,
    workspaceId: f.workspaceId,
  });
  await database.db.insert(workSessions).values({
    id: workSessionId,
    agentId,
    runId,
    workspaceId: f.workspaceId,
    issueId,
    status: "active",
    leaseExpiresAt:
      lease === "live"
        ? sql`statement_timestamp() + interval '5 minutes'`
        : sql`statement_timestamp() - interval '1 minute'`,
  });
  return { agentId, runId, workSessionId };
}

function identityForAgent(f: Fixture, agentId: string): AgentIdentity {
  return {
    agentId,
    name: "Worker",
    humanId: f.humanId,
    keyId: randomUUID(),
    workspaceId: f.workspaceId,
    validity: "never",
    projects: [
      {
        projectId: f.projectId,
        projectName: "Trash project",
        level: ProjectAccessLevel.enum.contribute,
      },
    ],
  } satisfies AgentIdentity;
}

async function kindOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) =>
      error instanceof ProjectsError ||
      error instanceof SessionsError ||
      error instanceof InboxError
        ? error.kind
        : undefined,
  );
}

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

async function seedAgentIdentity(f: Fixture) {
  const agentId = randomUUID();
  const runId = randomUUID();
  const keyId = randomUUID();
  await database.db
    .insert(agents)
    .values({ id: agentId, humanId: f.humanId, name: `agent-${agentId}` });
  await database.db.insert(runs).values({ id: runId, agentId, workspaceId: f.workspaceId });
  await database.db.insert(agentApiKeys).values({
    id: keyId,
    agentId,
    workspaceId: f.workspaceId,
    createdByHumanId: f.humanId,
    validity: "never",
    tokenHash: tokenHash(randomUUID()),
    createdAt: sql`statement_timestamp()`,
  });
  return {
    agentId,
    name: "Worker",
    humanId: f.humanId,
    keyId,
    workspaceId: f.workspaceId,
    validity: "never" as const,
    projects: [
      {
        projectId: f.projectId,
        projectName: "Trash project",
        level: ProjectAccessLevel.enum.contribute,
      },
    ],
  } satisfies AgentIdentity;
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

describe("issue trash", () => {
  it("scrubs no tool for deleting or restoring issues into the agent MCP surface", () => {
    const names = projectTools.map((tool) => tool.name);
    expect(names.some((name) => name.includes("delete_issue"))).toBe(false);
    expect(names.some((name) => name.includes("restore_issue"))).toBe(false);
    expect(names.some((name) => name.includes("trash"))).toBe(false);
  });

  it("soft-deletes only from human Contribute, records activity, and hides the issue", async () => {
    const f = await seed();
    const service = makeService();
    const actor = humanActor(f.humanId);
    const issue = await createIssue(service, actor, f.projectId);

    expect(await kindOf(service.deleteIssue(agentActor(agentIdentity(f)), issue.id))).toBe(
      "agents_cannot_delete_issues",
    );

    await service.deleteIssue(actor, issue.id);
    const row = first(await database.db.select().from(issues).where(eq(issues.id, issue.id)));
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByHumanId).toBe(f.humanId);
    expect(row.purgedAt).toBeNull();

    expect(await service.listIssues(actor, f.projectId)).toHaveLength(0);
    expect(await kindOf(service.getIssue(actor, issue.id))).toBe("issue_not_found");
    expect(await kindOf(service.deleteIssue(actor, issue.id))).toBe("issue_not_found");

    const activity = await service.listActivity(actor, f.projectId);
    expect(activity.map((event) => event.type)).toContain("issue_deleted");
    expect(activity.find((event) => event.type === "issue_deleted")).toMatchObject({
      issueId: issue.id,
      actor: { humanId: f.humanId },
    });
    expect(await service.listTrash(actor, f.projectId)).toHaveLength(1);
  });

  it("rejects a live session, but materializes a lapsed lease first", async () => {
    const f = await seed();
    const service = makeService();
    const actor = humanActor(f.humanId);
    const issue = await createIssue(service, actor, f.projectId);

    await insertLiveSession(f, issue.id, "live");
    expect(await kindOf(service.deleteIssue(actor, issue.id))).toBe("issue_active_session_exists");
    expect(await service.listTrash(actor, f.projectId)).toHaveLength(0);

    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 minute' where issue_id = ${issue.id}`,
    );
    await service.deleteIssue(actor, issue.id);
    expect(await service.listTrash(actor, f.projectId)).toHaveLength(1);
    const session = first(
      await database.db.select().from(workSessions).where(eq(workSessions.issueId, issue.id)),
    );
    expect(session.status).toBe("expired");
  });

  it("restores only for human Manage, within 30 days, with activity", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.humanId);
    const contributor = humanActor(f.otherHumanId);
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: f.projectId,
      humanId: f.otherHumanId,
      level: ProjectAccessLevel.enum.contribute,
      grantedByHumanId: f.humanId,
    });
    const issue = await createIssue(service, manager, f.projectId);
    await service.deleteIssue(manager, issue.id);

    expect(await kindOf(service.restoreIssue(agentActor(agentIdentity(f)), issue.id))).toBe(
      "insufficient_project_access",
    );
    expect(await kindOf(service.restoreIssue(contributor, issue.id))).toBe(
      "insufficient_project_access",
    );
    expect(await kindOf(service.restoreIssue(manager, "not-an-issue"))).toBe("issue_not_found");

    const restored = await service.restoreIssue(manager, issue.id);
    expect(restored.id).toBe(issue.id);
    const row = first(await database.db.select().from(issues).where(eq(issues.id, issue.id)));
    expect(row.deletedAt).toBeNull();
    expect(row.deletedByHumanId).toBeNull();
    expect(await service.listIssues(manager, f.projectId)).toHaveLength(1);
    expect(await service.listTrash(manager, f.projectId)).toHaveLength(0);
    const activity = await service.listActivity(manager, f.projectId);
    expect(activity.map((event) => event.type)).toContain("issue_restored");
  });

  it("treats a soft-deleted blocker as satisfied in ready work and hides the trashed issue", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.humanId);
    const blocker = await createIssue(service, manager, f.projectId);
    const dependent = await service.createIssue(manager, f.projectId, { title: "Dependent" });
    await service.addBlockedBy(manager, dependent.id, { blockedByIssueId: blocker.id });

    const sessions = createSessionsFeature({
      db: database.db,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
        projectAccessCeilingInTransaction(tx, workspaceId, humanId, projectIds),
      projectAccessAtLeast,
      listIssues: (actor, projectId) => service.listIssues(actor, projectId),
      questionLeaseDeadline: async () => null,
      evaluateQuestionDeadline: async () => {},
      sessionReader: async () => null,
      authenticate: async () => null,
    }).service;
    expect((await sessions.readyWork(manager, f.projectId)).map((i) => i.id)).not.toContain(
      dependent.id,
    );

    await service.deleteIssue(manager, blocker.id);
    const ready = (await sessions.readyWork(manager, f.projectId)).map((i) => i.id);
    expect(ready).toContain(dependent.id);
    expect(ready).not.toContain(blocker.id);

    const row = first(
      await database.db
        .select({ number: issues.number })
        .from(issues)
        .where(eq(issues.id, blocker.id)),
    );
    expect(row.number).toBe(blocker.number);
  });

  it("scrubs a 30-day tombstone in place at the database-time boundary", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.humanId);
    const old = await createIssue(service, manager, f.projectId);
    const fresh = await service.createIssue(manager, f.projectId, { title: "Still fresh" });
    await service.createComment(manager, old.id, { body: "secret comment" });
    await service.addIssueLink(manager, old.id, {
      url: "https://example.com/secret",
      title: "secret link",
      kind: "doc",
    });
    await service.addBlockedBy(manager, fresh.id, { blockedByIssueId: old.id });

    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '29 days', deleted_by_human_id = ${f.humanId} where id = ${old.id}`,
    );
    expect(await service.purgeExpiredTrash()).toBe(0);
    expect((await service.restoreIssue(manager, old.id)).id).toBe(old.id);
    const liveChild = await service.createIssue(manager, f.projectId, {
      title: "Live child of a future tombstone",
      parentIssueId: old.id,
    });

    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days', deleted_by_human_id = ${f.humanId} where id = ${old.id}`,
    );
    await service.deleteIssue(manager, fresh.id);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '30 days' - interval '1 second' where id = ${fresh.id}`,
    );
    expect(await service.purgeExpiredTrash()).toBe(2);

    const tombstone = first(await database.db.select().from(issues).where(eq(issues.id, old.id)));
    expect(tombstone.title).toBe("[deleted]");
    expect(tombstone.body).toBe("");
    expect(tombstone.parentIssueId).toBeNull();
    expect(tombstone.assigneeType).toBeNull();
    expect(tombstone.assigneeId).toBeNull();
    expect(tombstone.purgedAt).not.toBeNull();
    expect(tombstone.number).toBe(old.number);
    const child = first(await database.db.select().from(issues).where(eq(issues.id, liveChild.id)));
    expect(child.parentIssueId).toBeNull();

    expect(
      await database.db.select().from(issueComments).where(eq(issueComments.issueId, old.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(issueLinks).where(eq(issueLinks.issueId, old.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(issueLabels).where(eq(issueLabels.issueId, old.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(issueDependencies)
        .where(eq(issueDependencies.blockedByIssueId, old.id)),
    ).toHaveLength(0);

    const activity = await service.listActivity(manager, f.projectId);
    expect(activity.some((event) => event.issueId === old.id)).toBe(true);
    expect(await kindOf(service.restoreIssue(manager, old.id))).toBe("issue_purged");
    expect(await service.listTrash(manager, f.projectId)).toHaveLength(0);
  });

  it("purges an expired project and releases its attachments and session stream blobs", async () => {
    const f = await seed();
    const manager = humanActor(f.humanId);
    const { blobs, store } = memoryObjectStore();
    const attached = createAttachmentsFeature({
      db: database.db,
      store,
      maxAttachmentBytes: 1024 * 1024,
      sessionReader: async () => null,
      authenticate: async () => null,
      projectAccessCeiling: async () => new Map(),
      projectAccessAtLeast,
      agentProjectAccess: async () => null,
      log: silentLogger,
    });
    const attachmentSeams: AttachmentSeams = {
      syncReferences: (tx, input) => attached.service.syncReferences(tx, input),
      listMetadata: (tx, holders) => attached.service.listMetadata(tx, holders),
      purgeHolders: (tx, holders) => attached.service.purgeHolders(tx, holders),
      purgeProjectAttachments: (tx, projectIds) =>
        attached.service.purgeProjectAttachments(tx, projectIds),
    };
    const service = makeService(liveSessionGate, attachmentSeams);
    const activeIssue = await createIssue(service, manager, f.projectId);
    const blocker = await createIssue(service, manager, f.projectId);
    const trashedIssue = await createIssue(service, manager, f.projectId);
    const activeEntry = await service.createKnowledge(manager, f.projectId, {
      title: "Current runbook",
      body: "active knowledge secret",
    });
    const trashedEntry = await service.createKnowledge(manager, f.projectId, {
      title: "Old runbook",
      body: "trashed knowledge secret",
    });
    const comment = await service.createComment(manager, trashedIssue.id, {
      body: "comment secret",
    });
    await service.addIssueLink(manager, activeIssue.id, {
      url: "https://example.com/private",
      title: "private link",
      kind: "doc",
    });
    await service.addBlockedBy(manager, activeIssue.id, { blockedByIssueId: blocker.id });
    await service.deleteIssue(manager, trashedIssue.id);
    await service.deleteKnowledge(manager, trashedEntry.id);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '45 days' where id = ${trashedIssue.id}`,
    );
    await database.db.execute(
      sql`update knowledge_entries set deleted_at = statement_timestamp() - interval '45 days' where id = ${trashedEntry.id}`,
    );

    const labelId = randomUUID();
    await database.db.insert(projectLabels).values({
      id: labelId,
      projectId: f.projectId,
      name: "secret label",
      color: "#123abc",
      createdByHumanId: f.humanId,
    });
    await database.db.insert(issueLabels).values({ issueId: activeIssue.id, labelId });

    const attachmentBlobs: { attachmentId: string; key: string; objectId: string }[] = [];
    const addAttachment = async (holder?: {
      holderType: "issue" | "comment" | "knowledge";
      holderId: string;
    }) => {
      const objectId = randomUUID();
      const key = `attachments/${f.projectId}/${objectId}.bin`;
      const bytes = Buffer.from(`secret attachment ${objectId}`);
      const blobMeta = await store.put(key, bytes, "application/octet-stream");
      await database.db.insert(storedObjects).values({
        id: objectId,
        key,
        status: "active",
        contentType: "application/octet-stream",
        byteSize: blobMeta.byteSize,
        sha256: blobMeta.sha256,
      });
      const attachmentId = randomUUID();
      await database.db.insert(attachments).values({
        id: attachmentId,
        projectId: f.projectId,
        objectId,
        filename: "private.bin",
        contentType: "application/octet-stream",
        byteSize: bytes.byteLength,
        uploadedByHumanId: f.humanId,
        unreferencedAt: null,
      });
      if (holder !== undefined) {
        await database.db.insert(attachmentReferences).values({
          id: randomUUID(),
          attachmentId,
          ...holder,
        });
      }
      attachmentBlobs.push({ attachmentId, key, objectId });
    };
    await addAttachment({ holderType: "issue", holderId: activeIssue.id });
    await addAttachment({ holderType: "comment", holderId: comment.id });
    await addAttachment({ holderType: "issue", holderId: trashedIssue.id });
    await addAttachment({ holderType: "knowledge", holderId: activeEntry.id });
    await addAttachment({ holderType: "knowledge", holderId: trashedEntry.id });
    await addAttachment();

    const agentId = randomUUID();
    await database.db.insert(agents).values({
      id: agentId,
      humanId: f.humanId,
      name: "Purge test agent",
    });
    const apiKeyId = randomUUID();
    await database.db.insert(agentApiKeys).values({
      id: apiKeyId,
      agentId,
      workspaceId: f.workspaceId,
      createdByHumanId: f.humanId,
      validity: "never",
      tokenHash: tokenHash(randomUUID()),
    });
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: apiKeyId,
      projectId: f.projectId,
      level: ProjectAccessLevel.enum.manage,
    });
    await database.db.insert(projectAccessGrants).values({
      id: randomUUID(),
      projectId: f.projectId,
      humanId: f.otherHumanId,
      level: ProjectAccessLevel.enum.read,
      grantedByHumanId: f.humanId,
    });

    const invitationId = randomUUID();
    await database.db.insert(workspaceInvitations).values({
      id: invitationId,
      workspaceId: f.workspaceId,
      email: `${randomUUID()}@example.com`,
      status: "pending",
      tokenHash: tokenHash(randomUUID()),
      invitedByHumanId: f.humanId,
      expiresAt: sql`statement_timestamp() + interval '1 day'`,
    });
    await database.db.insert(workspaceInvitationGrants).values({
      id: randomUUID(),
      invitationId,
      projectId: f.projectId,
      level: ProjectAccessLevel.enum.read,
    });

    const destinationWorkspaceId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({
        id: destinationWorkspaceId,
        kind: WorkspaceKind.enum.shared,
        name: "Destination",
        personalOwnerHumanId: null,
      });
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId: destinationWorkspaceId,
        humanId: f.humanId,
        isOwner: true,
      });
    });
    await database.db.insert(projectTransferAuthorizations).values({
      id: randomUUID(),
      projectId: f.projectId,
      sourceWorkspaceId: f.workspaceId,
      destinationWorkspaceId,
      authorizedByHumanId: f.humanId,
      tokenHash: tokenHash(randomUUID()),
      status: "pending",
      expiresAt: sql`statement_timestamp() + interval '1 day'`,
    });

    const webhookId = randomUUID();
    await database.db.insert(webhooks).values({
      id: webhookId,
      workspaceId: f.workspaceId,
      url: "https://example.com/hook",
      secretEncrypted: "test-secret",
      allProjects: false,
      allEvents: false,
      events: ["issue_created"],
      createdByHumanId: f.humanId,
      updatedByHumanId: f.humanId,
    });
    await database.db.insert(webhookProjects).values({ webhookId, projectId: f.projectId });

    const issueCreatedActivity = first(
      await database.db
        .select({ id: projectActivity.id })
        .from(projectActivity)
        .where(
          and(
            eq(projectActivity.issueId, activeIssue.id),
            eq(projectActivity.type, "issue_created"),
          ),
        ),
    );
    await database.db.insert(notifications).values({
      id: randomUUID(),
      humanId: f.otherHumanId,
      projectId: f.projectId,
      issueId: activeIssue.id,
      activityId: issueCreatedActivity.id,
      kind: "issue_mentioned",
      summary: "notification secret",
    });
    const accessEventId = randomUUID();
    await database.db.insert(projectAccessEvents).values({
      id: accessEventId,
      projectId: f.projectId,
      workspaceId: f.workspaceId,
      actorHumanId: f.humanId,
      subjectHumanId: f.otherHumanId,
      type: "project_access_granted",
      level: ProjectAccessLevel.enum.read,
      previousLevel: null,
    });

    const runnerHostId = randomUUID();
    await database.db.insert(runnerHosts).values({
      id: runnerHostId,
      humanId: f.humanId,
      displayName: "Purge runner host",
      platform: "linux",
      credentialHash: tokenHash(randomUUID()),
    });
    const runnerId = randomUUID();
    await database.db.insert(runners).values({
      id: runnerId,
      hostId: runnerHostId,
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      agentId,
      displayName: "Purge runner",
      repoFingerprint: tokenHash(randomUUID()),
    });
    const runId = randomUUID();
    await database.db.insert(runs).values({
      id: runId,
      agentId,
      workspaceId: f.workspaceId,
      status: "ended",
      endedAt: sql`statement_timestamp()`,
    });
    const streamObjectId = randomUUID();
    const streamKey = `work-sessions/${randomUUID()}/stream.jsonl`;
    const streamBytes = Buffer.from("private work session stream");
    const streamMeta = await store.put(streamKey, streamBytes, "application/jsonl");
    await database.db.insert(storedObjects).values({
      id: streamObjectId,
      key: streamKey,
      status: "active",
      contentType: "application/jsonl",
      byteSize: streamMeta.byteSize,
      sha256: streamMeta.sha256,
    });
    const workSessionId = randomUUID();
    await database.db.insert(workSessions).values({
      id: workSessionId,
      agentId,
      runId,
      workspaceId: f.workspaceId,
      issueId: activeIssue.id,
      status: "expired",
      leaseExpiresAt: sql`statement_timestamp() - interval '1 minute'`,
      endedAt: sql`statement_timestamp()`,
      streamObjectId,
    });
    const dispatchId = randomUUID();
    await database.db.insert(runnerDispatches).values({
      id: dispatchId,
      runnerId,
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      issueId: activeIssue.id,
      requestedByHumanId: f.humanId,
      agentId,
      dispatchAttemptId: randomUUID(),
      state: "ended",
      endedAt: sql`statement_timestamp()`,
    });
    await database.db.insert(dispatchTokens).values({
      id: randomUUID(),
      tokenHash: tokenHash(randomUUID()),
      runnerHostId,
      runnerId,
      dispatchId,
      dispatchAttemptId: randomUUID(),
      agentId,
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      issueId: activeIssue.id,
      runId,
      workSessionId,
    });

    await service.deleteProject(manager, f.projectId);
    await expect(
      service.createProject(sessionAccount(f.humanId), f.workspaceId, {
        name: "Conflicting key",
        key: "TRH",
      }),
    ).rejects.toMatchObject({ kind: "project_key_taken" });
    const auditActivityIds = (
      await database.db
        .select({ id: projectActivity.id })
        .from(projectActivity)
        .where(eq(projectActivity.projectId, f.projectId))
    ).map((event) => event.id);
    const workspaceAuditIds = (
      await database.db
        .select({ id: workspaceEvents.id })
        .from(workspaceEvents)
        .where(eq(workspaceEvents.workspaceId, f.workspaceId))
    ).map((event) => event.id);
    const originalTrashedIssue = first(
      await database.db.select().from(issues).where(eq(issues.id, trashedIssue.id)),
    );
    const originalTrashedEntry = first(
      await database.db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, trashedEntry.id)),
    );
    await database.db.execute(
      sql`update projects set deleted_at = statement_timestamp() - interval '31 days' where id = ${f.projectId}`,
    );
    expect(
      [...attachmentBlobs.map((blob) => blob.key), streamKey].every((key) => blobs.has(key)),
    ).toBe(true);

    expect(await service.purgeExpiredTrash()).toBe(6);

    const project = first(
      await database.db.select().from(projects).where(eq(projects.id, f.projectId)),
    );
    expect(project).toMatchObject({ name: "[deleted]", description: "" });
    expect(project.purgedAt).not.toBeNull();
    const purgedIssues = await database.db
      .select()
      .from(issues)
      .where(eq(issues.projectId, f.projectId));
    expect(purgedIssues).toHaveLength(3);
    for (const issue of purgedIssues) {
      expect(issue).toMatchObject({
        title: "[deleted]",
        body: "",
        parentIssueId: null,
        assigneeType: null,
        assigneeId: null,
      });
      expect(issue.purgedAt).not.toBeNull();
      expect(issue.deletedAt).not.toBeNull();
      expect(issue.deletedByHumanId).not.toBeNull();
    }
    const scrubbedTrashedIssue = first(
      purgedIssues.filter((issue) => issue.id === trashedIssue.id),
    );
    expect(scrubbedTrashedIssue.deletedAt).toEqual(originalTrashedIssue.deletedAt);
    expect(scrubbedTrashedIssue.deletedByHumanId).toBe(f.humanId);
    const purgedEntries = await database.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.projectId, f.projectId));
    expect(purgedEntries).toHaveLength(2);
    expect(purgedEntries.find((entry) => entry.id === activeEntry.id)).toMatchObject({
      title: "[deleted]",
      body: "",
      purgedAt: expect.any(Date),
      deletedByHumanId: f.humanId,
    });
    expect(purgedEntries.find((entry) => entry.id === trashedEntry.id)).toMatchObject({
      title: "[deleted]",
      body: "",
      purgedAt: expect.any(Date),
      deletedByHumanId: f.humanId,
    });
    const scrubbedTrashedEntry = first(
      await database.db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.id, trashedEntry.id)),
    );
    expect(scrubbedTrashedEntry.deletedAt).toEqual(originalTrashedEntry.deletedAt);
    expect(scrubbedTrashedEntry.deletedByHumanId).toBe(f.humanId);

    expect(
      await database.db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, trashedIssue.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(issueLinks).where(eq(issueLinks.issueId, activeIssue.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(issueLabels).where(eq(issueLabels.issueId, activeIssue.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(issueDependencies)
        .where(eq(issueDependencies.issueId, activeIssue.id)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(projectLabels)
        .where(eq(projectLabels.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(projectAccessGrants)
        .where(eq(projectAccessGrants.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(workspaceInvitationGrants)
        .where(eq(workspaceInvitationGrants.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(agentApiKeyProjects)
        .where(eq(agentApiKeyProjects.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(projectTransferAuthorizations)
        .where(eq(projectTransferAuthorizations.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(webhookProjects)
        .where(eq(webhookProjects.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(runners).where(eq(runners.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(runnerDispatches)
        .where(eq(runnerDispatches.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(dispatchTokens)
        .where(eq(dispatchTokens.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(notifications)
        .where(eq(notifications.projectId, f.projectId)),
    ).toHaveLength(0);
    expect(
      (
        await database.db
          .select({ id: projectActivity.id })
          .from(projectActivity)
          .where(eq(projectActivity.projectId, f.projectId))
      ).map((event) => event.id),
    ).toEqual(auditActivityIds);
    expect(
      (
        await database.db
          .select({ id: workspaceEvents.id })
          .from(workspaceEvents)
          .where(eq(workspaceEvents.workspaceId, f.workspaceId))
      ).map((event) => event.id),
    ).toEqual(workspaceAuditIds);
    expect(
      await database.db
        .select()
        .from(projectAccessEvents)
        .where(eq(projectAccessEvents.id, accessEventId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.holderId, activeIssue.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(attachments).where(eq(attachments.projectId, f.projectId)),
    ).toHaveLength(0);
    const streamSession = first(
      await database.db
        .select({ streamObjectId: workSessions.streamObjectId })
        .from(workSessions)
        .where(eq(workSessions.id, workSessionId)),
    );
    expect(streamSession.streamObjectId).toBeNull();
    const releasedObjects = await database.db
      .select({ id: storedObjects.id, status: storedObjects.status })
      .from(storedObjects);
    expect(releasedObjects).toHaveLength(attachmentBlobs.length + 1);
    expect(releasedObjects.every((object) => object.status === "deleted")).toBe(true);
    expect(await sweepOrphanObjects(database.db, store)).toBe(attachmentBlobs.length + 1);
    expect(
      [...attachmentBlobs.map((blob) => blob.key), streamKey].every((key) => !blobs.has(key)),
    ).toBe(true);
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);

    const replacement = await service.createProject(sessionAccount(f.humanId), f.workspaceId, {
      name: "Replacement project",
      key: "TRH",
    });
    expect(replacement.key).toBe("TRH");
  });

  it("keeps issue and knowledge purge timers independent from the project timer", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.humanId);
    const oldIssue = await createIssue(service, manager, f.projectId);
    const oldEntry = await service.createKnowledge(manager, f.projectId, {
      title: "Old knowledge",
      body: "old secret",
    });
    await service.deleteIssue(manager, oldIssue.id);
    await service.deleteKnowledge(manager, oldEntry.id);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days' where id = ${oldIssue.id}`,
    );
    await database.db.execute(
      sql`update knowledge_entries set deleted_at = statement_timestamp() - interval '31 days' where id = ${oldEntry.id}`,
    );
    await service.deleteProject(manager, f.projectId);
    await database.db.execute(
      sql`update projects set deleted_at = statement_timestamp() - interval '10 days' where id = ${f.projectId}`,
    );

    expect(await service.purgeExpiredTrash()).toBe(2);
    const withinProjectWindow = first(
      await database.db.select().from(projects).where(eq(projects.id, f.projectId)),
    );
    expect(withinProjectWindow.purgedAt).toBeNull();
    expect(
      first(await database.db.select().from(issues).where(eq(issues.id, oldIssue.id))).purgedAt,
    ).not.toBeNull();
    expect(
      first(
        await database.db
          .select()
          .from(knowledgeEntries)
          .where(eq(knowledgeEntries.id, oldEntry.id)),
      ).purgedAt,
    ).not.toBeNull();
    await expect(
      service.createProject(sessionAccount(f.humanId), f.workspaceId, {
        name: "Project still in Trash",
        key: "TRH",
      }),
    ).rejects.toMatchObject({ kind: "project_key_taken" });

    await database.db.execute(
      sql`update projects set deleted_at = statement_timestamp() - interval '31 days' where id = ${f.projectId}`,
    );
    expect(await service.purgeExpiredTrash()).toBe(1);
    expect(
      first(await database.db.select().from(projects).where(eq(projects.id, f.projectId))).purgedAt,
    ).not.toBeNull();
  });

  it("skips an expired project locked by another purge worker", async () => {
    const f = await seed();
    const otherProjectId = randomUUID();
    await database.db.insert(projects).values({
      id: otherProjectId,
      workspaceId: f.workspaceId,
      name: "Second project",
      key: "SEC",
      createdByHumanId: f.humanId,
    });
    const service = makeService();
    const manager = humanActor(f.humanId);
    await service.deleteProject(manager, f.projectId);
    await service.deleteProject(manager, otherProjectId);
    await database.db.execute(
      sql`update projects set deleted_at = statement_timestamp() - interval '31 days' where id in (${f.projectId}, ${otherProjectId})`,
    );
    const ordered = await database.db
      .select({ id: projects.id })
      .from(projects)
      .where(sql`${projects.id} in (${f.projectId}, ${otherProjectId})`)
      .orderBy(projects.id);
    const lockedProjectId = first(ordered).id;
    const skippedProjectId = ordered[1]?.id;
    if (skippedProjectId === undefined) throw new Error("the second project was not seeded");

    let purgePromise: Promise<number> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await database.db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, lockedProjectId))
          .for("update");
        purgePromise = service.purgeExpiredTrash();
        const result = await Promise.race([
          purgePromise.then((count) => ({ kind: "finished" as const, count })),
          new Promise<{ kind: "blocked" }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "blocked" }), 2_000);
          }),
        ]);
        expect(result).toEqual({ kind: "finished", count: 1 });
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await purgePromise?.catch(() => {});
    }

    expect(
      first(await database.db.select().from(projects).where(eq(projects.id, lockedProjectId)))
        .purgedAt,
    ).toBeNull();
    expect(
      first(await database.db.select().from(projects).where(eq(projects.id, skippedProjectId)))
        .purgedAt,
    ).not.toBeNull();
  });

  it("excludes trashed issues from the inbox, subtrees, and the trash window", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.humanId);
    const inbox = createInboxFeature({
      db: database.db,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
        projectAccessCeilingInTransaction(tx, workspaceId, humanId, projectIds),
      projectAccessAtLeast,
      deliver: async () => {},
      log: silentLogger,
      sessionReader: async () => null,
      authenticate: async () => null,
    }).service;

    const questionIssue = await createIssue(service, manager, f.projectId);
    const { agentId, runId } = await insertLiveSession(f, questionIssue.id);
    await database.db.execute(
      sql`update issues set status = 'in_progress' where id = ${questionIssue.id}`,
    );
    const question = await inbox.ask(
      { kind: "agent", identity: identityForAgent(f, agentId) },
      {
        issueId: questionIssue.id,
        runId,
        question: "Which way?",
        proposedFallback: "keep going",
      },
    );
    expect((await inbox.list(manager)).map((q) => q.id)).toContain(question.id);

    await database.db.execute(
      sql`update work_sessions set lease_expires_at = statement_timestamp() - interval '1 minute' where issue_id = ${questionIssue.id}`,
    );
    await service.deleteIssue(manager, questionIssue.id);
    expect((await inbox.list(manager)).map((q) => q.id)).not.toContain(question.id);
    expect(await kindOf(inbox.issueHistory(manager, questionIssue.id))).toBe("issue_not_found");
    expect(
      await kindOf(
        inbox.ask(
          { kind: "agent", identity: identityForAgent(f, agentId) },
          {
            issueId: questionIssue.id,
            runId,
            question: "Still there?",
            proposedFallback: "stop",
          },
        ),
      ),
    ).toBe("issue_not_found");

    const parent = await createIssue(service, manager, f.projectId);
    const child = await service.createIssue(manager, f.projectId, {
      title: "Child",
      parentIssueId: parent.id,
    });
    expect(child.parentIssueId).toBe(parent.id);
    await service.deleteIssue(manager, parent.id);
    expect(
      await kindOf(
        service.createIssue(manager, f.projectId, {
          title: "New child of trash",
          parentIssueId: parent.id,
        }),
      ),
    ).toBe("issue_not_found");
    expect(await kindOf(service.updateIssue(manager, child.id, { parentIssueId: parent.id }))).toBe(
      "issue_not_found",
    );

    const stale = await createIssue(service, manager, f.projectId);
    await service.deleteIssue(manager, stale.id);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days', deleted_by_human_id = ${f.humanId} where id = ${stale.id}`,
    );
    expect((await service.listTrash(manager, f.projectId)).map((i) => i.id)).not.toContain(
      stale.id,
    );
    expect(await kindOf(service.restoreIssue(manager, stale.id))).toBe("issue_purged");
  });

  it("refuses every write and every claim on a trashed issue", async () => {
    const f = await seed();
    const service = makeService();
    const manager = humanActor(f.humanId);
    const issue = await createIssue(service, manager, f.projectId);
    const other = await service.createIssue(manager, f.projectId, { title: "Other" });
    const label = await service.createLabel(manager, f.projectId, {
      name: "bug",
      color: "#ff0000",
    });
    const identity = await seedAgentIdentity(f);
    const sessions = createSessionsFeature({
      db: database.db,
      projectAccessCeiling: (tx, workspaceId, humanId, projectIds) =>
        projectAccessCeilingInTransaction(tx, workspaceId, humanId, projectIds),
      projectAccessAtLeast,
      listIssues: (actor, projectId) => service.listIssues(actor, projectId),
      questionLeaseDeadline: async () => null,
      evaluateQuestionDeadline: async () => {},
      sessionReader: async () => null,
      authenticate: async () => null,
    }).service;

    await service.deleteIssue(manager, issue.id);
    expect(await kindOf(service.updateIssue(manager, issue.id, { title: "nope" }))).toBe(
      "issue_not_found",
    );
    expect(await kindOf(service.createComment(manager, issue.id, { body: "nope" }))).toBe(
      "issue_not_found",
    );
    expect(
      await kindOf(
        service.addIssueLink(manager, issue.id, {
          url: "https://example.com",
          title: "nope",
          kind: "doc",
        }),
      ),
    ).toBe("issue_not_found");
    expect(
      await kindOf(service.addBlockedBy(manager, other.id, { blockedByIssueId: issue.id })),
    ).toBe("issue_not_found");
    expect(await kindOf(service.attachLabel(manager, issue.id, label.id))).toBe("issue_not_found");
    expect(
      await kindOf(
        service.setIssueFallbackPolicyOverride(sessionAccount(f.humanId), issue.id, {
          override: null,
        }),
      ),
    ).toBe("issue_not_found");
    const worker: Extract<WorkActor, { kind: "agent" }> = { kind: "agent", identity };
    expect(await kindOf(sessions.claim(worker, { issueId: issue.id, runId: "run" }))).toBe(
      "issue_not_found",
    );
    expect(await kindOf(sessions.reacquire(worker, { issueId: issue.id, runId: "run" }))).toBe(
      "issue_not_found",
    );
  });

  it("exposes REST trash routes with the right Problem codes", async () => {
    const f = await seed();
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: "s",
      publicUrl: "http://orrery.test",
    });
    const service = makeService();
    let identity = agentIdentity(f);
    const feature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async (request) =>
        request.headers.get("authorization")?.startsWith("Bearer ") === true ? identity : null,
      sessionGate: async () => true,
      issueSessionGate: liveSessionGate,
    });
    const app = createApp({
      features: [accounts, feature],
      publicUrl: "http://orrery.test",
      log: silentLogger,
    });
    const actor = humanActor(f.humanId);
    const issue = await createIssue(service, actor, f.projectId);

    const listed = await app.request(`/api/projects/${f.projectId}/trash`, {
      headers: { authorization: `Bearer agent-key` },
    });
    expect(listed.status).toBe(403);
    expect(await listed.json()).toMatchObject({ code: "insufficient_project_access" });

    const removed = await app.request(`/api/issues/${issue.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer agent-key` },
    });
    expect(removed.status).toBe(403);
    expect(await removed.json()).toMatchObject({ code: "agents_cannot_delete_issues" });

    const agentRestore = await app.request(`/api/issues/${issue.id}/restore`, {
      method: "POST",
      headers: { authorization: `Bearer agent-key` },
    });
    expect(agentRestore.status).toBe(403);

    const cookie = await humanCookie(f.humanId);

    const claimed = await service.createIssue(actor, f.projectId, { title: "Claimed" });
    await insertLiveSession(f, claimed.id, "live");
    const conflict = await app.request(`/api/issues/${claimed.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "issue_active_session_exists" });

    const deleted = await app.request(`/api/issues/${issue.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);
    const trash = await app.request(`/api/projects/${f.projectId}/trash`, {
      headers: { cookie },
    });
    expect(trash.status).toBe(200);
    expect(IssuesResponse.parse(await trash.json())).toHaveLength(1);

    const restored = await app.request(`/api/issues/${issue.id}/restore`, {
      method: "POST",
      headers: { cookie },
    });
    expect(restored.status).toBe(200);

    const purged = await service.createIssue(actor, f.projectId, { title: "Purged" });
    await service.deleteIssue(actor, purged.id);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days', deleted_by_human_id = ${f.humanId} where id = ${purged.id}`,
    );
    const gone = await app.request(`/api/issues/${purged.id}/restore`, {
      method: "POST",
      headers: { cookie },
    });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "issue_purged" });
  });

  it("does not register Project Trash operations as MCP tools", () => {
    const names = projectTools.map((tool) => tool.name);
    expect(names).not.toContain("delete_project");
    expect(names).not.toContain("restore_project");
    expect(names).not.toContain("list_project_trash");
  });

  it("restricts project Trash to shared Workspace owners and rejects agents", async () => {
    const f = await seed();
    const roleHumans = [
      { id: randomUUID(), name: "manager", level: ProjectAccessLevel.enum.manage },
      { id: randomUUID(), name: "contributor", level: ProjectAccessLevel.enum.contribute },
      { id: randomUUID(), name: "reader", level: ProjectAccessLevel.enum.read },
      { id: randomUUID(), name: "suspended", level: null },
      { id: randomUUID(), name: "non-member", level: null },
    ] as const;
    await database.db.insert(humans).values(
      roleHumans.map(({ id }) => ({
        id,
        email: `${id}@example.com`,
        passwordHash: "x",
      })),
    );
    await database.db.insert(workspaceMemberships).values(
      roleHumans.flatMap((role) =>
        role.name === "non-member"
          ? []
          : [
              {
                id: randomUUID(),
                workspaceId: f.workspaceId,
                humanId: role.id,
                isOwner: false,
                suspendedAt: role.name === "suspended" ? new Date() : null,
              },
            ],
      ),
    );
    await database.db.insert(projectAccessGrants).values(
      roleHumans.flatMap(({ id, level }) =>
        level === null
          ? []
          : [
              {
                id: randomUUID(),
                projectId: f.projectId,
                humanId: id,
                level,
                grantedByHumanId: f.humanId,
              },
            ],
      ),
    );

    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: "s",
      publicUrl: "http://orrery.test",
    });
    const identity = agentIdentity(f);
    const feature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async (request) =>
        request.headers.get("authorization") === "Bearer agent-key" ? identity : null,
      sessionGate: async () => true,
      issueSessionGate: liveSessionGate,
    });
    const app = createApp({
      features: [accounts, feature],
      publicUrl: "http://orrery.test",
      log: silentLogger,
    });

    const roles = [
      ...roleHumans.map((role) => ({
        humanId: role.id,
        status: role.name === "non-member" || role.name === "suspended" ? 404 : 403,
        code:
          role.name === "non-member" || role.name === "suspended"
            ? "project_not_found"
            : "workspace_owner_required",
        trashCode:
          role.name === "non-member" || role.name === "suspended"
            ? "workspace_not_found"
            : "workspace_owner_required",
      })),
      {
        humanId: f.otherHumanId,
        status: 403,
        code: "workspace_owner_required",
        trashCode: "workspace_owner_required",
      },
    ];
    for (const role of roles) {
      const cookie = await humanCookie(role.humanId);
      const removed = await app.request(`/api/projects/${f.projectId}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(removed.status).toBe(role.status);
      expect(await removed.json()).toMatchObject({ code: role.code });

      const restored = await app.request(`/api/projects/${f.projectId}/restore`, {
        method: "POST",
        headers: { cookie },
      });
      expect(restored.status).toBe(role.status);
      expect(await restored.json()).toMatchObject({ code: role.code });

      const missingId = randomUUID();
      const missingDelete = await app.request(`/api/projects/${missingId}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(missingDelete.status).toBe(404);
      expect(await missingDelete.json()).toMatchObject({ code: "project_not_found" });

      const missingRestore = await app.request(`/api/projects/${missingId}/restore`, {
        method: "POST",
        headers: { cookie },
      });
      expect(missingRestore.status).toBe(404);
      expect(await missingRestore.json()).toMatchObject({ code: "project_not_found" });

      const trash = await app.request(`/api/workspaces/${f.workspaceId}/trash/projects`, {
        headers: { cookie },
      });
      expect(trash.status).toBe(role.status);
      expect(await trash.json()).toMatchObject({ code: role.trashCode });
    }

    for (const request of [
      app.request(`/api/projects/${f.projectId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer agent-key" },
      }),
      app.request(`/api/projects/${f.projectId}/restore`, {
        method: "POST",
        headers: { authorization: "Bearer agent-key" },
      }),
      app.request(`/api/workspaces/${f.workspaceId}/trash/projects`, {
        headers: { authorization: "Bearer agent-key" },
      }),
    ]) {
      const rejected = await request;
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: "agents_cannot_delete_projects" });
    }

    const ownerCookie = await humanCookie(f.humanId);
    const removed = await app.request(`/api/projects/${f.projectId}`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(removed.status).toBe(204);
    const listed = await app.request(`/api/workspaces/${f.workspaceId}/trash/projects`, {
      headers: { cookie: ownerCookie },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject([{ id: f.projectId }]);
    const restored = await app.request(`/api/projects/${f.projectId}/restore`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(restored.status).toBe(200);
  });

  it("hides labels from update and delete after their project enters Trash", async () => {
    const f = await seed();
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: "s",
      publicUrl: "http://orrery.test",
    });
    const feature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async () => null,
      sessionGate: async () => true,
      issueSessionGate: liveSessionGate,
    });
    const app = createApp({
      features: [accounts, feature],
      publicUrl: "http://orrery.test",
      log: silentLogger,
    });
    const cookie = await humanCookie(f.humanId);
    const created = await app.request(`/api/projects/${f.projectId}/labels`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Sensitive", color: "#112233" }),
    });
    expect(created.status).toBe(201);
    const label = ProjectLabel.parse(await created.json());

    const trashed = await app.request(`/api/projects/${f.projectId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(trashed.status).toBe(204);

    const updated = await app.request(`/api/labels/${label.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Changed after Trash" }),
    });
    const removed = await app.request(`/api/labels/${label.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(updated.status).toBe(404);
    expect(removed.status).toBe(404);
  });

  it("blocks project Trash for live sessions and non-ended dispatches, then revokes offers", async () => {
    const f = await seed();
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: "s",
      publicUrl: "http://orrery.test",
    });
    const feature = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async () => null,
      sessionGate: async () => true,
      issueSessionGate: liveSessionGate,
    });
    const app = createApp({
      features: [accounts, feature],
      publicUrl: "http://orrery.test",
      log: silentLogger,
    });
    const service = makeService();
    const actor = humanActor(f.humanId);
    const cookie = await humanCookie(f.humanId);
    const sessionIssue = await createIssue(service, actor, f.projectId);
    await insertLiveSession(f, sessionIssue.id, "live");
    const sessionConflict = await app.request(`/api/projects/${f.projectId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(sessionConflict.status).toBe(409);
    expect(await sessionConflict.json()).toMatchObject({ code: "project_active_work_exists" });
    await database.db
      .update(workSessions)
      .set({
        status: "expired",
        endedAt: sql`statement_timestamp()`,
        updatedAt: sql`statement_timestamp()`,
      })
      .where(eq(workSessions.issueId, sessionIssue.id));

    const dispatchStates = ["pending", "active", "uncertain"] as const;
    for (const state of dispatchStates) {
      const issue = await createIssue(service, actor, f.projectId);
      const session = await insertLiveSession(f, issue.id, "lapsed");
      const hostId = randomUUID();
      const runnerId = randomUUID();
      const dispatchId = randomUUID();
      await database.db.insert(runnerHosts).values({
        id: hostId,
        humanId: f.humanId,
        displayName: `Host ${state}`,
        platform: "linux-x64",
        credentialHash: tokenHash(randomUUID()),
      });
      await database.db.insert(runners).values({
        id: runnerId,
        hostId,
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        agentId: session.agentId,
        displayName: `Runner ${state}`,
        repoFingerprint: "a".repeat(64),
      });
      await database.db.insert(runnerDispatches).values({
        id: dispatchId,
        runnerId,
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        issueId: issue.id,
        requestedByHumanId: f.humanId,
        agentId: session.agentId,
        dispatchAttemptId: randomUUID(),
        state,
        ...(state === "pending"
          ? {}
          : {
              runId: session.runId,
              workSessionId: session.workSessionId,
              acceptedAt: new Date(),
            }),
      });

      const conflict = await app.request(`/api/projects/${f.projectId}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: "project_active_work_exists" });
      await database.db.delete(runnerDispatches).where(eq(runnerDispatches.id, dispatchId));
    }

    const destinationWorkspaceId = randomUUID();
    await database.db.insert(workspaces).values({
      id: destinationWorkspaceId,
      kind: WorkspaceKind.enum.personal,
      name: "Destination",
      personalOwnerHumanId: f.otherHumanId,
    });
    const authorizationId = randomUUID();
    await database.db.insert(projectTransferAuthorizations).values({
      id: authorizationId,
      projectId: f.projectId,
      sourceWorkspaceId: f.workspaceId,
      destinationWorkspaceId,
      authorizedByHumanId: f.humanId,
      tokenHash: tokenHash(randomUUID()),
      status: "pending",
      expiresAt: sql`statement_timestamp() + interval '1 day'`,
    });

    const removed = await app.request(`/api/projects/${f.projectId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(removed.status).toBe(204);
    const [authorization] = await database.db
      .select()
      .from(projectTransferAuthorizations)
      .where(eq(projectTransferAuthorizations.id, authorizationId));
    expect(authorization).toMatchObject({ status: "revoked" });
    expect(authorization?.revokedAt).not.toBeNull();
  });
});

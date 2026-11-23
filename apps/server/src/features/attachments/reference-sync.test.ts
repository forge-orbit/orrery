import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { type ServerType, serve } from "@hono/node-server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Attachment,
  attachmentUrlFor,
  Issue,
  IssueComment,
  IssueDetail,
  IssueCommentsResponse,
  KnowledgeEntry,
  Problem,
  Project,
  type AgentIdentity,
} from "@orrery/contract";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  attachmentReferences,
  attachments,
  humans,
  issueComments,
  storedObjects,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database, type DbTransaction } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { sweepOrphanObjects } from "../../platform/object-sweep.ts";
import { createLocalObjectStore, type ObjectStore } from "../../platform/storage.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { agentProjectAccessInTransaction } from "../agents/index.ts";
import {
  attachmentHolderKey,
  createAttachmentsFeature,
  type AttachmentSeams,
  type AttachmentsFeature,
} from "../attachments/index.ts";
import { createProjectsFeature, type ProjectsFeature } from "../projects/index.ts";

const PUBLIC_URL = "http://127.0.0.1";
const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const silentLogger = createLogger("error");
const AGENT_KEY = "contribute-key";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename, { type }));
  return form;
}

describe("#179 attachment reference sync, metadata, grace sweep and Trash cleanup", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let dataDir: string;
  let store: ObjectStore;
  let app: Hono;
  let server: ServerType;
  let port: number;
  let adminCookie: string;
  let projectId: string;
  let workspaceId: string;
  let adminId: string;
  let identities: Record<string, AgentIdentity>;
  let wired: AttachmentSeams;
  let attached: AttachmentsFeature;
  let projects: ProjectsFeature;

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

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "orrery-reference-sync-"));
    store = createLocalObjectStore(dataDir);
    identities = {};
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    let real: AttachmentSeams | undefined;
    const seams: AttachmentSeams = {
      syncReferences: (tx, input) => {
        if (real === undefined) throw new Error("sync not wired");
        return real.syncReferences(tx, input);
      },
      listMetadata: (tx, holders) => {
        if (real === undefined) throw new Error("metadata not wired");
        return real.listMetadata(tx, holders);
      },
      purgeHolders: (tx, holders) => {
        if (real === undefined) throw new Error("purge not wired");
        return real.purgeHolders(tx, holders);
      },
    };
    const agentAuthenticator = async (request: Request): Promise<AgentIdentity | null> => {
      const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      return token === undefined ? null : (identities[token] ?? null);
    };
    projects = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator,
      sessionGate: async () => true,
      attachmentSeams: seams,
      log: silentLogger,
    });
    const agentProjectAccess = (
      tx: DbTransaction,
      identity: AgentIdentity,
      targetWorkspaceId: string,
      targetProjectId: string,
    ) =>
      agentProjectAccessInTransaction(
        tx,
        (t, wid, hid, pids) => projects.projectAccessCeiling(t, wid, hid, pids),
        (actual, required) =>
          ({ read: 1, contribute: 2, manage: 3 })[actual] >=
          { read: 1, contribute: 2, manage: 3 }[required],
        identity,
        targetWorkspaceId,
        targetProjectId,
      );
    attached = createAttachmentsFeature({
      db: database.db,
      store,
      maxAttachmentBytes: 1024 * 1024,
      sessionReader: accounts.sessionReader,
      authenticate: agentAuthenticator,
      projectAccessCeiling: (tx, targetWorkspaceId, humanId, projectIds) =>
        projects.projectAccessCeiling(tx, targetWorkspaceId, humanId, projectIds),
      projectAccessAtLeast: (actual, required) =>
        ({ read: 1, contribute: 2, manage: 3 })[actual] >=
        { read: 1, contribute: 2, manage: 3 }[required],
      agentProjectAccess,
      log: silentLogger,
    });
    real = {
      syncReferences: (tx, input) => attached.service.syncReferences(tx, input),
      listMetadata: (tx, holders) => attached.service.listMetadata(tx, holders),
      purgeHolders: (tx, holders) => attached.service.purgeHolders(tx, holders),
    };
    wired = real;
    app = createApp({
      features: [accounts, projects, attached],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    server = serve({ fetch: app.fetch, port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP address");
    port = address.port;

    const setup = await postJson("/api/setup/admin", {
      secret: SECRET,
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    if (setup.status !== 201) throw new Error("setup failed");
    const login = await postJson("/api/auth/login", { email: ADMIN_EMAIL, password: PASSWORD });
    adminCookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    adminId = admin?.id ?? "";
    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, adminId));
    workspaceId = personal?.id ?? "";
    const created = await postJson(
      `/api/workspaces/${workspaceId}/projects`,
      { name: "Reference project" },
      withCookie(),
    );
    if (created.status !== 201) throw new Error(`project creation failed: ${created.status}`);
    projectId = Project.parse(await created.json()).id;

    const agentId = randomUUID();
    await database.db.insert(agents).values({ id: agentId, humanId: adminId, name: "test-agent" });
    identities[AGENT_KEY] = {
      agentId,
      name: "contributor",
      humanId: adminId,
      keyId: randomUUID(),
      workspaceId,
      validity: "90",
      projects: [{ projectId, projectName: "Reference project", level: "contribute" }],
    };
    await database.db.insert(agentApiKeys).values({
      id: identities[AGENT_KEY].keyId,
      agentId,
      workspaceId,
      createdByHumanId: adminId,
      validity: "90",
      tokenHash: tokenHash(AGENT_KEY),
      expiresAt: sql`now() + interval '90 days'`,
    });
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: identities[AGENT_KEY].keyId,
      projectId,
      level: "contribute",
    });
  });

  afterEach(async () => {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from attachment_references`);
      await tx.execute(sql`delete from attachments`);
      await tx.execute(sql`delete from stored_objects`);
      await tx.execute(sql`delete from project_activity`);
      await tx.execute(sql`delete from issue_comments`);
      await tx.execute(sql`delete from issues`);
      await tx.execute(sql`delete from knowledge_entries`);
      await tx.execute(sql`delete from project_access_grants`);
      await tx.execute(sql`delete from agent_api_key_projects`);
      await tx.execute(sql`delete from projects`);
      await tx.execute(sql`delete from agent_api_keys`);
      await tx.execute(sql`delete from agents`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from humans`);
    });
  });

  function postJson(path: string, body: unknown, extra: Record<string, string> = {}) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  }

  const withCookie = () => ({ cookie: adminCookie });

  async function upload(filename: string, text: string): Promise<Attachment> {
    const response = await app.request(`/api/projects/${projectId}/attachments`, {
      method: "POST",
      headers: withCookie(),
      body: multipart(Buffer.from(text), filename, "text/plain"),
    });
    expect(response.status).toBe(201);
    return Attachment.parse(await response.json());
  }

  async function createIssue(body: string): Promise<{ id: string }> {
    const response = await postJson(
      `/api/projects/${projectId}/issues`,
      { title: "Issue", body },
      withCookie(),
    );
    expect(response.status).toBe(201);
    return Issue.parse(await response.json());
  }

  async function detail(issueId: string): Promise<IssueDetail> {
    const response = await app.request(`/api/issues/${issueId}`, { headers: withCookie() });
    expect(response.status).toBe(200);
    return IssueDetail.parse(await response.json());
  }

  async function comments(issueId: string): Promise<IssueCommentsResponse> {
    const response = await app.request(`/api/issues/${issueId}/comments`, {
      headers: withCookie(),
    });
    expect(response.status).toBe(200);
    return IssueCommentsResponse.parse(await response.json());
  }

  async function knowledge(body: string): Promise<KnowledgeEntry> {
    const response = await postJson(
      `/api/projects/${projectId}/knowledge`,
      { title: "Entry", body },
      withCookie(),
    );
    expect(response.status).toBe(201);
    return KnowledgeEntry.parse(await response.json());
  }

  async function mcpCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${AGENT_KEY}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const line = text
      .split("\n")
      .find((part) => part.startsWith("data: ") || part.trimStart().startsWith("{"));
    const payload = JSON.parse(line?.startsWith("data: ") ? line.slice(6) : (line ?? "{}"));
    if (payload.error !== undefined) throw new Error(JSON.stringify(payload.error));
    if (payload.result?.isError === true) throw new Error(JSON.stringify(payload.result));
    return z.record(z.string(), z.unknown()).parse(payload.result?.structuredContent ?? {});
  }

  it("syncs references on create and edit, deduplicates, and resets the grace timer", async () => {
    const file = await upload("notes.txt", "a note\n");
    const url = attachmentUrlFor(projectId, file.id);
    const issue = await createIssue(`See [one](${url}) and [twice](${url}).`);

    const refs = await database.db
      .select()
      .from(attachmentReferences)
      .where(eq(attachmentReferences.attachmentId, file.id));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ holderType: "issue", holderId: issue.id });
    const [bound] = await database.db
      .select({ unreferencedAt: attachments.unreferencedAt })
      .from(attachments)
      .where(eq(attachments.id, file.id));
    expect(bound?.unreferencedAt).toBeNull();

    const expected = [
      {
        id: file.id,
        filename: file.filename,
        contentType: "text/plain",
        byteSize: file.byteSize,
        downloadUrl: url,
      },
    ];
    expect((await detail(issue.id)).attachments).toEqual(expected);
    const viaMcp = await mcpCall("get_issue", { issueId: issue.id });
    expect(viaMcp.issue).toMatchObject({ attachments: expected });

    const removed = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...withCookie() },
      body: JSON.stringify({ body: "The link is gone." }),
    });
    expect(removed.status).toBe(200);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, file.id)),
    ).toHaveLength(0);
    const [released] = await database.db
      .select({ unreferencedAt: attachments.unreferencedAt })
      .from(attachments)
      .where(eq(attachments.id, file.id));
    expect(released?.unreferencedAt).not.toBeNull();
    expect((await detail(issue.id)).attachments).toEqual([]);

    // Dead, reclaimed and cross-project URLs are inert text, never a save error.
    const deadUrl = attachmentUrlFor(projectId, randomUUID());
    const crossUrl = attachmentUrlFor(randomUUID(), file.id);
    const stale = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...withCookie() },
      body: JSON.stringify({
        body: `![gone](${deadUrl}) [cross](${crossUrl}) https://elsewhere/x.png`,
      }),
    });
    expect(stale.status).toBe(200);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, file.id)),
    ).toHaveLength(0);
    expect((await detail(issue.id)).body).toContain(deadUrl);
  });

  it("returns attachment metadata for comments and knowledge over REST and MCP", async () => {
    const file = await upload("build.log", "build output\n");
    const url = attachmentUrlFor(projectId, file.id);
    const issue = await createIssue("A discussion");
    const commentResponse = await postJson(
      `/api/issues/${issue.id}/comments`,
      { body: `Here is [the log](${url})` },
      withCookie(),
    );
    expect(commentResponse.status).toBe(201);
    const createdComment = IssueComment.parse(await commentResponse.json());
    const expected = [
      {
        id: file.id,
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.byteSize,
        downloadUrl: url,
      },
    ];
    const listed = await comments(issue.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.attachments).toEqual(expected);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, file.id)),
    ).toHaveLength(1);
    const viaMcp = await mcpCall("list_comments", { issueId: issue.id });
    expect(viaMcp.comments).toMatchObject([{ attachments: expected }]);

    const entry = await knowledge(`Documentation [log](${url})`);
    expect(entry.attachments).toEqual(expected);
    const noop = await app.request(`/api/knowledge/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...withCookie() },
      body: JSON.stringify({ title: entry.title, body: entry.body }),
    });
    expect(noop.status).toBe(200);
    expect(KnowledgeEntry.parse(await noop.json()).attachments).toEqual(expected);
    const fetched = await app.request(`/api/knowledge/${entry.id}`, { headers: withCookie() });
    expect(KnowledgeEntry.parse(await fetched.json()).attachments).toEqual(expected);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, file.id)),
    ).toHaveLength(2);
    const knowledgeViaMcp = await mcpCall("get_knowledge", { entryId: entry.id });
    expect(knowledgeViaMcp.entry).toMatchObject({ attachments: expected });
    expect(attachmentHolderKey("comment", createdComment.id)).toBe(`comment:${createdComment.id}`);

    // Editing a knowledge entry that was the sole holder drops the last
    // reference and starts a fresh 24-hour grace window.
    const solo = await upload("solo.txt", "only in knowledge\n");
    const soloUrl = attachmentUrlFor(projectId, solo.id);
    const soloEntry = await knowledge(`[solo](${soloUrl})`);
    expect(soloEntry.attachments).toHaveLength(1);
    const soloPatch = await app.request(`/api/knowledge/${soloEntry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...withCookie() },
      body: JSON.stringify({ body: "The link was removed." }),
    });
    expect(soloPatch.status).toBe(200);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, solo.id)),
    ).toHaveLength(0);
    const [released] = await database.db
      .select({ unreferencedAt: attachments.unreferencedAt })
      .from(attachments)
      .where(eq(attachments.id, solo.id));
    expect(released?.unreferencedAt).not.toBeNull();
  });

  it("keeps unreferenced attachments for 24 hours then reclaims blob and row atomically", async () => {
    const file = await upload("draft.txt", "unattached draft\n");
    expect(await attached.service.sweepUnreferenced()).toBe(0);
    const [fresh] = await database.db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(fresh?.unreferencedAt).not.toBeNull();

    await database.db
      .update(attachments)
      .set({ unreferencedAt: sql`statement_timestamp() - interval '25 hours'` })
      .where(eq(attachments.id, file.id));
    expect(await attached.service.sweepUnreferenced()).toBe(1);
    expect(
      await database.db.select().from(attachments).where(eq(attachments.id, file.id)),
    ).toHaveLength(0);
    const [claimed] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.id, file.id));
    expect(claimed).toMatchObject({ status: "deleted" });
    expect(claimed?.deletedAt).not.toBeNull();
    expect(await store.head(claimed?.key ?? "")).not.toBeNull();

    // The shared sweep can now remove the blob and its metadata row with no FK error.
    expect(await sweepOrphanObjects(database.db, store)).toBe(1);
    expect(await store.head(claimed?.key ?? "")).toBeNull();
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
  });

  it("lets a late save win over the 24-hour sweep, and rejects a reclaimed URL cleanly", async () => {
    const saved = await upload("late.txt", "saved just in time\n");
    const savedUrl = attachmentUrlFor(projectId, saved.id);
    await database.db
      .update(attachments)
      .set({ unreferencedAt: sql`statement_timestamp() - interval '25 hours'` })
      .where(eq(attachments.id, saved.id));

    const entered = deferred();
    const release = deferred();
    const realSync = wired.syncReferences;
    wired.syncReferences = async (tx, input) => {
      const result = await realSync(tx, input);
      entered.resolve();
      await release.promise;
      return result;
    };
    const save = createIssue(`[late](${savedUrl})`);
    await entered.promise;
    const sweep = attached.service.sweepUnreferenced();
    release.resolve();
    await save;
    expect(await sweep).toBe(0);

    const [bound] = await database.db
      .select({ unreferencedAt: attachments.unreferencedAt })
      .from(attachments)
      .where(eq(attachments.id, saved.id));
    expect(bound?.unreferencedAt).toBeNull();
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, saved.id)),
    ).toHaveLength(1);

    const reclaimed = await upload("gone.txt", "reclaimed before save\n");
    const reclaimedUrl = attachmentUrlFor(projectId, reclaimed.id);
    await database.db
      .update(attachments)
      .set({ unreferencedAt: sql`statement_timestamp() - interval '25 hours'` })
      .where(eq(attachments.id, reclaimed.id));
    expect(await attached.service.sweepUnreferenced()).toBe(1);
    const staleIssue = await createIssue(`[gone](${reclaimedUrl})`);
    expect((await detail(staleIssue.id)).attachments).toEqual([]);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, reclaimed.id)),
    ).toHaveLength(0);
    const response = await app.request(`/api/projects/${projectId}/attachments/${reclaimed.id}`, {
      headers: withCookie(),
    });
    expect(response.status).toBe(404);
    expect(Problem.parse(await response.json()).code).toBe("attachment_not_found");
  });

  it("preserves attachments across Trash and purge only the expired issue's orphaned files", async () => {
    const onlyTrashed = await upload("only-trashed.txt", "only in the tombstone\n");
    const shared = await upload("shared.txt", "also used by a live issue\n");
    const onlyUrl = attachmentUrlFor(projectId, onlyTrashed.id);
    const sharedUrl = attachmentUrlFor(projectId, shared.id);
    const trashed = await createIssue(`[only](${onlyUrl}) [shared](${sharedUrl})`);
    const commentResponse = await postJson(
      `/api/issues/${trashed.id}/comments`,
      { body: `from a comment [shared](${sharedUrl})` },
      withCookie(),
    );
    expect(commentResponse.status).toBe(201);
    const commentId = IssueComment.parse(await commentResponse.json()).id;
    const live = await createIssue(`[shared](${sharedUrl})`);

    const trash = await app.request(`/api/issues/${trashed.id}`, {
      method: "DELETE",
      headers: withCookie(),
    });
    expect(trash.status).toBe(204);
    expect(await database.db.select().from(attachments)).toHaveLength(2);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.holderType, "issue")),
    ).toHaveLength(3);
    const restore = await postJson(`/api/issues/${trashed.id}/restore`, {}, withCookie());
    expect(restore.status).toBe(200);
    expect((await detail(trashed.id)).attachments).toHaveLength(2);

    const trashAgain = await app.request(`/api/issues/${trashed.id}`, {
      method: "DELETE",
      headers: withCookie(),
    });
    expect(trashAgain.status).toBe(204);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days' where id = ${trashed.id}`,
    );
    expect(await projects.service.purgeExpiredTrash()).toBe(1);

    expect(
      await database.db.select().from(issueComments).where(eq(issueComments.issueId, trashed.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(attachments).where(eq(attachments.id, shared.id)),
    ).toHaveLength(1);
    expect(
      await database.db.select().from(attachments).where(eq(attachments.id, onlyTrashed.id)),
    ).toHaveLength(0);
    const surviving = await database.db
      .select()
      .from(attachmentReferences)
      .where(eq(attachmentReferences.attachmentId, shared.id));
    expect(surviving).toHaveLength(1);
    expect(surviving[0]).toMatchObject({ holderType: "issue", holderId: live.id });
    const commentRefs = await database.db
      .select()
      .from(attachmentReferences)
      .where(eq(attachmentReferences.holderId, commentId));
    expect(commentRefs).toHaveLength(0);
    const [reclaimed] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.id, onlyTrashed.id));
    expect(reclaimed).toMatchObject({ status: "deleted" });
    expect(await sweepOrphanObjects(database.db, store)).toBe(1);
    expect(await store.head(reclaimed?.key ?? "")).toBeNull();
    expect((await detail(live.id)).attachments).toHaveLength(1);
  });
});

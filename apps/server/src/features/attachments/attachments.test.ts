import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Attachment, Problem, Project, type AgentIdentity } from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  attachmentReferences,
  attachments,
  browserSessions,
  humans,
  storedObjects,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { sweepOrphanObjects } from "../../platform/object-sweep.ts";
import { createLocalObjectStore, type ObjectStore } from "../../platform/storage.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createAttachmentsFeature } from "./index.ts";

const PUBLIC_URL = "http://orrery.test";
const SECRET = "correct horse battery staple staple";
const ADMIN_EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const silentLogger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown, cookie = "") =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

async function jpegWithExif() {
  const base = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 30, g: 90, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  const payload = Buffer.from("Exif\0\0GPS-latitude-secret-51.5", "utf8");
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  return Buffer.concat([base.subarray(0, 2), segment, base.subarray(2)]);
}

function multipart(bytes: Uint8Array, filename: string, type: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], filename, { type }));
  return form;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("project-scoped attachments", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let dataDir: string;
  let store: ObjectStore;
  let app: Hono;
  let adminCookie: string;
  let projectId: string;
  let workspaceId: string;
  let adminId: string;
  let identities: Record<string, AgentIdentity>;

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
    dataDir = await mkdtemp(join(tmpdir(), "orrery-attachments-"));
    store = createLocalObjectStore(dataDir);
    identities = {};
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    const projects = createProjectsFeature({
      db: database.db,
      sessionReader: accounts.sessionReader,
      agentAuthenticator: async (request) => {
        const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        return token === undefined ? null : (identities[token] ?? null);
      },
      sessionGate: async () => true,
    });
    const attachmentsFeature = createAttachmentsFeature({
      db: database.db,
      store,
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      sessionReader: accounts.sessionReader,
      authenticate: async (request) => {
        const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        return token === undefined ? null : (identities[token] ?? null);
      },
      projectAccessCeiling: (tx, targetWorkspaceId, humanId, projectIds) =>
        projects.projectAccessCeiling(tx, targetWorkspaceId, humanId, projectIds),
      projectAccessAtLeast: (actual, required) =>
        ({ read: 1, contribute: 2, manage: 3 })[actual] >=
        { read: 1, contribute: 2, manage: 3 }[required],
    });
    app = createApp({
      features: [accounts, projects, attachmentsFeature],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });

    const setup = await postJson(app, "/api/setup/admin", {
      secret: SECRET,
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    if (setup.status !== 201) throw new Error("setup failed");
    const login = await postJson(app, "/api/auth/login", {
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    adminCookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, ADMIN_EMAIL));
    adminId = admin?.id ?? "";
    const [personalWorkspace] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, adminId));
    workspaceId = personalWorkspace?.id ?? "";

    const created = await postJson(
      app,
      `/api/workspaces/${workspaceId}/projects`,
      { name: "Launch" },
      adminCookie,
    );
    if (created.status !== 201) throw new Error(`project creation failed: ${created.status}`);
    projectId = Project.parse(await created.json()).id;

    const agentId = randomUUID();
    await database.db.insert(agents).values({ id: agentId, humanId: adminId, name: "test-agent" });
    identities["contribute-key"] = {
      agentId,
      name: "contributor",
      humanId: adminId,
      keyId: randomUUID(),
      workspaceId,
      validity: "90",
      projects: [{ projectId, projectName: "Launch", level: "contribute" }],
    };
    identities["read-key"] = {
      ...identities["contribute-key"],
      projects: [{ projectId, projectName: "Launch", level: "read" }],
    };
  });

  afterEach(async () => {
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

  const upload = (
    form: FormData,
    options: { cookie?: string; token?: string; project?: string } = {},
  ) =>
    app.request(`/api/projects/${options.project ?? projectId}/attachments`, {
      method: "POST",
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: form,
    });

  const download = (
    id: string,
    options: { cookie?: string; token?: string; project?: string } = {},
  ) =>
    app.request(`/api/projects/${options.project ?? projectId}/attachments/${id}`, {
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });

  it("uploads an image claim-first, strips its EXIF, and serves it inline", async () => {
    const original = await jpegWithExif();
    const response = await upload(multipart(original, "screenshot.jpg", "image/jpeg"), {
      cookie: adminCookie,
    });
    expect(response.status).toBe(201);
    const metadata = Attachment.parse(await response.json());
    expect(metadata).toMatchObject({
      projectId,
      filename: "screenshot.jpg",
      contentType: "image/jpeg",
      byteSize: expect.any(Number),
      inline: true,
      downloadUrl: `/api/projects/${projectId}/attachments/${metadata.id}`,
    });

    const [object] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.id, metadata.id));
    expect(object?.status).toBe("active");
    const [row] = await database.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, metadata.id));
    expect(row?.unreferencedAt).toBeInstanceOf(Date);
    expect(row?.uploadedByHumanId).toBe(adminId);
    expect(row?.uploadedByAgentId).toBeNull();

    const blob = await store.get(object!.key);
    const stripped = await sharp(blob?.data ?? Buffer.alloc(0)).metadata();
    expect(stripped.exif).toBeUndefined();
    expect(blob?.data.equals(original)).toBe(false);

    const served = await download(metadata.id, { cookie: adminCookie });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("content-disposition")).toContain("inline");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer()).equals(blob!.data)).toBe(true);
  });

  it("lets an agent with Contribute upload and an agent with Read only download", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const uploaded = await upload(multipart(png, "tiny.png", "image/png"), {
      token: "contribute-key",
    });
    expect(uploaded.status).toBe(201);
    const metadata = Attachment.parse(await uploaded.json());

    const denied = await upload(multipart(png, "tiny.png", "image/png"), { token: "read-key" });
    expect(denied.status).toBe(403);
    expect(Problem.parse(await denied.json()).code).toBe("insufficient_project_access");

    const anonymous = await upload(multipart(png, "tiny.png", "image/png"));
    expect(anonymous.status).toBe(401);

    expect((await download(metadata.id, { token: "read-key" })).status).toBe(200);
    expect((await download(metadata.id, { token: "contribute-key" })).status).toBe(200);
  });

  it("refuses cross-project, unrelated, and unauthenticated downloads", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const uploaded = await upload(multipart(png, "tiny.png", "image/png"), { cookie: adminCookie });
    const metadata = Attachment.parse(await uploaded.json());
    const otherProject = randomUUID();

    expect(
      (await download(metadata.id, { project: otherProject, cookie: adminCookie })).status,
    ).toBe(404);
    expect((await download(metadata.id)).status).toBe(401);

    const [outsider] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email: "outsider@example.com", passwordHash: "scrypt$test" })
      .returning();
    const token = randomBytes(32).toString("base64url");
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: outsider!.id,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 hour'`,
    });
    const outsiderResponse = await download(metadata.id, { cookie: `orrery_session=${token}` });
    expect(outsiderResponse.status).toBe(404);
  });

  it("rejects unsupported bytes and oversized payloads with Problem Details", async () => {
    const notPng = Buffer.from("this is definitely not a PNG image");
    const badMagic = await upload(multipart(notPng, "fake.png", "image/png"), {
      cookie: adminCookie,
    });
    expect(badMagic.status).toBe(415);
    expect(Problem.parse(await badMagic.json()).code).toBe("unsupported_file_type");

    const unknown = await upload(multipart(Buffer.from("data"), "movie.mp4", "video/mp4"), {
      cookie: adminCookie,
    });
    expect(unknown.status).toBe(415);

    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x89);
    big.set(Buffer.from([0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 1);
    const oversized = await upload(multipart(big, "huge.png", "image/png"), {
      cookie: adminCookie,
    });
    expect(oversized.status).toBe(413);
    expect(Problem.parse(await oversized.json()).code).toBe("payload_too_large");
  });

  it("forces downloads for SVG and keeps GIF bytes untouched", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const svgUpload = await upload(multipart(svg, "icon.svg", "image/svg+xml"), {
      cookie: adminCookie,
    });
    expect(svgUpload.status).toBe(201);
    const svgMeta = Attachment.parse(await svgUpload.json());
    const served = await download(svgMeta.id, { cookie: adminCookie });
    expect(served.headers.get("content-disposition")).toContain("attachment");
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");

    const gifBytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 200, g: 10, b: 30, alpha: 1 } },
    })
      .gif()
      .toBuffer();
    const gifUpload = await upload(multipart(gifBytes, "animation.gif", "image/gif"), {
      cookie: adminCookie,
    });
    expect(gifUpload.status).toBe(201);
    const gifMeta = Attachment.parse(await gifUpload.json());
    const gifServed = await download(gifMeta.id, { cookie: adminCookie });
    expect(Buffer.from(await gifServed.arrayBuffer()).equals(gifBytes)).toBe(true);
    expect(gifServed.headers.get("content-disposition")).toContain("inline");

    const corrupt = await upload(multipart(Buffer.from("GIF89a-broken"), "bad.gif", "image/gif"), {
      cookie: adminCookie,
    });
    expect(corrupt.status).toBe(400);
    expect(Problem.parse(await corrupt.json()).code).toBe("invalid_image");
  });

  it("enforces unique references per holder and cascades on attachment deletion", async () => {
    const txt = Buffer.from("a log line\n");
    const uploaded = await upload(multipart(txt, "build.log", "text/plain"), {
      cookie: adminCookie,
    });
    const metadata = Attachment.parse(await uploaded.json());
    const values = {
      attachmentId: metadata.id,
      holderType: "issue" as const,
      holderId: randomUUID(),
    };
    await database.db.insert(attachmentReferences).values({ id: randomUUID(), ...values });
    await expect(
      database.db.insert(attachmentReferences).values({ id: randomUUID(), ...values }),
    ).rejects.toBeInstanceOf(Error);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, metadata.id)),
    ).toHaveLength(1);

    const [row] = await database.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, metadata.id));
    expect(row?.contentType).toBe("text/x-log");
    await database.db.delete(attachments).where(eq(attachments.id, metadata.id));
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, metadata.id)),
    ).toHaveLength(0);
  });

  it("serves a Unicode filename with an RFC 5987 Content-Disposition", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const response = await upload(multipart(pdf, "résumé-日本語.pdf", "application/pdf"), {
      cookie: adminCookie,
    });
    expect(response.status).toBe(201);
    const metadata = Attachment.parse(await response.json());
    const served = await download(metadata.id, { cookie: adminCookie });
    expect(served.status).toBe(200);
    const disposition = served.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent("résumé-日本語.pdf"));
  });

  it("accepts an extensionless upload with a valid MIME type and magic bytes", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 4, g: 5, b: 6 } },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(png)], "clipboard", { type: "image/png" }));
    const response = await upload(form, { cookie: adminCookie });
    expect(response.status).toBe(201);
    expect(Attachment.parse(await response.json())).toMatchObject({
      contentType: "image/png",
      inline: true,
      filename: "clipboard",
    });
  });

  it("authorizes before decoding bytes or sniffing magic numbers", async () => {
    const garbage = Buffer.from("not a valid image, not a valid document");
    const readOnly = await upload(multipart(garbage, "fake.png", "image/png"), {
      token: "read-key",
    });
    expect(readOnly.status).toBe(403);
    expect(Problem.parse(await readOnly.json()).code).toBe("insufficient_project_access");

    const crossProject = await upload(multipart(garbage, "fake.png", "image/png"), {
      project: randomUUID(),
      cookie: adminCookie,
    });
    expect(crossProject.status).toBe(404);
    expect(Problem.parse(await crossProject.json()).code).toBe("project_not_found");

    const badZip = Buffer.concat([Buffer.from("PKxx"), Buffer.from("word/document.xml")]);
    const rejected = await upload(
      multipart(
        badZip,
        "broken.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      { cookie: adminCookie },
    );
    expect(rejected.status).toBe(415);
  });

  it("allows unreferenced_at to be cleared when a reference binds an attachment", async () => {
    const txt = Buffer.from("bind me\n");
    const uploaded = await upload(multipart(txt, "bind.txt", "text/plain"), {
      cookie: adminCookie,
    });
    const metadata = Attachment.parse(await uploaded.json());
    await database.db
      .update(attachments)
      .set({ unreferencedAt: null })
      .where(eq(attachments.id, metadata.id));
    const [row] = await database.db
      .select({ unreferencedAt: attachments.unreferencedAt })
      .from(attachments)
      .where(eq(attachments.id, metadata.id));
    expect(row?.unreferencedAt).toBeNull();
  });

  it("loses a claim-first race cleanly and reclaims the orphaned blob", async () => {
    const putEntered = deferred<string>();
    const allowPut = deferred();
    const deleteEntered = deferred<string>();
    const allowDelete = deferred();
    const hooked: ObjectStore = {
      ...store,
      async put(k, data, type) {
        const meta = await store.put(k, data, type);
        putEntered.resolve(k);
        await allowPut.promise;
        return meta;
      },
      async delete(k) {
        deleteEntered.resolve(k);
        await allowDelete.promise;
        return store.delete(k);
      },
    };
    const hookedApp = createApp({
      features: [
        createAccountsFeature({ db: database.db, setupSecret: SECRET, publicUrl: PUBLIC_URL }),
        createProjectsFeature({
          db: database.db,
          sessionReader: async () => null,
          agentAuthenticator: async (request) =>
            /^Bearer valid-key$/.test(request.headers.get("authorization") ?? "")
              ? (identities["contribute-key"] ?? null)
              : null,
          sessionGate: async () => true,
        }),
        createAttachmentsFeature({
          db: database.db,
          store: hooked,
          maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
          sessionReader: async () => null,
          authenticate: async (request) =>
            /^Bearer valid-key$/.test(request.headers.get("authorization") ?? "")
              ? (identities["contribute-key"] ?? null)
              : null,
          projectAccessCeiling: async () => new Map(),
          projectAccessAtLeast: () => true,
        }),
      ],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const uploadPromise = hookedApp.request(`/api/projects/${projectId}/attachments`, {
      method: "POST",
      headers: { authorization: "Bearer valid-key" },
      body: multipart(png, "race.png", "image/png"),
    });
    const key = await putEntered.promise;
    await database.db
      .update(storedObjects)
      .set({ createdAt: sql`statement_timestamp() - interval '16 minutes'` })
      .where(eq(storedObjects.key, key));

    const sweepPromise = sweepOrphanObjects(database.db, hooked);
    expect(await deleteEntered.promise).toBe(key);
    const [claimed] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.key, key));
    expect(claimed).toMatchObject({ status: "deleted" });
    expect(claimed?.deletedAt).not.toBeNull();

    allowPut.resolve();
    const response = await uploadPromise;
    expect(response.status).toBe(409);
    expect(Problem.parse(await response.json()).code).toBe("attachment_upload_expired");

    allowDelete.resolve();
    expect(await sweepPromise).toBe(1);
    expect(await store.head(key)).toBeNull();
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
    expect(await database.db.select().from(attachments)).toHaveLength(0);
  });
});

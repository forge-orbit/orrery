import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Problem, SessionResponse, type AgentIdentity } from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  browserSessions,
  humans,
  storedObjects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createLocalObjectStore, type ObjectStore } from "../../platform/storage.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createDeactivationFeature } from "../deactivation/index.ts";
import { avatarKey, type AvatarsFeature, createAvatarsFeature } from "./index.ts";

const PUBLIC_URL = "http://orrery.test";
const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const OTHER_EMAIL = "other@example.com";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const silentLogger = createLogger("error");

const postJson = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const cookie = (res: Response) => res.headers.getSetCookie()[0]?.split(";")[0] ?? "";

async function image(format: "jpeg" | "png" | "webp", width = 600, height = 400) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } },
  })
    .toFormat(format)
    .toBuffer();
}

/** A JPEG carrying an APP1/Exif segment with a GPS-looking payload. */
async function jpegWithExif() {
  const base = await image("jpeg");
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

/** A backend whose deletes fail, leaving the deleted row for the orphan sweep. */
function failingDeleteStore(inner: ObjectStore): ObjectStore {
  return {
    ...inner,
    async delete() {
      throw new Error("injected blob delete failure");
    },
  };
}

/** A backend whose writes fail before any bytes are stored. */
function failingPutStore(inner: ObjectStore, onPut?: (key: string) => void): ObjectStore {
  return {
    ...inner,
    async put(key) {
      onPut?.(key);
      throw new Error("injected blob write failure");
    },
  };
}

/** A backend that runs a hook between reserving the row and writing the bytes. */
function putHookStore(inner: ObjectStore, hook: (key: string) => Promise<void>): ObjectStore {
  return {
    ...inner,
    async put(key, data, contentType) {
      await hook(key);
      return inner.put(key, data, contentType);
    },
  };
}

describe("avatars", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let dataDir: string;
  let store: ObjectStore;
  let agentIdentity: AgentIdentity | null;
  let app: Hono;
  let avatars: AvatarsFeature;
  let adminCookie: string;
  let adminId: string;

  async function sharedWorkspaceWith(
    humanIds: readonly string[],
    ownerId: string,
    suspendedIds: readonly string[] = [],
  ) {
    const id = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values({ id, kind: "shared", name: "Shared" });
      for (const humanId of humanIds) {
        await tx.insert(workspaceMemberships).values({
          id: randomUUID(),
          workspaceId: id,
          humanId,
          isOwner: humanId === ownerId,
          suspendedAt: suspendedIds.includes(humanId) ? new Date() : null,
        });
      }
    });
    return id;
  }

  async function sessionFor(humanId: string, token: string) {
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId,
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 day'`,
    });
    return `orrery_session=${token}`;
  }

  async function humanWithSession(email: string, token: string) {
    const [row] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email, passwordHash: "scrypt$test" })
      .returning({ id: humans.id });
    const humanId = row?.id ?? "";
    return { id: humanId, cookie: await sessionFor(humanId, token) };
  }

  function install(storeOverride: ObjectStore = store, dbOverride: Database["db"] = database.db) {
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    avatars = createAvatarsFeature({
      db: dbOverride,
      store: storeOverride,
      sessionReader: accounts.sessionReader,
      authenticate: async (request: Request) =>
        request.headers.get("authorization") === "Bearer valid-key" ? agentIdentity : null,
      log: silentLogger,
    });
    app = createApp({
      features: [
        accounts,
        avatars,
        createDeactivationFeature({ db: database.db, sessionReader: accounts.sessionReader }),
      ],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
  }

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
    dataDir = await mkdtemp(join(tmpdir(), "orrery-avatars-"));
    store = createLocalObjectStore(dataDir);
    agentIdentity = null;
    install();

    const setup = await postJson(app, "/api/setup/admin", {
      secret: SECRET,
      email: EMAIL,
      password: PASSWORD,
    });
    if (setup.status !== 201) throw new Error("setup failed");
    const login = await postJson(app, "/api/auth/login", { email: EMAIL, password: PASSWORD });
    adminCookie = cookie(login);
    const [admin] = await database.db.select().from(humans).where(eq(humans.email, EMAIL));
    adminId = admin?.id ?? "";

    const [personal] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.personalOwnerHumanId, adminId));
    agentIdentity = {
      agentId: randomUUID(),
      name: "test-agent",
      humanId: adminId,
      keyId: randomUUID(),
      workspaceId: personal?.id ?? "",
      validity: "90",
      projects: [],
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`delete from stored_objects`);
      await tx.execute(sql`delete from account_recovery_events`);
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from humans`);
    });
  });

  const upload = (form: FormData, session = adminCookie) =>
    app.request("/api/account/avatar", { method: "PUT", headers: { cookie: session }, body: form });

  const removePhoto = (session = adminCookie) =>
    app.request("/api/account/avatar", { method: "DELETE", headers: { cookie: session } });

  const fetchAvatar = (humanId: string, query = "", session = adminCookie) =>
    app.request(`/api/humans/${humanId}/avatar${query}`, { headers: { cookie: session } });

  it("accepts JPEG, PNG and WebP and normalizes each to a 256x256 WebP blob", async () => {
    for (const [format, type, filename] of [
      ["jpeg", "image/jpeg", "photo.jpg"],
      ["png", "image/png", "photo.png"],
      ["webp", "image/webp", "photo.webp"],
    ] as const) {
      const bytes = await image(format);
      const res = await upload(multipart(bytes, filename, type));
      expect(res.status).toBe(200);
      const body = SessionResponse.parse(await res.json());
      expect(body.email).toBe(EMAIL);
      expect(body.avatarUrl).toMatch(
        new RegExp(`^/api/humans/${adminId}/avatar\\?v=[0-9a-f-]{36}$`),
      );
      const objectId = body.avatarUrl?.split("v=")[1] ?? "";

      const [row] = await database.db
        .select()
        .from(storedObjects)
        .where(eq(storedObjects.id, objectId));
      expect(row).toMatchObject({
        key: `avatars/${adminId}/${objectId}.webp`,
        status: "active",
        contentType: "image/webp",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      const key = `avatars/${adminId}/${objectId}.webp`;
      const normalized = await sharp(await readFile(join(dataDir, "objects", key))).metadata();
      expect(normalized.format).toBe("webp");
      expect(normalized.width).toBe(256);
      expect(normalized.height).toBe(256);
    }
  });

  it("strips EXIF metadata from an uploaded JPEG", async () => {
    const res = await upload(multipart(await jpegWithExif(), "gps.jpg", "image/jpeg"));
    expect(res.status).toBe(200);
    const objectId = SessionResponse.parse(await res.json()).avatarUrl?.split("v=")[1] ?? "";
    const stored = await readFile(join(dataDir, "objects", `avatars/${adminId}/${objectId}.webp`));
    expect(stored.includes(Buffer.from("GPS-latitude-secret"))).toBe(false);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
  });

  it("rejects SVG, corrupted images and oversized uploads with Problems and no stored rows", async () => {
    const cases = [
      {
        form: multipart(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          "x.svg",
          "image/svg+xml",
        ),
        status: 415,
        code: "unsupported_image_type",
      },
      {
        form: multipart(
          Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("broken")]),
          "x.jpg",
          "image/jpeg",
        ),
        status: 400,
        code: "invalid_image",
      },
      {
        form: multipart(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 7), "x.png", "image/png"),
        status: 413,
        code: "payload_too_large",
      },
    ];
    for (const { form, status, code } of cases) {
      const res = await upload(form);
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(Problem.parse(await res.json())).toMatchObject({ code, status });
    }
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
  });

  it("requires an authenticated active human to upload", async () => {
    const unauth = await app.request("/api/account/avatar", {
      method: "PUT",
      body: multipart(await image("png"), "photo.png", "image/png"),
    });
    expect(unauth.status).toBe(401);
    expect(Problem.parse(await unauth.json()).code).toBe("not_signed_in");
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
  });

  it("refuses an upload if the human was deactivated after the session was issued", async () => {
    await database.db
      .update(humans)
      .set({ deactivatedAt: new Date() })
      .where(eq(humans.id, adminId));
    const res = await upload(multipart(await image("png"), "photo.png", "image/png"));
    expect(res.status).toBe(401);
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
  });

  it("serves the avatar with nosniff, ETag and immutable caching when v matches", async () => {
    const uploaded = await upload(multipart(await image("png"), "photo.png", "image/png"));
    const objectId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";

    const plain = await fetchAvatar(adminId);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("image/webp");
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    expect(plain.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(plain.headers.get("cache-control")).toBe("private, no-cache");

    const versioned = await fetchAvatar(adminId, `?v=${objectId}`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await sharp(Buffer.from(await versioned.arrayBuffer())).metadata()).width).toBe(256);
  });

  it("answers 401 unauthenticated and 404 with no existence leak for unrelated humans", async () => {
    const unauth = await fetchAvatar(adminId, "", "");
    expect(unauth.status).toBe(401);

    const [strangerId] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email: OTHER_EMAIL, passwordHash: "scrypt$test" })
      .returning({ id: humans.id });
    const hidden = await fetchAvatar(strangerId?.id ?? "");
    expect(hidden.status).toBe(404);
    expect(Problem.parse(await hidden.json()).code).toBe("avatar_not_visible");

    const missing = await fetchAvatar(randomUUID());
    expect(missing.status).toBe(404);
    expect(Problem.parse(await missing.json()).code).toBe("avatar_not_visible");

    const noAvatar = await fetchAvatar(adminId);
    expect(noAvatar.status).toBe(404);
    expect(Problem.parse(await noAvatar.json()).code).toBe("avatar_not_found");
  });

  it("serves another shared-workspace member's avatar, not an outsider's or a suspended member's", async () => {
    const member = await humanWithSession("member@example.com", "member-token");
    const outsider = await humanWithSession("outsider@example.com", "outsider-token");
    const suspended = await humanWithSession("suspended@example.com", "suspended-token");
    await sharedWorkspaceWith([adminId, member.id, suspended.id], adminId, [suspended.id]);

    const uploaded = await upload(
      multipart(await image("webp"), "photo.webp", "image/webp"),
      member.cookie,
    );
    expect(uploaded.status).toBe(200);

    expect((await fetchAvatar(member.id, "", adminCookie)).status).toBe(200);
    expect((await fetchAvatar(member.id, "", outsider.cookie)).status).toBe(404);
    expect((await fetchAvatar(member.id, "", suspended.cookie)).status).toBe(404);

    await upload(multipart(await image("png"), "s.png", "image/png"), suspended.cookie);
    expect((await fetchAvatar(suspended.id, "", adminCookie)).status).toBe(404);
  });

  it("lets a workspace-scoped agent key read a member's avatar but not a non-member's", async () => {
    const member = await humanWithSession("agent-member@example.com", "agent-member-token");
    const outsider = await humanWithSession("agent-outsider@example.com", "agent-outsider-token");
    const suspended = await humanWithSession(
      "agent-suspended@example.com",
      "agent-suspended-token",
    );
    const sharedId = await sharedWorkspaceWith([adminId, member.id, suspended.id], adminId, [
      suspended.id,
    ]);
    agentIdentity = {
      agentId: randomUUID(),
      name: "scoped-agent",
      humanId: adminId,
      keyId: randomUUID(),
      workspaceId: sharedId,
      validity: "90",
      projects: [],
    };
    const bearer = { authorization: "Bearer valid-key" };

    for (const human of [member, outsider, suspended]) {
      const uploaded = await upload(
        multipart(await image("png"), "a.png", "image/png"),
        human.cookie,
      );
      expect(uploaded.status).toBe(200);
    }
    expect((await app.request(`/api/humans/${member.id}/avatar`, { headers: bearer })).status).toBe(
      200,
    );
    expect(
      (await app.request(`/api/humans/${outsider.id}/avatar`, { headers: bearer })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/humans/${suspended.id}/avatar`, { headers: bearer })).status,
    ).toBe(404);
  });

  it("uses no-cache for a stale version and answers If-None-Match with 304", async () => {
    const uploaded = await upload(multipart(await image("png"), "photo.png", "image/png"));
    const objectId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";

    const stale = await fetchAvatar(adminId, `?v=${randomUUID()}`);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");

    const versioned = await fetchAvatar(adminId, `?v=${objectId}`);
    const etag = versioned.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const conditional = await app.request(`/api/humans/${adminId}/avatar?v=${objectId}`, {
      headers: { cookie: adminCookie, "if-none-match": etag },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await conditional.text()).toBe("");
  });

  it("rejects a missing or non-file upload field with a Problem instead of a 500", async () => {
    const missing = await upload(new FormData());
    expect(missing.status).toBe(400);
    expect(Problem.parse(await missing.json()).code).toBe("validation_failed");

    const form = new FormData();
    form.set("file", "not a file");
    const notAFile = await upload(form);
    expect(notAFile.status).toBe(400);
    expect(Problem.parse(await notAFile.json()).code).toBe("invalid_upload");
  });

  it("rejects an oversized content-length before reading the body", async () => {
    const request = new Request("http://orrery.test/api/account/avatar", {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-length": String(MAX_UPLOAD_BYTES + 64 * 1024),
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unused"));
          controller.close();
        },
      }),
      duplex: "half",
    });
    const res = await app.request(request);
    expect(res.status).toBe(413);
    expect(Problem.parse(await res.json()).code).toBe("payload_too_large");
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
  });

  it("replaces a photo with a new cache-busting id and reclaims the old blob and row", async () => {
    const first = await upload(multipart(await image("jpeg"), "one.jpg", "image/jpeg"));
    const firstId = SessionResponse.parse(await first.json()).avatarUrl?.split("v=")[1] ?? "";
    const second = await upload(multipart(await image("png"), "two.png", "image/png"));
    const secondId = SessionResponse.parse(await second.json()).avatarUrl?.split("v=")[1] ?? "";
    expect(secondId).not.toBe(firstId);

    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBe(secondId);
    const rows = await database.db.select().from(storedObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: secondId, status: "active" });
    expect(rows[0]?.deletedAt).toBeNull();
    expect(await store.head(avatarKey(adminId, firstId))).toBeNull();
    expect(await store.head(avatarKey(adminId, secondId))).not.toBeNull();
    expect((await fetchAvatar(adminId, `?v=${secondId}`)).status).toBe(200);
  });

  it("removes the avatar with DELETE, returning avatarUrl null and reclaiming the blob", async () => {
    const uploaded = await upload(multipart(await image("webp"), "photo.webp", "image/webp"));
    const objectId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";

    const res = await removePhoto();
    expect(res.status).toBe(200);
    expect(SessionResponse.parse(await res.json())).toMatchObject({
      email: EMAIL,
      avatarUrl: null,
    });

    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBeNull();
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
    expect(await store.head(avatarKey(adminId, objectId))).toBeNull();
    expect((await fetchAvatar(adminId)).status).toBe(404);
  });

  it("makes DELETE idempotent when no photo is set", async () => {
    const res = await removePhoto();
    expect(res.status).toBe(200);
    expect(SessionResponse.parse(await res.json()).avatarUrl).toBeNull();
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
  });

  it("keeps a removed row deleted with deleted_at when the blob delete fails, then sweeps it", async () => {
    const uploaded = await upload(multipart(await image("png"), "photo.png", "image/png"));
    const objectId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";

    install(failingDeleteStore(store));
    const res = await removePhoto();
    expect(res.status).toBe(200);
    expect(SessionResponse.parse(await res.json()).avatarUrl).toBeNull();

    const [row] = await database.db.select().from(storedObjects);
    expect(row).toMatchObject({ id: objectId, status: "deleted" });
    expect(row?.deletedAt).not.toBeNull();
    expect(await store.head(avatarKey(adminId, objectId))).not.toBeNull();

    install(store);
    expect(await avatars.sweepOrphans()).toBe(1);
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
    expect(await store.head(avatarKey(adminId, objectId))).toBeNull();
  });

  it("requires an active human session to remove a photo", async () => {
    const uploaded = await upload(multipart(await image("png"), "photo.png", "image/png"));
    const objectId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";

    const unauth = await removePhoto("");
    expect(unauth.status).toBe(401);
    expect(Problem.parse(await unauth.json()).code).toBe("not_signed_in");

    await database.db
      .update(humans)
      .set({ deactivatedAt: new Date() })
      .where(eq(humans.id, adminId));
    const deactivated = await removePhoto();
    expect(deactivated.status).toBe(401);

    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBe(objectId);
    const [row] = await database.db.select().from(storedObjects);
    expect(row).toMatchObject({ status: "active" });
    expect(await store.head(avatarKey(adminId, objectId))).not.toBeNull();
  });

  it("marks the replaced row deleted when the immediate blob delete fails, then sweeps it", async () => {
    const first = await upload(multipart(await image("jpeg"), "one.jpg", "image/jpeg"));
    const firstId = SessionResponse.parse(await first.json()).avatarUrl?.split("v=")[1] ?? "";

    install(failingDeleteStore(store));
    const second = await upload(multipart(await image("png"), "two.png", "image/png"));
    const secondId = SessionResponse.parse(await second.json()).avatarUrl?.split("v=")[1] ?? "";
    expect(second.status).toBe(200);
    expect(secondId).not.toBe(firstId);

    const deleted = (await database.db.select().from(storedObjects)).find((r) => r.id === firstId);
    expect(deleted).toMatchObject({ status: "deleted" });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(await store.head(avatarKey(adminId, firstId))).not.toBeNull();
    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBe(secondId);

    install(store);
    expect(await avatars.sweepOrphans()).toBe(1);
    expect(await store.head(avatarKey(adminId, firstId))).toBeNull();
    const rows = await database.db.select().from(storedObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(secondId);
  });

  it("sweeps deleted rows and pending rows older than 15 minutes but keeps fresh pending rows", async () => {
    const uploaded = await upload(multipart(await image("png"), "photo.png", "image/png"));
    const firstId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";
    install(failingDeleteStore(store));
    await removePhoto();
    install(store);

    const bytes = Buffer.from("pending-blob");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expiredKey = `avatars/${adminId}/expired.webp`;
    const freshKey = `avatars/${adminId}/fresh.webp`;
    for (const key of [expiredKey, freshKey]) {
      await store.put(key, bytes, "image/webp");
      await database.db.insert(storedObjects).values({
        id: randomUUID(),
        key,
        status: "pending",
        contentType: "image/webp",
        byteSize: bytes.byteLength,
        sha256,
      });
    }
    await database.db.execute(
      sql`update stored_objects set created_at = statement_timestamp() - interval '16 minutes' where key = ${expiredKey}`,
    );
    await database.db.execute(
      sql`update stored_objects set created_at = statement_timestamp() - interval '14 minutes' where key = ${freshKey}`,
    );

    expect(await avatars.sweepOrphans()).toBe(2);
    expect(await avatars.sweepOrphans()).toBe(0);

    expect(await store.head(avatarKey(adminId, firstId))).toBeNull();
    expect(await store.head(expiredKey)).toBeNull();
    expect(await store.head(freshKey)).not.toBeNull();
    const rows = await database.db.select().from(storedObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: freshKey, status: "pending" });
  });

  it("cleans up the blob and pending row when the blob write fails", async () => {
    let reservedKey = "";
    install(failingPutStore(store, (key) => (reservedKey = key)));
    const res = await upload(multipart(await image("png"), "x.png", "image/png"));
    expect(res.status).toBe(500);
    expect(Problem.parse(await res.json()).code).toBe("internal_error");

    expect(reservedKey).not.toBe("");
    expect(await store.head(reservedKey)).toBeNull();
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBeNull();

    install(store);
    expect(await avatars.sweepOrphans()).toBe(0);
  });

  it("rejects an upload deactivated mid-flight and cleans up the blob and pending row", async () => {
    let reservedKey = "";
    install(
      putHookStore(store, async (key) => {
        reservedKey = key;
        await database.db
          .update(humans)
          .set({ deactivatedAt: sql`statement_timestamp()` })
          .where(eq(humans.id, adminId));
      }),
    );
    const res = await upload(multipart(await image("png"), "x.png", "image/png"));
    expect(res.status).toBe(403);
    expect(Problem.parse(await res.json()).code).toBe("account_deactivated");

    expect(await store.head(reservedKey)).toBeNull();
    expect(await database.db.select().from(storedObjects)).toHaveLength(0);
    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBeNull();

    install(store);
    expect(await avatars.sweepOrphans()).toBe(0);
  });

  it("cleans up the blob and pending row when the promoting transaction fails", async () => {
    let reservedKey = "";
    install(
      putHookStore(store, async (key) => {
        reservedKey = key;
      }),
    );
    await database.db.execute(sql`
      create function avatars_fail_commit() returns trigger language plpgsql as $$
      begin
        raise exception 'injected commit failure';
      end; $$;
    `);
    await database.db.execute(sql`
      create trigger avatars_fail_commit_trigger before update on stored_objects
      for each row when (new.status = 'active') execute function avatars_fail_commit();
    `);
    try {
      const res = await upload(multipart(await image("png"), "x.png", "image/png"));
      expect(res.status).toBe(500);
      expect(Problem.parse(await res.json()).code).toBe("internal_error");

      expect(await store.head(reservedKey)).toBeNull();
      expect(await database.db.select().from(storedObjects)).toHaveLength(0);
      const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
      expect(human?.avatarObjectId).toBeNull();

      expect(await avatars.sweepOrphans()).toBe(0);
    } finally {
      await database.db.execute(
        sql`drop trigger if exists avatars_fail_commit_trigger on stored_objects`,
      );
      await database.db.execute(sql`drop function if exists avatars_fail_commit()`);
    }
  });

  it("keeps a committed avatar live when the connection drops after the transaction", async () => {
    const droppedConnectionDb = new Proxy(database.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: never) => {
            await database.db.transaction(fn);
            throw new Error("simulated connection drop after commit");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    install(store, droppedConnectionDb);

    const res = await upload(multipart(await image("png"), "x.png", "image/png"));
    expect(res.status).toBe(500);

    const rows = await database.db.select().from(storedObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active" });
    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBe(rows[0]?.id);
    expect(await store.head(avatarKey(adminId, rows[0]?.id ?? ""))).not.toBeNull();
    expect((await fetchAvatar(adminId)).status).toBe(200);

    install(store);
    expect(await avatars.sweepOrphans()).toBe(0);
    expect((await fetchAvatar(adminId)).status).toBe(200);
  });

  it("keeps a deactivated human's avatar visible on historical work and restores it on reactivation", async () => {
    const member = await humanWithSession("member@example.com", "member-token");
    await sharedWorkspaceWith([adminId, member.id], adminId);
    const uploaded = await upload(
      multipart(await image("png"), "member.png", "image/png"),
      member.cookie,
    );
    const objectId = SessionResponse.parse(await uploaded.json()).avatarUrl?.split("v=")[1] ?? "";
    const expectedUrl = `/api/humans/${member.id}/avatar?v=${objectId}`;
    expect((await fetchAvatar(member.id, `?v=${objectId}`)).status).toBe(200);

    const deactivated = await app.request(`/api/admin/accounts/${member.id}/deactivate`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(deactivated.status).toBe(200);

    const [human] = await database.db.select().from(humans).where(eq(humans.id, member.id));
    expect(human?.avatarObjectId).toBe(objectId);
    const [row] = await database.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.id, objectId));
    expect(row).toMatchObject({ status: "active" });
    expect(row?.deletedAt).toBeNull();
    expect(await store.head(avatarKey(member.id, objectId))).not.toBeNull();

    // Deactivation ends sessions; even a freshly issued session cannot change the photo.
    const freshCookie = await sessionFor(member.id, "deactivated-token");
    const blockedUpload = await upload(
      multipart(await image("png"), "x.png", "image/png"),
      freshCookie,
    );
    expect(blockedUpload.status).toBe(401);
    expect((await removePhoto(freshCookie)).status).toBe(401);

    const served = await fetchAvatar(member.id, `?v=${objectId}`, adminCookie);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    const reactivated = await app.request(`/api/admin/accounts/${member.id}/reactivate`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(reactivated.status).toBe(200);
    expect((await fetchAvatar(member.id, `?v=${objectId}`, adminCookie)).status).toBe(200);
    const session = await app.request("/api/auth/session", { headers: { cookie: freshCookie } });
    expect(session.status).toBe(200);
    expect(SessionResponse.parse(await session.json()).avatarUrl).toBe(expectedUrl);
    expect(await avatars.sweepOrphans()).toBe(0);
  });

  it("lets a workspace-scoped agent key read a deactivated member's avatar before and after reactivation", async () => {
    const member = await humanWithSession("agent-member@example.com", "agent-member-token");
    const outsider = await humanWithSession("agent-outsider@example.com", "agent-outsider-token");
    const sharedId = await sharedWorkspaceWith([adminId, member.id], adminId);
    agentIdentity = {
      agentId: randomUUID(),
      name: "deactivation-agent",
      humanId: adminId,
      keyId: randomUUID(),
      workspaceId: sharedId,
      validity: "90",
      projects: [],
    };
    const bearer = { authorization: "Bearer valid-key" };
    const readAsAgent = (humanId: string) =>
      app.request(`/api/humans/${humanId}/avatar`, { headers: bearer });

    const uploaded = await upload(
      multipart(await image("png"), "member.png", "image/png"),
      member.cookie,
    );
    expect(uploaded.status).toBe(200);
    const before = await readAsAgent(member.id);
    expect(before.status).toBe(200);
    const etag = before.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await readAsAgent(outsider.id)).status).toBe(404);

    const deactivated = await app.request(`/api/admin/accounts/${member.id}/deactivate`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(deactivated.status).toBe(200);
    const whileDeactivated = await readAsAgent(member.id);
    expect(whileDeactivated.status).toBe(200);
    expect(whileDeactivated.headers.get("etag")).toBe(etag);
    expect((await readAsAgent(outsider.id)).status).toBe(404);

    const reactivated = await app.request(`/api/admin/accounts/${member.id}/reactivate`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(reactivated.status).toBe(200);
    const after = await readAsAgent(member.id);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).toBe(etag);
    expect(await database.db.select().from(storedObjects)).toHaveLength(1);
  });

  it("reports storage health through /readyz alongside Postgres", async () => {
    const { createSystemFeature } = await import("../system/index.ts");
    const healthy = createApp({
      features: [
        createSystemFeature({ ping: async () => {}, checkStorage: () => store.checkHealth() }),
      ],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });
    expect((await healthy.request("/readyz")).status).toBe(200);
  });
});

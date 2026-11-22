import { randomUUID } from "node:crypto";
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
import { createAvatarsFeature } from "./index.ts";

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

describe("avatars", () => {
  let pg: StartedPostgreSqlContainer;
  let database: Database;
  let dataDir: string;
  let store: ObjectStore;
  let agentIdentity: AgentIdentity | null;
  let app: Hono;
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

  async function humanWithSession(email: string, token: string) {
    const [row] = await database.db
      .insert(humans)
      .values({ id: randomUUID(), email, passwordHash: "scrypt$test" })
      .returning({ id: humans.id });
    await database.db.insert(browserSessions).values({
      id: randomUUID(),
      humanId: row?.id ?? "",
      tokenHash: tokenHash(token),
      expiresAt: sql`now() + interval '1 day'`,
    });
    return { id: row?.id ?? "", cookie: `orrery_session=${token}` };
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
    const accounts = createAccountsFeature({
      db: database.db,
      setupSecret: SECRET,
      publicUrl: PUBLIC_URL,
    });
    app = createApp({
      features: [
        accounts,
        createAvatarsFeature({
          db: database.db,
          store,
          sessionReader: accounts.sessionReader,
          authenticate: async (request: Request) =>
            request.headers.get("authorization") === "Bearer valid-key" ? agentIdentity : null,
        }),
      ],
      publicUrl: PUBLIC_URL,
      log: silentLogger,
    });

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
      await tx.execute(sql`delete from workspace_memberships`);
      await tx.execute(sql`delete from workspaces`);
      await tx.execute(sql`delete from browser_sessions`);
      await tx.execute(sql`delete from instance_setup`);
      await tx.execute(sql`delete from humans`);
    });
  });

  const upload = (form: FormData, session = adminCookie) =>
    app.request("/api/account/avatar", { method: "PUT", headers: { cookie: session }, body: form });

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

  it("keeps one live avatar row when replacing a photo and changes the cache-busting id", async () => {
    const first = await upload(multipart(await image("jpeg"), "one.jpg", "image/jpeg"));
    const firstId = SessionResponse.parse(await first.json()).avatarUrl?.split("v=")[1] ?? "";
    const second = await upload(multipart(await image("png"), "two.png", "image/png"));
    const secondId = SessionResponse.parse(await second.json()).avatarUrl?.split("v=")[1] ?? "";
    expect(secondId).not.toBe(firstId);

    const [human] = await database.db.select().from(humans).where(eq(humans.id, adminId));
    expect(human?.avatarObjectId).toBe(secondId);
    const rows = await database.db.select().from(storedObjects);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === firstId)).toMatchObject({ status: "deleted" });
    expect(rows.find((row) => row.id === firstId)?.deletedAt).not.toBeNull();
    expect(rows.find((row) => row.id === secondId)).toMatchObject({ status: "active" });
    expect(rows.find((row) => row.id === secondId)?.deletedAt).toBeNull();
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

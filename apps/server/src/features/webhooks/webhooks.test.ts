import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { WorkActor } from "../projects/index.ts";
import { WebhookPayload } from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  humans,
  issues,
  projectActivity,
  projects,
  runs,
  webhookDeliveries,
  webhookProjects,
  webhooks,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createLogger, type Logger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { AgentsError } from "../agents/index.ts";
import { createProjectsFeature } from "../projects/index.ts";
import { createTransfersFeature } from "../transfers/index.ts";
import { createSessionsFeature } from "../work-sessions/index.ts";
import { createWebhooksRest } from "./rest.ts";
import { createWebhooksService, isBlockedAddress, type WebhooksService } from "./service.ts";

const SETUP_SECRET = "correct horse battery staple webhooks test";
const PUBLIC_URL = "http://orrery.test";
const KEY_A = Buffer.from("webhook-test-key-aaaaaaaaaaaaaaa");
const KEY_B = Buffer.from("webhook-test-key-bbbbbbbbbbbbbbb");
const silent: Logger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let service: WebhooksService;
let strictService: WebhooksService;
let noKeyService: WebhooksService;
let transfers: ReturnType<typeof createTransfersFeature>["service"];
let projectsFeature: ReturnType<typeof createProjectsFeature>;

function humanActor(humanId: string): WorkActor {
  return {
    kind: "human",
    account: {
      humanId,
      email: `${humanId}@orrery.test`,
      isSystemAdministrator: false,
      emailVerifiedAt: new Date(),
    },
  };
}

function headerOf(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new Error("missing header");
  return value;
}

const agentActor: WorkActor = {
  kind: "agent",
  identity: {
    agentId: "agent-1",
    name: "agent-1",
    humanId: "human-1",
    keyId: "key-1",
    workspaceId: "workspace-1",
    validity: "never",
    projects: [],
  },
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SETUP_SECRET,
    publicUrl: PUBLIC_URL,
  });
  service = createWebhooksService({
    db: database.db,
    encryptionKey: KEY_A,
    allowPrivateUrls: true,
    log: silent,
  });
  strictService = createWebhooksService({
    db: database.db,
    encryptionKey: KEY_A,
    allowPrivateUrls: false,
    log: silent,
  });
  noKeyService = createWebhooksService({
    db: database.db,
    encryptionKey: undefined,
    allowPrivateUrls: true,
    log: silent,
  });
  projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => false,
    onActivity: service.enqueueForActivity,
  });
  transfers = createTransfersFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
  }).service;
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from webhook_deliveries`);
    await tx.execute(sql`delete from webhook_projects`);
    await tx.execute(sql`delete from webhooks`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from work_sessions`);
    await tx.execute(sql`delete from runs`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from project_transfer_authorizations`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from humans`);
  });
});

async function insertHuman(email = `h-${randomUUID()}@orrery.test`) {
  const [human] = await database.db
    .insert(humans)
    .values({ id: randomUUID(), email, passwordHash: tokenHash(randomBytes(32).toString("hex")) })
    .returning();
  if (human === undefined) throw new Error("human not inserted");
  return human;
}

async function personalWorkspace(humanId: string) {
  const [row] = await database.db
    .insert(workspaces)
    .values({
      id: randomUUID(),
      kind: "personal",
      name: `personal-${humanId}`,
      personalOwnerHumanId: humanId,
    })
    .returning();
  if (row === undefined) throw new Error("workspace not inserted");
  return row;
}

async function sharedWorkspace(name: string, ownerHumanId: string, canCreateProjects = false) {
  return database.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workspaces)
      .values({ id: randomUUID(), kind: "shared", name })
      .returning();
    if (row === undefined) throw new Error("workspace not inserted");
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: row.id,
      humanId: ownerHumanId,
      isOwner: true,
      canCreateProjects,
    });
    return row;
  });
}

async function addMembership(
  workspaceId: string,
  humanId: string,
  isOwner = false,
  canCreateProjects = false,
) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner,
    canCreateProjects,
  });
}

async function insertProject(workspaceId: string, key: string, humanId: string) {
  const [row] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name: `Project ${key}`,
      key,
      createdByHumanId: humanId,
    })
    .returning();
  if (row === undefined) throw new Error("project not inserted");
  return row;
}

async function insertIssue(projectId: string, number: number, humanId: string) {
  const [row] = await database.db
    .insert(issues)
    .values({
      id: randomUUID(),
      projectId,
      number,
      title: `Issue ${number}`,
      status: "todo",
      sortOrder: number,
      createdByHumanId: humanId,
      updatedByHumanId: humanId,
    })
    .returning();
  if (row === undefined) throw new Error("issue not inserted");
  return row;
}

async function insertActivity(
  projectId: string,
  humanId: string,
  type: "project_renamed" = "project_renamed",
  issueId: string | null = null,
) {
  return database.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(projectActivity)
      .values({
        id: randomUUID(),
        projectId,
        type,
        actorHumanId: humanId,
        summary: "A project activity",
        issueId,
        createdAt: sql`statement_timestamp()`,
      })
      .returning();
    if (row === undefined) throw new Error("activity not inserted");
    await service.enqueueForActivity(tx, row.id);
    return row;
  });
}

const createInput = (overrides: Partial<Parameters<WebhooksService["create"]>[2]> = {}) => ({
  url: "https://example.com/hook",
  description: "a test hook",
  allProjects: true,
  projectIds: [],
  allEvents: true,
  events: [],
  ...overrides,
});

async function createHook(actor: WorkActor, workspaceId: string, overrides = {}) {
  return service.create(actor, workspaceId, createInput(overrides));
}

type Receiver = {
  url: string;
  received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }>;
  status: () => number;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
};

async function startReceiver(
  responder?: (req: { body: string; url: string | undefined }) => number,
): Promise<Receiver> {
  const received: Receiver["received"] = [];
  let currentStatus = 200;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ body, headers: req.headers });
      const status = responder
        ? responder({ body, url: req.url })
        : req.url === "/redirect"
          ? 302
          : currentStatus;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status >= 200 && status < 300 ? "ok" : "no");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no receiver address");
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    status: () => currentStatus,
    setStatus: (status: number) => {
      currentStatus = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe("webhook management authorization", () => {
  it("rejects anonymous callers, agents, outsiders, and non-owner members; hides other workspaces' hooks", async () => {
    const owner = await insertHuman();
    const member = await insertHuman();
    const outsider = await insertHuman();
    const ws = await sharedWorkspace("auth-team", owner.id);
    await addMembership(ws.id, member.id);
    const other = await personalWorkspace(outsider.id);
    const ownersSecond = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);

    await expect(service.list(null, ws.id)).rejects.toMatchObject({ kind: "not_signed_in" });
    await expect(service.list(agentActor, ws.id)).rejects.toMatchObject({
      kind: "agents_cannot_manage_webhooks",
    });
    await expect(service.list(humanActor(outsider.id), ws.id)).rejects.toMatchObject({
      kind: "not_workspace_member",
    });
    await expect(service.list(humanActor(member.id), ws.id)).rejects.toMatchObject({
      kind: "not_workspace_owner",
    });
    await expect(service.deliveries(humanActor(owner.id), ws.id, hook.id)).resolves.toMatchObject({
      items: [],
    });
    // Outsiders get 404 (not_workspace_member) for the other workspace entirely.
    await expect(service.deliveries(humanActor(owner.id), other.id, hook.id)).rejects.toMatchObject(
      {
        kind: "not_workspace_member",
      },
    );
    // An owner who can access both workspaces still cannot see a webhook from the other one.
    await expect(
      service.deliveries(humanActor(owner.id), ownersSecond.id, hook.id),
    ).rejects.toMatchObject({ kind: "webhook_not_found" });
    await expect(service.list(humanActor(owner.id), ws.id)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: hook.id })],
    });
  });

  it("lets a personal workspace owner manage hooks but not anybody else", async () => {
    const owner = await insertHuman();
    const other = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);
    expect((await service.list(humanActor(owner.id), ws.id)).items).toHaveLength(1);
    await expect(service.list(humanActor(other.id), ws.id)).rejects.toMatchObject({
      kind: "not_workspace_member",
    });
    await expect(service.remove(humanActor(other.id), ws.id, hook.id)).rejects.toMatchObject({
      kind: "not_workspace_member",
    });
  });

  it("enforces the 20-webhook-per-workspace cap", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    for (let i = 0; i < 20; i++) await createHook(humanActor(owner.id), ws.id);
    await expect(createHook(humanActor(owner.id), ws.id)).rejects.toMatchObject({
      kind: "webhook_limit_reached",
    });
  });
});

describe("signing secrets and encryption", () => {
  it("returns a secret only once, encrypts it at rest, and never leaks it in reads", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const created = await createHook(humanActor(owner.id), ws.id);
    expect(created.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const [stored] = await database.db.select().from(webhooks).where(eq(webhooks.id, created.id));
    expect(stored?.secretEncrypted).not.toContain(created.signingSecret);
    expect(stored?.secretEncrypted.startsWith("v1:")).toBe(true);

    const listed = await service.list(humanActor(owner.id), ws.id);
    expect(JSON.stringify(listed)).not.toContain(created.signingSecret);
    const updated = await service.update(humanActor(owner.id), ws.id, created.id, {
      description: "renamed",
    });
    expect(JSON.stringify(updated)).not.toContain(created.signingSecret);

    const rotated = await service.rotateSecret(humanActor(owner.id), ws.id, created.id);
    expect(rotated.signingSecret).toMatch(/^whsec_/);
    expect(rotated.signingSecret).not.toBe(created.signingSecret);
    expect(JSON.stringify(rotated)).not.toContain(created.signingSecret);
    expect((await service.list(humanActor(owner.id), ws.id)).items[0]?.id).toBe(created.id);
  });

  it("requires an encryption key to create or rotate", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    await expect(
      noKeyService.create(humanActor(owner.id), ws.id, createInput()),
    ).rejects.toMatchObject({ kind: "encryption_key_missing" });
    const hook = await createHook(humanActor(owner.id), ws.id);
    await expect(
      noKeyService.rotateSecret(humanActor(owner.id), ws.id, hook.id),
    ).rejects.toMatchObject({ kind: "encryption_key_missing" });
  });

  it("records webhook_secret_unreadable when the key cannot decrypt at send time", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);
    await insertActivity((await insertProject(ws.id, "SEC1", owner.id)).id, owner.id);
    const wrongKey = createWebhooksService({
      db: database.db,
      encryptionKey: KEY_B,
      allowPrivateUrls: true,
      log: silent,
    });
    await wrongKey.drain();
    const [delivery] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    expect(delivery?.lastError).toBe("webhook_secret_unreadable");
    expect(delivery?.attemptCount).toBe(1);
    expect(delivery?.status).toBe("pending");
  });
});

describe("transactional outbox and envelope", () => {
  it("enqueues a version-1 metadata-only envelope for matching activities", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const project = await insertProject(ws.id, "ENV1", owner.id);
    const issue = await insertIssue(project.id, 7, owner.id);
    await database.db
      .update(issues)
      .set({ body: "SECRET ISSUE MARKDOWN BODY" })
      .where(eq(issues.id, issue.id));
    const hook = await createHook(humanActor(owner.id), ws.id);

    await projectsFeature.service.updateIssue(humanActor(owner.id), issue.id, {
      title: "Issue seven",
    });
    const [delivery] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    expect(delivery?.event).toBe("issue_edited");
    expect(delivery?.activityId).not.toBeNull();
    const payload = WebhookPayload.parse(delivery?.payload);
    expect(payload).toMatchObject({
      id: delivery?.activityId,
      version: 1,
      event: "issue_edited",
      workspaceId: ws.id,
      project: { id: project.id, key: "ENV1", name: "Project ENV1" },
      issue: { number: 7, identifier: "ENV1-7", id: issue.id },
      actor: { kind: "human", id: owner.id },
    });
    expect(JSON.stringify(payload)).not.toContain("SECRET ISSUE MARKDOWN BODY");
    expect(payload["occurredAt"]).toBeDefined();
  });

  it("never widens empty project or event lists to wildcards", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const project = await insertProject(ws.id, "SCP1", owner.id);
    await createHook(humanActor(owner.id), ws.id, { allProjects: false, projectIds: [] });
    await createHook(humanActor(owner.id), ws.id, { allEvents: false, events: [] });
    await insertActivity(project.id, owner.id);
    expect(await database.db.select().from(webhookDeliveries)).toHaveLength(0);
  });

  it("removes transferred projects from the source workspace's webhook scopes without widening", async () => {
    const owner = await insertHuman();
    const source = await personalWorkspace(owner.id);
    const destination = await sharedWorkspace("transfer-dest", owner.id, true);
    const project = await insertProject(source.id, "TRN1", owner.id);
    const sibling = await insertProject(source.id, "TRN2", owner.id);
    const hook = await createHook(humanActor(owner.id), source.id, {
      allProjects: false,
      projectIds: [project.id],
    });
    expect(await database.db.select().from(webhookProjects)).toHaveLength(1);

    await transfers.complete(
      {
        humanId: owner.id,
        email: owner.email,
        isSystemAdministrator: false,
        emailVerifiedAt: new Date(),
      },
      project.id,
      destination.id,
    );

    expect(await database.db.select().from(webhookProjects)).toHaveLength(0);
    const [after] = await database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(after?.allProjects).toBe(false);
    // Neither the transferred project nor a sibling remaining in the source workspace matches.
    await insertActivity(project.id, owner.id);
    await insertActivity(sibling.id, owner.id);
    expect(await database.db.select().from(webhookDeliveries)).toHaveLength(0);
  });
});

describe("SSRF guard and delivery", () => {
  it("blocks private, loopback, metadata, IPv4-mapped, and http URLs by default", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const blocked = [
      "http://example.com/hook",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/hook",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://192.168.1.10/hook",
      "https://100.64.0.1/hook",
    ];
    const receiver = await startReceiver();
    try {
      for (const url of blocked) {
        await createHook(humanActor(owner.id), ws.id, { url });
      }
      await insertActivity((await insertProject(ws.id, "SSRF", owner.id)).id, owner.id);
      await strictService.drain();
      const deliveries = await database.db
        .select()
        .from(webhookDeliveries)
        .orderBy(webhookDeliveries.createdAt);
      expect(deliveries).toHaveLength(blocked.length);
      expect(deliveries.map((delivery) => delivery.lastError)).toEqual(
        blocked.map(() => expect.stringMatching(/^ssrf_blocked/)),
      );
      expect(receiver.received).toHaveLength(0);
    } finally {
      await receiver.close();
    }
  });

  it("rejects redirects and verifies the timestamped HMAC-SHA256 signature", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const receiver = await startReceiver();
    try {
      const hook = await createHook(humanActor(owner.id), ws.id, { url: receiver.url });
      const redirectHook = await createHook(humanActor(owner.id), ws.id, {
        url: receiver.url.replace("/hook", "/redirect"),
      });
      const delivery = await service.test(humanActor(owner.id), ws.id, hook.id);
      const redirectDelivery = await service.test(humanActor(owner.id), ws.id, redirectHook.id);
      await service.drain();

      expect(receiver.received).toHaveLength(2);
      const signed = receiver.received.find(
        (entry) => entry.headers["x-orrery-delivery"] === delivery.id,
      );
      expect(signed).toBeDefined();
      const { body, headers } = signed!;
      const timestamp = headerOf(headers["x-orrery-timestamp"]);
      const signature = headerOf(headers["x-orrery-signature-256"]);
      const expected = createHmac("sha256", hook.signingSecret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      expect(signature).toBe(`sha256=${expected}`);
      expect(headers["x-orrery-event"]).toBe("webhook.test");
      expect(headers["x-orrery-delivery"]).toBe(delivery.id);
      expect(headers["user-agent"]).toBe("Orrery-Webhooks/1");
      expect(headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(body)).toMatchObject({ version: 1, event: "webhook.test" });

      const [failed] = await database.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, redirectDelivery.id));
      expect(failed?.lastError).toBe("http_302");
      expect(failed?.status).toBe("pending");
      expect(
        receiver.received.some(
          (entry) =>
            entry.headers["x-orrery-delivery"] === redirectDelivery.id &&
            entry.headers["x-orrery-event"] === "webhook.test",
        ),
      ).toBe(true);
    } finally {
      await receiver.close();
    }
  });

  it("delivers to a private receiver only when opted in", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const receiver = await startReceiver();
    try {
      await createHook(humanActor(owner.id), ws.id, { url: receiver.url });
      await service.test(
        humanActor(owner.id),
        ws.id,
        (await service.list(humanActor(owner.id), ws.id)).items[0]!.id,
      );
      await service.drain();
      expect(receiver.received).toHaveLength(1);
    } finally {
      await receiver.close();
    }
  });
});

describe("retry, circuit breaker, test events, and maintenance", () => {
  it("retries failures with backoff and resets consecutive failures after a 2xx", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const receiver = await startReceiver();
    try {
      const hook = await createHook(humanActor(owner.id), ws.id, { url: receiver.url });
      await service.test(humanActor(owner.id), ws.id, hook.id);
      receiver.setStatus(500);
      await service.drain();
      let [row] = await database.db.select().from(webhookDeliveries);
      expect(row?.status).toBe("pending");
      expect(row?.attemptCount).toBe(1);
      expect(row?.lastError).toBe("http_500");
      expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 25_000);

      await database.db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: sql`statement_timestamp()` })
        .where(eq(webhookDeliveries.id, row!.id));
      receiver.setStatus(200);
      await database.db
        .update(webhooks)
        .set({ consecutiveFailures: 3 })
        .where(eq(webhooks.id, hook.id));
      await service.drain();
      [row] = await database.db.select().from(webhookDeliveries);
      expect(row?.status).toBe("delivered");
      expect(row?.deliveredAt).not.toBeNull();
      const [after] = await database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
      expect(after?.consecutiveFailures).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  it("exhausts after five attempts and auto-disables after ten failures, but test events never count", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id, { url: "http://127.0.0.1:1/hook" });
    const project = await insertProject(ws.id, "FAIL", owner.id);
    await insertActivity(project.id, owner.id);
    const [delivery] = await database.db.select().from(webhookDeliveries);
    for (let attempt = 0; attempt < 5; attempt++) {
      await database.db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: sql`statement_timestamp()` })
        .where(eq(webhookDeliveries.id, delivery!.id));
      await service.drain();
    }
    let [row] = await database.db.select().from(webhookDeliveries);
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(5);
    let [after] = await database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(after?.consecutiveFailures).toBe(1);

    // Test deliveries never move the circuit breaker.
    await service.test(humanActor(owner.id), ws.id, hook.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      await database.db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: sql`statement_timestamp()` })
        .where(eq(webhookDeliveries.status, "pending"));
      await service.drain();
    }
    [after] = await database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(after?.consecutiveFailures).toBe(1);
    expect(after?.enabled).toBe(true);

    // Nine prior failures + one exhausted delivery disables the webhook.
    await database.db
      .update(webhooks)
      .set({ consecutiveFailures: 9 })
      .where(eq(webhooks.id, hook.id));
    await insertActivity(project.id, owner.id);
    await database.db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: sql`statement_timestamp()` })
      .where(
        eq(
          webhookDeliveries.activityId,
          sql`(select id from project_activity where project_id = ${project.id} order by created_at desc limit 1)`,
        ),
      );
    for (let attempt = 0; attempt < 5; attempt++) {
      await database.db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: sql`statement_timestamp()` })
        .where(eq(webhookDeliveries.status, "pending"));
      await service.drain();
    }
    [after] = await database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toBe("consecutive_failures");
    expect(after?.disabledAt).not.toBeNull();
  });

  it("clears disabled state on re-enable", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);
    await database.db
      .update(webhooks)
      .set({
        enabled: false,
        disabledAt: new Date(),
        disabledReason: "consecutive_failures",
        consecutiveFailures: 10,
      })
      .where(eq(webhooks.id, hook.id));
    const updated = await service.update(humanActor(owner.id), ws.id, hook.id, { enabled: true });
    expect(updated).toMatchObject({
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      consecutiveFailures: 0,
    });
  });

  it("recovers stale delivering leases without inflating the attempt count", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const receiver = await startReceiver();
    try {
      const hook = await createHook(humanActor(owner.id), ws.id, { url: receiver.url });
      await service.test(humanActor(owner.id), ws.id, hook.id);
      await database.db
        .update(webhookDeliveries)
        .set({
          status: "delivering",
          attemptCount: 3,
          lockedUntil: sql`statement_timestamp() - interval '1 minute'`,
        })
        .where(eq(webhookDeliveries.webhookId, hook.id));
      await service.drain();
      const [row] = await database.db.select().from(webhookDeliveries);
      expect(row?.attemptCount).toBe(3);
      expect(row?.status).toBe("delivered");
    } finally {
      await receiver.close();
    }
  });

  it("prunes deliveries older than 30 days", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);
    const fresh = await service.test(humanActor(owner.id), ws.id, hook.id);
    await database.db
      .update(webhookDeliveries)
      .set({ createdAt: sql`statement_timestamp() - interval '31 days'` })
      .where(eq(webhookDeliveries.id, fresh.id));
    const keep = await service.test(humanActor(owner.id), ws.id, hook.id);
    expect(await service.prune()).toBe(1);
    const remaining = await database.db.select().from(webhookDeliveries);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(keep.id);
  });

  it("stops delivering queued non-test deliveries after a webhook is disabled", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const project = await insertProject(ws.id, "DIS1", owner.id);
    const receiver = await startReceiver();
    try {
      const hook = await createHook(humanActor(owner.id), ws.id, { url: receiver.url });
      await insertActivity(project.id, owner.id);
      await service.update(humanActor(owner.id), ws.id, hook.id, { enabled: false });
      await service.drain();
      expect(receiver.received).toHaveLength(0);
      const [row] = await database.db.select().from(webhookDeliveries);
      expect(row?.status).toBe("failed");
      expect(row?.lastError).toBe("webhook_disabled");
      const [after] = await database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
      expect(after?.consecutiveFailures).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  it("preserves consecutive_failures reason when updating an already auto-disabled hook with enabled=false", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);
    await database.db
      .update(webhooks)
      .set({
        enabled: false,
        disabledAt: sql`statement_timestamp()`,
        disabledReason: "consecutive_failures",
        consecutiveFailures: 10,
      })
      .where(eq(webhooks.id, hook.id));
    const updated = await service.update(humanActor(owner.id), ws.id, hook.id, {
      description: "edited while disabled",
      enabled: false,
    });
    expect(updated.disabledReason).toBe("consecutive_failures");
    expect(updated.enabled).toBe(false);
  });

  it("cancels queued and reclaimed source webhook deliveries when a project is transferred", async () => {
    const owner = await insertHuman();
    const source = await personalWorkspace(owner.id);
    const destination = await sharedWorkspace("transfer-stale-dest", owner.id, true);
    const project = await insertProject(source.id, "STAL", owner.id);
    const receiver = await startReceiver();
    try {
      const wildcardHook = await createHook(humanActor(owner.id), source.id, {
        url: receiver.url,
        allProjects: true,
      });
      const scopedHook = await createHook(humanActor(owner.id), source.id, {
        url: receiver.url,
        allProjects: false,
        projectIds: [project.id],
      });

      await insertActivity(project.id, owner.id);
      const pendingBeforeTransfer = await database.db.select().from(webhookDeliveries);
      expect(pendingBeforeTransfer).toHaveLength(2);

      // Also simulate a delivery already in `delivering` (stale lease) when the transfer runs,
      // so drain() reclaims it after the transfer and must still block it at attempt time.
      const reclaimedTarget = pendingBeforeTransfer.find((d) => d.webhookId === wildcardHook.id)!;
      await database.db
        .update(webhookDeliveries)
        .set({
          status: "delivering",
          attemptCount: 1,
          lockedUntil: sql`statement_timestamp() - interval '1 minute'`,
        })
        .where(eq(webhookDeliveries.id, reclaimedTarget.id));

      await transfers.complete(
        {
          humanId: owner.id,
          email: owner.email,
          isSystemAdministrator: false,
          emailVerifiedAt: new Date(),
        },
        project.id,
        destination.id,
      );

      // The pending row was cancelled immediately inside transfers.complete().
      const [scopedRowAfterTransfer] = await database.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, scopedHook.id));
      expect(scopedRowAfterTransfer?.status).toBe("failed");
      expect(scopedRowAfterTransfer?.lastError).toBe("project_transferred");

      // Reclaiming and draining the previously in-flight row must also fail without POSTing.
      await service.drain();
      expect(receiver.received).toHaveLength(0);

      const allDeliveries = await database.db.select().from(webhookDeliveries);
      expect(allDeliveries).toHaveLength(2);
      for (const row of allDeliveries) {
        expect(row.status).toBe("failed");
        expect(row.lastError).toBe("project_transferred");
      }
      const hooksAfter = await database.db
        .select()
        .from(webhooks)
        .where(eq(webhooks.workspaceId, source.id));
      for (const hook of hooksAfter) {
        expect(hook.consecutiveFailures).toBe(0);
      }
    } finally {
      await receiver.close();
    }
  });

  it("stops delivering queued deliveries after webhook project or event scope is narrowed", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const projectA = await insertProject(ws.id, "SCA1", owner.id);
    const projectB = await insertProject(ws.id, "SCB1", owner.id);
    const receiver = await startReceiver();
    try {
      const projectScoped = await createHook(humanActor(owner.id), ws.id, {
        url: receiver.url,
        allProjects: false,
        projectIds: [projectA.id],
        allEvents: true,
      });
      const eventScoped = await createHook(humanActor(owner.id), ws.id, {
        url: receiver.url,
        allProjects: true,
        allEvents: false,
        events: ["project_renamed"],
      });

      await insertActivity(projectA.id, owner.id);
      expect(await database.db.select().from(webhookDeliveries)).toHaveLength(2);

      await service.update(humanActor(owner.id), ws.id, projectScoped.id, {
        projectIds: [projectB.id],
      });
      await service.update(humanActor(owner.id), ws.id, eventScoped.id, {
        events: ["issue_created"],
      });

      await service.drain();
      expect(receiver.received).toHaveLength(0);

      const rows = await database.db.select().from(webhookDeliveries);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("failed");
        expect(row.lastError).toBe("webhook_out_of_scope");
      }
      const hooksAfter = await database.db
        .select()
        .from(webhooks)
        .where(eq(webhooks.workspaceId, ws.id));
      for (const hook of hooksAfter) {
        expect(hook.consecutiveFailures).toBe(0);
      }
    } finally {
      await receiver.close();
    }
  });
});

describe("hardening: DNS pinning, IPv6 SSRF, truncated responses, scope validation, work-sessions, and REST", () => {
  it("blocks raw DNS dotted-quad IPv4-mapped IPv6 and special-use ranges without over-blocking public IPs", () => {
    const blockedCases = [
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.1",
      "0:0:0:0:0:ffff:127.0.0.1",
      "::127.0.0.1",
      "64:ff9b::127.0.0.1",
      "fe80::1%eth0",
      "fc00::1",
      "2001:db8::1",
      "2002:7f00:0001::1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
    ];
    expect(blockedCases.map((addr) => [addr, isBlockedAddress(addr)])).toEqual(
      blockedCases.map((addr) => [addr, true]),
    );
    const publicCases = ["192.0.78.24", "1.1.1.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"];
    expect(publicCases.map((addr) => [addr, isBlockedAddress(addr)])).toEqual(
      publicCases.map((addr) => [addr, false]),
    );
  });

  it("delivers to a hostname via DNS-pinned lookup on Node 26 (autoSelectFamily)", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const receiver = await startReceiver();
    try {
      const localhostUrl = receiver.url.replace("127.0.0.1", "localhost");
      const hook = await createHook(humanActor(owner.id), ws.id, { url: localhostUrl });
      await service.test(humanActor(owner.id), ws.id, hook.id);
      await service.drain();
      expect(receiver.received).toHaveLength(1);
      const [row] = await database.db.select().from(webhookDeliveries);
      expect(row?.status).toBe("delivered");
      expect(row?.lastStatusCode).toBe(200);
    } finally {
      await receiver.close();
    }
  });

  it("settles cleanly without hanging when a receiver truncates the TCP response mid-body", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const tcpServer = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\npartial");
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
    const addr = tcpServer.address();
    if (addr === null || typeof addr === "string") throw new Error("no tcp address");
    try {
      const hook = await createHook(humanActor(owner.id), ws.id, {
        url: `http://127.0.0.1:${addr.port}/hook`,
      });
      await service.test(humanActor(owner.id), ws.id, hook.id);
      await service.drain();
      const [row] = await database.db.select().from(webhookDeliveries);
      expect(row?.status).toBe("pending");
      expect(["aborted", "response_truncated"]).toContain(row?.lastError);
    } finally {
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }
  });

  it("deduplicates duplicate projectIds, rejects foreign projectIds, and checks 404 before 409 on rotateSecret", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const otherWs = await sharedWorkspace("foreign", owner.id);
    const project = await insertProject(ws.id, "DUP1", owner.id);
    const foreignProject = await insertProject(otherWs.id, "FOR1", owner.id);

    const created = await createHook(humanActor(owner.id), ws.id, {
      allProjects: false,
      projectIds: [project.id, project.id],
      allEvents: false,
      events: ["issue_edited", "issue_edited"],
    });
    expect(created.projectIds).toEqual([project.id]);
    expect(created.events).toEqual(["issue_edited"]);

    const updated = await service.update(humanActor(owner.id), ws.id, created.id, {
      allProjects: false,
      projectIds: [project.id, project.id],
    });
    expect(updated.projectIds).toEqual([project.id]);

    await expect(
      createHook(humanActor(owner.id), ws.id, {
        allProjects: false,
        projectIds: [foreignProject.id],
      }),
    ).rejects.toMatchObject({ kind: "invalid_webhook_scope" });

    await expect(
      noKeyService.rotateSecret(humanActor(owner.id), ws.id, "missing-webhook"),
    ).rejects.toMatchObject({ kind: "webhook_not_found" });
  });

  it("enqueues exactly one delivery per review handoff and snapshots todo status on session expiry", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    const project = await insertProject(ws.id, "WSN1", owner.id);
    const issueA = await insertIssue(project.id, 1, owner.id);
    const issueB = await insertIssue(project.id, 2, owner.id);
    const hook = await createHook(humanActor(owner.id), ws.id);

    const agentId = randomUUID();
    await database.db.insert(agents).values({
      id: agentId,
      humanId: owner.id,
      name: "worker-agent",
    });
    const runId = randomUUID();
    await database.db.insert(runs).values({
      id: runId,
      workspaceId: ws.id,
      agentId,
      harness: "test",
      nativeSessionId: randomUUID(),
      status: "active",
    });

    const sessions = createSessionsFeature({
      db: database.db,
      sessionReader: async () => null,
      authenticate: async () => null,
      projectAccessCeiling: async (_tx, _wsId, _hId, ids) =>
        new Map(ids.map((id) => [id, "manage" as const])),
      projectAccessAtLeast: () => true,
      listIssues: async () => [],
      notifyActivity: async () => {},
      onActivity: service.enqueueForActivity,
    }).service;
    const agentIdentity: WorkActor = {
      kind: "agent",
      identity: {
        agentId,
        name: "worker-agent",
        humanId: owner.id,
        keyId: randomUUID(),
        workspaceId: ws.id,
        validity: "never",
        projects: [{ projectId: project.id, projectName: project.name, level: "contribute" }],
      },
    };

    await sessions.claim(agentIdentity, { issueId: issueA.id, runId });
    await sessions.stop(agentIdentity, issueA.id, "review");

    const handoffDeliveries = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    expect(handoffDeliveries).toHaveLength(1);
    expect(handoffDeliveries[0]?.event).toBe("issue_review_handoff");

    await sessions.claim(agentIdentity, { issueId: issueB.id, runId });
    await database.db
      .update(workSessions)
      .set({ leaseExpiresAt: sql`statement_timestamp() - interval '1 minute'` })
      .where(eq(workSessions.issueId, issueB.id));
    await sessions.sweep();

    const allDeliveries = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    const expired = allDeliveries.find((d) => d.event === "issue_session_expired");
    expect(expired).toBeDefined();
    const expiredPayload = WebhookPayload.parse(expired?.payload);
    expect(expiredPayload.issue?.status).toBe("todo");
  });

  it("maps REST auth errors, Problem Details, and embedded-credential URLs accurately", async () => {
    const owner = await insertHuman();
    const ws = await personalWorkspace(owner.id);
    let currentAccount: Extract<WorkActor, { kind: "human" }>["account"] | null = null;
    let authMode: "none" | "revoked" | "agent" = "none";
    const app = createWebhooksRest(
      service,
      async () => currentAccount,
      async () => {
        if (authMode === "revoked") throw new AgentsError("key_revoked");
        if (authMode === "agent") return agentActor.kind === "agent" ? agentActor.identity : null;
        return null;
      },
    );

    const unauth = await app.request(`/api/workspaces/${ws.id}/webhooks`);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("content-type")).toContain("application/problem+json");
    expect(await unauth.json()).toMatchObject({ code: "not_signed_in" });

    authMode = "revoked";
    const revoked = await app.request(`/api/workspaces/${ws.id}/webhooks`);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: "key_revoked" });

    authMode = "agent";
    const asAgent = await app.request(`/api/workspaces/${ws.id}/webhooks`);
    expect(asAgent.status).toBe(403);
    expect(await asAgent.json()).toMatchObject({ code: "agents_cannot_manage_webhooks" });

    authMode = "none";
    currentAccount = {
      humanId: owner.id,
      email: owner.email,
      isSystemAdministrator: false,
      emailVerifiedAt: new Date(),
    };
    const withCreds = await app.request(`/api/workspaces/${ws.id}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://user:pass@example.com/hook",
        allProjects: true,
        allEvents: true,
      }),
    });
    expect(withCreds.status).toBe(400);
    expect(withCreds.headers.get("content-type")).toContain("application/problem+json");

    const ok = await app.request(`/api/workspaces/${ws.id}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/hook",
        description: "rest hook",
        allProjects: true,
        allEvents: true,
      }),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({
      signingSecret: expect.stringMatching(/^whsec_/),
    });
  });
});

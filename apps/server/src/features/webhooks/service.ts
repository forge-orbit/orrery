import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import {
  ProjectActivityType,
  WebhookEvent,
  type CreateWebhookRequest,
  type UpdateWebhookRequest,
  type Webhook,
  type WebhookDeliveriesResponse,
  type WebhookDelivery,
  type WebhookPayload,
  type WebhooksResponse,
  type WebhookWithSecret,
} from "@orrery/contract";
import { and, asc, desc, eq, exists, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  humans,
  issues,
  knowledgeEntries,
  projectActivity,
  projects,
  webhookDeliveries,
  webhookProjects,
  webhooks,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { errorSummary } from "../../platform/errors.ts";
import type { Logger } from "../../platform/log.ts";
import { decryptSecret, encryptSecret } from "../../platform/secrets.ts";
import type { WorkActor } from "../projects/index.ts";

export const MAX_WEBHOOKS_PER_WORKSPACE = 20;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const AUTO_DISABLE_AFTER_FAILURES = 10;
export const DRAIN_BATCH_SIZE = 10;
const DELIVERY_CONCURRENCY = 5;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PREVIEW_CHARS = 512;

/** Milliseconds to wait before attempt N (1-indexed). Attempt 1 is immediate. */
const BACKOFF_MS: readonly (number | null)[] = [
  0,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  null,
];

export type WebhooksErrorKind =
  | "not_signed_in"
  | "agents_cannot_manage_webhooks"
  | "not_workspace_member"
  | "not_workspace_owner"
  | "webhook_not_found"
  | "webhook_limit_reached"
  | "encryption_key_missing"
  | "invalid_webhook_scope";

const messages: Record<WebhooksErrorKind, string> = {
  not_signed_in: "Sign in as a human to manage webhooks.",
  agents_cannot_manage_webhooks: "Agent keys cannot manage webhooks.",
  not_workspace_member: "No such workspace is accessible to the caller.",
  not_workspace_owner: "Only a workspace owner can manage webhooks.",
  webhook_not_found: "No such webhook exists in this workspace.",
  webhook_limit_reached: "This workspace already has the maximum of 20 webhooks.",
  encryption_key_missing:
    "No encryption key is configured, so a signing secret cannot be generated. Set ORRERY_ENCRYPTION_KEY on the server and try again.",
  invalid_webhook_scope: "The selected projects must exist in this workspace.",
};

export class WebhooksError extends Error {
  readonly kind: WebhooksErrorKind;

  constructor(kind: WebhooksErrorKind) {
    super(messages[kind]);
    this.name = "WebhooksError";
    this.kind = kind;
  }
}

class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Writes the outbox for a project activity inside the transaction that wrote the activity. */
export type EnqueueWebhookActivity = (tx: DbTransaction, activityId: string) => Promise<void>;

export interface WebhooksDeps {
  db: PostgresJsDatabase;
  encryptionKey: Buffer | undefined;
  allowPrivateUrls: boolean;
  log: Logger;
}

export interface WebhooksService {
  list(actor: WorkActor | null, workspaceId: string): Promise<WebhooksResponse>;
  create(
    actor: WorkActor | null,
    workspaceId: string,
    input: CreateWebhookRequest,
  ): Promise<WebhookWithSecret>;
  update(
    actor: WorkActor | null,
    workspaceId: string,
    webhookId: string,
    input: UpdateWebhookRequest,
  ): Promise<Webhook>;
  rotateSecret(
    actor: WorkActor | null,
    workspaceId: string,
    webhookId: string,
  ): Promise<WebhookWithSecret>;
  remove(actor: WorkActor | null, workspaceId: string, webhookId: string): Promise<void>;
  test(actor: WorkActor | null, workspaceId: string, webhookId: string): Promise<WebhookDelivery>;
  deliveries(
    actor: WorkActor | null,
    workspaceId: string,
    webhookId: string,
  ): Promise<WebhookDeliveriesResponse>;
  enqueueForActivity: EnqueueWebhookActivity;
  /** Attempt due deliveries. Returns the number of rows claimed. */
  drain(): Promise<number>;
  prune(): Promise<number>;
  /** Set by the feature to wake the worker right after a local enqueue. */
  setWakeup(fn: () => void): void;
}

type DeliveryAttemptResult =
  | { ok: true; status: number }
  | { ok: false; error: string; status?: number; terminal?: boolean; skipCircuitBreaker?: boolean };

type Queryable = Pick<DbTransaction, "select">;

function parseIpv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function parseIpv6SegmentList(segment: string, allowTrailingIpv4: boolean): number[] | null {
  if (segment === "") return [];
  const parts = segment.split(":");
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (allowTrailingIpv4 && i === parts.length - 1 && part.includes(".")) {
      const octets = parseIpv4Octets(part);
      if (octets === null) return null;
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
  }
  return groups;
}

function expandIpv6(raw: string): number[] | null {
  const stripped =
    raw
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  if (stripped === "") return null;
  const halves = stripped.split("::");
  if (halves.length > 2) return null;

  if (halves.length === 1) {
    const groups = parseIpv6SegmentList(halves[0]!, true);
    return groups !== null && groups.length === 8 ? groups : null;
  }

  const head = parseIpv6SegmentList(halves[0]!, false);
  const tail = parseIpv6SegmentList(halves[1]!, true);
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function embeddedIpv4Blocked(high: number, low: number): boolean {
  return isBlockedAddress(
    `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
  );
}

/**
 * Returns true if the IP literal is non-public or special-use per RFC 6890 and ADR-0007.
 * Handles both URL-normalized IPv6 and raw libc/DNS dotted-quad forms like `::ffff:127.0.0.1`.
 */
export function isBlockedAddress(address: string): boolean {
  const normalized = address.trim().replace(/^\[|\]$/g, "");
  const withoutZone = normalized.split("%")[0] ?? "";
  const kind = isIP(withoutZone);
  if (kind === 6) {
    const groups = expandIpv6(normalized);
    if (groups === null || groups.length !== 8) return true;
    const g0 = groups[0]!;
    const g1 = groups[1]!;
    const g2 = groups[2]!;
    const g3 = groups[3]!;
    const g4 = groups[4]!;
    const g5 = groups[5]!;
    const g6 = groups[6]!;
    const g7 = groups[7]!;

    // ::/96 covers unspecified (::), loopback (::1), and deprecated IPv4-compatible addresses.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
    // IPv4-mapped ::ffff:0:0/96: evaluate embedded IPv4 address.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return embeddedIpv4Blocked(g6, g7);
    }
    // IPv4-translated ::ffff:0:0:0/96.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
    // Discard-Only 100::/64.
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48.
    if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return true;
    }
    if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) return true;
    // Teredo 2001:0000::/32 and documentation 2001:db8::/32.
    if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8)) return true;
    // 6to4 2002::/16.
    if (g0 === 0x2002) return true;
    // Unique local fc00::/7.
    if ((g0 & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10.
    if ((g0 & 0xffc0) === 0xfe80) return true;
    // Deprecated site-local fec0::/10.
    if ((g0 & 0xffc0) === 0xfec0) return true;
    // Multicast ff00::/8.
    if ((g0 & 0xff00) === 0xff00) return true;
    return false;
  }
  if (kind !== 4) return true;
  const octets = parseIpv4Octets(withoutZone);
  if (octets === null) return true;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local & cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol & TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

async function lookupWithTimeout(hostname: string, timeoutMs: number): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolvePinnedAddresses(
  url: URL,
  allowPrivateUrls: boolean,
): Promise<LookupAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const ipFamily = isIP(hostname);
  if (ipFamily !== 0) {
    if (!allowPrivateUrls && isBlockedAddress(hostname)) {
      throw new SsrfBlockedError("blocked address");
    }
    return [{ address: hostname, family: ipFamily }];
  }
  const resolved = await lookupWithTimeout(hostname, DELIVERY_TIMEOUT_MS);
  if (resolved.length === 0) throw new Error("no addresses");
  if (!allowPrivateUrls && resolved.some((entry) => isBlockedAddress(entry.address))) {
    throw new SsrfBlockedError("blocked address");
  }
  return resolved.map((entry) => ({
    address: entry.address,
    family: entry.family || isIP(entry.address),
  }));
}

function sanitizeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, PREVIEW_CHARS);
}

const noWakeup = () => {};

function toWebhook(row: typeof webhooks.$inferSelect, projectIds: string[]): Webhook {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    description: row.description,
    allProjects: row.allProjects,
    projectIds,
    allEvents: row.allEvents,
    events: row.events.map((event) => ProjectActivityType.parse(event)),
    enabled: row.enabled,
    consecutiveFailures: row.consecutiveFailures,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertWebhookInWorkspace(
  q: Queryable,
  workspaceId: string,
  webhookId: string,
): Promise<typeof webhooks.$inferSelect> {
  const [row] = await q
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.workspaceId, workspaceId)))
    .limit(1);
  if (row === undefined) throw new WebhooksError("webhook_not_found");
  return row;
}

async function loadWebhook(q: Queryable, webhookId: string): Promise<Webhook> {
  const [row] = await q.select().from(webhooks).where(eq(webhooks.id, webhookId)).limit(1);
  if (row === undefined) throw new WebhooksError("webhook_not_found");
  const projectRows = await q
    .select({ projectId: webhookProjects.projectId })
    .from(webhookProjects)
    .innerJoin(projects, eq(webhookProjects.projectId, projects.id))
    .where(and(eq(webhookProjects.webhookId, webhookId), isNull(projects.deletedAt)))
    .orderBy(asc(webhookProjects.projectId));
  return toWebhook(
    row,
    projectRows.map((entry) => entry.projectId),
  );
}

function toDelivery(row: typeof webhookDeliveries.$inferSelect): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    event: WebhookEvent.parse(row.event),
    activityId: row.activityId,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastStatusCode: row.lastStatusCode,
    lastDurationMs: row.lastDurationMs,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function buildEnvelope(
  tx: DbTransaction,
  activity: typeof projectActivity.$inferSelect,
  project: { id: string; key: string; name: string; workspaceId: string },
): Promise<WebhookPayload> {
  let issue: WebhookPayload["issue"] = null;
  if (activity.issueId !== null) {
    const [row] = await tx
      .select({ id: issues.id, number: issues.number, title: issues.title, status: issues.status })
      .from(issues)
      .where(eq(issues.id, activity.issueId))
      .limit(1);
    if (row !== undefined) {
      issue = {
        id: row.id,
        number: row.number,
        identifier: `${project.key}-${row.number}`,
        title: row.title,
        status: row.status,
      };
    }
  }

  let knowledgeEntry: WebhookPayload["knowledgeEntry"] = null;
  if (activity.knowledgeEntryId !== null) {
    const [row] = await tx
      .select({ id: knowledgeEntries.id, title: knowledgeEntries.title })
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.id, activity.knowledgeEntryId))
      .limit(1);
    if (row !== undefined) knowledgeEntry = { id: row.id, title: row.title };
  }

  let actor: WebhookPayload["actor"] = { kind: "system", id: null, displayName: "System" };
  if (activity.actorHumanId !== null) {
    const [row] = await tx
      .select({ id: humans.id, displayName: humans.displayName, email: humans.email })
      .from(humans)
      .where(eq(humans.id, activity.actorHumanId))
      .limit(1);
    if (row !== undefined) {
      actor = { kind: "human", id: row.id, displayName: row.displayName ?? row.email };
    }
  } else if (activity.actorAgentId !== null) {
    const [row] = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, activity.actorAgentId))
      .limit(1);
    if (row !== undefined) actor = { kind: "agent", id: row.id, displayName: row.name };
  }

  return {
    id: activity.id,
    version: 1,
    event: WebhookEvent.parse(activity.type),
    occurredAt: activity.createdAt.toISOString(),
    workspaceId: project.workspaceId,
    project: { id: project.id, key: project.key, name: project.name },
    issue,
    knowledgeEntry,
    actor,
    summary: activity.summary,
  };
}

async function performHttpDelivery(
  url: URL,
  secret: string,
  delivery: typeof webhookDeliveries.$inferSelect,
  pinnedAddresses: readonly LookupAddress[],
): Promise<DeliveryAttemptResult> {
  const rawBody = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const headers: Record<string, string | number> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "Orrery-Webhooks/1",
    "x-orrery-delivery": delivery.id,
    "x-orrery-event": delivery.event,
    "x-orrery-timestamp": timestamp,
    "x-orrery-signature-256": `sha256=${signature}`,
    "content-length": Buffer.byteLength(rawBody),
  };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Pinned lookup: resolve and validate DNS first, then connect only to those exact
  // validated addresses so a DNS rebind cannot redirect the delivery. Passing all validated
  // entries when `options.all` is set preserves Node 26 Happy Eyeballs fallback on dual-stack hosts.
  const lookup = (
    _hostname: string,
    options: LookupOptions,
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    if (options.all) {
      callback(
        null,
        pinnedAddresses.map((entry) => ({ address: entry.address, family: entry.family })),
      );
      return;
    }
    const preferred =
      typeof options.family === "number" && options.family !== 0
        ? (pinnedAddresses.find((entry) => entry.family === options.family) ?? pinnedAddresses[0]!)
        : pinnedAddresses[0]!;
    callback(null, preferred.address, preferred.family);
  };
  const transport = url.protocol === "http:" ? http : https;
  return await new Promise<DeliveryAttemptResult>((resolve) => {
    let settled = false;
    const finish = (result: DeliveryAttemptResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = transport.request(
      url,
      {
        method: "POST",
        headers,
        agent: false,
        lookup,
        servername: isIP(hostname) === 0 ? hostname : undefined,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      },
      (response) => {
        // Redirects are never followed: any 3xx is a failed delivery.
        const status = response.statusCode ?? 0;
        const statusResult: DeliveryAttemptResult =
          status >= 200 && status < 300
            ? { ok: true, status }
            : { ok: false, status, error: `http_${status}` };
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(statusResult);
            response.destroy();
          }
        });
        response.on("end", () => finish(statusResult));
        response.on("error", (error: Error) => {
          finish({ ok: false, status, error: sanitizeError(error.message || "response_error") });
        });
        response.on("close", () => {
          finish(
            response.complete ? statusResult : { ok: false, status, error: "response_truncated" },
          );
        });
      },
    );
    request.on("error", (error: Error) => {
      finish({ ok: false, error: sanitizeError(error.message || "network_error") });
    });
    request.end(rawBody);
  });
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const count = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (index < items.length) {
        const current = items[index]!;
        index += 1;
        await worker(current);
      }
    }),
  );
}

/**
 * Resolve the caller and assert workspace ownership inside the active query/transaction.
 * Never reveals membership to outsiders. Optionally locks the workspace row to serialize
 * webhook creation against the per-workspace cap.
 */
async function requireOwner(
  tx: DbTransaction,
  actor: WorkActor | null,
  workspaceId: string,
  lockWorkspace = false,
): Promise<string> {
  if (actor === null) throw new WebhooksError("not_signed_in");
  if (actor.kind === "agent") throw new WebhooksError("agents_cannot_manage_webhooks");
  const humanId = actor.account.humanId;
  const baseQuery = tx
    .select({ kind: workspaces.kind, personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const [workspace] = await (lockWorkspace ? baseQuery.for("update") : baseQuery);
  if (workspace === undefined) throw new WebhooksError("not_workspace_member");
  if (workspace.kind === "personal") {
    if (workspace.personalOwnerHumanId !== humanId) throw new WebhooksError("not_workspace_member");
    return humanId;
  }
  const [membership] = await tx
    .select({
      isOwner: workspaceMemberships.isOwner,
      suspendedAt: workspaceMemberships.suspendedAt,
    })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
      ),
    )
    .limit(1);
  if (membership === undefined || membership.suspendedAt !== null) {
    throw new WebhooksError("not_workspace_member");
  }
  if (!membership.isOwner) throw new WebhooksError("not_workspace_owner");
  return humanId;
}

export function createWebhooksService(deps: WebhooksDeps): WebhooksService {
  const { db, encryptionKey, log, allowPrivateUrls } = deps;
  let wakeup: () => void = noWakeup;

  const enqueueForActivity: EnqueueWebhookActivity = async (tx, activityId) => {
    const [activity] = await tx
      .select()
      .from(projectActivity)
      .where(eq(projectActivity.id, activityId))
      .limit(1);
    if (activity === undefined) return;
    const [project] = await tx
      .select({
        id: projects.id,
        key: projects.key,
        name: projects.name,
        workspaceId: projects.workspaceId,
        deletedAt: projects.deletedAt,
      })
      .from(projects)
      .where(eq(projects.id, activity.projectId))
      .limit(1);
    if (project === undefined) return;

    const event = WebhookEvent.parse(activity.type);
    if (project.deletedAt !== null && event !== "project_deleted") return;
    const matching = await tx
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.workspaceId, project.workspaceId),
          eq(webhooks.enabled, true),
          or(
            eq(webhooks.allProjects, true),
            exists(
              tx
                .select({ id: webhookProjects.webhookId })
                .from(webhookProjects)
                .where(
                  and(
                    eq(webhookProjects.webhookId, webhooks.id),
                    eq(webhookProjects.projectId, project.id),
                  ),
                ),
            ),
          ),
          or(eq(webhooks.allEvents, true), sql`${event} = any(${webhooks.events})`),
        ),
      );
    if (matching.length === 0) return;

    const payload = await buildEnvelope(tx, activity, project);
    await tx
      .insert(webhookDeliveries)
      .values(
        matching.map((hook) => ({
          id: randomUUID(),
          webhookId: hook.id,
          event: payload.event,
          activityId,
          payload,
          status: "pending" as const,
          nextAttemptAt: sql`statement_timestamp()`,
        })),
      )
      .onConflictDoNothing();
    // Defer wakeup until after the enclosing transaction has had a chance to commit;
    // the 2s background poll also catches anything whose commit takes longer.
    const timer = setTimeout(() => wakeup(), 25);
    timer.unref();
  };

  const attempt = async (
    hook: typeof webhooks.$inferSelect,
    delivery: typeof webhookDeliveries.$inferSelect,
  ): Promise<DeliveryAttemptResult> => {
    if (!hook.enabled && delivery.event !== "webhook.test") {
      return {
        ok: false,
        error: "webhook_disabled",
        terminal: true,
        skipCircuitBreaker: true,
      };
    }
    if (delivery.event !== "webhook.test") {
      if (!hook.allEvents && !hook.events.includes(delivery.event)) {
        return {
          ok: false,
          error: "webhook_out_of_scope",
          terminal: true,
          skipCircuitBreaker: true,
        };
      }
      if (delivery.activityId === null) {
        return {
          ok: false,
          error: "webhook_out_of_scope",
          terminal: true,
          skipCircuitBreaker: true,
        };
      }
      const [target] = await db
        .select({
          projectId: projects.id,
          workspaceId: projects.workspaceId,
          deletedAt: projects.deletedAt,
          activityType: projectActivity.type,
        })
        .from(projectActivity)
        .innerJoin(projects, eq(projects.id, projectActivity.projectId))
        .where(eq(projectActivity.id, delivery.activityId))
        .limit(1);
      if (target === undefined || target.workspaceId !== hook.workspaceId) {
        return {
          ok: false,
          error: "project_transferred",
          terminal: true,
          skipCircuitBreaker: true,
        };
      }
      if (target.deletedAt !== null && target.activityType !== "project_deleted") {
        return {
          ok: false,
          error: "project_trashed",
          terminal: true,
          skipCircuitBreaker: true,
        };
      }
      if (!hook.allProjects) {
        const [inScope] = await db
          .select({ projectId: webhookProjects.projectId })
          .from(webhookProjects)
          .where(
            and(
              eq(webhookProjects.webhookId, hook.id),
              eq(webhookProjects.projectId, target.projectId),
            ),
          )
          .limit(1);
        if (inScope === undefined) {
          return {
            ok: false,
            error: "webhook_out_of_scope",
            terminal: true,
            skipCircuitBreaker: true,
          };
        }
      }
    }
    if (encryptionKey === undefined) return { ok: false, error: "webhook_secret_unreadable" };
    const secret = decryptSecret(encryptionKey, hook.secretEncrypted);
    if (secret === undefined) return { ok: false, error: "webhook_secret_unreadable" };
    let url: URL;
    try {
      url = new URL(hook.url);
    } catch {
      return { ok: false, error: "invalid_url" };
    }
    if (url.protocol !== "https:" && !(allowPrivateUrls && url.protocol === "http:")) {
      return { ok: false, error: "ssrf_blocked_scheme" };
    }
    let pinned: LookupAddress[];
    try {
      pinned = await resolvePinnedAddresses(url, allowPrivateUrls);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        return { ok: false, error: "ssrf_blocked" };
      }
      return { ok: false, error: "dns_lookup_failed" };
    }
    return await performHttpDelivery(url, secret, delivery, pinned);
  };

  const finalize = async (
    delivery: typeof webhookDeliveries.$inferSelect,
    result: DeliveryAttemptResult,
    durationMs: number,
  ): Promise<void> => {
    const safeDurationMs = Math.max(0, Math.round(durationMs));
    const leaseMatches =
      delivery.lockedUntil === null
        ? and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, "delivering"))
        : and(
            eq(webhookDeliveries.id, delivery.id),
            eq(webhookDeliveries.status, "delivering"),
            eq(webhookDeliveries.lockedUntil, delivery.lockedUntil),
          );
    await db.transaction(async (tx) => {
      if (result.ok) {
        const [updatedDelivery] = await tx
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            deliveredAt: sql`statement_timestamp()`,
            lockedUntil: null,
            lastStatusCode: result.status,
            lastDurationMs: safeDurationMs,
            lastError: null,
          })
          .where(leaseMatches)
          .returning({ id: webhookDeliveries.id });
        if (updatedDelivery === undefined) return;
        await tx
          .update(webhooks)
          .set({ consecutiveFailures: 0 })
          .where(eq(webhooks.id, delivery.webhookId));
        return;
      }

      const exhausted = result.terminal === true || delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS;
      const delay =
        delivery.attemptCount < BACKOFF_MS.length
          ? (BACKOFF_MS[delivery.attemptCount] ?? null)
          : null;
      const nextAttemptExpr =
        exhausted || delay === null
          ? delivery.nextAttemptAt
          : sql`statement_timestamp() + make_interval(secs => ${delay / 1000})`;
      const [updatedDelivery] = await tx
        .update(webhookDeliveries)
        .set({
          status: exhausted ? "failed" : "pending",
          nextAttemptAt: nextAttemptExpr,
          lockedUntil: null,
          lastStatusCode: result.status ?? null,
          lastDurationMs: safeDurationMs,
          lastError: sanitizeError(result.error),
        })
        .where(leaseMatches)
        .returning({ id: webhookDeliveries.id });
      if (updatedDelivery === undefined) return;

      // Synthetic test deliveries and disabled-webhook cancellations never drive the circuit breaker.
      if (!exhausted || delivery.event === "webhook.test" || result.skipCircuitBreaker === true) {
        return;
      }
      const [updated] = await tx
        .update(webhooks)
        .set({ consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1` })
        .where(eq(webhooks.id, delivery.webhookId))
        .returning({ value: webhooks.consecutiveFailures });
      if (updated !== undefined && updated.value >= AUTO_DISABLE_AFTER_FAILURES) {
        await tx
          .update(webhooks)
          .set({
            enabled: false,
            disabledAt: sql`statement_timestamp()`,
            disabledReason: "consecutive_failures",
            updatedAt: sql`statement_timestamp()`,
          })
          .where(and(eq(webhooks.id, delivery.webhookId), eq(webhooks.enabled, true)));
      }
    });
  };

  return {
    enqueueForActivity,

    setWakeup(fn) {
      wakeup = fn;
    },

    async list(actor, workspaceId) {
      return db.transaction(
        async (tx) => {
          await requireOwner(tx, actor, workspaceId);
          const rows = await tx
            .select()
            .from(webhooks)
            .where(eq(webhooks.workspaceId, workspaceId))
            .orderBy(desc(webhooks.createdAt), desc(webhooks.id));
          if (rows.length === 0) return { items: [] };
          const scopeRows = await tx
            .select({
              webhookId: webhookProjects.webhookId,
              projectId: webhookProjects.projectId,
            })
            .from(webhookProjects)
            .innerJoin(projects, eq(webhookProjects.projectId, projects.id))
            .where(
              and(
                inArray(
                  webhookProjects.webhookId,
                  rows.map((row) => row.id),
                ),
                isNull(projects.deletedAt),
              ),
            )
            .orderBy(asc(webhookProjects.projectId));
          const projectsByWebhook = new Map<string, string[]>();
          for (const entry of scopeRows) {
            const list = projectsByWebhook.get(entry.webhookId);
            if (list === undefined) projectsByWebhook.set(entry.webhookId, [entry.projectId]);
            else list.push(entry.projectId);
          }
          return {
            items: rows.map((row) => toWebhook(row, projectsByWebhook.get(row.id) ?? [])),
          };
        },
        { accessMode: "read only" },
      );
    },

    async create(actor, workspaceId, input) {
      return db.transaction(async (tx) => {
        const humanId = await requireOwner(tx, actor, workspaceId, true);
        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(webhooks)
          .where(eq(webhooks.workspaceId, workspaceId));
        if ((count?.value ?? 0) >= MAX_WEBHOOKS_PER_WORKSPACE) {
          throw new WebhooksError("webhook_limit_reached");
        }
        const uniqueProjectIds = [...new Set(input.projectIds)];
        const uniqueEvents = [...new Set(input.events)];
        if (!input.allProjects && uniqueProjectIds.length > 0) {
          const inWorkspace = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.workspaceId, workspaceId),
                inArray(projects.id, uniqueProjectIds),
                isNull(projects.deletedAt),
              ),
            );
          if (inWorkspace.length !== uniqueProjectIds.length) {
            throw new WebhooksError("invalid_webhook_scope");
          }
        }
        if (encryptionKey === undefined) throw new WebhooksError("encryption_key_missing");
        const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
        const id = randomUUID();
        await tx.insert(webhooks).values({
          id,
          workspaceId,
          url: input.url,
          description: input.description,
          secretEncrypted: encryptSecret(encryptionKey, signingSecret),
          allProjects: input.allProjects,
          allEvents: input.allEvents,
          events: uniqueEvents,
          createdByHumanId: humanId,
          updatedByHumanId: humanId,
          createdAt: sql`statement_timestamp()`,
          updatedAt: sql`statement_timestamp()`,
        });
        if (!input.allProjects && uniqueProjectIds.length > 0) {
          await tx
            .insert(webhookProjects)
            .values(uniqueProjectIds.map((projectId) => ({ webhookId: id, projectId })));
        }
        return { ...(await loadWebhook(tx, id)), signingSecret };
      });
    },

    async update(actor, workspaceId, webhookId, input) {
      return db.transaction(async (tx) => {
        const humanId = await requireOwner(tx, actor, workspaceId);
        const [existing] = await tx
          .select()
          .from(webhooks)
          .where(and(eq(webhooks.id, webhookId), eq(webhooks.workspaceId, workspaceId)))
          .limit(1)
          .for("update");
        if (existing === undefined) throw new WebhooksError("webhook_not_found");

        const set: {
          updatedByHumanId: string;
          updatedAt: ReturnType<typeof sql>;
          url?: string;
          description?: string;
          allProjects?: boolean;
          allEvents?: boolean;
          events?: string[];
          enabled?: boolean;
          disabledAt?: ReturnType<typeof sql> | null;
          disabledReason?: string | null;
          consecutiveFailures?: number;
        } = {
          updatedByHumanId: humanId,
          updatedAt: sql`statement_timestamp()`,
        };
        if (input.url !== undefined) set.url = input.url;
        if (input.description !== undefined) set.description = input.description;
        if (input.allProjects !== undefined) set.allProjects = input.allProjects;
        if (input.allEvents !== undefined) set.allEvents = input.allEvents;
        if (input.events !== undefined) set.events = [...new Set(input.events)];
        if (input.enabled !== undefined) {
          set.enabled = input.enabled;
          if (input.enabled) {
            set.disabledAt = null;
            set.disabledReason = null;
            set.consecutiveFailures = 0;
          } else if (existing.enabled) {
            set.disabledAt = sql`statement_timestamp()`;
            set.disabledReason = "disabled_by_owner";
          }
        }
        await tx.update(webhooks).set(set).where(eq(webhooks.id, webhookId));

        const effectiveAllProjects = input.allProjects ?? existing.allProjects;
        if (input.projectIds !== undefined || input.allProjects === true) {
          const uniqueProjectIds =
            input.projectIds === undefined ? [] : [...new Set(input.projectIds)];
          if (!effectiveAllProjects && uniqueProjectIds.length > 0) {
            const inWorkspace = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(
                and(
                  eq(projects.workspaceId, workspaceId),
                  inArray(projects.id, uniqueProjectIds),
                  isNull(projects.deletedAt),
                ),
              );
            if (inWorkspace.length !== uniqueProjectIds.length) {
              throw new WebhooksError("invalid_webhook_scope");
            }
          }
          await tx.delete(webhookProjects).where(eq(webhookProjects.webhookId, webhookId));
          if (!effectiveAllProjects && uniqueProjectIds.length > 0) {
            await tx
              .insert(webhookProjects)
              .values(uniqueProjectIds.map((projectId) => ({ webhookId, projectId })));
          }
        }
        return loadWebhook(tx, webhookId);
      });
    },

    async rotateSecret(actor, workspaceId, webhookId) {
      return db.transaction(async (tx) => {
        const humanId = await requireOwner(tx, actor, workspaceId);
        await assertWebhookInWorkspace(tx, workspaceId, webhookId);
        if (encryptionKey === undefined) throw new WebhooksError("encryption_key_missing");
        const signingSecret = `whsec_${randomBytes(32).toString("base64url")}`;
        await tx
          .update(webhooks)
          .set({
            secretEncrypted: encryptSecret(encryptionKey, signingSecret),
            updatedByHumanId: humanId,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(webhooks.id, webhookId));
        return { ...(await loadWebhook(tx, webhookId)), signingSecret };
      });
    },

    async remove(actor, workspaceId, webhookId) {
      await db.transaction(async (tx) => {
        await requireOwner(tx, actor, workspaceId);
        await assertWebhookInWorkspace(tx, workspaceId, webhookId);
        await tx.delete(webhooks).where(eq(webhooks.id, webhookId));
      });
    },

    async test(actor, workspaceId, webhookId) {
      const delivery = await db.transaction(async (tx) => {
        await requireOwner(tx, actor, workspaceId);
        await assertWebhookInWorkspace(tx, workspaceId, webhookId);
        const payload: WebhookPayload = {
          id: randomUUID(),
          version: 1,
          event: "webhook.test",
          occurredAt: new Date().toISOString(),
          workspaceId,
          project: { id: "", key: "TEST", name: "Webhook test" },
          issue: null,
          knowledgeEntry: null,
          actor: { kind: "system", id: null, displayName: "System" },
          summary: "Synthetic webhook test event.",
        };
        const id = randomUUID();
        const [row] = await tx
          .insert(webhookDeliveries)
          .values({
            id,
            webhookId,
            event: "webhook.test",
            activityId: null,
            payload,
            status: "pending",
            nextAttemptAt: sql`statement_timestamp()`,
          })
          .returning();
        if (row === undefined) throw new WebhooksError("webhook_not_found");
        return toDelivery(row);
      });
      wakeup();
      return delivery;
    },

    async deliveries(actor, workspaceId, webhookId) {
      return db.transaction(
        async (tx) => {
          await requireOwner(tx, actor, workspaceId);
          await assertWebhookInWorkspace(tx, workspaceId, webhookId);
          const rows = await tx
            .select()
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.webhookId, webhookId))
            .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
            .limit(50);
          return { items: rows.map(toDelivery) };
        },
        { accessMode: "read only" },
      );
    },

    async drain() {
      const claimed = await db.transaction(async (tx) => {
        const due = await tx
          .select()
          .from(webhookDeliveries)
          .where(
            or(
              and(
                eq(webhookDeliveries.status, "pending"),
                lte(webhookDeliveries.nextAttemptAt, sql`statement_timestamp()`),
              ),
              and(
                eq(webhookDeliveries.status, "delivering"),
                lte(webhookDeliveries.lockedUntil, sql`statement_timestamp()`),
              ),
            ),
          )
          .orderBy(asc(webhookDeliveries.nextAttemptAt))
          .limit(DRAIN_BATCH_SIZE)
          .for("update", { skipLocked: true });
        const result: typeof due = [];
        for (const row of due) {
          const attemptCount = row.status === "pending" ? row.attemptCount + 1 : row.attemptCount;
          const [claimedRow] = await tx
            .update(webhookDeliveries)
            .set({
              status: "delivering",
              attemptCount,
              lockedUntil: sql`date_trunc('milliseconds', statement_timestamp() + interval '2 minutes')`,
            })
            .where(eq(webhookDeliveries.id, row.id))
            .returning();
          if (claimedRow !== undefined) result.push(claimedRow);
        }
        return result;
      });

      await runWithConcurrency(claimed, DELIVERY_CONCURRENCY, async (delivery) => {
        try {
          const [hook] = await db
            .select()
            .from(webhooks)
            .where(eq(webhooks.id, delivery.webhookId))
            .limit(1);
          if (hook === undefined) {
            await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
            return;
          }
          const started = Date.now();
          const result = await attempt(hook, delivery);
          await finalize(delivery, result, Date.now() - started);
        } catch (error) {
          log.warn("webhook delivery attempt failed unexpectedly", {
            deliveryId: delivery.id,
            ...errorSummary(error),
          });
          try {
            await finalize(delivery, { ok: false, error: "internal_error" }, 0);
          } catch (finalizeError) {
            log.warn("webhook delivery fallback finalize failed", {
              deliveryId: delivery.id,
              ...errorSummary(finalizeError),
            });
          }
        }
      });
      return claimed.length;
    },

    async prune() {
      return db.transaction(async (tx) => {
        const removed = await tx
          .delete(webhookDeliveries)
          .where(lte(webhookDeliveries.createdAt, sql`statement_timestamp() - interval '30 days'`))
          .returning({ id: webhookDeliveries.id });
        return removed.length;
      });
    },
  };
}

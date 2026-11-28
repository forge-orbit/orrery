import { randomUUID } from "node:crypto";
import { NotificationKind, type NotificationsResponse } from "@orrery/contract";
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQLWrapper } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  agents,
  humans,
  issues,
  notifications,
  projectAccessGrants,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import type { WorkActor } from "../projects/index.ts";

export type NotificationsErrorKind =
  | "not_signed_in"
  | "agents_cannot_use_notifications"
  | "invalid_cursor"
  | "notification_not_found";

const messages: Record<NotificationsErrorKind, string> = {
  not_signed_in: "Sign in as a human to read notifications.",
  agents_cannot_use_notifications: "Only humans may use notifications.",
  invalid_cursor: "The pagination cursor is invalid.",
  notification_not_found: "No such notification is accessible to the caller.",
};

export class NotificationsError extends Error {
  readonly kind: NotificationsErrorKind;

  constructor(kind: NotificationsErrorKind) {
    super(messages[kind]);
    this.name = "NotificationsError";
    this.kind = kind;
  }
}

export interface NotificationsDeps {
  db: PostgresJsDatabase;
}

export interface ActivityNotificationInput {
  activityId: string;
  projectId: string;
  issueId: string;
  kind: NotificationKind;
  summary: string;
  actorHumanId?: string | null;
  actorAgentId?: string | null;
  /** Handles struck from a Markdown body; only Humans with live Read access are notified. */
  mentionHandles?: readonly string[];
}

/**
 * Writes the notifications for a project activity inside the very same transaction that
 * wrote the activity row. Every feature that records a notifiable activity calls this.
 */
export type NotifyActivity = (tx: DbTransaction, input: ActivityNotificationInput) => Promise<void>;

export interface ListNotificationsInput {
  unreadOnly?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface NotificationsService {
  createForActivity: NotifyActivity;
  list(actor: WorkActor | null, input?: ListNotificationsInput): Promise<NotificationsResponse>;
  markRead(actor: WorkActor | null, notificationId: string): Promise<void>;
  markAllRead(actor: WorkActor | null): Promise<number>;
  prune(): Promise<number>;
}

const Cursor = z.object({ createdAt: z.iso.datetime(), id: z.string().min(1) });
type Cursor = z.infer<typeof Cursor>;

const encodeCursor = (row: { createdAtCursor: string; id: string }): string =>
  Buffer.from(JSON.stringify({ createdAt: row.createdAtCursor, id: row.id }), "utf8").toString(
    "base64url",
  );

function decodeCursor(value: string): Cursor {
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown);
  } catch {
    throw new NotificationsError("invalid_cursor");
  }
}

function requireHumanId(actor: WorkActor | null): string {
  if (actor === null) throw new NotificationsError("not_signed_in");
  if (actor.kind === "agent") throw new NotificationsError("agents_cannot_use_notifications");
  return actor.account.humanId;
}

async function callerIsActive(tx: DbTransaction, humanId: string): Promise<boolean> {
  const [caller] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .limit(1);
  return caller !== undefined;
}

/**
 * Live Read access resolved in SQL through the notification's current project and workspace:
 * a personal-workspace owner, or an active (non-suspended) shared-workspace owner/member with
 * a project grant. Project transfers are reflected immediately because the join uses the
 * project's current workspace_id; there is no denormalized workspace id to go stale.
 */
const readableAccess = (humanId: string | SQLWrapper) =>
  sql`${projects.deletedAt} is null and exists (
    select 1 from ${workspaces}
    where ${workspaces.id} = ${projects.workspaceId}
      and (
        ${workspaces.personalOwnerHumanId} = ${humanId}
        or exists (
          select 1 from ${workspaceMemberships}
          where ${workspaceMemberships.workspaceId} = ${workspaces.id}
            and ${workspaceMemberships.humanId} = ${humanId}
            and ${workspaceMemberships.suspendedAt} is null
            and (
              ${workspaceMemberships.isOwner} = true
              or exists (
                select 1 from ${projectAccessGrants}
                where ${projectAccessGrants.projectId} = ${projects.id}
                  and ${projectAccessGrants.humanId} = ${humanId}
                  and ${projectAccessGrants.level} in ('read', 'contribute', 'manage')
              )
            )
        )
      )
  )`;

const createForActivity: NotifyActivity = async (tx, input) => {
  const [issue] = await tx
    .select({
      assigneeHumanId: issues.assigneeHumanId,
      createdByHumanId: issues.createdByHumanId,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (issue === undefined) return;

  const isMention = input.kind === "issue_mentioned";
  const mentionedIds = new Set<string>();
  if (input.mentionHandles !== undefined && input.mentionHandles.length > 0) {
    const handles = [...new Set(input.mentionHandles.map((handle) => handle.toLowerCase()))];
    const mentioned = await tx
      .select({ id: humans.id })
      .from(humans)
      .where(and(inArray(sql`lower(${humans.handle})`, handles), isNull(humans.deactivatedAt)));
    for (const { id } of mentioned) mentionedIds.add(id);
  }

  const recipients = new Set<string>();
  if (!isMention && input.actorAgentId !== null && input.actorAgentId !== undefined) {
    const [owner] = await tx
      .select({ humanId: agents.humanId })
      .from(agents)
      .where(eq(agents.id, input.actorAgentId))
      .limit(1);
    if (owner !== undefined) recipients.add(owner.humanId);
  }
  // An `issue_mentioned` notification is only for the handles actually written:
  // an unmentioned assignee must never receive one.
  if (!isMention && issue.assigneeHumanId !== null) {
    recipients.add(issue.assigneeHumanId);
  }
  // A handoff with no human assignee also notifies the issue's human creator (if any).
  if (
    input.kind === "handoff" &&
    issue.assigneeHumanId === null &&
    issue.createdByHumanId !== null
  ) {
    recipients.add(issue.createdByHumanId);
  }
  for (const humanId of mentionedIds) recipients.add(humanId);

  // Never notify the human who caused the event, even when they mentioned themselves.
  // An agent's owner is not auto-added for a mention, so an explicit @mention of that
  // owner is delivered; for all other events the owner remains a recipient as before.
  if (input.actorHumanId !== null && input.actorHumanId !== undefined) {
    recipients.delete(input.actorHumanId);
  }
  if (recipients.size === 0) return;

  const live = await tx
    .select({ id: humans.id })
    .from(humans)
    .innerJoin(projects, eq(projects.id, input.projectId))
    .where(
      and(
        inArray(humans.id, [...recipients]),
        isNull(humans.deactivatedAt),
        readableAccess(humans.id),
      ),
    );
  if (live.length === 0) return;
  await tx
    .insert(notifications)
    .values(
      live.map(({ id: humanId }) => ({
        id: randomUUID(),
        humanId,
        projectId: input.projectId,
        issueId: input.issueId,
        activityId: input.activityId,
        kind: input.kind,
        summary: input.summary,
        createdAt: sql`statement_timestamp()`,
      })),
    )
    .onConflictDoNothing();
};

export function createNotificationsService(deps: NotificationsDeps): NotificationsService {
  const { db } = deps;

  const notificationColumns = {
    id: notifications.id,
    kind: notifications.kind,
    summary: notifications.summary,
    readAt: notifications.readAt,
    createdAt: notifications.createdAt,
    createdAtCursor: sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    projectId: projects.id,
    projectKey: projects.key,
    projectName: projects.name,
    workspaceId: projects.workspaceId,
    issueId: issues.id,
    issueNumber: issues.number,
    issueTitle: issues.title,
  };

  return {
    createForActivity,

    async list(actor, input = {}) {
      const humanId = requireHumanId(actor);
      const limit = input.limit ?? 50;
      const cursor =
        input.cursor === null || input.cursor === undefined || input.cursor === ""
          ? null
          : decodeCursor(input.cursor);
      return db.transaction(
        async (tx) => {
          if (!(await callerIsActive(tx, humanId))) {
            return { items: [], unreadCount: 0, nextCursor: null };
          }
          const conditions = [
            eq(notifications.humanId, humanId),
            isNull(issues.deletedAt),
            readableAccess(humanId),
          ];
          if (input.unreadOnly === true) conditions.push(isNull(notifications.readAt));
          if (cursor !== null) {
            const at = sql`${cursor.createdAt}::timestamptz`;
            conditions.push(
              sql`(${notifications.createdAt} < ${at} or (${notifications.createdAt} = ${at} and ${notifications.id} < ${cursor.id}))`,
            );
          }
          const rows = await tx
            .select(notificationColumns)
            .from(notifications)
            .innerJoin(issues, eq(issues.id, notifications.issueId))
            .innerJoin(projects, eq(projects.id, notifications.projectId))
            .where(and(...conditions))
            .orderBy(desc(notifications.createdAt), desc(notifications.id))
            .limit(limit + 1);
          const [count] = await tx
            .select({ value: sql<number>`count(*)::int` })
            .from(notifications)
            .innerJoin(issues, eq(issues.id, notifications.issueId))
            .innerJoin(projects, eq(projects.id, notifications.projectId))
            .where(
              and(
                eq(notifications.humanId, humanId),
                isNull(notifications.readAt),
                isNull(issues.deletedAt),
                readableAccess(humanId),
              ),
            );
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          return {
            items: page.map((row) => ({
              id: row.id,
              kind: NotificationKind.parse(row.kind),
              summary: row.summary,
              readAt: row.readAt?.toISOString() ?? null,
              createdAt: row.createdAt.toISOString(),
              project: {
                id: row.projectId,
                key: row.projectKey,
                name: row.projectName,
                workspaceId: row.workspaceId,
              },
              issue: {
                id: row.issueId,
                number: row.issueNumber,
                identifier: `${row.projectKey}-${row.issueNumber}`,
                title: row.issueTitle,
              },
            })),
            unreadCount: count?.value ?? 0,
            nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
          };
        },
        { accessMode: "read only" },
      );
    },

    async markRead(actor, notificationId) {
      const humanId = requireHumanId(actor);
      await db.transaction(async (tx) => {
        if (!(await callerIsActive(tx, humanId))) {
          throw new NotificationsError("notification_not_found");
        }
        const [row] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .innerJoin(issues, eq(issues.id, notifications.issueId))
          .innerJoin(projects, eq(projects.id, notifications.projectId))
          .where(
            and(
              eq(notifications.id, notificationId),
              eq(notifications.humanId, humanId),
              isNull(issues.deletedAt),
              readableAccess(humanId),
            ),
          )
          .limit(1);
        if (row === undefined) throw new NotificationsError("notification_not_found");
        await tx
          .update(notifications)
          .set({ readAt: sql`coalesce(${notifications.readAt}, statement_timestamp())` })
          .where(eq(notifications.id, notificationId));
      });
    },

    async markAllRead(actor) {
      const humanId = requireHumanId(actor);
      return db.transaction(async (tx) => {
        if (!(await callerIsActive(tx, humanId))) return 0;
        const accessible = tx
          .select({ id: notifications.id })
          .from(notifications)
          .innerJoin(issues, eq(issues.id, notifications.issueId))
          .innerJoin(projects, eq(projects.id, notifications.projectId))
          .where(
            and(
              eq(notifications.humanId, humanId),
              isNull(notifications.readAt),
              isNull(issues.deletedAt),
              readableAccess(humanId),
            ),
          );
        const updated = await tx
          .update(notifications)
          .set({ readAt: sql`statement_timestamp()` })
          .where(
            and(
              eq(notifications.humanId, humanId),
              isNull(notifications.readAt),
              inArray(notifications.id, accessible),
            ),
          )
          .returning({ id: notifications.id });
        return updated.length;
      });
    },

    async prune() {
      return db.transaction(async (tx) => {
        const removed = await tx
          .delete(notifications)
          .where(
            or(
              lt(notifications.readAt, sql`statement_timestamp() - interval '90 days'`),
              lt(notifications.createdAt, sql`statement_timestamp() - interval '180 days'`),
            ),
          )
          .returning({ id: notifications.id });
        return removed.length;
      });
    },
  };
}

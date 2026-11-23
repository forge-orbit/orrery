import { z } from "zod";
import { Timestamp } from "./common.ts";

export const NotificationKind = z
  .enum(["handoff", "needs_input", "session_expired", "issue_mentioned"])
  .meta({ id: "NotificationKind" });
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NotificationProject = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    workspaceId: z.string(),
  })
  .meta({ id: "NotificationProject" });
export type NotificationProject = z.infer<typeof NotificationProject>;

export const NotificationIssue = z
  .object({
    id: z.string(),
    number: z.int(),
    identifier: z.string(),
    title: z.string(),
  })
  .meta({ id: "NotificationIssue" });
export type NotificationIssue = z.infer<typeof NotificationIssue>;

export const Notification = z
  .object({
    id: z.string(),
    kind: NotificationKind,
    summary: z.string(),
    readAt: Timestamp.nullable(),
    createdAt: Timestamp,
    project: NotificationProject,
    issue: NotificationIssue,
  })
  .meta({ id: "Notification" });
export type Notification = z.infer<typeof Notification>;

export const ListNotificationsQuery = z
  .object({
    unreadOnly: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  })
  .meta({ id: "ListNotificationsQuery" });
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationsResponse = z
  .object({
    items: z.array(Notification),
    unreadCount: z.int().nonnegative(),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "NotificationsResponse" });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

export const MarkAllReadResponse = z
  .object({
    markedCount: z.int().nonnegative(),
  })
  .meta({ id: "MarkAllReadResponse" });
export type MarkAllReadResponse = z.infer<typeof MarkAllReadResponse>;

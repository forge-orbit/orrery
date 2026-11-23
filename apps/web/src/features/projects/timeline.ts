import type { ActivityLabel, Actor, IssueComment, ProjectActivity } from "@orrery/contract";

/** Consecutive label edits by one actor inside this window become one timeline row. */
export const LABEL_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type TimelineEntry =
  | { kind: "comment"; id: string; createdAt: string; comment: IssueComment }
  | { kind: "activity"; id: string; createdAt: string; activity: ProjectActivity }
  | {
      kind: "label_group";
      id: string;
      createdAt: string;
      action: "added" | "removed";
      actor: Actor;
      labels: ActivityLabel[];
      activityIds: string[];
    };

function byChronology(a: TimelineEntry, b: TimelineEntry): number {
  const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return delta === 0 ? a.id.localeCompare(b.id) : delta;
}

function sameActor(a: Actor, b: Actor): boolean {
  return (a.humanId ?? null) === (b.humanId ?? null) && (a.agentId ?? null) === (b.agentId ?? null);
}

function labelEvent(activity: ProjectActivity): {
  action: "added" | "removed";
  label: ActivityLabel;
} | null {
  const detail = activity.detail;
  if (detail?.kind === "label_added") return { action: "added", label: detail.label };
  if (detail?.kind === "label_removed") return { action: "removed", label: detail.label };
  return null;
}

export function buildTimeline(
  comments: readonly IssueComment[],
  activity: readonly ProjectActivity[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...comments.map((comment): TimelineEntry => ({
      kind: "comment",
      id: comment.id,
      createdAt: comment.createdAt,
      comment,
    })),
    // Comments already appear as comment entries; their `issue_commented`
    // activity rows would duplicate them in the unified timeline.
    ...activity
      .filter((event) => event.type !== "issue_commented")
      .map((event): TimelineEntry => ({
        kind: "activity",
        id: event.id,
        createdAt: event.createdAt,
        activity: event,
      })),
  ];
  return entries.toSorted(byChronology);
}

export function groupLabelEvents(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const grouped: TimelineEntry[] = [];
  for (const entry of entries) {
    const previous = grouped[grouped.length - 1];
    const event = entry.kind === "activity" ? labelEvent(entry.activity) : null;
    if (
      event !== null &&
      entry.kind === "activity" &&
      previous?.kind === "label_group" &&
      previous.action === event.action &&
      sameActor(previous.actor, entry.activity.actor) &&
      Date.parse(entry.createdAt) - Date.parse(previous.createdAt) <= LABEL_GROUP_WINDOW_MS
    ) {
      grouped[grouped.length - 1] = {
        ...previous,
        labels: [...previous.labels, event.label],
        activityIds: [...previous.activityIds, entry.activity.id],
      };
      continue;
    }
    if (event !== null && entry.kind === "activity") {
      grouped.push({
        kind: "label_group",
        id: `label-group:${entry.activity.id}`,
        createdAt: entry.createdAt,
        action: event.action,
        actor: entry.activity.actor,
        labels: [event.label],
        activityIds: [entry.activity.id],
      });
      continue;
    }
    grouped.push(entry);
  }
  return grouped;
}

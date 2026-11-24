import { ISSUE_SORT_STEP, type IssuePriority } from "@orrery/contract";

export const PRIORITY_RANK: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export interface BoardOrderable {
  priority: IssuePriority;
  sortOrder: number;
  createdAt: string;
  number: number;
}

export function compareBoardIssues(a: BoardOrderable, b: BoardOrderable): number {
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    a.sortOrder - b.sortOrder ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.number - b.number
  );
}

export interface BoardDropPlacement {
  priority: IssuePriority;
  sortOrder: number | undefined;
}

/**
 * Compute the priority and sortOrder needed so `issue` lands at `targetIndex`
 * among `others` (which are already sorted by `compareBoardIssues`).
 *
 * When a drop crosses a priority boundary (e.g. dragging Medium above High),
 * the issue adopts the minimum priority change needed to stay where dropped.
 */
export function computeBoardDropPlacement(
  issue: Pick<BoardOrderable, "priority">,
  others: readonly Pick<BoardOrderable, "priority" | "sortOrder">[],
  targetIndex: number,
): BoardDropPlacement {
  const prev = others[targetIndex - 1];
  const next = others[targetIndex];
  const selfRank = PRIORITY_RANK[issue.priority];

  if (prev !== undefined && next !== undefined) {
    const prevRank = PRIORITY_RANK[prev.priority];
    const nextRank = PRIORITY_RANK[next.priority];

    if (prev.priority === next.priority) {
      return {
        priority: prev.priority,
        sortOrder: (prev.sortOrder + next.sortOrder) / 2,
      };
    }

    if (issue.priority === prev.priority) {
      return { priority: prev.priority, sortOrder: prev.sortOrder + ISSUE_SORT_STEP };
    }
    if (issue.priority === next.priority) {
      return { priority: next.priority, sortOrder: next.sortOrder - ISSUE_SORT_STEP };
    }
    if (selfRank > prevRank && selfRank < nextRank) {
      return { priority: issue.priority, sortOrder: undefined };
    }
    if (selfRank > nextRank) {
      return { priority: next.priority, sortOrder: next.sortOrder - ISSUE_SORT_STEP };
    }
    return { priority: prev.priority, sortOrder: prev.sortOrder + ISSUE_SORT_STEP };
  }

  if (next !== undefined) {
    const nextRank = PRIORITY_RANK[next.priority];
    const priority = selfRank > nextRank ? next.priority : issue.priority;
    return { priority, sortOrder: next.sortOrder - ISSUE_SORT_STEP };
  }

  if (prev !== undefined) {
    const prevRank = PRIORITY_RANK[prev.priority];
    const priority = selfRank < prevRank ? prev.priority : issue.priority;
    return { priority, sortOrder: prev.sortOrder + ISSUE_SORT_STEP };
  }

  return { priority: issue.priority, sortOrder: undefined };
}

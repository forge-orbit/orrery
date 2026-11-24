import { ISSUE_SORT_STEP, type IssuePriority } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import {
  compareBoardIssues,
  computeBoardDropPlacement,
  type BoardOrderable,
} from "./board-placement.ts";

function makeIssue(
  number: number,
  priority: IssuePriority,
  sortOrder: number,
): BoardOrderable & { id: string } {
  return {
    id: `ORR-${number}`,
    number,
    priority,
    sortOrder,
    createdAt: `2026-01-01T00:00:0${number}Z`,
  };
}

function applyDrop(
  lane: readonly (BoardOrderable & { id: string })[],
  draggedId: string,
  targetIndex: number,
) {
  const dragged = lane.find((i) => i.id === draggedId)!;
  const others = lane.filter((i) => i.id !== draggedId);
  const placement = computeBoardDropPlacement(dragged, others, targetIndex);
  const updated = {
    ...dragged,
    priority: placement.priority,
    ...(placement.sortOrder === undefined ? {} : { sortOrder: placement.sortOrder }),
  };
  const sorted = [...others, updated].toSorted(compareBoardIssues);
  return { placement, ids: sorted.map((i) => i.id), updated };
}

describe("computeBoardDropPlacement", () => {
  it("promotes Medium to High when dropped above a High issue at top of lane", () => {
    const lane = [
      makeIssue(4, "high", ISSUE_SORT_STEP),
      makeIssue(2, "medium", ISSUE_SORT_STEP * 2),
      makeIssue(3, "low", ISSUE_SORT_STEP * 3),
    ];
    const { placement, ids } = applyDrop(lane, "ORR-2", 0);
    expect(placement.priority).toBe("high");
    expect(ids).toEqual(["ORR-2", "ORR-4", "ORR-3"]);
  });

  it("demotes High to Medium when dropped below a Medium issue at bottom of lane", () => {
    const lane = [
      makeIssue(4, "high", ISSUE_SORT_STEP),
      makeIssue(2, "medium", ISSUE_SORT_STEP * 2),
    ];
    const { placement, ids } = applyDrop(lane, "ORR-4", 1);
    expect(placement.priority).toBe("medium");
    expect(ids).toEqual(["ORR-2", "ORR-4"]);
  });

  it("reorders within the same priority band without changing priority", () => {
    const lane = [
      makeIssue(1, "high", ISSUE_SORT_STEP),
      makeIssue(2, "high", ISSUE_SORT_STEP * 2),
      makeIssue(3, "high", ISSUE_SORT_STEP * 3),
    ];
    const { placement, ids } = applyDrop(lane, "ORR-3", 1);
    expect(placement.priority).toBe("high");
    expect(ids).toEqual(["ORR-1", "ORR-3", "ORR-2"]);
  });

  it("keeps natural priority when dropped between a higher and lower priority issue", () => {
    const lane = [makeIssue(1, "high", ISSUE_SORT_STEP), makeIssue(2, "low", ISSUE_SORT_STEP * 2)];
    const dragged = makeIssue(9, "medium", ISSUE_SORT_STEP * 9);
    const placement = computeBoardDropPlacement(dragged, lane, 1);
    expect(placement.priority).toBe("medium");
    const updated = {
      ...dragged,
      priority: placement.priority,
      ...(placement.sortOrder === undefined ? {} : { sortOrder: placement.sortOrder }),
    };
    const sorted = [...lane, updated].toSorted(compareBoardIssues);
    expect(sorted.map((i) => i.id)).toEqual(["ORR-1", "ORR-9", "ORR-2"]);
  });

  it("promotes Low to Medium when dropped between High and Medium", () => {
    const lane = [
      makeIssue(1, "high", ISSUE_SORT_STEP),
      makeIssue(2, "medium", ISSUE_SORT_STEP * 2),
      makeIssue(3, "low", ISSUE_SORT_STEP * 3),
    ];
    const { placement, ids } = applyDrop(lane, "ORR-3", 1);
    expect(placement.priority).toBe("medium");
    expect(ids).toEqual(["ORR-1", "ORR-3", "ORR-2"]);
  });
});

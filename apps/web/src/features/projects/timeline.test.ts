import type { Actor, IssueComment, ProjectActivity } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { buildTimeline, groupLabelEvents, LABEL_GROUP_WINDOW_MS } from "./timeline.ts";

const alice: Actor = {
  humanId: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};
const bob: Actor = {
  humanId: "bob",
  email: "bob@example.com",
  displayName: "Bob",
  avatarUrl: null,
};

function activity(
  id: string,
  createdAt: string,
  actor: Actor,
  detail: ProjectActivity["detail"],
  type: ProjectActivity["type"] = "issue_edited",
): ProjectActivity {
  return {
    id,
    projectId: "p1",
    type:
      detail?.kind === "label_added"
        ? "issue_label_added"
        : detail?.kind === "label_removed"
          ? "issue_label_removed"
          : type,
    summary: `historical summary ${id}`,
    issueId: "i1",
    knowledgeEntryId: null,
    createdAt,
    actor,
    detail,
  };
}

function comment(id: string, createdAt: string): IssueComment {
  return {
    id,
    issueId: "i1",
    body: `comment ${id}`,
    createdAt,
    author: alice,
    attachments: [],
  };
}

const labelDetail = (id: string, kind: "label_added" | "label_removed") =>
  ({
    kind,
    label: { id, name: `Label ${id}`, color: "#3b74d6" },
  }) as const;

describe("buildTimeline", () => {
  it("merges comments and activity into one chronological list", () => {
    const entries = buildTimeline(
      [comment("c1", "2026-01-01T10:05:00.000Z"), comment("c2", "2026-01-01T10:00:00.000Z")],
      [activity("a1", "2026-01-01T10:02:00.000Z", alice, null)],
    );
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["comment", "c2"],
      ["activity", "a1"],
      ["comment", "c1"],
    ]);
  });

  it("does not duplicate comments as issue_commented activity rows", () => {
    const entries = buildTimeline(
      [comment("c1", "2026-01-01T10:00:00.000Z")],
      [activity("a1", "2026-01-01T10:00:01.000Z", alice, null, "issue_commented")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("breaks ties by id so the order stays stable", () => {
    const entries = buildTimeline(
      [comment("c1", "2026-01-01T10:00:00.000Z")],
      [activity("a0", "2026-01-01T10:00:00.000Z", alice, null)],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["a0", "c1"]);
  });
});

describe("groupLabelEvents", () => {
  it("groups rapid consecutive label additions by the same actor into one row", () => {
    const base = Date.parse("2026-01-01T10:00:00.000Z");
    const entries = buildTimeline(
      [],
      [
        activity("a1", new Date(base).toISOString(), alice, labelDetail("l1", "label_added")),
        activity(
          "a2",
          new Date(base + 60_000).toISOString(),
          alice,
          labelDetail("l2", "label_added"),
        ),
        activity(
          "a3",
          new Date(base + 120_000).toISOString(),
          alice,
          labelDetail("l3", "label_added"),
        ),
      ],
    );
    const grouped = groupLabelEvents(entries);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      kind: "label_group",
      action: "added",
      actor: alice,
      activityIds: ["a1", "a2", "a3"],
      labels: [
        { id: "l1", name: "Label l1", color: "#3b74d6" },
        { id: "l2", name: "Label l2", color: "#3b74d6" },
        { id: "l3", name: "Label l3", color: "#3b74d6" },
      ],
    });
  });

  it("keeps removals, different actors, gaps and intervening events separate", () => {
    const base = Date.parse("2026-01-01T10:00:00.000Z");
    const entries = buildTimeline(
      [],
      [
        activity("a1", new Date(base).toISOString(), alice, labelDetail("l1", "label_added")),
        activity(
          "a2",
          new Date(base + 1000).toISOString(),
          alice,
          labelDetail("l2", "label_removed"),
        ),
        activity("a3", new Date(base + 2000).toISOString(), bob, labelDetail("l3", "label_added")),
        activity("a4", new Date(base + 3000).toISOString(), alice, null),
        activity(
          "a5",
          new Date(base + 4000).toISOString(),
          alice,
          labelDetail("l4", "label_added"),
        ),
        activity(
          "a6",
          new Date(base + LABEL_GROUP_WINDOW_MS + 5000).toISOString(),
          alice,
          labelDetail("l5", "label_added"),
        ),
      ],
    );
    expect(groupLabelEvents(entries).map((entry) => entry.kind)).toEqual([
      "label_group",
      "label_group",
      "label_group",
      "activity",
      "label_group",
      "label_group",
    ]);
    expect(
      groupLabelEvents(entries)
        .filter((entry) => entry.kind === "label_group")
        .map((entry) => (entry.kind === "label_group" ? entry.activityIds : [])),
    ).toEqual([["a1"], ["a2"], ["a3"], ["a5"], ["a6"]]);
  });

  it("keeps historical rows without detail as summary activity rows", () => {
    const entries = buildTimeline([], [activity("old", "2026-01-01T10:00:00.000Z", alice, null)]);
    expect(groupLabelEvents(entries)).toEqual(entries);
    expect(entries[0]).toMatchObject({
      kind: "activity",
      activity: { summary: "historical summary old", detail: null },
    });
  });
});

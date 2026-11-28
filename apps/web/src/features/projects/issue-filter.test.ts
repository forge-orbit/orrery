import type { PowerSearchFilter } from "@astryxdesign/core/PowerSearch";
import type { Issue, ProjectLabel } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { buildIssueFilterConfig, countIssueScopes, filterAndSortIssues } from "./issue-filter.ts";

const humanActor = {
  humanId: "h-1",
  email: "rubi@example.com",
  handle: "rubi",
  displayName: "rubi@example.com",
  avatarUrl: null,
};

const agentActor = {
  agentId: "a-1",
  agentName: "AG",
  ownerDisplayName: "rubi@example.com",
  displayName: "AG",
  avatarUrl: null,
};

const bugLabel: ProjectLabel = {
  id: "lbl-bug",
  projectId: "proj-1",
  name: "bug",
  color: "#d73a4a",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: humanActor,
};

const agentLabel: ProjectLabel = {
  id: "lbl-agent",
  projectId: "proj-1",
  name: "ready-for-agent",
  color: "#0e8a16",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: humanActor,
};

function makeIssue(overrides: Partial<Issue> & Pick<Issue, "id" | "number" | "title">): Issue {
  return {
    projectId: "proj-1",
    identifier: `OJ-${overrides.number}`,
    body: "",
    status: "todo",
    priority: "medium",
    sortOrder: overrides.number * 1000,
    needsInput: false,
    assignee: null,
    createdAt: `2026-01-0${overrides.number}T00:00:00.000Z`,
    updatedAt: `2026-01-0${overrides.number}T00:00:00.000Z`,
    closedAt: null,
    createdBy: humanActor,
    updatedBy: humanActor,
    fallbackPolicyOverride: null,
    effectiveFallbackPolicy: "require_human",
    parentIssueId: null,
    labels: [],
    blockedByIds: [],
    ...overrides,
  };
}

const sampleIssues: Issue[] = [
  makeIssue({
    id: "i-1",
    number: 1,
    title: "Fix login redirect",
    body: "Redirects to /device fail",
    status: "in_progress",
    priority: "urgent",
    assignee: humanActor,
    labels: [bugLabel, agentLabel],
    updatedAt: "2026-01-05T00:00:00.000Z",
  }),
  makeIssue({
    id: "i-2",
    number: 2,
    title: "Add project filter",
    status: "todo",
    priority: "high",
    assignee: humanActor,
    labels: [agentLabel],
    needsInput: true,
    updatedAt: "2026-01-04T00:00:00.000Z",
  }),
  makeIssue({
    id: "i-3",
    number: 3,
    title: "Old finished task",
    status: "done",
    priority: "low",
    assignee: null,
    labels: [],
    createdBy: agentActor,
    updatedAt: "2026-01-06T00:00:00.000Z",
  }),
];

const liveSessions = new Set(["i-1"]);

describe("issue-filter", () => {
  it("computes status scope counts", () => {
    expect(countIssueScopes(sampleIssues)).toEqual({
      all: 3,
      backlog: 0,
      todo: 1,
      in_progress: 1,
      review: 0,
      done: 1,
      cancelled: 0,
    });
  });

  it("filters by status scope", () => {
    const inProgress = filterAndSortIssues({
      issues: sampleIssues,
      scope: "in_progress",
      filters: [],
      sort: "priority",
      activeSessionIssueIds: liveSessions,
    });
    expect(inProgress.map((i) => i.id)).toEqual(["i-1"]);

    const done = filterAndSortIssues({
      issues: sampleIssues,
      scope: "done",
      filters: [],
      sort: "priority",
      activeSessionIssueIds: liveSessions,
    });
    expect(done.map((i) => i.id)).toEqual(["i-3"]);
  });

  it("matches text search across identifier, title, and body", () => {
    const byKey: PowerSearchFilter[] = [
      { field: "query", operator: "contains", value: { type: "string", value: "oj-2" } },
    ];
    expect(
      filterAndSortIssues({
        issues: sampleIssues,
        scope: "all",
        filters: byKey,
        sort: "priority",
        activeSessionIssueIds: liveSessions,
      }).map((i) => i.id),
    ).toEqual(["i-2"]);

    const byBody: PowerSearchFilter[] = [
      { field: "query", operator: "contains", value: { type: "string", value: "/device" } },
    ];
    expect(
      filterAndSortIssues({
        issues: sampleIssues,
        scope: "all",
        filters: byBody,
        sort: "priority",
        activeSessionIssueIds: liveSessions,
      }).map((i) => i.id),
    ).toEqual(["i-1"]);
  });

  it("supports human assignee filters, label filters, and agent session filters", () => {
    const humanAssigned = filterAndSortIssues({
      issues: sampleIssues,
      scope: "all",
      filters: [
        { field: "assignee", operator: "is", value: { type: "enum", value: "__any_human__" } },
      ],
      sort: "priority",
      activeSessionIssueIds: liveSessions,
    });
    expect(humanAssigned.map((i) => i.id)).toEqual(["i-1", "i-2"]);

    const unlabeled = filterAndSortIssues({
      issues: sampleIssues,
      scope: "all",
      filters: [{ field: "label", operator: "is_empty", value: { type: "empty" } }],
      sort: "priority",
      activeSessionIssueIds: liveSessions,
    });
    expect(unlabeled.map((i) => i.id)).toEqual(["i-3"]);

    const needsInput = filterAndSortIssues({
      issues: sampleIssues,
      scope: "all",
      filters: [
        { field: "agent_session", operator: "is", value: { type: "enum", value: "needs_input" } },
      ],
      sort: "priority",
      activeSessionIssueIds: liveSessions,
    });
    expect(needsInput.map((i) => i.id)).toEqual(["i-2"]);
  });

  it("sorts by newest, oldest, and recently updated while preserving default priority order", () => {
    expect(
      filterAndSortIssues({
        issues: sampleIssues,
        scope: "all",
        filters: [],
        sort: "newest",
        activeSessionIssueIds: liveSessions,
      }).map((i) => i.id),
    ).toEqual(["i-3", "i-2", "i-1"]);

    expect(
      filterAndSortIssues({
        issues: sampleIssues,
        scope: "all",
        filters: [],
        sort: "updated",
        activeSessionIssueIds: liveSessions,
      }).map((i) => i.id),
    ).toEqual(["i-3", "i-1", "i-2"]);
  });

  it("builds PowerSearchConfig with project labels and distinct actors", () => {
    const config = buildIssueFilterConfig(sampleIssues, [bugLabel, agentLabel]);
    expect(config.contentSearchFieldKey).toBe("query");
    expect(config.fields.map((f) => f.key)).toEqual([
      "query",
      "status",
      "priority",
      "label",
      "assignee",
      "author",
      "agent_session",
      "blocked",
    ]);
  });
});

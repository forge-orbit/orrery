import type {
  EnumItem,
  PowerSearchConfig,
  PowerSearchFilter,
} from "@astryxdesign/core/PowerSearch";
import { IssuePriority, IssueStatus, type Issue, type ProjectLabel } from "@orrery/contract";
import { PRIORITY_LABELS } from "./IssuePriority.tsx";
import { issueStatusLabels } from "./issue-status.ts";

export type IssueStatusScope = "all" | IssueStatus;

export type IssueSortKey = "priority" | "newest" | "oldest" | "updated" | "number_desc";

export type IssueScopeCounts = Readonly<Record<IssueStatusScope, number>>;

export const ISSUE_SORT_OPTIONS: readonly {
  readonly value: IssueSortKey;
  readonly label: string;
}[] = [
  { value: "priority", label: "Sort: Priority" },
  { value: "newest", label: "Sort: Newest" },
  { value: "oldest", label: "Sort: Oldest" },
  { value: "updated", label: "Sort: Recently updated" },
  { value: "number_desc", label: "Sort: Key (newest)" },
];

const ASSIGNEE_UNASSIGNED = "__unassigned__";
const ASSIGNEE_ANY_HUMAN = "__any_human__";

function actorKey(actor: {
  humanId?: string | null | undefined;
  agentId?: string | null | undefined;
}): string {
  if (actor.agentId != null) return `agent:${actor.agentId}`;
  if (actor.humanId != null) return `human:${actor.humanId}`;
  return "";
}

function actorLabel(actor: { displayName: string; agentId?: string | null | undefined }): string {
  return actor.agentId != null ? `${actor.displayName} (Agent)` : actor.displayName;
}

export function countIssueScopes(issues: readonly Issue[]): IssueScopeCounts {
  const counts: Record<IssueStatusScope, number> = {
    all: issues.length,
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    cancelled: 0,
  };
  for (const issue of issues) {
    counts[issue.status] += 1;
  }
  return counts;
}

export function buildIssueFilterConfig(
  issues: readonly Issue[],
  labels: readonly ProjectLabel[],
): PowerSearchConfig {
  const statusValues: EnumItem[] = IssueStatus.options.map((status) => ({
    value: status,
    label: issueStatusLabels[status],
  }));

  const priorityValues: EnumItem[] = IssuePriority.options.map((priority) => ({
    value: priority,
    label: PRIORITY_LABELS[priority],
  }));

  const labelValues: EnumItem[] = labels.map((label) => ({
    value: label.id,
    label: label.name,
  }));

  const assigneeMap = new Map<string, string>();
  const authorMap = new Map<string, string>();
  for (const issue of issues) {
    if (issue.assignee !== null) {
      const key = actorKey(issue.assignee);
      if (key !== "" && !assigneeMap.has(key)) {
        assigneeMap.set(key, issue.assignee.displayName);
      }
    }
    const creatorKey = actorKey(issue.createdBy);
    if (creatorKey !== "" && !authorMap.has(creatorKey)) {
      authorMap.set(creatorKey, actorLabel(issue.createdBy));
    }
  }

  const assigneeValues: EnumItem[] = [
    { value: ASSIGNEE_UNASSIGNED, label: "Unassigned" },
    { value: ASSIGNEE_ANY_HUMAN, label: "Any human" },
    ...[...assigneeMap.entries()]
      .toSorted(([, a], [, b]) => a.localeCompare(b))
      .map(([value, label]) => ({ value, label })),
  ];

  const authorValues: EnumItem[] = [...authorMap.entries()]
    .toSorted(([, a], [, b]) => a.localeCompare(b))
    .map(([value, label]) => ({ value, label }));

  const labelOperators = [
    ...(labelValues.length > 0
      ? [
          { key: "is", label: "is", value: { type: "enum" as const, values: labelValues } },
          {
            key: "is_any_of",
            label: "is any of",
            value: { type: "enum_list" as const, values: labelValues },
          },
          { key: "is_not", label: "is not", value: { type: "enum" as const, values: labelValues } },
        ]
      : []),
    { key: "is_empty", label: "is empty", value: { type: "empty" as const } },
  ];

  return {
    name: "ProjectIssues",
    contentSearchFieldKey: "query",
    fields: [
      {
        key: "query",
        label: "Text",
        defaultOperator: "contains",
        typeaheadAliases: ["title", "key", "search"],
        operators: [
          { key: "contains", label: "contains", value: { type: "string" } },
          { key: "not_contains", label: "does not contain", value: { type: "string" } },
        ],
      },
      {
        key: "status",
        label: "Status",
        defaultOperator: "is",
        typeaheadAliases: ["state"],
        operators: [
          { key: "is", label: "is", value: { type: "enum", values: statusValues } },
          {
            key: "is_any_of",
            label: "is any of",
            value: { type: "enum_list", values: statusValues },
          },
          { key: "is_not", label: "is not", value: { type: "enum", values: statusValues } },
        ],
      },
      {
        key: "priority",
        label: "Priority",
        defaultOperator: "is",
        operators: [
          { key: "is", label: "is", value: { type: "enum", values: priorityValues } },
          {
            key: "is_any_of",
            label: "is any of",
            value: { type: "enum_list", values: priorityValues },
          },
          { key: "is_not", label: "is not", value: { type: "enum", values: priorityValues } },
        ],
      },
      {
        key: "label",
        label: "Label",
        defaultOperator: labelValues.length > 0 ? "is" : "is_empty",
        typeaheadAliases: ["tag", "labels"],
        operators: labelOperators,
      },
      {
        key: "assignee",
        label: "Assignee",
        defaultOperator: "is",
        typeaheadAliases: ["owner", "human"],
        operators: [
          { key: "is", label: "is", value: { type: "enum", values: assigneeValues } },
          { key: "is_not", label: "is not", value: { type: "enum", values: assigneeValues } },
        ],
      },
      ...(authorValues.length > 0
        ? [
            {
              key: "author",
              label: "Author",
              defaultOperator: "is",
              typeaheadAliases: ["creator", "opened by"],
              operators: [
                { key: "is", label: "is", value: { type: "enum" as const, values: authorValues } },
                {
                  key: "is_not",
                  label: "is not",
                  value: { type: "enum" as const, values: authorValues },
                },
              ],
            },
          ]
        : []),
      {
        key: "agent_session",
        label: "Agent session",
        defaultOperator: "is",
        typeaheadAliases: ["session", "live", "running"],
        operators: [
          {
            key: "is",
            label: "is",
            value: {
              type: "enum",
              values: [
                { value: "live", label: "Live session running" },
                { value: "needs_input", label: "Needs input" },
                { value: "none", label: "No live session" },
              ],
            },
          },
        ],
      },
      {
        key: "blocked",
        label: "Dependencies",
        defaultOperator: "is",
        typeaheadAliases: ["blocked", "blocker", "ready"],
        operators: [
          {
            key: "is",
            label: "is",
            value: {
              type: "enum",
              values: [
                { value: "blocked", label: "Blocked" },
                { value: "unblocked", label: "Not blocked" },
              ],
            },
          },
        ],
      },
    ],
  };
}

function matchesAssigneeValue(issue: Issue, value: string): boolean {
  if (value === ASSIGNEE_UNASSIGNED) return issue.assignee === null;
  if (value === ASSIGNEE_ANY_HUMAN) return issue.assignee !== null;
  return issue.assignee !== null && actorKey(issue.assignee) === value;
}

function matchesSingleFilter(
  issue: Issue,
  filter: PowerSearchFilter,
  activeSessionIssueIds: ReadonlySet<string>,
): boolean {
  const { field, operator, value } = filter;

  if (field === "query" && value.type === "string") {
    const needle = value.value.trim().toLowerCase();
    if (needle === "") return true;
    const hit =
      issue.identifier.toLowerCase().includes(needle) ||
      issue.title.toLowerCase().includes(needle) ||
      issue.body.toLowerCase().includes(needle);
    return operator === "not_contains" ? !hit : hit;
  }

  if (field === "status") {
    if (value.type === "enum") {
      return operator === "is_not" ? issue.status !== value.value : issue.status === value.value;
    }
    if (value.type === "enum_list") {
      return value.value.length === 0 || value.value.includes(issue.status);
    }
  }

  if (field === "priority") {
    if (value.type === "enum") {
      return operator === "is_not"
        ? issue.priority !== value.value
        : issue.priority === value.value;
    }
    if (value.type === "enum_list") {
      return value.value.length === 0 || value.value.includes(issue.priority);
    }
  }

  if (field === "label") {
    if (operator === "is_empty") return issue.labels.length === 0;
    if (value.type === "enum") {
      const has = issue.labels.some((label) => label.id === value.value);
      return operator === "is_not" ? !has : has;
    }
    if (value.type === "enum_list") {
      return (
        value.value.length === 0 || issue.labels.some((label) => value.value.includes(label.id))
      );
    }
  }

  if (field === "assignee" && value.type === "enum") {
    const hit = matchesAssigneeValue(issue, value.value);
    return operator === "is_not" ? !hit : hit;
  }

  if (field === "author" && value.type === "enum") {
    const hit = actorKey(issue.createdBy) === value.value;
    return operator === "is_not" ? !hit : hit;
  }

  if (field === "agent_session" && value.type === "enum") {
    if (value.value === "live") return activeSessionIssueIds.has(issue.id);
    if (value.value === "needs_input") return issue.needsInput;
    if (value.value === "none") return !activeSessionIssueIds.has(issue.id);
  }

  if (field === "blocked" && value.type === "enum") {
    if (value.value === "blocked") return issue.blockedByIds.length > 0;
    if (value.value === "unblocked") return issue.blockedByIds.length === 0;
  }

  return true;
}

export function filterAndSortIssues({
  issues,
  scope,
  filters,
  sort,
  activeSessionIssueIds,
}: {
  issues: readonly Issue[];
  scope: IssueStatusScope;
  filters: readonly PowerSearchFilter[];
  sort: IssueSortKey;
  activeSessionIssueIds: ReadonlySet<string>;
}): Issue[] {
  const filtered = issues.filter((issue) => {
    if (scope !== "all" && issue.status !== scope) return false;
    for (const filter of filters) {
      if (!matchesSingleFilter(issue, filter, activeSessionIssueIds)) return false;
    }
    return true;
  });

  if (sort === "priority") return filtered;

  return filtered.toSorted((a, b) => {
    if (sort === "newest") {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      return cmp !== 0 ? cmp : b.number - a.number;
    }
    if (sort === "oldest") {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      return cmp !== 0 ? cmp : a.number - b.number;
    }
    if (sort === "updated") {
      const cmp = b.updatedAt.localeCompare(a.updatedAt);
      return cmp !== 0 ? cmp : b.number - a.number;
    }
    return b.number - a.number;
  });
}

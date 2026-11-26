import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { PowerSearch, type PowerSearchFilter } from "@astryxdesign/core/PowerSearch";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import type { Issue, ProjectLabel } from "@orrery/contract";
import { RotateCcw, Search } from "lucide-react";
import { useMemo } from "react";
import {
  buildIssueFilterConfig,
  ISSUE_SORT_OPTIONS,
  type IssueLifecycleScope,
  type IssueScopeCounts,
  type IssueSortKey,
} from "./issue-filter.ts";

const SCOPE_OPTIONS: readonly { readonly id: IssueLifecycleScope; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "active", label: "Active" },
  { id: "closed", label: "Closed" },
];

export function IssueFilterBar({
  issues,
  labels,
  scope,
  onScopeChange,
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  counts,
  filteredCount,
  onReset,
}: {
  issues: readonly Issue[];
  labels: readonly ProjectLabel[];
  scope: IssueLifecycleScope;
  onScopeChange: (scope: IssueLifecycleScope) => void;
  filters: readonly PowerSearchFilter[];
  onFiltersChange: (filters: PowerSearchFilter[]) => void;
  sort: IssueSortKey;
  onSortChange: (sort: IssueSortKey) => void;
  counts: IssueScopeCounts;
  filteredCount: number;
  onReset: () => void;
}) {
  const config = useMemo(() => buildIssueFilterConfig(issues, labels), [issues, labels]);
  const isFiltered = scope !== "all" || filters.length > 0;
  const hasNonDefaultState = isFiltered || sort !== "priority";

  return (
    <Section variant="transparent" dividers={["bottom"]} padding={0} paddingBlockEnd={3}>
      <Stack gap={2} data-issue-filter-bar="">
        <PowerSearch
          config={config}
          filters={filters}
          onChange={(next) => onFiltersChange([...next])}
          label="Filter project issues"
          placeholder="Search issues or filter by status, label, assignee, priority, agent session…"
          size="sm"
          startIcon={<Icon icon={Search} size="sm" />}
          {...(isFiltered ? { resultCount: `${filteredCount} of ${issues.length}` } : {})}
          data-issue-power-search=""
        />
        <Stack direction="horizontal" gap={2} vAlign="center" justify="between" wrap="wrap">
          <Stack
            direction="horizontal"
            gap={1}
            vAlign="center"
            wrap="wrap"
            role="group"
            aria-label="Filter issues by lifecycle"
          >
            {SCOPE_OPTIONS.map(({ id, label }) => {
              const count = counts[id];
              return (
                <ToggleButton
                  key={id}
                  label={`${label} (${count})`}
                  isPressed={scope === id}
                  size="sm"
                  data-issue-scope={id}
                  onPressedChange={(pressed) => onScopeChange(pressed ? id : "all")}
                >
                  {label} <Badge label={count} />
                </ToggleButton>
              );
            })}
          </Stack>
          <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
            <Selector
              label="Sort issues"
              isLabelHidden
              id="project-issues-sort"
              variant="secondary"
              size="sm"
              value={sort}
              onChange={(value) => {
                if (
                  value === "priority" ||
                  value === "newest" ||
                  value === "oldest" ||
                  value === "updated" ||
                  value === "number_desc"
                ) {
                  onSortChange(value);
                }
              }}
              options={[...ISSUE_SORT_OPTIONS]}
            />
            {hasNonDefaultState && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                label="Reset"
                icon={<Icon icon={RotateCcw} />}
                onClick={onReset}
              />
            )}
          </Stack>
        </Stack>
      </Stack>
    </Section>
  );
}

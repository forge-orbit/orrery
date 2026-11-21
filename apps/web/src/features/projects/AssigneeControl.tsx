import { Banner } from "@astryxdesign/core/Banner";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { Assignee, Issue, IssueDetail } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updateIssue } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery } from "./queries.ts";

export type AssigneeCandidate = { value: string; label: string; assignee: Assignee };

export function AssigneeControl({
  issue,
  candidates,
  canContribute,
}: {
  issue: Issue;
  candidates: readonly AssigneeCandidate[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const value = currentValue(issue);

  async function onChange(nextValue: string) {
    if (nextValue === value) return;
    setSaving(true);
    setError(undefined);
    const chosen = candidates.find((candidate) => candidate.value === nextValue);
    try {
      const updated = await updateIssue(issue.id, { assignee: chosen?.assignee ?? null });
      queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
        old === undefined ? old : { ...old, ...updated },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({
          queryKey: projectActivityQuery(issue.projectId).queryKey,
        }),
      ]);
      toast({ body: chosen ? `Assigned to ${chosen.label}.` : "Assignee cleared." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not change the assignee.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (!canContribute) {
    return (
      <Stack gap={0.5}>
        <Text type="supporting" weight="semibold" color="secondary">
          Assignee
        </Text>
        <Text type="body" color={issue.assignee === null ? "secondary" : "primary"}>
          {currentLabel(issue)}
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={1.5}>
      <Selector
        label="Assignee"
        id={`assignee-${issue.id}`}
        size="sm"
        value={value}
        isDisabled={saving}
        onChange={(nextValue) => void onChange(nextValue)}
        options={[
          { value: "", label: "Unassigned" },
          ...candidates.map((candidate) => ({ value: candidate.value, label: candidate.label })),
          ...(issue.assignee !== null && !candidates.some((c) => c.value === value)
            ? [{ value, label: currentLabel(issue) }]
            : []),
        ]}
      />
      {error !== undefined && <Banner status="error" role="alert" title={error} />}
    </Stack>
  );
}

function currentValue(issue: Issue): string {
  if (issue.assignee === null) return "";
  return issue.assignee.agentId !== undefined
    ? `agent:${issue.assignee.agentId}`
    : `human:${issue.assignee.humanId ?? ""}`;
}

function currentLabel(issue: Issue): string {
  if (issue.assignee === null) return "Unassigned";
  return issue.assignee.agentId !== undefined
    ? `Agent · ${issue.assignee.displayName}`
    : `Human · ${issue.assignee.displayName}`;
}

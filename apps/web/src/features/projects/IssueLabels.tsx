import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { type Issue, type IssueDetail, type ProjectLabel } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { attachIssueLabel, detachIssueLabel } from "./commands.ts";
import { issueQuery, issuesQuery, projectActivityQuery } from "./queries.ts";
import { LabelPill } from "./LabelPill.tsx";

export function IssueLabels({
  issue,
  labels,
  canContribute,
}: {
  issue: IssueDetail;
  labels: ProjectLabel[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const available = labels.filter(
    (label) => !issue.labels.some((attached) => attached.id === label.id),
  );

  async function refresh(updated: Issue) {
    queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
      old === undefined ? old : { ...old, ...updated },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
      queryClient.invalidateQueries({
        queryKey: projectActivityQuery(issue.projectId).queryKey,
      }),
    ]);
  }

  async function onAttach() {
    if (selected === "") return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await attachIssueLabel(issue.id, selected);
      setSelected("");
      await refresh(updated);
      toast({ body: "Label attached." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach the label.");
    } finally {
      setSaving(false);
    }
  }

  async function onDetach(labelId: string) {
    setSaving(true);
    setError(undefined);
    try {
      await refresh(await detachIssueLabel(issue.id, labelId));
      toast({ body: "Label removed." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not detach the label.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap={2}>
      <Text type="supporting" weight="semibold" color="secondary">
        Labels
      </Text>
      {issue.labels.length === 0 ? (
        <Text as="p" display="block" type="supporting" color="secondary">
          No labels
        </Text>
      ) : (
        <Stack as="ul" direction="horizontal" gap={1.5} wrap="wrap">
          {issue.labels.map((label) => (
            <Stack
              as="li"
              key={label.id}
              data-issue-label-id={label.id}
              direction="horizontal"
              gap={0.5}
              vAlign="center"
            >
              <LabelPill label={label} />
              {canContribute && (
                <IconButton
                  type="button"
                  label={`Remove ${label.name}`}
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon="close" size="xsm" />}
                  isDisabled={saving}
                  onClick={() => void onDetach(label.id)}
                />
              )}
            </Stack>
          ))}
        </Stack>
      )}
      {canContribute && available.length > 0 && (
        <Stack gap={2}>
          <Selector
            label="Attach label"
            id="issue-attach-label"
            size="sm"
            width="100%"
            value={selected}
            onChange={setSelected}
            placeholder="Choose a label…"
            options={available.map((label) => ({ value: label.id, label: label.name }))}
          />
          <Stack hAlign="start">
            <Button
              type="button"
              label="Attach label"
              variant="secondary"
              size="sm"
              isDisabled={saving || selected === ""}
              onClick={() => void onAttach()}
            />
          </Stack>
        </Stack>
      )}
      {error !== undefined && <Banner status="error" role="alert" title={error} />}
    </Stack>
  );
}

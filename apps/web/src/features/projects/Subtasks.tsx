import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { type Issue, type IssueDetail } from "@orrery/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { Link } from "../../lib/Link.tsx";
import { createIssue } from "./commands.ts";
import { issueStatusLabels } from "./issue-status.ts";
import { issueQuery, issuesQuery, projectActivityQuery, readyWorkQuery } from "./queries.ts";

export function subtasksOf(issues: Issue[], parentId: string): Issue[] {
  return issues.filter((issue) => issue.parentIssueId === parentId);
}

export function completedSubtaskCount(subtasks: Issue[]): number {
  return subtasks.filter((issue) => issue.status === "done" || issue.status === "cancelled").length;
}

export function Subtasks({
  issue,
  issues,
  canContribute,
}: {
  issue: IssueDetail;
  issues: Issue[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const subtasks = subtasksOf(issues, issue.id);
  const completed = completedSubtaskCount(subtasks);
  const parent =
    issue.parentIssueId === null ? undefined : issues.find((i) => i.id === issue.parentIssueId);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await createIssue(issue.projectId, { title, parentIssueId: issue.id });
      setTitle("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({
          queryKey: projectActivityQuery(issue.projectId).queryKey,
        }),
      ]);
      toast({ body: "Subtask created." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the subtask.");
    } finally {
      setSaving(false);
    }
  }

  const isSubtask = issue.parentIssueId !== null;

  return (
    <Section
      variant="transparent"
      dividers={["top"]}
      padding={0}
      paddingBlockStart={4}
      data-subtasks-section=""
    >
      <Stack gap={3}>
        {isSubtask && (
          <Heading level={2} color="inherit">
            Subtasks
          </Heading>
        )}
        {isSubtask ? (
          parent !== undefined ? (
            <Text as="p" display="block" type="supporting" color="secondary">
              Subtask of{" "}
              <Link to="/issues/$issueId" params={{ issueId: parent.id }}>
                {parent.identifier} {parent.title}
              </Link>
            </Text>
          ) : (
            <Text as="p" display="block" type="supporting" color="secondary">
              Subtask of another issue.
            </Text>
          )
        ) : (
          <>
            <Stack direction="horizontal" justify="between" vAlign="center" gap={2} wrap="wrap">
              <Heading level={2} color="inherit">
                Subtasks
              </Heading>
              <Token
                label={`${completed} of ${subtasks.length} complete`}
                color={subtasks.length > 0 && completed === subtasks.length ? "green" : "gray"}
                size="sm"
                data-subtask-count={String(subtasks.length)}
                data-completed-subtask-count={String(completed)}
              />
            </Stack>
            {subtasks.length > 0 && (
              <ProgressBar
                label="Subtask progress"
                isLabelHidden
                value={(completed / subtasks.length) * 100}
                variant="success"
              />
            )}
            {subtasks.length === 0 ? (
              <Text as="p" display="block" type="supporting" color="secondary">
                No subtasks yet.
              </Text>
            ) : (
              <Stack as="ul" gap={2}>
                {subtasks.map((subtask) => (
                  <Stack
                    as="li"
                    key={subtask.id}
                    data-subtask-id={subtask.id}
                    data-subtask-status={subtask.status}
                  >
                    <Card variant="muted" padding={2}>
                      <Stack
                        direction="horizontal"
                        justify="between"
                        vAlign="center"
                        gap={2}
                        wrap="wrap"
                      >
                        <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
                          <Text as="span" type="code" color="secondary">
                            {subtask.identifier}
                          </Text>
                          <Link
                            to="/issues/$issueId"
                            params={{ issueId: subtask.id }}
                            color="primary"
                            weight="medium"
                          >
                            {subtask.title}
                          </Link>
                        </Stack>
                        <Token
                          label={issueStatusLabels[subtask.status]}
                          color={
                            subtask.status === "done"
                              ? "green"
                              : subtask.status === "cancelled"
                                ? "red"
                                : subtask.status === "in_progress"
                                  ? "orange"
                                  : "gray"
                          }
                          size="sm"
                        />
                      </Stack>
                    </Card>
                  </Stack>
                ))}
              </Stack>
            )}
            {canContribute && (
              <form onSubmit={(event) => void onCreate(event)}>
                <Stack direction="horizontal" gap={2} vAlign="end" wrap="wrap">
                  <TextField
                    label="Subtask name"
                    id="new-subtask-title"
                    htmlName="title"
                    value={title}
                    onChange={setTitle}
                    maxLength={200}
                    placeholder="Add a subtask…"
                    width="min(100%, 24rem)"
                    required
                  />
                  <Button
                    type="submit"
                    size="sm"
                    label="Create subtask"
                    variant="secondary"
                    isDisabled={saving}
                    isLoading={saving}
                  />
                </Stack>
              </form>
            )}
            {error !== undefined && <Banner status="error" role="alert" title={error} />}
          </>
        )}
      </Stack>
    </Section>
  );
}

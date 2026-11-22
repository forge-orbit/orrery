import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { AgentAvatar } from "../../lib/harness.tsx";
import { formatDateTime, formatFullDateTime, relativeTime } from "../../lib/time.ts";
import { projectActivityQuery } from "../projects/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { requestStop } from "./commands.ts";
import { sessionQuery, sessionsQuery } from "./queries.ts";

export function SessionStatus({
  issueId,
  projectId,
  canContribute,
}: {
  issueId: string;
  projectId: string;
  canContribute: boolean;
}) {
  const { data: session } = useQuery(sessionQuery(issueId));
  const { data: runs = [] } = useQuery({
    ...workspaceRunsQuery(session?.workspaceId ?? ""),
    enabled: session !== null && session !== undefined,
  });

  if (session === null || session === undefined) return null;

  const run = runs.find((entry) => entry.id === session.runId);
  const stopping = session.status === "active" && session.stopRequested;
  const status = stopping ? "stopping" : session.status;

  return (
    <Card padding={3} data-session-id={session.id}>
      <Stack gap={2}>
        <Stack direction="horizontal" gap={1.5} vAlign="center" justify="between" wrap="wrap">
          <Stack direction="horizontal" gap={1.5} vAlign="center">
            {run !== undefined && (
              <AgentAvatar name={run.agentName} harness={run.harness} size={16} />
            )}
            <Text type="supporting" weight="semibold" color="primary">
              {run?.agentName ?? "Work session"}
            </Text>
          </Stack>
          <Token
            label={status}
            color={status === "active" ? "green" : status === "stopping" ? "orange" : "gray"}
            size="sm"
            data-session-status={status}
          />
        </Stack>
        {session.stopRequested && session.stopRequestedAt !== null && (
          <Text
            as="p"
            display="block"
            type="supporting"
            color="secondary"
            data-stop-requested-at={session.stopRequestedAt}
          >
            Stop requested{" "}
            <time
              dateTime={session.stopRequestedAt}
              title={formatFullDateTime(session.stopRequestedAt)}
            >
              {relativeTime(session.stopRequestedAt)} ({formatDateTime(session.stopRequestedAt)})
            </time>
            {session.stopReason !== null && <> · “{session.stopReason}”</>}
          </Text>
        )}
        {canContribute && session.status === "active" && !stopping && (
          <StopAgentForm
            issueId={issueId}
            projectId={projectId}
            workspaceId={session.workspaceId}
          />
        )}
      </Stack>
    </Card>
  );
}

function StopAgentForm({
  issueId,
  projectId,
  workspaceId,
}: {
  issueId: string;
  projectId: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmOpen(true);
  }

  async function onConfirmStop() {
    setSubmitting(true);
    setError(undefined);
    try {
      const updated = await requestStop(issueId, reason);
      queryClient.setQueryData(sessionQuery(issueId).queryKey, updated);
      setConfirmOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "work-sessions"] }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      toast({ body: "Stop requested for active agent session." });
    } catch (cause) {
      setConfirmOpen(false);
      const msg = cause instanceof Error ? cause.message : "Could not request a stop.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={onSubmit}>
        <Stack gap={2} hAlign="start">
          <TextField
            label="Reason (optional)"
            id={`stop-reason-${issueId}`}
            htmlName="reason"
            value={reason}
            maxLength={2000}
            onChange={setReason}
            placeholder="Why should the agent stop?"
            width="100%"
          />
          <Button
            type="submit"
            size="sm"
            isDisabled={submitting}
            isLoading={submitting}
            label="Stop agent"
            variant="destructive"
          />
          {error !== undefined && <Banner status="error" role="alert" title={error} />}
        </Stack>
      </form>
      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Stop active agent session?"
        description={
          reason.trim() === ""
            ? "The agent will be signalled to wrap up and release its claim on this issue."
            : `The agent will be signalled to stop with reason: “${reason.trim()}”.`
        }
        actionLabel="Stop agent"
        actionVariant="destructive"
        isActionLoading={submitting}
        onAction={() => void onConfirmStop()}
      />
    </>
  );
}

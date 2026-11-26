import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import type { WorkSession } from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Square, Terminal } from "lucide-react";
import { useState } from "react";
import { TextField } from "../../lib/fields.tsx";
import { HarnessBadge } from "../../lib/harness.tsx";
import {
  chunkPath,
  coalesceAcpChunks,
  defaultOpenFor,
  extractChangedFiles,
  extractDiagnostics,
  extractPlan,
  filterChunks,
  isOwnerOfRunner,
  mergeStreamChunks,
  telemetryText,
  type StudioFilter,
} from "./stream.ts";
import { issueQuestionsQuery } from "../inbox/index.ts";
import { requestStop } from "../work-sessions/index.ts";
import { sessionsQuery } from "../work-sessions/index.ts";
import { projectQuery } from "../projects/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { resolveUncertainDispatch } from "./commands.ts";
import { harnessDisplayName } from "./dispatchOptions.ts";
import { NeedsInputComposer, PausedNeedsInput } from "./NeedsInput.tsx";
import { ContextRail, DiagnosticBanners, LeaseCountdown, StreamCard } from "./StudioParts.tsx";
import {
  dispatchMetaQuery,
  issueDispatchesQuery,
  issueDispatchesQueryKey,
  streamQuery,
  workspaceRunnersQuery,
} from "./queries.ts";

const FILTERS: ReadonlyArray<{ value: StudioFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "edits", label: "Edits" },
  { value: "commands", label: "Commands & Tests" },
  { value: "thoughts", label: "Thoughts" },
  { value: "diagnostics", label: "Diagnostics" },
];

const FILTER_VALUES: ReadonlySet<string> = new Set(FILTERS.map((entry) => entry.value));

function isFilter(value: string): value is StudioFilter {
  return FILTER_VALUES.has(value);
}

function asFilter(value: string | undefined): StudioFilter {
  return value !== undefined && isFilter(value) ? value : "all";
}

export function LiveStudio({
  issueId,
  runnerId,
  dispatchId,
  workspaceId: searchWorkspaceId,
  filter: searchFilter,
  file: selectedFile,
}: {
  issueId: string;
  runnerId: string;
  dispatchId: string;
  workspaceId?: string | undefined;
  filter?: string | undefined;
  file?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate({ from: "/live/$runnerId/$dispatchId" });
  const isNarrow = useMediaQuery("(max-width: 62rem)");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showRaw, setShowRaw] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopError, setStopError] = useState<string | undefined>();

  const hasIssue = issueId !== "";
  const sessions = useQuery({ ...sessionsQuery(issueId, true), enabled: hasIssue });
  const dispatches = useQuery({ ...issueDispatchesQuery(issueId), enabled: hasIssue });
  const listed = dispatches.data?.dispatches.find((entry) => entry.id === dispatchId);
  // Teammates with project Read access are not on the per-issue dispatch list
  // (it only covers a human's own dispatches), so fetch this dispatch's
  // metadata — including the custom prompt — directly. Non-members get 404.
  const meta = useQuery({
    ...dispatchMetaQuery(runnerId, dispatchId),
    enabled: hasIssue && listed === undefined && dispatches.isSuccess,
  });
  // The fetched metadata only applies when it belongs to the URL's issue;
  // a mismatched ?issueId= must keep behaving as if no dispatch were known.
  const dispatch =
    listed ?? (meta.data !== undefined && meta.data.issueId === issueId ? meta.data : undefined);
  const workspaceId = searchWorkspaceId ?? dispatch?.workspaceId ?? "";
  const session =
    sessions.data?.find((entry) => entry.id === dispatch?.workSessionId) ??
    sessions.data?.find((entry) => entry.status === "active") ??
    sessions.data?.[0];

  const hasMetadata = dispatch !== undefined || session !== undefined;
  const dispatchActive = dispatch !== undefined && dispatch.state !== "ended";
  const active = session !== undefined ? session.status === "active" : dispatchActive;
  const ended = hasMetadata && !active;

  // Polled question state drives the inline Needs Input composer; the deadline
  // clock itself lives in a leaf so this root does not re-render every second.
  // Replays are settled, so there is nothing to poll there.
  const questions = useQuery({
    ...issueQuestionsQuery(issueId),
    enabled: hasIssue,
    refetchInterval: ended ? false : 4000,
  });
  const openQuestion = questions.data?.find((entry) => entry.status === "open");
  const currentRunId = dispatch?.runId ?? session?.runId;
  // A historical paused question must not stick around on a new active dispatch.
  const pausedQuestion =
    openQuestion === undefined && !active
      ? questions.data?.find(
          (entry) =>
            entry.status === "paused" &&
            (currentRunId === undefined || entry.runId === currentRunId),
        )
      : undefined;

  const fleet = useQuery({
    ...workspaceRunnersQuery(workspaceId, !ended),
    enabled: workspaceId !== "",
  });
  const hostEntry = fleet.data?.hosts.find((entry) =>
    entry.runners.some((runner) => runner.id === runnerId),
  );
  const host = hostEntry?.host;
  const runner = hostEntry?.runners.find((entry) => entry.id === runnerId);
  const isOwner = isOwnerOfRunner(fleet.data?.hosts, runnerId);

  const runs = useQuery({
    ...workspaceRunsQuery(workspaceId),
    enabled: workspaceId !== "",
  });
  const run = runs.data?.find((entry) => entry.id === (dispatch?.runId ?? session?.runId));
  const project = useQuery({
    ...projectQuery(dispatch?.projectId ?? ""),
    enabled: dispatch?.projectId !== undefined,
  });
  // Matches resolveUncertain's server authorization: the host owner or a
  // project manager may settle an uncertain attempt; readers only see the banner.
  const canResolveUncertain =
    dispatch?.state === "uncertain" && (isOwner || project.data?.accessLevel === "manage");

  // A bare bookmark URL has no issue metadata, so read the stream directly by ids.
  const bareUrl = !hasIssue;
  const live = useQuery(
    streamQuery(queryClient, runnerId, dispatchId, {
      active: active || bareUrl,
      enabled: bareUrl || undefined,
    }),
  );
  const replay = useQuery(
    streamQuery(queryClient, runnerId, dispatchId, {
      active: ended && !bareUrl,
      replay: true,
    }),
  );
  const useLiveStream = bareUrl || active;
  const primaryStream = useLiveStream ? live : replay;
  const streamError = primaryStream.isError;
  const isStreamLoading = useLiveStream ? live.isPending : replay.isPending;
  const rawChunks = mergeStreamChunks(live.data?.chunks ?? [], replay.data?.chunks ?? []);
  const chunks = coalesceAcpChunks(rawChunks);
  const rolledUp = live.data?.rolledUp === true || replay.data?.rolledUp === true;

  const filter = asFilter(searchFilter);
  const diagnostics = extractDiagnostics(chunks);
  // Once a human resolves the dispatch (or the session ends), hide the active
  // "Runner disconnected — parked until resolved" banner; the event stays in the stream log.
  const activeDiagnostics =
    dispatch?.state === "ended"
      ? diagnostics.filter((entry) => entry.diagnostic.kind !== "runner_disconnected")
      : diagnostics;
  const plan = extractPlan(chunks);
  const files = extractChangedFiles(chunks);
  const visible = filterChunks(chunks, filter, { showRaw, file: selectedFile });

  const stop = useMutation({
    mutationFn: () => requestStop(issueId, reason),
    onSuccess: async (updated: WorkSession) => {
      await queryClient.cancelQueries({ queryKey: sessionsQuery(issueId).queryKey });
      queryClient.setQueryData<WorkSession[]>(sessionsQuery(issueId).queryKey, (current) =>
        current?.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      setConfirmStop(false);
      setStopError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueDispatchesQueryKey(issueId) }),
      ]);
      toast({ body: "Stop requested for the active agent session." });
    },
    onError: (cause: unknown) => {
      setConfirmStop(false);
      setStopError(cause instanceof Error ? cause.message : "Could not request a stop.");
    },
  });

  const resolve = useMutation({
    mutationFn: (outcome: "released" | "completed") =>
      resolveUncertainDispatch(dispatchId, outcome),
    onSuccess: async () => {
      toast({ body: "Uncertain dispatch resolved." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueDispatchesQueryKey(issueId) }),
        queryClient.invalidateQueries({ queryKey: sessionsQuery(issueId).queryKey }),
      ]);
    },
    onError: (cause: unknown) => {
      toast({
        body: cause instanceof Error ? cause.message : "Could not resolve this dispatch.",
        type: "error",
      });
    },
  });

  const connection = bareUrl
    ? live.isFetching
      ? "Streaming"
      : "Connected"
    : live.isFetching && active
      ? "Streaming"
      : active
        ? "Live"
        : "Replay";
  const telemetry = telemetryText({
    inputTokens: session?.inputTokens ?? null,
    outputTokens: session?.outputTokens ?? null,
    costUsdMicros: session?.costUsdMicros ?? null,
  });
  const sessionStatus =
    session?.stopRequested && session.status === "active" ? "stopping" : session?.status;

  const contextRail = (
    <ContextRail
      plan={plan}
      files={files}
      childWorkers={run?.children ?? []}
      host={host}
      runner={runner}
      prompt={dispatch?.prompt ?? undefined}
      selectedFile={selectedFile}
      onSelectFile={selectFile}
    />
  );

  function setFilter(value: string) {
    void navigate({
      search: (previous) => ({ ...previous, filter: value }),
    });
  }

  function selectFile(path: string) {
    void navigate({
      search: (previous) => ({ ...previous, filter: "edits", file: path }),
    });
  }

  return (
    <Layout
      contentWidth="78rem"
      padding={6}
      data-live-studio=""
      header={
        <LayoutHeader hasDivider>
          <Stack gap={2} width="100%">
            <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" vAlign="center">
              <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
                <Heading level={1} color="inherit">
                  Live Session Studio
                </Heading>
                <Token
                  label={connection}
                  size="sm"
                  color={active ? "green" : "gray"}
                  data-studio-connection=""
                />
                {sessionStatus !== undefined && (
                  <Token label={sessionStatus} size="sm" color={active ? "orange" : "gray"} />
                )}
                {openQuestion !== undefined && (
                  <Token label="Needs input" size="sm" color="orange" data-studio-needs-input="" />
                )}
                {pausedQuestion !== undefined && (
                  <Token label="Paused" size="sm" color="orange" data-studio-paused="" />
                )}
                {rolledUp && (
                  <Token label="Archived replay" size="sm" color="blue" data-studio-replay="" />
                )}
              </Stack>
              {hasIssue ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  icon={<Icon icon={ArrowLeft} />}
                  label="Back to issue"
                  onClick={() => void navigate({ to: "/issues/$issueId", params: { issueId } })}
                />
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  icon={<Icon icon={ArrowLeft} />}
                  label="Back to workspaces"
                  onClick={() => void navigate({ to: "/" })}
                />
              )}
            </Stack>

            <Stack direction="horizontal" gap={3} wrap="wrap" justify="between" vAlign="end">
              <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
                <Token label={host?.displayName ?? "Runner host"} size="sm" color="gray" />
                <Token
                  label={dispatch?.branchName ?? "branch unknown"}
                  size="sm"
                  color="gray"
                  data-studio-branch=""
                />
                <Token
                  label={dispatch?.dirtyWorktree === true ? "dirty worktree" : "clean worktree"}
                  size="sm"
                  color={dispatch?.dirtyWorktree === true ? "orange" : "gray"}
                />
                {active && session !== null && session !== undefined && (
                  <LeaseCountdown leaseExpiresAt={session.leaseExpiresAt} enabled={active} />
                )}
                <Stack
                  direction="horizontal"
                  gap={2}
                  vAlign="center"
                  wrap="wrap"
                  data-studio-options=""
                >
                  <HarnessBadge
                    harness={harnessDisplayName(runner, dispatch?.harness ?? run?.harness)}
                    empty="Harness unknown"
                  />
                  <Text type="supporting" color="secondary">
                    {run?.agentName ?? "Agent"} · {dispatch?.model ?? run?.model ?? "model unknown"}
                    {dispatch?.effort !== null && dispatch?.effort !== undefined
                      ? ` · ${dispatch.effort} effort`
                      : ""}{" "}
                    · {telemetry.tokens} tokens · {telemetry.cost}
                  </Text>
                </Stack>
              </Stack>

              {active && session !== null && session !== undefined && (
                <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="end">
                  <TextField
                    label="Stop reason (optional)"
                    id={`studio-stop-reason-${dispatchId}`}
                    htmlName="reason"
                    value={reason}
                    maxLength={2000}
                    onChange={setReason}
                    placeholder="Why should the agent stop?"
                    size="sm"
                    width="14rem"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    label="Stop Agent"
                    icon={<Icon icon={Square} />}
                    isDisabled={stop.isPending}
                    isLoading={stop.isPending}
                    data-studio-stop-agent=""
                    onClick={() => {
                      setStopError(undefined);
                      setConfirmStop(true);
                    }}
                  />
                </Stack>
              )}
            </Stack>
            {stopError !== undefined && (
              <Banner
                status="error"
                role="alert"
                title="Stop request failed"
                description={stopError}
                collapsible={false}
              />
            )}
            <AlertDialog
              isOpen={confirmStop}
              onOpenChange={setConfirmStop}
              title="Stop the active agent?"
              description={
                reason.trim() === ""
                  ? "The agent will be signalled to wrap up and release its claim on this issue. Leaving this Studio does not stop it."
                  : `The agent will be signalled to stop with reason: “${reason.trim()}”. Leaving this Studio does not stop it.`
              }
              actionLabel="Stop Agent"
              actionVariant="destructive"
              isActionLoading={stop.isPending}
              onAction={() => stop.mutate()}
            />
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent isScrollable>
          <Stack gap={4}>
            <DiagnosticBanners entries={activeDiagnostics} />
            {openQuestion !== undefined && (
              <NeedsInputComposer question={openQuestion} issueId={issueId} />
            )}
            {pausedQuestion !== undefined && (
              <PausedNeedsInput
                question={pausedQuestion}
                issueId={issueId}
                runnerId={runnerId}
                workspaceId={workspaceId}
                isOwner={isOwner}
              />
            )}
            {streamError && (
              <Banner
                status="error"
                role="alert"
                title="Could not load the session stream"
                description={
                  primaryStream.error instanceof Error
                    ? primaryStream.error.message
                    : "The session stream is unavailable."
                }
                collapsible={false}
                data-stream-error=""
              />
            )}
            {dispatch?.state === "uncertain" && (
              <Banner
                status="warning"
                title="This dispatch needs human resolution"
                description="The Runner lost its session. Resolve it before this issue can be dispatched again."
                collapsible={false}
                data-uncertain-dispatch=""
              >
                {canResolveUncertain && (
                  <Stack direction="horizontal" gap={2} wrap="wrap">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      label="Resolve as completed"
                      isDisabled={resolve.isPending}
                      data-resolve-dispatch="completed"
                      onClick={() => resolve.mutate("completed")}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      label="Release for re-dispatch"
                      isDisabled={resolve.isPending}
                      data-resolve-dispatch="released"
                      onClick={() => resolve.mutate("released")}
                    />
                  </Stack>
                )}
              </Banner>
            )}
            {rolledUp && (
              <Banner
                status="info"
                title="Replaying the archived session"
                description="The Runner session has ended. All chunks are replayed from the server's ObjectStore rollup."
                collapsible={false}
              />
            )}
            <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" vAlign="center">
              <SegmentedControl
                label="Stream filter"
                value={filter}
                onChange={setFilter}
                size="sm"
                data-stream-filter=""
              >
                {FILTERS.map((entry) => (
                  <SegmentedControlItem key={entry.value} value={entry.value} label={entry.label} />
                ))}
              </SegmentedControl>
              {isOwner ? (
                <ToggleButton
                  label="Raw output"
                  icon={<Icon icon={Terminal} />}
                  elevation="low"
                  isPressed={showRaw}
                  onPressedChange={setShowRaw}
                  size="sm"
                  data-raw-toggle=""
                >
                  Raw output
                </ToggleButton>
              ) : fleet.isPending && workspaceId !== "" ? (
                <Text type="supporting" color="secondary">
                  Checking Runner host access…
                </Text>
              ) : (
                <Text type="supporting" color="secondary" data-raw-restricted="">
                  Raw output is restricted to the Runner host owner.
                </Text>
              )}
            </Stack>
            {filter === "edits" && selectedFile !== undefined && (
              <Banner
                status="info"
                title={`Showing diffs for ${selectedFile}`}
                description="Only edits to this file are shown."
                isDismissable
                onDismiss={() =>
                  void navigate({
                    search: (previous) => ({ ...previous, file: undefined }),
                  })
                }
                collapsible={false}
              />
            )}
            {chunks.length === 0 && isStreamLoading && !streamError && (
              <Text as="p" display="block" type="supporting" role="status">
                Connecting to the session stream…
              </Text>
            )}
            {chunks.length === 0 && !isStreamLoading && !streamError && (
              <Text as="p" display="block" type="supporting" color="secondary">
                No stream chunks yet.
              </Text>
            )}
            <Stack gap={2} data-stream-pane="">
              {visible.map((chunk) => (
                <Stack key={chunk.seq} id={`stream-seq-${chunk.seq}`}>
                  <StreamCard
                    chunk={chunk}
                    isOpen={expanded[chunk.seq] ?? defaultOpenFor(chunk)}
                    highlighted={selectedFile !== undefined && chunkPath(chunk) === selectedFile}
                    onOpenChange={(open) =>
                      setExpanded((current) => ({ ...current, [chunk.seq]: open }))
                    }
                  />
                </Stack>
              ))}
            </Stack>
            {isNarrow && (
              <Section padding={3} data-narrow-context="">
                <Collapsible
                  trigger={
                    <Text type="body" weight="semibold">
                      Session context
                    </Text>
                  }
                  defaultIsOpen={false}
                >
                  <Stack paddingBlockStart={2}>{contextRail}</Stack>
                </Collapsible>
              </Section>
            )}
          </Stack>
        </LayoutContent>
      }
      end={
        isNarrow ? undefined : (
          <LayoutPanel
            width={320}
            hasDivider
            isScrollable
            role="complementary"
            label="Studio context"
          >
            {contextRail}
          </LayoutPanel>
        )
      }
    />
  );
}

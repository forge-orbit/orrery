import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import {
  type ActiveWorkSession,
  type Issue,
  IssuePriority,
  IssueStatus,
  type RunDetail,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  completedSubtaskCount,
  CreateIssueForm,
  issueBlockedByQuery,
  issueQuery,
  issuesQuery,
  issueStatusLabels,
  LabelPill,
  PRIORITY_LABELS,
  PriorityBadge,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  readyWorkQuery,
  ResourceLoadError,
  subtasksOf,
  updateIssue,
} from "../features/projects/index.ts";
import { workspaceRunsQuery } from "../features/runs/index.ts";
import { activeSessionsQuery, SessionInspectorDetails } from "../features/work-sessions/index.ts";
import { workspaceQuery } from "../features/workspaces/index.ts";
import { AgentAvatar } from "../lib/harness.tsx";
import { Link } from "../lib/Link.tsx";

export const Route = createFileRoute("/board/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(projectLabelsQuery(project.id)),
      context.queryClient.ensureQueryData(readyWorkQuery(project.id)),
      context.queryClient.ensureQueryData(activeSessionsQuery(project.workspaceId)),
    ]);
  },
  component: BoardPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="board" error={error} />,
});

type BoardFilter = "all" | "needs-input" | "ready";
type AssigneeFilter = "all" | "unassigned" | "human" | "agent";
type BoardPanel = { kind: "new-issue" } | { kind: "session"; issueId: string; sessionId: string };

const BOARD_COLUMNS: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

const COLUMN_STATUS_DOTS: Record<IssueStatus, StatusDotVariant> = {
  backlog: "neutral",
  todo: "neutral",
  in_progress: "accent",
  review: "warning",
  done: "success",
  cancelled: "neutral",
};

function BoardPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const { data: issues } = useSuspenseQuery({ ...issuesQuery(projectId), refetchInterval: 4000 });
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(projectId));
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const { data: runs = [] } = useQuery(workspaceRunsQuery(project.workspaceId));
  const { data: ready } = useSuspenseQuery({ ...readyWorkQuery(projectId), refetchInterval: 4000 });
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | "all">("all");
  const [labelFilter, setLabelFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [panel, setPanel] = useState<BoardPanel>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [createdIssue, setCreatedIssue] = useState<Issue>();
  const [moveError, setMoveError] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [draggingIssueId, setDraggingIssueId] = useState<string>();
  const [dragOverStatus, setDragOverStatus] = useState<IssueStatus>();
  const [pendingClose, setPendingClose] = useState<{
    issue: Issue;
    status: IssueStatus;
    openSubtaskCount: number;
  }>();

  const canContribute = project.accessLevel !== "read";
  const readyIds = new Set(ready.map((issue) => issue.id));
  const sessionsByIssue = new Map(
    sessions
      .filter((session) => session.projectId === project.id)
      .map((session) => [session.issueId, session]),
  );
  const needsInputCount = issues.filter((issue) => issue.needsInput).length;
  const filters: { id: BoardFilter; label: string; count: number }[] = [
    { id: "all", label: "All issues", count: issues.length },
    { id: "needs-input", label: "Needs input", count: needsInputCount },
    { id: "ready", label: "Ready to claim", count: readyIds.size },
  ];
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visible = issues.filter((issue) => {
    if (filter === "needs-input" && !issue.needsInput) return false;
    if (filter === "ready" && !readyIds.has(issue.id)) return false;
    if (assigneeFilter === "unassigned" && issue.assignee !== null) return false;
    if (assigneeFilter === "human" && (issue.assignee === null || issue.assignee.agentId != null)) {
      return false;
    }
    if (assigneeFilter === "agent" && issue.assignee?.agentId == null) return false;
    if (priorityFilter !== "all" && issue.priority !== priorityFilter) return false;
    if (labelFilter !== "all" && !issue.labels.some((label) => label.id === labelFilter)) {
      return false;
    }
    if (
      normalizedSearch !== "" &&
      !issue.title.toLowerCase().includes(normalizedSearch) &&
      !issue.identifier.toLowerCase().includes(normalizedSearch)
    ) {
      return false;
    }
    return true;
  });
  const columns = Object.groupBy(visible, (issue) => issue.status);
  const inspected =
    panel?.kind === "session" ? issues.find((issue) => issue.id === panel.issueId) : undefined;

  function showPanel(next: BoardPanel) {
    setPanel(next);
    setPanelOpen(true);
  }

  async function performMove(issue: Issue, status: IssueStatus) {
    setMoving(true);
    setMoveError(undefined);
    setPendingClose(undefined);
    try {
      await updateIssue(issue.id, { status });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      toast({ body: `Moved ${issue.identifier} to ${issueStatusLabels[status]}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not move the issue.";
      setMoveError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setMoving(false);
    }
  }

  function onMove(issue: Issue, status: IssueStatus) {
    if (status === issue.status) return;
    if (status === "done" || status === "cancelled") {
      const subtasks = subtasksOf(issues, issue.id);
      const openSubtaskCount = subtasks.length - completedSubtaskCount(subtasks);
      if (openSubtaskCount > 0) {
        setPendingClose({ issue, status, openSubtaskCount });
        return;
      }
    }
    void performMove(issue, status);
  }

  const hasActiveFilter =
    filter !== "all" ||
    assigneeFilter !== "all" ||
    priorityFilter !== "all" ||
    labelFilter !== "all" ||
    normalizedSearch !== "";

  function clearFilters() {
    setFilter("all");
    setAssigneeFilter("all");
    setPriorityFilter("all");
    setLabelFilter("all");
    setSearchQuery("");
  }

  return (
    <Stack width="100%" gap={4} data-board-page="">
      <Stack as="header" direction="vertical" gap={3}>
        <Stack
          as="nav"
          direction="horizontal"
          gap={1}
          vAlign="center"
          wrap="wrap"
          aria-label="Project location"
        >
          <Link
            to="/workspaces/$workspaceId"
            params={{ workspaceId: workspace.id }}
            color="secondary"
          >
            {workspace.name}
          </Link>
          <Icon icon="chevronRight" size="xsm" color="secondary" />
          <Link to="/projects/$projectId" params={{ projectId }} color="secondary">
            {project.name}
          </Link>
        </Stack>
        <Stack direction="horizontal" gap={2} vAlign="center" justify="between" wrap="wrap">
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Heading level={1} color="inherit">
              Board
            </Heading>
            <Token label={project.key} color="gray" size="sm" />
            {sessionsByIssue.size > 0 && (
              <Token
                label={`${sessionsByIssue.size} active ${sessionsByIssue.size === 1 ? "session" : "sessions"}`}
                color="green"
                size="sm"
                data-active-sessions=""
              />
            )}
          </Stack>
          {canContribute && (
            <Button
              label="New issue"
              variant="primary"
              size="sm"
              onClick={() => showPanel({ kind: "new-issue" })}
            />
          )}
        </Stack>
        <Section variant="transparent" dividers={["top", "bottom"]} padding={0} paddingBlock={3}>
          <Stack direction="horizontal" gap={2} vAlign="center" justify="between" wrap="wrap">
            <Stack
              direction="horizontal"
              gap={1}
              wrap="wrap"
              role="group"
              aria-label="Filter issues"
            >
              {filters.map(({ id, label, count }) => (
                <ToggleButton
                  key={id}
                  label={`${label} (${count})`}
                  isPressed={filter === id}
                  size="sm"
                  data-board-filter={id}
                  data-board-ready-count={id === "ready" ? String(count) : undefined}
                  onPressedChange={(pressed) => setFilter(pressed ? id : "all")}
                >
                  {label} <Badge label={count} />
                </ToggleButton>
              ))}
            </Stack>
            <Stack
              direction="horizontal"
              gap={1.5}
              vAlign="center"
              wrap="wrap"
              role="group"
              aria-label="Narrow issues"
            >
              <TextInput
                id="board-search"
                label="Search issues"
                isLabelHidden
                size="sm"
                width="13rem"
                placeholder="Search issues…"
                value={searchQuery}
                onChange={setSearchQuery}
              />
              <Selector
                label="Assignee"
                isLabelHidden
                id="board-assignee-filter"
                variant="secondary"
                size="sm"
                value={assigneeFilter}
                onChange={(value) =>
                  setAssigneeFilter(
                    value === "unassigned" || value === "human" || value === "agent"
                      ? value
                      : "all",
                  )
                }
                options={[
                  { value: "all", label: "Any assignee" },
                  { value: "unassigned", label: "Unassigned" },
                  { value: "human", label: "Human" },
                  { value: "agent", label: "Agent" },
                ]}
              />
              <Selector
                label="Priority"
                isLabelHidden
                id="board-priority-filter"
                variant="secondary"
                size="sm"
                value={priorityFilter}
                onChange={(value) =>
                  setPriorityFilter(value === "all" ? "all" : IssuePriority.parse(value))
                }
                options={[
                  { value: "all", label: "Any priority" },
                  ...IssuePriority.options.map((priority) => ({
                    value: priority,
                    label: PRIORITY_LABELS[priority],
                  })),
                ]}
              />
              <Selector
                label="Label"
                isLabelHidden
                id="board-label-filter"
                variant="secondary"
                size="sm"
                value={labelFilter}
                onChange={setLabelFilter}
                options={[
                  { value: "all", label: "Any label" },
                  ...labels.map((label) => ({ value: label.id, label: label.name })),
                ]}
              />
              {hasActiveFilter && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  label="Clear filters"
                  onClick={clearFilters}
                />
              )}
            </Stack>
          </Stack>
        </Section>
      </Stack>

      {createdIssue !== undefined && (
        <Banner
          status="success"
          role="status"
          isDismissable
          onDismiss={() => setCreatedIssue(undefined)}
          title={
            <>
              Created{" "}
              <Link to="/issues/$issueId" params={{ issueId: createdIssue.id }}>
                {createdIssue.identifier}
              </Link>
            </>
          }
        />
      )}

      {moveError !== undefined && (
        <Banner
          status="error"
          role="alert"
          data-board-move-error=""
          title="Could not move issue"
          description={moveError}
        />
      )}

      {pendingClose !== undefined && (
        <Banner
          status="warning"
          role="alert"
          data-board-open-subtask-warning=""
          title={`${pendingClose.issue.identifier} still has ${pendingClose.openSubtaskCount} open ${pendingClose.openSubtaskCount === 1 ? "subtask" : "subtasks"}`}
          description={`Move to ${issueStatusLabels[pendingClose.status]} anyway?`}
          endContent={
            <Stack direction="horizontal" gap={1}>
              <Button
                type="button"
                label="Close anyway"
                variant="secondary"
                size="sm"
                isDisabled={moving}
                isLoading={moving}
                onClick={() => void performMove(pendingClose.issue, pendingClose.status)}
              />
              <Button
                type="button"
                label="Cancel"
                variant="ghost"
                size="sm"
                isDisabled={moving}
                onClick={() => setPendingClose(undefined)}
              />
            </Stack>
          }
        />
      )}

      {issues.length === 0 ? (
        <Stack align="center" justify="center" minHeight="18rem" width="100%">
          <EmptyState
            title="No issues yet"
            description="Create an issue to start tracking work across columns."
            icon={<Icon icon="viewColumns" size="lg" />}
            headingLevel={2}
            actions={
              canContribute ? (
                <Button
                  label="New issue"
                  variant="primary"
                  onClick={() => showPanel({ kind: "new-issue" })}
                />
              ) : undefined
            }
          />
        </Stack>
      ) : (
        <>
          {visible.length === 0 && hasActiveFilter && (
            <Banner
              status="info"
              title="No matching issues"
              description="Try adjusting your search or active filters."
              endContent={
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  label="Show all issues"
                  onClick={clearFilters}
                />
              }
            />
          )}
          <Stack
            data-board=""
            direction="horizontal"
            tabIndex={0}
            role="region"
            aria-label="Issue board"
          >
            {BOARD_COLUMNS.map((status) => {
              const lane = columns[status] ?? [];
              const isDropTarget = dragOverStatus === status;
              return (
                <Stack
                  as="section"
                  key={status}
                  data-board-column={issueStatusLabels[status]}
                  data-board-status={status}
                  data-drag-over={isDropTarget ? "true" : undefined}
                  onDragOver={(event) => {
                    if (!canContribute || moving) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dragOverStatus !== status) setDragOverStatus(status);
                  }}
                  onDragLeave={(event) => {
                    if (
                      event.relatedTarget instanceof Node &&
                      event.currentTarget.contains(event.relatedTarget)
                    ) {
                      return;
                    }
                    if (dragOverStatus === status) setDragOverStatus(undefined);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOverStatus(undefined);
                    const droppedId = event.dataTransfer.getData("text/plain") || draggingIssueId;
                    setDraggingIssueId(undefined);
                    if (!canContribute || moving || !droppedId) return;
                    const droppedIssue = issues.find((candidate) => candidate.id === droppedId);
                    if (droppedIssue !== undefined) onMove(droppedIssue, status);
                  }}
                >
                  <Section variant="transparent" padding={1}>
                    <Stack gap={2} minHeight="clamp(18rem, 54svh, 34rem)">
                      <Stack
                        direction="horizontal"
                        justify="between"
                        vAlign="center"
                        gap={1.5}
                        paddingInline={1}
                        paddingBlock={1}
                      >
                        <Stack direction="horizontal" gap={1.5} vAlign="center">
                          <StatusDot
                            variant={COLUMN_STATUS_DOTS[status]}
                            label={`${issueStatusLabels[status]} status`}
                          />
                          <Heading level={4} accessibilityLevel={2} color="inherit">
                            {issueStatusLabels[status]}
                          </Heading>
                        </Stack>
                        <Badge label={lane.length} />
                      </Stack>
                      <Divider />
                      <Stack as="ul" gap={2}>
                        {lane.map((issue) => {
                          const subtasks = subtasksOf(issues, issue.id);
                          const session = sessionsByIssue.get(issue.id);
                          return (
                            <BoardCard
                              key={issue.id}
                              issue={issue}
                              session={session}
                              run={session === undefined ? undefined : runsById.get(session.runId)}
                              ready={readyIds.has(issue.id)}
                              subtaskCount={subtasks.length}
                              completedSubtaskCount={completedSubtaskCount(subtasks)}
                              canMove={canContribute && !moving}
                              dragging={draggingIssueId === issue.id}
                              onDragStart={() => setDraggingIssueId(issue.id)}
                              onDragEnd={() => {
                                setDraggingIssueId(undefined);
                                setDragOverStatus(undefined);
                              }}
                              onMove={(next) => onMove(issue, next)}
                              onInspect={(sessionId) =>
                                showPanel({ kind: "session", issueId: issue.id, sessionId })
                              }
                            />
                          );
                        })}
                      </Stack>
                    </Stack>
                  </Section>
                </Stack>
              );
            })}
          </Stack>
        </>
      )}

      <Drawer
        isOpen={panelOpen}
        onOpenChange={setPanelOpen}
        purpose={panel?.kind === "new-issue" ? "form" : "info"}
        label={panel?.kind === "new-issue" ? "New issue" : "Session preview"}
        width="29rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title={
                panel?.kind === "new-issue" ? "New issue" : (inspected?.title ?? "Session preview")
              }
              subtitle={
                inspected === undefined ? project.name : `${project.key}-${inspected.number}`
              }
              onOpenChange={setPanelOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            {panel?.kind === "new-issue" && canContribute && (
              <CreateIssueForm
                key={project.id}
                projectId={project.id}
                onCreated={(issue) => {
                  setCreatedIssue(issue);
                  setFilter("all");
                  setPanelOpen(false);
                }}
              />
            )}
            {panel?.kind === "session" && (
              <>
                {inspected === undefined ? (
                  <Banner status="error" role="alert" title="This issue is no longer available." />
                ) : (
                  <Stack gap={3}>
                    <Stack direction="horizontal" hAlign="start">
                      <Link
                        to="/issues/$issueId"
                        params={{ issueId: panel.issueId }}
                        search={{ inspector: true, session: panel.sessionId }}
                        color="accent"
                        weight="semibold"
                        hasUnderline
                      >
                        Open issue
                      </Link>
                    </Stack>
                    <SessionInspectorDetails
                      key={panel.sessionId}
                      issueId={panel.issueId}
                      canContribute={canContribute}
                      open={panelOpen}
                      initialSessionId={panel.sessionId}
                    />
                  </Stack>
                )}
              </>
            )}
          </LayoutContent>
        </Layout>
      </Drawer>
    </Stack>
  );
}

function BoardCard({
  issue,
  session,
  run,
  ready,
  subtaskCount,
  completedSubtaskCount: doneCount,
  canMove,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onInspect,
}: {
  issue: Issue;
  session: ActiveWorkSession | undefined;
  run: RunDetail | undefined;
  ready: boolean;
  subtaskCount: number;
  completedSubtaskCount: number;
  canMove: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (status: IssueStatus) => void;
  onInspect: (sessionId: string) => void;
}) {
  const { data: blockers = [] } = useQuery({
    ...issueBlockedByQuery(issue.id),
    refetchInterval: 15_000,
  });
  const state = issue.needsInput
    ? "needs-input"
    : session?.status === "active" && session.stopRequested
      ? "stopping"
      : session?.status;
  const assignee = issue.assignee;
  const assigneeType = assignee === null ? "none" : assignee.agentId != null ? "agent" : "human";

  return (
    <Stack
      as="li"
      data-board-issue-id={issue.id}
      data-ready={String(ready)}
      data-assignee-type={assigneeType}
      data-priority={issue.priority}
      draggable={canMove}
      onDragStart={(event) => {
        if (!canMove) return;
        event.dataTransfer.setData("text/plain", issue.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <Card
        data-needs-input={issue.needsInput ? "true" : "false"}
        data-agent-working={state === "active" ? "true" : undefined}
        data-draggable={canMove ? "true" : undefined}
        data-dragging={dragging ? "true" : undefined}
        data-subtask-count={String(subtaskCount)}
        data-completed-subtask-count={String(doneCount)}
        padding={3}
      >
        <Stack gap={2}>
          <Link
            to="/issues/$issueId"
            params={{ issueId: issue.id }}
            weight="medium"
            color="primary"
            display="block"
          >
            <Stack gap={0.5}>
              <Text type="code" color="secondary" data-issue-identifier={issue.identifier}>
                {issue.identifier}
              </Text>
              <Text type="body" color="primary" display="block" weight="medium" maxLines={2}>
                {issue.title}
              </Text>
            </Stack>
          </Link>
          {(issue.priority !== "none" ||
            assignee !== null ||
            state !== undefined ||
            blockers.length > 0 ||
            subtaskCount > 0 ||
            issue.labels.length > 0) && (
            <Stack direction="horizontal" gap={1} vAlign="center" wrap="wrap">
              {issue.priority !== "none" && <PriorityBadge priority={issue.priority} />}
              {state !== undefined && (
                <Token
                  label={state === "needs-input" ? "Needs input" : state}
                  color={
                    state === "active"
                      ? "green"
                      : state === "needs-input" || state === "stopping"
                        ? "orange"
                        : "gray"
                  }
                  size="sm"
                  data-session-state={state}
                />
              )}
              {blockers.length > 0 && (
                <Token
                  label={`Blocked by ${blockers.length}`}
                  color="red"
                  size="sm"
                  data-blocked-by={blockers.map((blocker) => blocker.id).join(",")}
                />
              )}
              {issue.labels.map((label) => (
                <LabelPill key={label.id} label={label} />
              ))}
              {subtaskCount > 0 && (
                <Text type="supporting" color="secondary">
                  Subtasks {doneCount}/{subtaskCount}
                </Text>
              )}
              {assignee !== null && (
                <Stack as="span" direction="horizontal" vAlign="center">
                  {assigneeType === "agent" ? (
                    <AgentAvatar
                      name={assignee.displayName}
                      harness={session?.agentId === assignee.agentId ? run?.harness : undefined}
                      size={16}
                    />
                  ) : (
                    <Avatar name={assignee.displayName} shape="circle" size="xsm" />
                  )}
                  <VisuallyHidden>{assignee.displayName}</VisuallyHidden>
                </Stack>
              )}
              {session !== undefined &&
                run !== undefined &&
                assignee?.agentId !== session.agentId && (
                  <Stack as="span" direction="horizontal" vAlign="center" data-working-agent="">
                    <AgentAvatar name={run.agentName} harness={run.harness} size={16} />
                    <VisuallyHidden>{run.agentName}</VisuallyHidden>
                  </Stack>
                )}
            </Stack>
          )}
          {(canMove || issue.needsInput || session !== undefined) && (
            <Stack direction="horizontal" gap={1.5} justify="between" vAlign="center" wrap="wrap">
              {canMove && (
                <Selector
                  label={`Move ${issue.identifier}`}
                  id={`board-move-${issue.id}`}
                  isLabelHidden
                  variant="ghost"
                  size="sm"
                  value={issue.status}
                  onChange={(value) => onMove(IssueStatus.parse(value))}
                  options={BOARD_COLUMNS.map((status) => ({
                    value: status,
                    label: issueStatusLabels[status],
                  }))}
                />
              )}
              {(issue.needsInput || session !== undefined) && (
                <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
                  {issue.needsInput && (
                    <Link
                      to="/inbox"
                      search={{ issue: issue.id }}
                      color="accent"
                      weight="semibold"
                      hasUnderline
                    >
                      View question
                    </Link>
                  )}
                  {session !== undefined && (
                    <Button
                      label="Inspect session"
                      variant="ghost"
                      size="sm"
                      onClick={() => onInspect(session.id)}
                    />
                  )}
                </Stack>
              )}
            </Stack>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

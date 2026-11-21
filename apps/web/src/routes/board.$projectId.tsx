import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Token } from "@astryxdesign/core/Token";
import { type ActiveWorkSession, type Issue, IssuePriority, IssueStatus } from "@orrery/contract";
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
import { activeSessionsQuery, SessionInspectorDetails } from "../features/work-sessions/index.ts";
import { workspaceQuery } from "../features/workspaces/index.ts";
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

function BoardPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const { data: issues } = useSuspenseQuery({ ...issuesQuery(projectId), refetchInterval: 4000 });
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(projectId));
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const { data: ready } = useSuspenseQuery({ ...readyWorkQuery(projectId), refetchInterval: 4000 });
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
    <Stack as="main" width="100%">
      <Stack as="header" direction="vertical" gap={2}>
        <Stack
          as="nav"
          direction="horizontal"
          gap={0.5}
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
          <Icon icon="chevronRight" size="xsm" />
          <Link to="/projects/$projectId" params={{ projectId }} color="secondary">
            {project.name}
          </Link>
        </Stack>
        <Stack direction="horizontal" gap={1} vAlign="center" justify="between" wrap="wrap">
          <Heading level={1} color="inherit">
            Board
          </Heading>
          {canContribute && (
            <Button
              label="New issue"
              variant="primary"
              onClick={() => showPanel({ kind: "new-issue" })}
            />
          )}
        </Stack>
        <Stack
          direction="horizontal"
          gap={1}
          vAlign="center"
          justify="between"
          wrap="wrap"
          paddingBlock={1}
        >
          <Stack
            direction="horizontal"
            gap={0.5}
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
            gap={0.5}
            wrap="wrap"
            role="group"
            aria-label="Narrow issues"
          >
            <TextInput
              id="board-search"
              label="Search issues"
              isLabelHidden
              size="sm"
              width="12rem"
              placeholder="Search issues…"
              value={searchQuery}
              onChange={setSearchQuery}
            />
            <Selector
              label="Assignee"
              id="board-assignee-filter"
              variant="secondary"
              size="sm"
              value={assigneeFilter}
              onChange={(value) =>
                setAssigneeFilter(
                  value === "unassigned" || value === "human" || value === "agent" ? value : "all",
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
          {sessionsByIssue.size > 0 && (
            <Text as="p" display="block" type="supporting" data-active-sessions="">
              {sessionsByIssue.size} active {sessionsByIssue.size === 1 ? "session" : "sessions"}
            </Text>
          )}
        </Stack>
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
                  direction="vertical"
                  padding={1}
                  gap={0.5}
                  minHeight="clamp(17rem, 50svh, 29rem)"
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
                  <Heading level={2} color="inherit">
                    {issueStatusLabels[status]} <Badge label={lane.length} />
                  </Heading>
                  <Stack as="ul" gap={0.5}>
                    {lane.map((issue) => {
                      const subtasks = subtasksOf(issues, issue.id);
                      return (
                        <BoardCard
                          key={issue.id}
                          issue={issue}
                          session={sessionsByIssue.get(issue.id)}
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
                  <>
                    <Link
                      to="/issues/$issueId"
                      params={{ issueId: panel.issueId }}
                      search={{ inspector: true, session: panel.sessionId }}
                    >
                      Open issue
                    </Link>
                    <SessionInspectorDetails
                      key={panel.sessionId}
                      issueId={panel.issueId}
                      canContribute={canContribute}
                      open={panelOpen}
                      initialSessionId={panel.sessionId}
                    />
                  </>
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
        <Link
          to="/issues/$issueId"
          params={{ issueId: issue.id }}
          weight="semibold"
          display="block"
        >
          <Text type="inherit" color="inherit" display="block" weight="semibold">
            <Text type="code" color="secondary" data-issue-identifier={issue.identifier}>
              {issue.identifier}
            </Text>
            {issue.title}
          </Text>
        </Link>
        {(issue.priority !== "none" ||
          assignee !== null ||
          state !== undefined ||
          blockers.length > 0 ||
          subtaskCount > 0) && (
          <Stack direction="horizontal" gap={0.5} vAlign="center" wrap="wrap">
            {issue.priority !== "none" && <PriorityBadge priority={issue.priority} />}
            {state !== undefined && (
              <Text type="inherit" color="inherit" data-session-state={state}>
                {state === "needs-input" ? "Needs input" : state}
              </Text>
            )}
            {blockers.length > 0 && (
              <Token
                label={`Blocked by ${blockers.length}`}
                color="red"
                size="sm"
                data-blocked-by={blockers.map((blocker) => blocker.id).join(",")}
              />
            )}
            {assignee !== null && (
              <Stack as="span" direction="horizontal" gap={0.5} vAlign="center">
                <Avatar
                  name={assignee.displayName}
                  shape={assigneeType === "agent" ? "rounded" : "circle"}
                  size="xsm"
                  tooltip={false}
                />
                <Text type="inherit" color="inherit">
                  {assignee.displayName}
                </Text>
              </Stack>
            )}
            {subtaskCount > 0 && (
              <Text type="supporting" color="secondary">
                Subtasks {doneCount}/{subtaskCount}
              </Text>
            )}
          </Stack>
        )}
        {issue.labels.length > 0 && (
          <Stack direction="horizontal" gap={0.5} wrap="wrap">
            {issue.labels.map((label) => (
              <LabelPill key={label.id} label={label} />
            ))}
          </Stack>
        )}
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
          <Stack
            direction="horizontal"
            gap={0.5}
            vAlign="center"
            wrap="wrap"
            paddingBlockStart={0.5}
          >
            {issue.needsInput && (
              <Link to="/inbox" search={{ issue: issue.id }} color="accent" hasUnderline>
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
      </Card>
    </Stack>
  );
}

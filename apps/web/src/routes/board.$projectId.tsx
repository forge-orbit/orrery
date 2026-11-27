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
import { Stack, StackItem } from "@astryxdesign/core/Stack";
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
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import {
  compareBoardIssues,
  completedSubtaskCount,
  computeBoardDropPlacement,
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
import { LiveStudioLink } from "../features/runners/index.ts";
import { workspaceRunsQuery } from "../features/runs/index.ts";
import { activeSessionsQuery, SessionInspectorDetails } from "../features/work-sessions/index.ts";
import { workspaceQuery } from "../features/workspaces/index.ts";
import { HumanAvatar } from "../lib/avatar.tsx";
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
type AssigneeFilter = "all" | "unassigned" | "human";
type BoardPanel = { kind: "session"; issueId: string; sessionId: string };

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

const DRAG_THRESHOLD_PX = 6;

type DragState = {
  issue: Issue;
  sourceStatus: IssueStatus;
  sourceIndex: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
};

type PendingDrag = DragState & {
  pointerId: number;
  startX: number;
  startY: number;
};

type DropTarget = {
  status: IssueStatus;
  index: number;
  slotY: number;
};

function isInteractiveDragTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, select, textarea, [role='combobox'], [role='option'], [role='listbox']",
    ) !== null
  );
}

function BoardPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
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
  const [moveError, setMoveError] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [dragState, setDragState] = useState<DragState>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const [pendingClose, setPendingClose] = useState<{
    issue: Issue;
    status: IssueStatus;
    sortOrder: number | undefined;
    priority: IssuePriority | undefined;
    openSubtaskCount: number;
  }>();

  const boardRef = useRef<HTMLElement>(null);
  const pendingDragRef = useRef<PendingDrag | undefined>(undefined);
  const dragStateRef = useRef<DragState | undefined>(undefined);
  const dropTargetRef = useRef<DropTarget | undefined>(undefined);
  const suppressClickRef = useRef(false);

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
    if (assigneeFilter === "human" && issue.assignee === null) return false;
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

  async function performMove(
    issue: Issue,
    status: IssueStatus,
    sortOrder?: number,
    priority?: IssuePriority,
  ) {
    setMoving(true);
    setMoveError(undefined);
    setPendingClose(undefined);
    const nextPriority = priority ?? issue.priority;
    const priorityChanged = nextPriority !== issue.priority;
    const previousIssues = queryClient.getQueryData<Issue[]>(issuesQuery(projectId).queryKey);
    if (previousIssues !== undefined) {
      const nextIssues = previousIssues
        .map((candidate) =>
          candidate.id === issue.id
            ? {
                ...candidate,
                status,
                priority: nextPriority,
                ...(sortOrder === undefined ? {} : { sortOrder }),
              }
            : candidate,
        )
        .toSorted(compareBoardIssues);
      queryClient.setQueryData(issuesQuery(projectId).queryKey, nextIssues);
    }
    try {
      await updateIssue(issue.id, {
        status,
        ...(priorityChanged ? { priority: nextPriority } : {}),
        ...(sortOrder === undefined ? {} : { sortOrder }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      toast({
        body:
          status === issue.status
            ? priorityChanged
              ? `Moved ${issue.identifier} to ${PRIORITY_LABELS[nextPriority]} priority in ${issueStatusLabels[status]}.`
              : `Reordered ${issue.identifier} in ${issueStatusLabels[status]}.`
            : priorityChanged
              ? `Moved ${issue.identifier} to ${issueStatusLabels[status]} (${PRIORITY_LABELS[nextPriority]} priority).`
              : `Moved ${issue.identifier} to ${issueStatusLabels[status]}.`,
      });
    } catch (cause) {
      if (previousIssues !== undefined) {
        queryClient.setQueryData(issuesQuery(projectId).queryKey, previousIssues);
      }
      const msg = cause instanceof Error ? cause.message : "Could not move the issue.";
      setMoveError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setMoving(false);
    }
  }

  function onMove(issue: Issue, status: IssueStatus, sortOrder?: number, priority?: IssuePriority) {
    const statusChanged = status !== issue.status;
    const priorityChanged = priority !== undefined && priority !== issue.priority;
    const orderChanged = sortOrder !== undefined && sortOrder !== issue.sortOrder;
    if (!statusChanged && !priorityChanged && !orderChanged) return;
    if (statusChanged && (status === "done" || status === "cancelled")) {
      const subtasks = subtasksOf(issues, issue.id);
      const openSubtaskCount = subtasks.length - completedSubtaskCount(subtasks);
      if (openSubtaskCount > 0) {
        setPendingClose({ issue, status, sortOrder, priority, openSubtaskCount });
        return;
      }
    }
    void performMove(issue, status, sortOrder, priority);
  }

  function computeDropTarget(
    clientX: number,
    clientY: number,
    active: DragState,
  ): DropTarget | undefined {
    const board = boardRef.current;
    if (board === null) return undefined;
    const columnNodes = board.querySelectorAll<HTMLElement>("[data-board-status]");
    let matchedColumn: HTMLElement | undefined;
    for (const columnNode of columnNodes) {
      const rect = columnNode.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        matchedColumn = columnNode;
        break;
      }
    }
    if (matchedColumn === undefined) return undefined;
    const parsedStatus = IssueStatus.safeParse(matchedColumn.getAttribute("data-board-status"));
    if (!parsedStatus.success) return undefined;
    const status = parsedStatus.data;
    const laneNode = matchedColumn.querySelector<HTMLElement>("[data-board-lane]");
    if (laneNode === null) return { status, index: 0, slotY: 0 };

    const laneRect = laneNode.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(laneNode).rowGap) || 8;
    const cards = [...laneNode.querySelectorAll<HTMLElement>("[data-board-issue-id]")];

    if (status !== active.sourceStatus) {
      let index = cards.length;
      for (let i = 0; i < cards.length; i += 1) {
        const card = cards[i]!;
        const midY = laneRect.top + card.offsetTop + card.offsetHeight / 2;
        if (clientY < midY) {
          index = i;
          break;
        }
      }
      let slotY = 0;
      if (cards.length > 0) {
        if (index < cards.length) {
          slotY = cards[index]!.offsetTop;
        } else {
          const last = cards[cards.length - 1]!;
          slotY = last.offsetTop + last.offsetHeight + gap;
        }
      }
      return { status, index, slotY };
    }

    const otherCards = cards.filter((_, idx) => idx !== active.sourceIndex);
    let targetIndex = otherCards.length;
    for (let i = 0; i < otherCards.length; i += 1) {
      const card = otherCards[i]!;
      const midY = laneRect.top + card.offsetTop + card.offsetHeight / 2;
      if (clientY < midY) {
        targetIndex = i;
        break;
      }
    }
    let slotY = 0;
    if (targetIndex === active.sourceIndex) {
      slotY = cards[active.sourceIndex]?.offsetTop ?? 0;
    } else if (targetIndex < active.sourceIndex) {
      slotY = cards[targetIndex]?.offsetTop ?? 0;
    } else {
      const targetCard = cards[targetIndex];
      slotY =
        targetCard === undefined
          ? 0
          : targetCard.offsetTop + targetCard.offsetHeight - active.height;
    }
    return { status, index: targetIndex, slotY };
  }

  function applyDropTarget(next: DropTarget | undefined) {
    const prev = dropTargetRef.current;
    const board = boardRef.current;
    if (board !== null && next !== undefined) {
      board.style.setProperty("--drop-slot-y", `${next.slotY}px`);
    }
    if (
      prev?.status === next?.status &&
      prev?.index === next?.index &&
      prev?.slotY === next?.slotY
    ) {
      return;
    }
    dropTargetRef.current = next;
    setDropTarget(next);
  }

  function clearDrag() {
    pendingDragRef.current = undefined;
    dragStateRef.current = undefined;
    dropTargetRef.current = undefined;
    setDragState(undefined);
    setDropTarget(undefined);
  }

  function onCardPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    issue: Issue,
    sourceStatus: IssueStatus,
    sourceIndex: number,
  ) {
    if (!canContribute || moving || event.button !== 0) return;
    if (isInteractiveDragTarget(event.target)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pendingDragRef.current = {
      issue,
      sourceStatus,
      sourceIndex,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function onCardPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const pending = pendingDragRef.current;
    let active = dragStateRef.current;
    if (active === undefined) {
      if (pending === undefined || pending.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) <
        DRAG_THRESHOLD_PX
      ) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      active = {
        issue: pending.issue,
        sourceStatus: pending.sourceStatus,
        sourceIndex: pending.sourceIndex,
        width: pending.width,
        height: pending.height,
        offsetX: pending.offsetX,
        offsetY: pending.offsetY,
      };
      dragStateRef.current = active;
      suppressClickRef.current = true;
      window.getSelection()?.removeAllRanges();
      const board = boardRef.current;
      if (board !== null) {
        board.style.setProperty("--drag-width", `${active.width}px`);
        board.style.setProperty("--drag-height", `${active.height}px`);
        board.style.setProperty("--drag-x", `${event.clientX - active.offsetX}px`);
        board.style.setProperty("--drag-y", `${event.clientY - active.offsetY}px`);
      }
      setDragState(active);
    } else {
      event.preventDefault();
      const board = boardRef.current;
      if (board !== null) {
        board.style.setProperty("--drag-x", `${event.clientX - active.offsetX}px`);
        board.style.setProperty("--drag-y", `${event.clientY - active.offsetY}px`);
      }
    }
    applyDropTarget(computeDropTarget(event.clientX, event.clientY, active));
  }

  function onCardPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const active = dragStateRef.current;
    const target = dropTargetRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearDrag();
    if (suppressClickRef.current) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    if (active === undefined || target === undefined) return;
    if (target.status === active.sourceStatus && target.index === active.sourceIndex) return;

    const others = (columns[target.status] ?? []).filter((item) => item.id !== active.issue.id);
    const placement = computeBoardDropPlacement(active.issue, others, target.index);
    onMove(active.issue, target.status, placement.sortOrder, placement.priority);
  }

  function onCardPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    suppressClickRef.current = false;
    clearDrag();
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
          {canContribute && issues.length > 0 && (
            <Button
              label="New issue"
              icon={<Icon icon={Plus} />}
              variant="primary"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/projects/$projectId/issues/new",
                  params: { projectId },
                })
              }
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
                  setAssigneeFilter(value === "unassigned" || value === "human" ? value : "all")
                }
                options={[
                  { value: "all", label: "Any assignee" },
                  { value: "unassigned", label: "Unassigned" },
                  { value: "human", label: "Human" },
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
                onClick={() =>
                  void performMove(
                    pendingClose.issue,
                    pendingClose.status,
                    pendingClose.sortOrder,
                    pendingClose.priority,
                  )
                }
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
                  icon={<Icon icon={Plus} />}
                  variant="primary"
                  onClick={() =>
                    void navigate({
                      to: "/projects/$projectId/issues/new",
                      params: { projectId },
                    })
                  }
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
            ref={boardRef}
            data-board=""
            data-dragging-active={dragState !== undefined ? "true" : undefined}
            direction="horizontal"
            tabIndex={0}
            role="region"
            aria-label="Issue board"
          >
            {BOARD_COLUMNS.map((status) => {
              const lane = columns[status] ?? [];
              const isDropTarget = dropTarget?.status === status;
              const isCrossColumnDrop =
                dragState !== undefined && isDropTarget && dragState.sourceStatus !== status;
              const isSameColumnDrop =
                dragState !== undefined && isDropTarget && dragState.sourceStatus === status;
              return (
                <Stack
                  as="section"
                  key={status}
                  data-board-column={issueStatusLabels[status]}
                  data-board-status={status}
                  data-drag-over={isDropTarget ? "true" : undefined}
                >
                  <Section variant="transparent" padding={1}>
                    <Stack gap={2} minHeight="clamp(18rem, 54svh, 34rem)">
                      <Stack
                        direction="horizontal"
                        justify="between"
                        vAlign="center"
                        gap={1.5}
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
                      <Stack
                        as="ul"
                        gap={2}
                        data-board-lane=""
                        data-drop-active={isCrossColumnDrop ? "true" : undefined}
                      >
                        {isDropTarget && (
                          <Stack as="li" aria-hidden="true" data-board-drop-slot="" />
                        )}
                        {lane.map((issue, laneIndex) => {
                          const subtasks = subtasksOf(issues, issue.id);
                          const session = sessionsByIssue.get(issue.id);
                          const isDraggingThis = dragState?.issue.id === issue.id;
                          let shift: "up" | "down" | undefined;
                          if (
                            isCrossColumnDrop &&
                            dropTarget !== undefined &&
                            laneIndex >= dropTarget.index
                          ) {
                            shift = "down";
                          } else if (
                            isSameColumnDrop &&
                            dragState !== undefined &&
                            dropTarget !== undefined &&
                            !isDraggingThis
                          ) {
                            if (
                              dropTarget.index > dragState.sourceIndex &&
                              laneIndex > dragState.sourceIndex &&
                              laneIndex <= dropTarget.index
                            ) {
                              shift = "up";
                            } else if (
                              dropTarget.index < dragState.sourceIndex &&
                              laneIndex >= dropTarget.index &&
                              laneIndex < dragState.sourceIndex
                            ) {
                              shift = "down";
                            }
                          }
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
                              dragging={isDraggingThis}
                              sameColumnDrag={isDraggingThis && isSameColumnDrop}
                              shift={shift}
                              onPointerDown={(event) =>
                                onCardPointerDown(event, issue, status, laneIndex)
                              }
                              onPointerMove={onCardPointerMove}
                              onPointerUp={onCardPointerUp}
                              onPointerCancel={onCardPointerCancel}
                              onClickCapture={(event) => {
                                if (suppressClickRef.current) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  suppressClickRef.current = false;
                                }
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
            {dragState !== undefined && (
              <Stack data-drag-overlay="" aria-hidden="true">
                <BoardCardContent
                  issue={dragState.issue}
                  session={sessionsByIssue.get(dragState.issue.id)}
                  run={(() => {
                    const session = sessionsByIssue.get(dragState.issue.id);
                    return session === undefined ? undefined : runsById.get(session.runId);
                  })()}
                  subtaskCount={subtasksOf(issues, dragState.issue.id).length}
                  completedSubtaskCount={completedSubtaskCount(
                    subtasksOf(issues, dragState.issue.id),
                  )}
                  canMove={canContribute && !moving}
                  dragging={false}
                  isOverlay
                  onMove={() => {}}
                  onInspect={() => {}}
                />
              </Stack>
            )}
          </Stack>
        </>
      )}

      <Drawer
        isOpen={panelOpen}
        onOpenChange={setPanelOpen}
        purpose="info"
        label="Session preview"
        width="29rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title={inspected?.title ?? "Session preview"}
              subtitle={
                inspected === undefined ? project.name : `${project.key}-${inspected.number}`
              }
              onOpenChange={setPanelOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
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
                      compact
                      liveStudioLink={<LiveStudioLink issueId={panel.issueId} />}
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
  sameColumnDrag,
  shift,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onClickCapture,
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
  sameColumnDrag: boolean;
  shift: "up" | "down" | undefined;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  onMove: (status: IssueStatus) => void;
  onInspect: (sessionId: string) => void;
}) {
  const assignee = issue.assignee;
  const assigneeType = assignee === null ? "none" : "human";

  return (
    <Stack
      as="li"
      data-board-issue-id={issue.id}
      data-ready={String(ready)}
      data-assignee-type={assigneeType}
      data-priority={issue.priority}
      data-draggable={canMove ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-same-column-drag={sameColumnDrag ? "true" : undefined}
      data-shift={shift}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
    >
      <BoardCardContent
        issue={issue}
        session={session}
        run={run}
        subtaskCount={subtaskCount}
        completedSubtaskCount={doneCount}
        canMove={canMove}
        dragging={dragging}
        isOverlay={false}
        onMove={onMove}
        onInspect={onInspect}
      />
    </Stack>
  );
}

function BoardCardContent({
  issue,
  session,
  run,
  subtaskCount,
  completedSubtaskCount: doneCount,
  canMove,
  dragging,
  isOverlay,
  onMove,
  onInspect,
}: {
  issue: Issue;
  session: ActiveWorkSession | undefined;
  run: RunDetail | undefined;
  subtaskCount: number;
  completedSubtaskCount: number;
  canMove: boolean;
  dragging: boolean;
  isOverlay: boolean;
  onMove: (status: IssueStatus) => void;
  onInspect: (sessionId: string) => void;
}) {
  const blockers = issue.blockedByIds;
  const state = issue.needsInput
    ? "needs-input"
    : session?.status === "active" && session.stopRequested
      ? "stopping"
      : session?.status;
  const assignee = issue.assignee;
  const hasLabels =
    issue.priority !== "none" ||
    state !== undefined ||
    blockers.length > 0 ||
    issue.labels.length > 0;
  // The assignee is always a human now, so a live session always shows its Agent.
  const workingAgent = session !== undefined && run !== undefined ? run : undefined;
  const hasAvatars = assignee !== null || workingAgent !== undefined;

  return (
    <Card
      data-needs-input={issue.needsInput ? "true" : "false"}
      data-agent-working={state === "active" ? "true" : undefined}
      data-draggable={canMove ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-subtask-count={String(subtaskCount)}
      data-completed-subtask-count={String(doneCount)}
      elevation={isOverlay ? "high" : "none"}
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
        {(hasLabels || hasAvatars) && (
          <Stack direction="horizontal" gap={2} justify="between" vAlign="start">
            <StackItem size="fill">
              {hasLabels && (
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
                      data-blocked-by={blockers.join(",")}
                    />
                  )}
                  {issue.labels.map((label) => (
                    <LabelPill key={label.id} label={label} />
                  ))}
                </Stack>
              )}
            </StackItem>
            {hasAvatars && (
              <StackItem size="static">
                <Stack direction="horizontal" gap={1} vAlign="center">
                  {assignee !== null && (
                    <Stack as="span" direction="horizontal" vAlign="center">
                      <HumanAvatar name={assignee.displayName} size="xsm" />
                      <VisuallyHidden>{assignee.displayName}</VisuallyHidden>
                    </Stack>
                  )}
                  {workingAgent !== undefined && (
                    <Stack as="span" direction="horizontal" vAlign="center" data-working-agent="">
                      <AgentAvatar
                        name={workingAgent.agentName}
                        harness={workingAgent.harness}
                        size={16}
                      />
                      <VisuallyHidden>{workingAgent.agentName}</VisuallyHidden>
                    </Stack>
                  )}
                </Stack>
              </StackItem>
            )}
          </Stack>
        )}
        {(canMove || subtaskCount > 0 || issue.needsInput || session !== undefined) && (
          <Stack direction="horizontal" gap={1.5} justify="between" vAlign="center" wrap="wrap">
            {canMove && (
              <Selector
                label={`Move ${issue.identifier}`}
                id={isOverlay ? undefined : `board-move-${issue.id}`}
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
            {(subtaskCount > 0 || issue.needsInput || session !== undefined) && (
              <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
                {subtaskCount > 0 && (
                  <Text type="supporting" color="secondary">
                    Subtasks {doneCount}/{subtaskCount}
                  </Text>
                )}
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
  );
}

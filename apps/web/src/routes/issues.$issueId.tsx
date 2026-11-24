import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from "@astryxdesign/core/Layout";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import {
  type Actor,
  type Issue,
  type IssueComment,
  type IssueDetail,
  type IssueLink,
  IssueLinkKind,
  type ProjectActivity,
  IssueStatus,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent, RefObject } from "react";
import { useRef, useState } from "react";
import { agentKeysQuery, workspaceAgentKeysQuery } from "../features/agents/index.ts";
import {
  addBlockedBy,
  addIssueLink,
  type AssigneeCandidate,
  buildTimeline,
  AssigneeControl,
  completedSubtaskCount,
  createIssueComment,
  deleteIssue,
  issueBlockedByQuery,
  issueBlockingQuery,
  issueCommentsQuery,
  IssueLabels,
  issueActivityQuery,
  IssueMentionTextArea,
  IssuePriorityControls,
  issueQuery,
  issuesQuery,
  issueStatusLabels,
  groupLabelEvents,
  missingProjectAccessHumanIds,
  PRIORITY_LABELS,
  projectAccessHumanIdsQuery,
  LabelPill,
  MentionMarkdown,
  PriorityBadge,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  projectTrashQuery,
  readyWorkQuery,
  removeBlockedBy,
  removeIssueLink,
  ResourceLoadError,
  Subtasks,
  subtasksOf,
  type TimelineEntry,
  TitleBodyForm,
  updateIssue,
} from "../features/projects/index.ts";
import { workspaceRunsQuery } from "../features/runs/index.ts";
import {
  activeSessionsQuery,
  SessionInspector,
  SessionStatus,
} from "../features/work-sessions/index.ts";
import { workspaceMembersQuery, workspaceQuery } from "../features/workspaces/index.ts";
import { HumanAvatar } from "../lib/avatar.tsx";
import { TextField } from "../lib/fields.tsx";
import { AgentAvatar } from "../lib/harness.tsx";
import { Link } from "../lib/Link.tsx";
import { quoteReply } from "../lib/markdown-toolbar.ts";
import { PageHeader } from "../lib/PageHeader.tsx";
import { formatCompactDateTime, formatFullDateTime, relativeTime } from "../lib/time.ts";

export const Route = createFileRoute("/issues/$issueId")({
  staticData: { fullHeightLayout: true },
  validateSearch: (search: Record<string, unknown>) => {
    const parsed: { inspector?: true; session?: string } = {};
    if (search.inspector === true || search.inspector === "true") parsed.inspector = true;
    if (typeof search.session === "string") parsed.session = search.session;
    return parsed;
  },
  loader: async ({ context, params }) => {
    const issue = await context.queryClient.ensureQueryData(issueQuery(params.issueId));
    const project = await context.queryClient.ensureQueryData(projectQuery(issue.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issueCommentsQuery(params.issueId)),
      context.queryClient.ensureQueryData(issueActivityQuery(params.issueId)),
      context.queryClient.ensureQueryData(workspaceQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(agentKeysQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(issueBlockedByQuery(params.issueId)),
      context.queryClient.ensureQueryData(issueBlockingQuery(params.issueId)),
      context.queryClient.ensureQueryData(issuesQuery(issue.projectId)),
      context.queryClient.ensureQueryData(projectLabelsQuery(issue.projectId)),
      context.queryClient.ensureQueryData(activeSessionsQuery(project.workspaceId)),
    ]);
  },
  component: IssuePage,
  errorComponent: ({ error }) => (
    <Layout contentWidth="78rem" padding={6}>
      <LayoutContent>
        <ResourceLoadError resource="issue" error={error} />
      </LayoutContent>
    </Layout>
  ),
});

const STATUS_OPTIONS: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

const STATUS_COLORS: Record<IssueStatus, "gray" | "blue" | "orange" | "purple" | "green" | "red"> =
  {
    backlog: "gray",
    todo: "blue",
    in_progress: "orange",
    review: "purple",
    done: "green",
    cancelled: "red",
  };

const LINK_KIND_LABELS: Record<IssueLinkKind, string> = {
  pr: "PR",
  commit: "Commit",
  doc: "Doc",
  link: "Link",
};

function describeActivity(activity: ProjectActivity): string {
  const detail = activity.detail;
  if (detail === null) return activity.summary;
  switch (detail.kind) {
    case "issue_edited":
      return detail.changes
        .map((change) => {
          switch (change.kind) {
            case "status":
              return `changed status from ${issueStatusLabels[change.from]} to ${issueStatusLabels[change.to]}`;
            case "priority":
              return `changed priority from ${PRIORITY_LABELS[change.from]} to ${PRIORITY_LABELS[change.to]}`;
            case "assignee":
              return `changed assignee from ${change.from?.displayName ?? "nobody"} to ${change.to?.displayName ?? "nobody"}`;
            default:
              return activity.summary;
          }
        })
        .join("; ");
    case "label_added":
      return `added the ${detail.label.name} label`;
    case "label_removed":
      return `removed the ${detail.label.name} label`;
    case "issue_closed":
      return "closed the issue";
    case "issue_reopened":
      return "reopened the issue";
    case "parent_changed":
      return detail.to === null ? "cleared the parent issue" : "changed the parent issue";
    case "issue_dependency_added":
      return `added ${detail.title} as a blocker`;
    case "issue_dependency_removed":
      return `removed ${detail.title} as a blocker`;
    case "issue_link_added":
      return `added the ${detail.title} link`;
    case "issue_link_removed":
      return `removed the ${detail.title} link`;
    default:
      return activity.summary;
  }
}

function ActorAvatar({ actor }: { actor: Actor }) {
  if (actor.agentId != null) return <AgentAvatar name={actor.displayName} size={16} />;
  return (
    <HumanAvatar name={actor.displayName} avatarUrl={actor.avatarUrl} size="xsm" tooltip={false} />
  );
}

function TimelineRow({
  entry,
  projectId,
  projectIssues,
  canContribute,
  onQuoteReply,
}: {
  entry: TimelineEntry;
  projectId: string;
  projectIssues: Issue[];
  canContribute: boolean;
  onQuoteReply: (comment: IssueComment) => void;
}) {
  if (entry.kind === "comment") {
    return (
      <Stack as="li" key={entry.id} data-timeline-kind="comment" data-comment-id={entry.comment.id}>
        <Card variant="muted" padding={3}>
          <Stack gap={2}>
            <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" vAlign="center">
              <Stack direction="horizontal" gap={1.5} vAlign="center">
                <ActorAvatar actor={entry.comment.author} />
                <Text type="body" weight="semibold" color="primary">
                  {entry.comment.author.displayName}
                </Text>
                <Text type="supporting" color="secondary">
                  commented
                </Text>
              </Stack>
              <Text type="supporting" color="secondary">
                <time
                  dateTime={entry.comment.createdAt}
                  title={formatFullDateTime(entry.comment.createdAt)}
                >
                  {formatCompactDateTime(entry.comment.createdAt)}
                </time>
              </Text>
            </Stack>
            <Stack data-comment-body="">
              <MentionMarkdown projectId={projectId} issueRefs={projectIssues}>
                {entry.comment.body}
              </MentionMarkdown>
            </Stack>
            {canContribute && (
              <Stack hAlign="start">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  label="Quote reply"
                  data-quote-comment-id={entry.comment.id}
                  onClick={() => onQuoteReply(entry.comment)}
                />
              </Stack>
            )}
          </Stack>
        </Card>
      </Stack>
    );
  }

  if (entry.kind === "label_group") {
    return (
      <Stack
        as="li"
        key={entry.id}
        data-timeline-kind="label_group"
        data-label-action={entry.action}
        data-actor-id={entry.actor.humanId ?? entry.actor.agentId ?? ""}
      >
        <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
          <ActorAvatar actor={entry.actor} />
          <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
            <Text type="body" weight="semibold" color="primary">
              {entry.actor.displayName}
            </Text>
            <Text type="supporting" color="secondary">
              {entry.action === "added" ? "added" : "removed"}
            </Text>
            {entry.labels.map((label) => (
              <LabelPill key={label.id} label={label} />
            ))}
            <Text type="supporting" color="secondary">
              <time dateTime={entry.createdAt} title={formatFullDateTime(entry.createdAt)}>
                {relativeTime(entry.createdAt)}
              </time>
            </Text>
          </Stack>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack
      as="li"
      key={entry.id}
      data-timeline-kind="activity"
      data-activity-type={entry.activity.type}
    >
      <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="center">
        <ActorAvatar actor={entry.activity.actor} />
        <Text type="body" weight="semibold" color="primary">
          {entry.activity.actor.displayName}
        </Text>
        <Text type="supporting" color="secondary">
          {describeActivity(entry.activity)}
        </Text>
        <Text type="supporting" color="secondary">
          <time
            dateTime={entry.activity.createdAt}
            title={formatFullDateTime(entry.activity.createdAt)}
          >
            {relativeTime(entry.activity.createdAt)}
          </time>
        </Text>
      </Stack>
    </Stack>
  );
}

function IssuePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { issueId } = Route.useParams();
  const { inspector, session: inspectorSession } = Route.useSearch();
  const { data: issue } = useSuspenseQuery(issueQuery(issueId));
  const { data: comments } = useSuspenseQuery(issueCommentsQuery(issueId));
  const { data: issueActivity } = useSuspenseQuery(issueActivityQuery(issueId));
  const { data: project } = useSuspenseQuery(projectQuery(issue.projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const canReadMembers =
    workspace.kind === "shared" &&
    (workspace.isOwner || workspace.canManageMemberPermissions || workspace.canRemoveMembers);
  const membersQuery = useQuery({
    ...workspaceMembersQuery(project.workspaceId),
    enabled: canReadMembers,
  });
  const accessIds = useQuery({
    ...projectAccessHumanIdsQuery(project.id),
    enabled: canReadMembers,
  });
  const withoutAccess =
    accessIds.data === undefined
      ? new Set<string>()
      : missingProjectAccessHumanIds(membersQuery.data ?? [], accessIds.data);
  const { data: myKeys } = useSuspenseQuery(agentKeysQuery(project.workspaceId));
  const workspaceKeys = useQuery({
    ...workspaceAgentKeysQuery(project.workspaceId),
    enabled: workspace.kind === "shared" && workspace.isOwner,
  });

  const [isEditing, setIsEditing] = useState(false);
  const [confirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const [warnedCloseTarget, setWarnedCloseTarget] = useState<IssueStatus | null>(null);
  const [trashError, setTrashError] = useState<string>();
  const [trashing, setTrashing] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentFocusSignal, setCommentFocusSignal] = useState(0);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const isNarrow = useMediaQuery("(max-width: 62rem)");

  const timeline = groupLabelEvents(buildTimeline(comments, issueActivity));

  function onQuoteReply(comment: IssueComment) {
    setCommentDraft((current) => quoteReply(comment.body, current));
    setCommentFocusSignal((current) => current + 1);
    requestAnimationFrame(() => {
      const target = commentInputRef.current;
      if (target === null) return;
      target.focus();
      target.setSelectionRange(target.value.length, target.value.length);
    });
  }

  const candidates: AssigneeCandidate[] = [];
  const seenHumans = new Set<string>();
  for (const actor of [project.createdBy, issue.createdBy, issue.updatedBy]) {
    if (actor.humanId && !seenHumans.has(actor.humanId)) {
      seenHumans.add(actor.humanId);
      candidates.push({
        value: `human:${actor.humanId}`,
        label: `Human · ${actor.email ?? actor.displayName}`,
        assignee: { type: "human" as const, id: actor.humanId },
        noProjectAccess: withoutAccess.has(actor.humanId),
      });
    }
  }
  for (const member of membersQuery.data ?? []) {
    if (seenHumans.has(member.humanId)) continue;
    seenHumans.add(member.humanId);
    candidates.push({
      value: `human:${member.humanId}`,
      label: `Human · ${member.email}`,
      assignee: { type: "human" as const, id: member.humanId },
      noProjectAccess: withoutAccess.has(member.humanId),
    });
  }
  const seen = new Set<string>();
  for (const key of [...myKeys, ...(workspaceKeys.data ?? [])]) {
    if (key.revokedAt !== null || seen.has(key.agentId)) continue;
    seen.add(key.agentId);
    candidates.push({
      value: `agent:${key.agentId}`,
      label: `Agent · ${key.agentName}`,
      assignee: { type: "agent" as const, id: key.agentId },
    });
  }

  const { data: blockedBy } = useSuspenseQuery(issueBlockedByQuery(issueId));
  const { data: blocking } = useSuspenseQuery(issueBlockingQuery(issueId));
  const { data: projectIssues } = useSuspenseQuery(issuesQuery(issue.projectId));
  const { data: projectLabels } = useSuspenseQuery(projectLabelsQuery(issue.projectId));
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(project.workspaceId));
  const { data: runs = [] } = useQuery(workspaceRunsQuery(project.workspaceId));
  const canContribute = project.accessLevel !== "read";
  const subtasks = subtasksOf(projectIssues, issue.id);
  const openSubtaskCount = subtasks.length - completedSubtaskCount(subtasks);
  const activeSession = sessions.find(
    (session) => session.issueId === issue.id && session.status === "active",
  );
  const activeRun =
    activeSession === undefined
      ? undefined
      : runs.find((entry) => entry.id === activeSession.runId);

  const isClosed = issue.status === "done" || issue.status === "cancelled";
  const toggleNextStatus: IssueStatus = isClosed ? "todo" : "done";

  async function applyStatus(next: IssueStatus) {
    setStatusSubmitting(true);
    setStatusError(undefined);
    try {
      const updated = await updateIssue(issue.id, { status: next });
      queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
        old === undefined ? old : { ...old, ...updated },
      );
      setWarnedCloseTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueActivityQuery(issue.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
      ]);
      toast({ body: `Moved ${issue.identifier} to ${issueStatusLabels[next]}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not change the issue.";
      setStatusError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setStatusSubmitting(false);
    }
  }

  function requestStatusChange(next: IssueStatus) {
    if (next === issue.status) return;
    if (
      (next === "done" || next === "cancelled") &&
      openSubtaskCount > 0 &&
      warnedCloseTarget !== next
    ) {
      setWarnedCloseTarget(next);
      return;
    }
    void applyStatus(next);
  }

  async function onDelete() {
    if (trashing) return;
    setTrashing(true);
    setTrashError(undefined);
    try {
      await deleteIssue(issue.id);
      setConfirmTrashOpen(false);
      toast({ body: `Moved ${issue.identifier} to trash.` });
      // Leave the issue route before dropping its cached queries: while this page
      // is mounted, any invalidation or removal makes it refetch the deleted issue.
      await navigate({ to: "/projects/$projectId", params: { projectId: issue.projectId } });
      queryClient.removeQueries({ queryKey: issueQuery(issue.id).queryKey });
      queryClient.removeQueries({ queryKey: issueActivityQuery(issue.id).queryKey });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectTrashQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
      ]);
    } catch (cause) {
      setConfirmTrashOpen(false);
      const msg = cause instanceof Error ? cause.message : "Could not move the issue to trash.";
      setTrashError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setTrashing(false);
    }
  }

  async function onCopyLink() {
    const url = `${window.location.origin}/issues/${issue.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ body: `Copied link to ${issue.identifier}.` });
    } catch {
      toast({ body: "Could not copy link to clipboard.", type: "error" });
    }
  }

  const pageHeader = (
    <PageHeader
      hasDivider={isNarrow}
      breadcrumbs={[
        <Link
          key="project"
          to="/projects/$projectId"
          params={{ projectId: issue.projectId }}
          color="secondary"
          weight="medium"
        >
          Back to project
        </Link>,
        <Link
          key="board"
          to="/board/$projectId"
          params={{ projectId: issue.projectId }}
          color="secondary"
          weight="medium"
        >
          Board
        </Link>,
      ]}
      title={issue.title}
      nonWrappingActions={!isNarrow}
      subtitle={
        <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
          <Token
            label={issueStatusLabels[issue.status]}
            color={STATUS_COLORS[issue.status]}
            size="sm"
            data-issue-status={issue.status}
          />
          <Text as="span" type="code" color="secondary" data-issue-identifier={issue.identifier}>
            {issue.identifier}
          </Text>
          <PriorityBadge priority={issue.priority} />
          {issue.assignee !== null && (
            <Stack as="span" direction="horizontal" gap={1} vAlign="center" data-issue-assignee="">
              {issue.assignee.agentId !== undefined ? (
                <AgentAvatar
                  name={issue.assignee.displayName}
                  harness={
                    activeSession?.agentId === issue.assignee.agentId
                      ? activeRun?.harness
                      : undefined
                  }
                  size={14}
                />
              ) : (
                <HumanAvatar
                  name={issue.assignee.displayName}
                  avatarUrl={issue.assignee.avatarUrl}
                  size="xsm"
                  tooltip={false}
                />
              )}
              <Text type="supporting" color="primary" weight="medium">
                {issue.assignee.displayName}
              </Text>
            </Stack>
          )}
          {activeSession !== undefined &&
            activeRun !== undefined &&
            issue.assignee?.agentId !== activeSession.agentId && (
              <Stack as="span" direction="horizontal" gap={1} vAlign="center" data-working-agent="">
                <AgentAvatar name={activeRun.agentName} harness={activeRun.harness} size={14} />
                <Text type="supporting" color="primary" weight="medium">
                  {activeRun.agentName}
                </Text>
              </Stack>
            )}
          <Text type="supporting" color="secondary">
            Created by {issue.createdBy.displayName} · Updated{" "}
            <time dateTime={issue.updatedAt} title={formatFullDateTime(issue.updatedAt)}>
              {relativeTime(issue.updatedAt)}
            </time>{" "}
            by {issue.updatedBy.displayName}
          </Text>
        </Stack>
      }
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            label="Copy link"
            onClick={() => void onCopyLink()}
          />
          {canContribute && (
            <>
              {!isEditing && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  label="Edit"
                  data-issue-edit=""
                  onClick={() => setIsEditing(true)}
                />
              )}
              <Button
                type="button"
                size="sm"
                variant="secondary"
                isDisabled={statusSubmitting}
                isLoading={statusSubmitting}
                label={toggleNextStatus === "done" ? "Close issue" : "Reopen issue"}
                onClick={() => requestStatusChange(toggleNextStatus)}
              />
            </>
          )}
        </>
      }
    />
  );

  const banners = (
    <>
      {statusError !== undefined && (
        <Banner
          status="error"
          role="alert"
          title="Could not update status"
          description={statusError}
        />
      )}
      {trashError !== undefined && (
        <Banner
          status="error"
          role="alert"
          title="Could not move to trash"
          description={trashError}
        />
      )}
      {warnedCloseTarget !== null && openSubtaskCount > 0 && (
        <Banner
          status="warning"
          role="status"
          data-open-subtask-warning=""
          title={`This issue still has ${openSubtaskCount} open ${openSubtaskCount === 1 ? "subtask" : "subtasks"}`}
          description="Close it anyway?"
          endContent={
            <Stack direction="horizontal" gap={1}>
              <Button
                type="button"
                label="Close anyway"
                variant="secondary"
                size="sm"
                isDisabled={statusSubmitting}
                isLoading={statusSubmitting}
                onClick={() => void applyStatus(warnedCloseTarget)}
              />
              <Button
                type="button"
                label="Cancel"
                variant="ghost"
                size="sm"
                isDisabled={statusSubmitting}
                onClick={() => setWarnedCloseTarget(null)}
              />
            </Stack>
          }
        />
      )}
      {canContribute && activeSession !== undefined && (
        <Banner
          status="info"
          data-trash-blocked=""
          title="An active work session holds this issue"
          description="End the session before moving this issue to trash."
        />
      )}
    </>
  );

  const mainColumn = (
    <Stack gap={5}>
      {isEditing ? (
        <Section padding={4}>
          <Stack gap={2} data-issue-editor="">
            <Heading level={2} color="inherit">
              Edit issue
            </Heading>
            <TitleBodyForm
              key={issue.updatedAt}
              idPrefix="edit-issue"
              titleLabel="Title"
              bodyLabel="Body"
              bodyRows={15}
              submitLabel="Save issue"
              fallbackError="Could not save the issue."
              initialTitle={issue.title}
              initialBody={issue.body}
              mentionIssues={projectIssues}
              projectId={issue.projectId}
              secondaryAction={
                <Button
                  type="button"
                  variant="secondary"
                  label="Cancel"
                  onClick={() => setIsEditing(false)}
                />
              }
              onSubmit={async ({ title, body }) => {
                const updated = await updateIssue(issue.id, { title, body });
                queryClient.setQueryData<IssueDetail>(issueQuery(issue.id).queryKey, (old) =>
                  old === undefined ? old : { ...old, ...updated },
                );
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: issuesQuery(issue.projectId).queryKey,
                  }),
                  queryClient.invalidateQueries({
                    queryKey: projectActivityQuery(issue.projectId).queryKey,
                  }),
                  queryClient.invalidateQueries({
                    queryKey: issueActivityQuery(issue.id).queryKey,
                  }),
                ]);
                setIsEditing(false);
                toast({ body: "Issue updated." });
              }}
            />
          </Stack>
        </Section>
      ) : (
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
            <Heading level={2} color="inherit">
              Description
            </Heading>
            {canContribute && issue.body === "" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                label="Add description"
                onClick={() => setIsEditing(true)}
              />
            )}
          </Stack>
          {issue.body === "" ? (
            <Text as="p" display="block" type="supporting" color="secondary">
              No description yet.
            </Text>
          ) : (
            <Stack data-issue-body="">
              <MentionMarkdown projectId={issue.projectId} issueRefs={projectIssues}>
                {issue.body}
              </MentionMarkdown>
            </Stack>
          )}
        </Stack>
      )}

      <Subtasks issue={issue} issues={projectIssues} canContribute={canContribute} />

      <Blockers
        issueId={issue.id}
        projectId={issue.projectId}
        blockedBy={blockedBy}
        blocking={blocking}
        candidates={projectIssues}
        canContribute={canContribute}
      />

      <Stack gap={4}>
        <Divider />
        <Stack gap={3}>
          <Heading level={2} color="inherit">
            Links
          </Heading>
          {issue.links.length === 0 ? (
            <Text as="p" display="block" type="supporting" color="secondary">
              No links attached.
            </Text>
          ) : (
            <Stack as="ul" gap={2}>
              {issue.links.map((link) => (
                <Stack as="li" key={link.id} data-link-id={link.id}>
                  <Card variant="muted" padding={2}>
                    <Stack
                      direction="horizontal"
                      gap={2}
                      wrap="wrap"
                      justify="between"
                      vAlign="center"
                    >
                      <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                        <Token
                          label={LINK_KIND_LABELS[link.kind]}
                          color="gray"
                          size="sm"
                          data-link-kind={link.kind}
                        />
                        <AstryxLink href={link.url} target="_blank" rel="noopener noreferrer">
                          {link.title}
                        </AstryxLink>
                      </Stack>
                      <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                        <Text type="supporting" color="secondary">
                          {link.createdBy.displayName}
                        </Text>
                        {canContribute && (
                          <LinkRemoveButton
                            issueId={issue.id}
                            projectId={issue.projectId}
                            link={link}
                          />
                        )}
                      </Stack>
                    </Stack>
                  </Card>
                </Stack>
              ))}
            </Stack>
          )}
          {canContribute && (
            <Collapsible
              defaultIsOpen={false}
              trigger={
                <Text type="body" weight="semibold">
                  Add link
                </Text>
              }
            >
              <Stack paddingBlockStart={2}>
                <LinkForm issueId={issue.id} projectId={issue.projectId} />
              </Stack>
            </Collapsible>
          )}
        </Stack>
      </Stack>

      <Stack gap={4}>
        <Divider />
        <Stack gap={3}>
          <Heading level={2} color="inherit">
            Timeline ({timeline.length})
          </Heading>
          {timeline.length === 0 ? (
            <Text as="p" display="block" type="supporting" color="secondary">
              No comments or lifecycle events yet.
            </Text>
          ) : (
            <Stack as="ul" gap={3} data-issue-timeline="">
              {timeline.map((entry) => (
                <TimelineRow
                  key={entry.id}
                  entry={entry}
                  projectId={issue.projectId}
                  projectIssues={projectIssues}
                  canContribute={canContribute}
                  onQuoteReply={onQuoteReply}
                />
              ))}
            </Stack>
          )}
          {canContribute && (
            <>
              <Divider />
              <CommentForm
                issueId={issue.id}
                projectId={issue.projectId}
                issues={projectIssues}
                body={commentDraft}
                onBodyChange={setCommentDraft}
                inputRef={commentInputRef}
                focusSignal={commentFocusSignal}
              />
            </>
          )}
        </Stack>
      </Stack>
    </Stack>
  );

  const inspectorColumn = (
    <Stack gap={4}>
      <Stack gap={3} aria-label="Issue properties">
        <Heading level={2} color="inherit">
          Properties
        </Heading>

        <Divider />

        {canContribute ? (
          <Selector
            label="Status"
            id="issue-status-selector"
            size="sm"
            width="100%"
            value={issue.status}
            isDisabled={statusSubmitting}
            onChange={(value) => requestStatusChange(IssueStatus.parse(value))}
            options={STATUS_OPTIONS.map((status) => ({
              value: status,
              label: issueStatusLabels[status],
            }))}
          />
        ) : (
          <Stack gap={0.5} hAlign="start">
            <Text type="supporting" weight="semibold" color="secondary">
              Status
            </Text>
            <Token
              label={issueStatusLabels[issue.status]}
              color={STATUS_COLORS[issue.status]}
              size="sm"
            />
          </Stack>
        )}

        <AssigneeControl
          issue={issue}
          candidates={candidates}
          canContribute={canContribute}
          activeHarness={
            issue.assignee?.agentId !== undefined &&
            activeSession?.agentId === issue.assignee.agentId
              ? activeRun?.harness
              : undefined
          }
        />

        {canContribute ? (
          <IssuePriorityControls
            issue={issue}
            issues={projectIssues}
            projectId={issue.projectId}
            showReorder={false}
          />
        ) : (
          <Stack gap={0.5} hAlign="start">
            <Text type="supporting" weight="semibold" color="secondary">
              Priority
            </Text>
            <PriorityBadge priority={issue.priority} />
          </Stack>
        )}

        <IssueLabels issue={issue} labels={projectLabels} canContribute={canContribute} />
      </Stack>

      <SessionStatus issueId={issue.id} projectId={issue.projectId} canContribute={canContribute} />

      <SessionInspector
        key={`${issue.id}:${inspector ?? false}:${inspectorSession ?? ""}`}
        issueId={issue.id}
        canContribute={canContribute}
        initialOpen={inspector}
        initialSessionId={inspectorSession}
      />

      {canContribute && (
        <Stack gap={4}>
          <Divider />
          <Stack hAlign="start">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              label="Move to Trash"
              isDisabled={activeSession !== undefined || trashing}
              data-trash-button=""
              onClick={() => setConfirmTrashOpen(true)}
            />
          </Stack>
        </Stack>
      )}
    </Stack>
  );

  return (
    <>
      <Layout
        contentWidth="78rem"
        padding={6}
        header={!isNarrow && <LayoutHeader hasDivider>{pageHeader}</LayoutHeader>}
        content={
          <LayoutContent isScrollable>
            <Stack gap={5}>
              {isNarrow && pageHeader}
              {banners}
              {mainColumn}
              {isNarrow && (
                <>
                  <Divider />
                  {inspectorColumn}
                </>
              )}
            </Stack>
          </LayoutContent>
        }
        end={
          !isNarrow && (
            <LayoutPanel
              width={320}
              hasDivider
              isScrollable
              role="complementary"
              label="Issue details"
            >
              {inspectorColumn}
            </LayoutPanel>
          )
        }
      />

      {canContribute && (
        <AlertDialog
          isOpen={confirmTrashOpen}
          onOpenChange={setConfirmTrashOpen}
          title={`Move ${issue.identifier} to Trash?`}
          description="Soft-deleted issues stay recoverable from project Trash for 30 days."
          actionLabel="Move to Trash"
          actionVariant="destructive"
          isActionLoading={trashing}
          onAction={() => void onDelete()}
        />
      )}
    </>
  );
}

function Blockers({
  issueId,
  projectId,
  blockedBy,
  blocking,
  candidates,
  canContribute,
}: {
  issueId: string;
  projectId: string;
  blockedBy: Issue[];
  blocking: Issue[];
  candidates: Issue[];
  canContribute: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<Issue>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: issueBlockedByQuery(issueId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issueBlockingQuery(issueId).queryKey }),
      queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issueActivityQuery(issueId).queryKey }),
      queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
    ]);

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === "" || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await addBlockedBy(issueId, selected);
      setSelected("");
      await refresh();
      toast({ body: "Blocker added." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the blocker.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove(blocker: Issue) {
    setSubmitting(true);
    setError(undefined);
    try {
      await removeBlockedBy(issueId, blocker.id);
      setConfirmRemove(undefined);
      await refresh();
      toast({ body: "Blocker removed." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not remove the blocker.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  const options = candidates.filter(
    (candidate) =>
      candidate.id !== issueId && !blockedBy.some((blocker) => blocker.id === candidate.id),
  );

  return (
    <Stack gap={4}>
      <Divider />
      <Stack gap={3}>
        <Heading level={2} color="inherit">
          Dependencies
        </Heading>
        {blockedBy.length === 0 && blocking.length === 0 ? (
          <Text as="p" display="block" type="supporting" color="secondary">
            No dependencies linked.
          </Text>
        ) : (
          <Stack gap={3}>
            {blockedBy.length > 0 && (
              <Stack gap={1.5}>
                <Heading level={3} color="inherit">
                  Blocked by
                </Heading>
                <Stack as="ul" gap={2}>
                  {blockedBy.map((blocker) => (
                    <Stack
                      as="li"
                      key={blocker.id}
                      data-blocker-id={blocker.id}
                      data-blocker-status={blocker.status}
                    >
                      <Card variant="muted" padding={2}>
                        <Stack
                          direction="horizontal"
                          gap={2}
                          wrap="wrap"
                          justify="between"
                          vAlign="center"
                        >
                          <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                            <Text as="span" type="code" color="secondary">
                              {blocker.identifier}
                            </Text>
                            <Link to="/issues/$issueId" params={{ issueId: blocker.id }}>
                              {blocker.title}
                            </Link>
                            <Token
                              label={issueStatusLabels[blocker.status]}
                              color={STATUS_COLORS[blocker.status]}
                              size="sm"
                            />
                            {blocker.status !== "done" && blocker.status !== "cancelled" && (
                              <Token label="Blocking" color="red" size="sm" />
                            )}
                          </Stack>
                          {canContribute && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => setConfirmRemove(blocker)}
                              isDisabled={submitting}
                              label="Remove"
                              variant="destructive"
                            />
                          )}
                        </Stack>
                      </Card>
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            )}
            {blocking.length > 0 && (
              <Stack gap={1.5}>
                <Heading level={3} color="inherit">
                  Blocking
                </Heading>
                <Stack as="ul" gap={2}>
                  {blocking.map((dependant) => (
                    <Stack as="li" key={dependant.id} data-dependant-id={dependant.id}>
                      <Card variant="muted" padding={2}>
                        <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                          <Text as="span" type="code" color="secondary">
                            {dependant.identifier}
                          </Text>
                          <Link
                            to="/issues/$issueId"
                            params={{ issueId: dependant.id }}
                            color="primary"
                            weight="medium"
                          >
                            {dependant.title}
                          </Link>
                          <Token
                            label={issueStatusLabels[dependant.status]}
                            color={STATUS_COLORS[dependant.status]}
                            size="sm"
                          />
                        </Stack>
                      </Card>
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            )}
          </Stack>
        )}
        {canContribute && (
          <Collapsible
            defaultIsOpen={false}
            trigger={
              <Text type="body" weight="semibold">
                Add blocker
              </Text>
            }
          >
            <Stack paddingBlockStart={2}>
              <form onSubmit={(event) => void onAdd(event)}>
                <Stack gap={2} hAlign="start">
                  <Selector
                    label="Add a blocker"
                    id="issue-blocker"
                    value={selected}
                    onChange={setSelected}
                    options={[
                      { value: "", label: "Choose an issue…" },
                      ...options.map((option) => ({
                        value: option.id,
                        label: `${option.identifier} ${option.title}`,
                      })),
                    ]}
                  />
                  {error !== undefined && <Banner status="error" role="alert" title={error} />}
                  <Button
                    type="submit"
                    size="sm"
                    isDisabled={submitting || selected === ""}
                    isLoading={submitting}
                    label="Add blocker"
                    variant="primary"
                  />
                </Stack>
              </form>
            </Stack>
          </Collapsible>
        )}
      </Stack>

      <AlertDialog
        isOpen={confirmRemove !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(undefined);
        }}
        title="Remove blocker?"
        description={
          confirmRemove === undefined
            ? "Remove this dependency?"
            : `Remove ${confirmRemove.identifier} (${confirmRemove.title}) as a blocker?`
        }
        actionLabel="Remove blocker"
        actionVariant="destructive"
        isActionLoading={submitting}
        onAction={() => {
          if (confirmRemove !== undefined) void onRemove(confirmRemove);
        }}
      />
    </Stack>
  );
}

function CommentForm({
  issueId,
  projectId,
  issues,
  body,
  onBodyChange,
  inputRef,
  focusSignal,
}: {
  issueId: string;
  projectId: string;
  issues: Issue[];
  body: string;
  onBodyChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  focusSignal: number;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await createIssueComment(issueId, { body });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueCommentsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueActivityQuery(issueId).queryKey }),
      ]);
      onBodyChange("");
      toast({ body: "Comment added." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={2}>
        <IssueMentionTextArea
          label="Comment"
          id="issue-comment"
          htmlName="body"
          placeholder="Write a comment… Type # to reference an issue"
          value={body}
          onChange={onBodyChange}
          rows={7}
          required
          issues={issues}
          projectId={projectId}
          inputRef={inputRef}
          focusSignal={focusSignal}
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Stack direction="horizontal" align="center">
          <Button
            type="submit"
            size="sm"
            isDisabled={submitting}
            isLoading={submitting}
            label="Add comment"
            variant="primary"
          />
        </Stack>
      </Stack>
    </form>
  );
}

function LinkForm({ issueId, projectId }: { issueId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<IssueLinkKind>("link");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await addIssueLink(issueId, { url, title, kind });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueActivityQuery(issueId).queryKey }),
      ]);
      setUrl("");
      setTitle("");
      setKind("link");
      toast({ body: "Link added." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={2} hAlign="start">
        <TextField
          label="URL"
          id="issue-link-url"
          htmlName="url"
          type="url"
          value={url}
          onChange={setUrl}
          placeholder="https://…"
          required
        />
        <TextField
          label="Link label"
          id="issue-link-title"
          htmlName="title"
          value={title}
          onChange={setTitle}
          required
        />
        <Selector
          label="Kind"
          id="issue-link-kind"
          htmlName="kind"
          value={kind}
          onChange={(value) => setKind(IssueLinkKind.parse(value))}
          options={[
            { value: "pr", label: "PR" },
            { value: "commit", label: "Commit" },
            { value: "doc", label: "Doc" },
            { value: "link", label: "Link" },
          ]}
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Button
          type="submit"
          size="sm"
          isDisabled={submitting}
          isLoading={submitting}
          label="Add link"
          variant="primary"
        />
      </Stack>
    </form>
  );
}

function LinkRemoveButton({
  issueId,
  projectId,
  link,
}: {
  issueId: string;
  projectId: string;
  link: IssueLink;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onRemove() {
    setSubmitting(true);
    setError(undefined);
    try {
      await removeIssueLink(issueId, link.id);
      setConfirmOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: issueActivityQuery(issueId).queryKey }),
      ]);
      toast({ body: "Link removed." });
    } catch (cause) {
      setConfirmOpen(false);
      const msg = cause instanceof Error ? cause.message : "Could not remove the link.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        isDisabled={submitting}
        label="Remove"
        variant="ghost"
      />
      {error !== undefined && <Banner status="error" role="alert" title={error} />}
      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove link?"
        description={`Remove "${link.title}" from this issue?`}
        actionLabel="Remove link"
        actionVariant="destructive"
        isActionLoading={submitting}
        onAction={() => void onRemove()}
      />
    </>
  );
}

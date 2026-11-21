import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import {
  type Issue,
  type IssueDetail,
  type IssueLink,
  IssueLinkKind,
  IssueStatus,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { agentKeysQuery, workspaceAgentKeysQuery } from "../features/agents/index.ts";
import {
  addBlockedBy,
  addIssueLink,
  type AssigneeCandidate,
  AssigneeControl,
  completedSubtaskCount,
  createIssueComment,
  deleteIssue,
  issueBlockedByQuery,
  issueBlockingQuery,
  issueCommentsQuery,
  IssueLabels,
  IssueMentionTextArea,
  IssuePriorityControls,
  issueQuery,
  issuesQuery,
  issueStatusLabels,
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
  TitleBodyForm,
  updateIssue,
} from "../features/projects/index.ts";
import {
  activeSessionsQuery,
  SessionInspector,
  SessionStatus,
} from "../features/work-sessions/index.ts";
import { workspaceMembersQuery, workspaceQuery } from "../features/workspaces/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { Markdown } from "../lib/Markdown.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import { formatCompactDateTime, formatFullDateTime, relativeTime } from "../lib/time.ts";

export const Route = createFileRoute("/issues/$issueId")({
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
  errorComponent: ({ error }) => <ResourceLoadError resource="issue" error={error} />,
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

function IssuePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { issueId } = Route.useParams();
  const { inspector, session: inspectorSession } = Route.useSearch();
  const { data: issue } = useSuspenseQuery(issueQuery(issueId));
  const { data: comments } = useSuspenseQuery(issueCommentsQuery(issueId));
  const { data: project } = useSuspenseQuery(projectQuery(issue.projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const canReadMembers =
    workspace.kind === "shared" &&
    (workspace.isOwner || workspace.canManageMemberPermissions || workspace.canRemoveMembers);
  const membersQuery = useQuery({
    ...workspaceMembersQuery(project.workspaceId),
    enabled: canReadMembers,
  });
  const { data: myKeys } = useSuspenseQuery(agentKeysQuery(project.workspaceId));
  const workspaceKeys = useQuery({
    ...workspaceAgentKeysQuery(project.workspaceId),
    enabled: workspace.kind === "shared" && workspace.isOwner,
  });

  const [editOpen, setEditOpen] = useState(false);
  const [confirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const [warnedCloseTarget, setWarnedCloseTarget] = useState<IssueStatus | null>(null);
  const [trashError, setTrashError] = useState<string>();
  const [trashing, setTrashing] = useState(false);

  const candidates: AssigneeCandidate[] = [];
  const seenHumans = new Set<string>();
  for (const actor of [project.createdBy, issue.createdBy, issue.updatedBy]) {
    if (actor.humanId && !seenHumans.has(actor.humanId)) {
      seenHumans.add(actor.humanId);
      candidates.push({
        value: `human:${actor.humanId}`,
        label: `Human · ${actor.email ?? actor.displayName}`,
        assignee: { type: "human" as const, id: actor.humanId },
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
  const canContribute = project.accessLevel !== "read";
  const subtasks = subtasksOf(projectIssues, issue.id);
  const openSubtaskCount = subtasks.length - completedSubtaskCount(subtasks);
  const activeSession = sessions.find(
    (session) => session.issueId === issue.id && session.status === "active",
  );

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
    setTrashing(true);
    setTrashError(undefined);
    try {
      await deleteIssue(issue.id);
      setConfirmTrashOpen(false);
      queryClient.removeQueries({ queryKey: issueQuery(issue.id).queryKey });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectTrashQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(issue.projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(issue.projectId).queryKey }),
      ]);
      toast({ body: `Moved ${issue.identifier} to trash.` });
      await navigate({ to: "/projects/$projectId", params: { projectId: issue.projectId } });
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

  return (
    <main className="issue-page">
      <PageHeader
        breadcrumbs={[
          <Link key="project" to="/projects/$projectId" params={{ projectId: issue.projectId }}>
            Back to project
          </Link>,
          <Link key="board" to="/board/$projectId" params={{ projectId: issue.projectId }}>
            Board
          </Link>,
          <Text
            key="identifier"
            type="inherit"
            color="inherit"
            className="issue-key"
            data-issue-identifier={issue.identifier}
          >
            {issue.identifier}
          </Text>,
        ]}
        title={issue.title}
        statusToken={
          <Token
            label={issueStatusLabels[issue.status]}
            color={STATUS_COLORS[issue.status]}
            size="sm"
            data-issue-status={issue.status}
          />
        }
        subtitle={
          <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
            <PriorityBadge priority={issue.priority} />
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
              variant="secondary"
              label="Copy link"
              onClick={() => void onCopyLink()}
            />
            {canContribute && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  label="Edit"
                  onClick={() => setEditOpen(true)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  isDisabled={statusSubmitting}
                  isLoading={statusSubmitting}
                  label={toggleNextStatus === "done" ? "Close issue" : "Reopen issue"}
                  onClick={() => requestStatusChange(toggleNextStatus)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  label="Move to Trash"
                  isDisabled={activeSession !== undefined || trashing}
                  data-trash-button
                  onClick={() => setConfirmTrashOpen(true)}
                />
              </>
            )}
          </>
        }
      />

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
          data-open-subtask-warning
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
          data-trash-blocked
          title="An active work session holds this issue"
          description="End the session before moving this issue to trash."
        />
      )}

      <Stack className="issue-layout">
        <Stack className="issue-primary">
          <Section className="page-section issue-description-card" padding={3}>
            <Stack gap={2}>
              <Stack direction="horizontal" className="section-toolbar">
                <Heading level={2} color="inherit">
                  Description
                </Heading>
                {canContribute && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    label={issue.body === "" ? "Add description" : "Edit"}
                    onClick={() => setEditOpen(true)}
                  />
                )}
              </Stack>
              {issue.body === "" ? (
                <Text as="p" display="block" type="supporting">
                  No description yet.
                </Text>
              ) : (
                <Stack data-issue-body className="issue-description-body">
                  <Markdown issueRefs={projectIssues}>{issue.body}</Markdown>
                </Stack>
              )}
            </Stack>
          </Section>

          <Subtasks issue={issue} issues={projectIssues} canContribute={canContribute} />

          <Blockers
            issueId={issue.id}
            projectId={issue.projectId}
            blockedBy={blockedBy}
            blocking={blocking}
            candidates={projectIssues}
            canContribute={canContribute}
          />

          <Section className="page-section" padding={3}>
            <Stack gap={2}>
              <Heading level={2} color="inherit">
                Links
              </Heading>
              {issue.links.length === 0 ? (
                <Text as="p" display="block" type="supporting">
                  No links attached.
                </Text>
              ) : (
                <ul className="row-list">
                  {issue.links.map((link) => (
                    <li key={link.id} className="row-item" data-link-id={link.id}>
                      <Stack direction="horizontal" className="row-item-main">
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
                      <Stack direction="horizontal" className="row-item-meta">
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
                    </li>
                  ))}
                </ul>
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
          </Section>

          <Section className="page-section" padding={3}>
            <Stack gap={3}>
              <Heading level={2} color="inherit">
                Comments ({comments.length})
              </Heading>
              {comments.length === 0 ? (
                <Text as="p" display="block" type="supporting">
                  No comments yet.
                </Text>
              ) : (
                <ul className="comment-list">
                  {comments.map((comment) => (
                    <li key={comment.id} className="comment-card" data-comment-id={comment.id}>
                      <Stack direction="horizontal" className="comment-header">
                        <strong>{comment.author.displayName}</strong>
                        <time
                          dateTime={comment.createdAt}
                          title={formatFullDateTime(comment.createdAt)}
                        >
                          {formatCompactDateTime(comment.createdAt)}
                        </time>
                      </Stack>
                      <Stack data-comment-body className="comment-body">
                        <Markdown issueRefs={projectIssues}>{comment.body}</Markdown>
                      </Stack>
                    </li>
                  ))}
                </ul>
              )}
              {canContribute && (
                <CommentForm
                  issueId={issue.id}
                  projectId={issue.projectId}
                  issues={projectIssues}
                />
              )}
            </Stack>
          </Section>
        </Stack>

        <aside className="issue-inspector">
          <Section className="issue-properties-panel" padding={3} aria-label="Issue properties">
            <Stack gap={3}>
              <Heading level={2} color="inherit" className="issue-properties-heading">
                Properties
              </Heading>

              <Stack className="issue-prop-group">
                {canContribute ? (
                  <Selector
                    label="Status"
                    id="issue-status-selector"
                    size="sm"
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
              </Stack>

              <Stack className="issue-prop-group">
                <AssigneeControl
                  issue={issue}
                  candidates={candidates}
                  canContribute={canContribute}
                />
              </Stack>

              <Stack className="issue-prop-group">
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
              </Stack>

              <Stack className="issue-prop-group">
                <IssueLabels issue={issue} labels={projectLabels} canContribute={canContribute} />
              </Stack>
            </Stack>
          </Section>

          <SessionStatus
            issueId={issue.id}
            projectId={issue.projectId}
            canContribute={canContribute}
          />

          <SessionInspector
            key={`${issue.id}:${inspector ?? false}:${inspectorSession ?? ""}`}
            issueId={issue.id}
            canContribute={canContribute}
            initialOpen={inspector}
            initialSessionId={inspectorSession}
          />
        </aside>
      </Stack>

      {canContribute && (
        <>
          <Drawer
            isOpen={editOpen}
            onOpenChange={setEditOpen}
            side="end"
            width="32rem"
            label="Edit issue"
          >
            <Layout
              height="fill"
              header={<DrawerHeader title="Edit issue" onOpenChange={setEditOpen} hasDivider />}
            >
              <LayoutContent>
                <TitleBodyForm
                  key={issue.updatedAt}
                  idPrefix="edit-issue"
                  titleLabel="Title"
                  bodyLabel="Body"
                  bodyRows={10}
                  submitLabel="Save issue"
                  fallbackError="Could not save the issue."
                  initialTitle={issue.title}
                  initialBody={issue.body}
                  mentionIssues={projectIssues}
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
                    ]);
                    setEditOpen(false);
                    toast({ body: "Issue updated." });
                  }}
                />
              </LayoutContent>
            </Layout>
          </Drawer>

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
        </>
      )}
    </main>
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
      queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
    ]);

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === "") return;
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
    <Section className="page-section" padding={3}>
      <Stack gap={2}>
        <Heading level={2} color="inherit">
          Dependencies
        </Heading>
        {blockedBy.length === 0 && blocking.length === 0 ? (
          <Text as="p" display="block" type="supporting">
            No dependencies linked.
          </Text>
        ) : (
          <Stack gap={2}>
            {blockedBy.length > 0 && (
              <Stack gap={1}>
                <Heading level={3} color="inherit">
                  Blocked by
                </Heading>
                <ul className="row-list">
                  {blockedBy.map((blocker) => (
                    <li
                      key={blocker.id}
                      className="row-item"
                      data-blocker-id={blocker.id}
                      data-blocker-status={blocker.status}
                    >
                      <Stack direction="horizontal" className="row-item-main">
                        <Text as="span" className="issue-key">
                          {blocker.identifier}
                        </Text>
                        <Link
                          to="/issues/$issueId"
                          params={{ issueId: blocker.id }}
                          className="row-item-title"
                        >
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
                    </li>
                  ))}
                </ul>
              </Stack>
            )}
            {blocking.length > 0 && (
              <Stack gap={1}>
                <Heading level={3} color="inherit">
                  Blocking
                </Heading>
                <ul className="row-list">
                  {blocking.map((dependant) => (
                    <li key={dependant.id} className="row-item" data-dependant-id={dependant.id}>
                      <Stack direction="horizontal" className="row-item-main">
                        <Text as="span" className="issue-key">
                          {dependant.identifier}
                        </Text>
                        <Link
                          to="/issues/$issueId"
                          params={{ issueId: dependant.id }}
                          className="row-item-title"
                        >
                          {dependant.title}
                        </Link>
                        <Token
                          label={issueStatusLabels[dependant.status]}
                          color={STATUS_COLORS[dependant.status]}
                          size="sm"
                        />
                      </Stack>
                    </li>
                  ))}
                </ul>
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
    </Section>
  );
}

function CommentForm({
  issueId,
  projectId,
  issues,
}: {
  issueId: string;
  projectId: string;
  issues: Issue[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await createIssueComment(issueId, { body });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueCommentsQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
      ]);
      setBody("");
      toast({ body: "Comment added." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="comment-composer" onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={2}>
        <IssueMentionTextArea
          label="Comment"
          id="issue-comment"
          htmlName="body"
          placeholder="Write a comment… Type # to reference an issue"
          value={body}
          onChange={setBody}
          rows={4}
          required
          issues={issues}
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <div className="comment-composer-actions">
          <Button
            type="submit"
            size="sm"
            isDisabled={submitting}
            isLoading={submitting}
            label="Add comment"
            variant="primary"
          />
        </div>
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
    setSubmitting(true);
    setError(undefined);
    try {
      await addIssueLink(issueId, { url, title, kind });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
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
    <form className="form-stack" onSubmit={(event) => void onSubmit(event)}>
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

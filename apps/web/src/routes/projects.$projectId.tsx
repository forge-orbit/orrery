import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import {
  FallbackPolicy,
  ProjectAccessLevel,
  type IssueStatus,
  type Project,
  type ProjectAccessGrant,
  type ProjectActivityType,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2, UserPlus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  IssuePriorityControls,
  issuesQuery,
  projectAccessCandidates,
  projectAccessCandidatesQuery,
  issueStatusLabels,
  knowledgeEntriesQuery,
  LabelPill,
  PriorityBadge,
  projectAccessQuery,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  projectsQuery,
  ProjectLabels,
  removeProjectAccess,
  ResourceLoadError,
  setProjectAccess,
  setProjectFallbackPolicy,
  updateProject,
} from "../features/projects/index.ts";
import { workspaceRunsQuery } from "../features/runs/index.ts";
import { activeSessionsQuery } from "../features/work-sessions/index.ts";
import { HumanAvatar } from "../lib/avatar.tsx";
import { TextAreaField, TextField } from "../lib/fields.tsx";
import { AgentAvatar } from "../lib/harness.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";
import { formatFullDateTime, relativeTime } from "../lib/time.ts";

export const Route = createFileRoute("/projects/$projectId")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(projectLabelsQuery(project.id)),
      context.queryClient.ensureQueryData(knowledgeEntriesQuery(project.id)),
      context.queryClient.ensureQueryData(projectActivityQuery(project.id)),
      ...(project.accessLevel === "manage" && project.workspaceKind === "shared"
        ? [
            context.queryClient.ensureQueryData(projectAccessQuery(project.id)),
            context.queryClient.ensureQueryData(projectAccessCandidatesQuery(project.id)),
          ]
        : []),
    ]);
  },
  component: ProjectPage,
  errorComponent: ({ error }) => <ResourceLoadError resource="project" error={error} />,
});

const statusTokenColors: Record<
  IssueStatus,
  "gray" | "blue" | "orange" | "purple" | "green" | "red"
> = {
  backlog: "gray",
  todo: "blue",
  in_progress: "orange",
  review: "purple",
  done: "green",
  cancelled: "red",
};

const activityLabels: Record<ProjectActivityType, string> = {
  project_created: "created the project",
  project_renamed: "renamed the project",
  project_fallback_policy_changed: "changed the project fallback policy",
  issue_created: "opened issue",
  issue_edited: "edited issue",
  issue_commented: "commented on issue",
  issue_review_handoff: "handed issue off for review",
  issue_closed: "closed issue",
  issue_reopened: "reopened issue",
  issue_dependency_added: "added a blocker to issue",
  issue_dependency_removed: "removed a blocker from issue",
  issue_link_added: "linked on issue",
  issue_link_removed: "unlinked from issue",
  issue_question_asked: "asked for input on issue",
  issue_question_answered: "answered a question on issue",
  issue_question_paused: "paused a question on issue",
  issue_question_fallback_used: "used an authorized fallback on issue",
  issue_question_follow_up: "added a follow-up to an authorized fallback on issue",
  issue_fallback_policy_override_changed: "changed the fallback policy override on issue",
  issue_stop_requested: "asked the agent to stop on issue",
  issue_session_expired: "lost its claim lease on issue",
  project_label_created: "created a project label",
  project_label_edited: "edited a project label",
  project_label_deleted: "deleted a project label",
  issue_label_added: "labelled issue",
  issue_label_removed: "unlabelled issue",
  issue_parent_changed: "changed the parent of issue",
  issue_deleted: "moved issue to trash",
  issue_restored: "restored issue from trash",
  knowledge_created: "created knowledge",
  knowledge_edited: "edited knowledge",
};

type ProjectTab = "issues" | "knowledge" | "labels" | "activity" | "settings";

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: issues } = useSuspenseQuery(issuesQuery(project.id));
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(project.id));
  const { data: knowledge } = useSuspenseQuery(knowledgeEntriesQuery(project.id));
  const { data: sessions = [] } = useQuery(activeSessionsQuery(project.workspaceId));
  const { data: runs = [] } = useQuery(workspaceRunsQuery(project.workspaceId));
  const sessionsByIssue = new Map(
    sessions
      .filter((session) => session.projectId === project.id && session.status === "active")
      .map((session) => [session.issueId, session]),
  );
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const canContribute = project.accessLevel !== "read";
  const canManage = project.accessLevel === "manage";
  const navigate = useNavigate();
  const [tab, setTab] = useState<ProjectTab>("issues");
  const activeTab: ProjectTab = tab === "settings" && !canManage ? "issues" : tab;

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link
            key="workspace"
            to="/workspaces/$workspaceId"
            params={{ workspaceId: project.workspaceId }}
            color="secondary"
            weight="medium"
          >
            Back to workspace
          </Link>,
        ]}
        title={project.name}
        badge={project.key}
        statusToken={
          <Token
            label={
              project.accessLevel === "manage"
                ? "Manager"
                : project.accessLevel === "contribute"
                  ? "Contributor"
                  : "Read-only"
            }
            color={project.accessLevel === "read" ? "gray" : "blue"}
            size="sm"
            data-project-access-level={project.accessLevel}
          />
        }
        subtitle={
          project.description !== ""
            ? `${project.description} · Created by ${project.createdBy.displayName}`
            : `Created by ${project.createdBy.displayName}`
        }
        actions={
          <>
            <Stack direction="horizontal" gap={3} align="center" wrap="wrap">
              {canManage && (
                <Link
                  to="/trash/$projectId"
                  params={{ projectId: project.id }}
                  color="secondary"
                  weight="medium"
                  isStandalone
                  data-trash-link=""
                >
                  <Stack as="span" direction="horizontal" gap={1} vAlign="center">
                    <Icon icon={Trash2} size="xsm" aria-hidden="true" />
                    Trash
                  </Stack>
                </Link>
              )}
              <Link
                to="/history/project/$projectId"
                params={{ projectId: project.id }}
                color="secondary"
                weight="medium"
                isStandalone
              >
                <Stack as="span" direction="horizontal" gap={1} vAlign="center">
                  <Icon icon="clock" size="xsm" aria-hidden="true" />
                  View history
                </Stack>
              </Link>
              <Link
                to="/board/$projectId"
                params={{ projectId: project.id }}
                color="secondary"
                weight="semibold"
                isStandalone
                data-board-link=""
              >
                <Stack as="span" direction="horizontal" gap={1} vAlign="center">
                  <Icon icon="viewColumns" size="xsm" aria-hidden="true" />
                  Board
                </Stack>
              </Link>
            </Stack>
            {canContribute && (
              <Button
                type="button"
                label="New issue"
                icon={<Icon icon={Plus} />}
                variant="primary"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/projects/$projectId/issues/new",
                    params: { projectId: project.id },
                  })
                }
              />
            )}
          </>
        }
      />

      <TabList
        value={activeTab}
        onChange={(value) => {
          if (
            value === "issues" ||
            value === "knowledge" ||
            value === "labels" ||
            value === "activity" ||
            value === "settings"
          ) {
            setTab(value);
          }
        }}
        role="tablist"
        aria-label="Project sections"
        size="sm"
        hasDivider
      >
        <Tab
          value="issues"
          label="Issues"
          panelId="panel-issues"
          endContent={<Badge label={issues.length} />}
        />
        <Tab
          value="knowledge"
          label="Knowledge"
          panelId="panel-knowledge"
          endContent={<Badge label={knowledge.length} />}
        />
        <Tab
          value="labels"
          label="Labels"
          panelId="panel-labels"
          endContent={<Badge label={labels.length} />}
        />
        <Tab value="activity" label="Activity" panelId="panel-activity" />
        {canManage && <Tab value="settings" label="Settings" panelId="panel-settings" />}
      </TabList>

      {activeTab === "issues" && (
        <section id="panel-issues" role="tabpanel">
          {issues.length === 0 ? (
            <Stack padding={4}>
              <EmptyState
                title="No issues yet"
                description="Create your first issue or open the Board to start staging work."
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
                          params: { projectId: project.id },
                        })
                      }
                    />
                  ) : undefined
                }
              />
            </Stack>
          ) : (
            <Section variant="transparent" padding={0}>
              <Table density="compact" hasHover dividers="rows" aria-label="Project issues">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Key</TableHeaderCell>
                    <TableHeaderCell>Issue</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Assignee</TableHeaderCell>
                    <TableHeaderCell>Priority</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {issues.map((issue) => {
                    const session = sessionsByIssue.get(issue.id);
                    const run = session === undefined ? undefined : runsById.get(session.runId);
                    const assignee = issue.assignee;
                    const showWorkingAgent =
                      session !== undefined &&
                      run !== undefined &&
                      assignee?.agentId !== session.agentId;

                    return (
                      <TableRow key={issue.id} data-issue-id={issue.id}>
                        <TableCell>
                          <Text
                            as="span"
                            type="supporting"
                            color="secondary"
                            data-issue-identifier={issue.identifier}
                          >
                            {issue.identifier}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
                            <Link
                              to="/issues/$issueId"
                              params={{ issueId: issue.id }}
                              color="primary"
                              weight="medium"
                            >
                              {issue.title}
                            </Link>
                            {issue.labels.map((label) => (
                              <LabelPill key={label.id} label={label} />
                            ))}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Token
                            label={issueStatusLabels[issue.status]}
                            color={statusTokenColors[issue.status]}
                            size="sm"
                            data-issue-status={issue.status}
                          />
                        </TableCell>
                        <TableCell>
                          {assignee === null && !showWorkingAgent ? (
                            <Text as="span" type="supporting" color="secondary">
                              —
                            </Text>
                          ) : (
                            <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
                              {assignee !== null && (
                                <Stack
                                  as="span"
                                  direction="horizontal"
                                  vAlign="center"
                                  data-issue-assignee=""
                                >
                                  {assignee.agentId !== undefined ? (
                                    <AgentAvatar
                                      name={assignee.displayName}
                                      harness={
                                        session?.agentId === assignee.agentId
                                          ? run?.harness
                                          : undefined
                                      }
                                      size={18}
                                    />
                                  ) : (
                                    <HumanAvatar
                                      name={assignee.displayName}
                                      avatarUrl={assignee.avatarUrl}
                                      size="xsm"
                                    />
                                  )}
                                  <VisuallyHidden>{assignee.displayName}</VisuallyHidden>
                                </Stack>
                              )}
                              {showWorkingAgent && (
                                <Stack
                                  as="span"
                                  direction="horizontal"
                                  vAlign="center"
                                  data-working-agent=""
                                >
                                  <AgentAvatar
                                    name={run.agentName}
                                    harness={run.harness}
                                    size={18}
                                  />
                                  <VisuallyHidden>{run.agentName}</VisuallyHidden>
                                </Stack>
                              )}
                            </Stack>
                          )}
                        </TableCell>
                        <TableCell>
                          {canContribute ? (
                            <IssuePriorityControls
                              issue={issue}
                              issues={issues}
                              projectId={project.id}
                              compact
                            />
                          ) : (
                            <PriorityBadge priority={issue.priority} />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Section>
          )}
        </section>
      )}

      {activeTab === "knowledge" && (
        <section id="panel-knowledge" role="tabpanel">
          <Section padding={4}>
            <Stack gap={3}>
              <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
                <Heading level={2} color="inherit">
                  Knowledge
                </Heading>
                {canContribute && (
                  <Button
                    type="button"
                    label="New document"
                    icon={<Icon icon={Plus} />}
                    variant="primary"
                    size="sm"
                    href={`/projects/${project.id}/knowledge/new`}
                    data-new-knowledge=""
                  />
                )}
              </Stack>
              {knowledge.length === 0 ? (
                <EmptyState
                  title="No knowledge entries yet"
                  description="Capture architecture notes and decisions for humans and agents."
                  isCompact
                  headingLevel={3}
                  actions={
                    canContribute ? (
                      <Button
                        label="New document"
                        icon={<Icon icon={Plus} />}
                        variant="primary"
                        href={`/projects/${project.id}/knowledge/new`}
                        data-new-knowledge=""
                      />
                    ) : undefined
                  }
                />
              ) : (
                <Table aria-label="Knowledge documents">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Document</TableHeaderCell>
                      <TableHeaderCell>Updated by</TableHeaderCell>
                      <TableHeaderCell>Last updated</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {knowledge.map((entry) => (
                      <TableRow key={entry.id} data-knowledge-id={entry.id}>
                        <TableCell>
                          <Link
                            to="/knowledge/$entryId"
                            params={{ entryId: entry.id }}
                            color="primary"
                            weight="medium"
                          >
                            {entry.title}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Text type="supporting" color="secondary">
                            {entry.updatedBy.displayName}
                          </Text>
                        </TableCell>
                        <TableCell>
                          <Text type="supporting" color="secondary">
                            <time
                              dateTime={entry.updatedAt}
                              title={formatFullDateTime(entry.updatedAt)}
                            >
                              {relativeTime(entry.updatedAt)}
                            </time>
                          </Text>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Stack>
          </Section>
        </section>
      )}

      {activeTab === "labels" && (
        <section id="panel-labels" role="tabpanel">
          <ProjectLabels projectId={project.id} labels={labels} canContribute={canContribute} />
        </section>
      )}

      {activeTab === "activity" && (
        <section id="panel-activity" role="tabpanel">
          <Activity projectId={project.id} />
        </section>
      )}

      {activeTab === "settings" && canManage && (
        <section id="panel-settings" role="tabpanel">
          <Stack gap={3}>
            <ProjectSettings
              key={`${project.name}:${project.description}:${project.fallbackPolicy}`}
              project={project}
            />
            {project.workspaceKind === "shared" && <ProjectAccess projectId={project.id} />}
          </Stack>
        </section>
      )}
    </Stack>
  );
}

function ProjectSettings({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [fallbackPolicy, setFallbackPolicy] = useState<FallbackPolicy>(project.fallbackPolicy);
  const [error, setError] = useState<string>();
  const [policyError, setPolicyError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await updateProject(project.id, { name, description });
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(project.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectsQuery(project.workspaceId).queryKey }),
      ]);
      toast({ body: "Project settings saved." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the project.");
    } finally {
      setSaving(false);
    }
  }

  async function onPolicyChange(next: FallbackPolicy) {
    setFallbackPolicy(next);
    setSavingPolicy(true);
    setPolicyError(undefined);
    try {
      const updated = await setProjectFallbackPolicy(project.id, { fallbackPolicy: next });
      queryClient.setQueryData(projectQuery(project.id).queryKey, updated);
      await queryClient.invalidateQueries({
        queryKey: projectActivityQuery(project.id).queryKey,
      });
      toast({ body: "Fallback policy updated." });
    } catch (cause) {
      setFallbackPolicy(project.fallbackPolicy);
      setPolicyError(cause instanceof Error ? cause.message : "Could not update fallback policy.");
    } finally {
      setSavingPolicy(false);
    }
  }

  return (
    <Section padding={4}>
      <Stack gap={4}>
        <Stack gap={3}>
          <Heading level={2} color="inherit">
            Project settings
          </Heading>
          <form onSubmit={(event) => void onSubmit(event)}>
            <Stack gap={3} hAlign="start">
              <TextField
                label="Project name"
                id="project-rename"
                htmlName="name"
                value={name}
                onChange={setName}
                required
                maxLength={120}
                width="min(100%, 28rem)"
              />
              <TextAreaField
                label="Description"
                id="project-description"
                htmlName="description"
                value={description}
                onChange={setDescription}
                isOptional
                rows={3}
                maxLength={500}
                htmlMaxLength={500}
                placeholder="What is this project about?"
                width="min(100%, 28rem)"
              />
              {error !== undefined && (
                <Banner
                  status="error"
                  role="alert"
                  title="Could not save project"
                  description={error}
                />
              )}
              <Button
                type="submit"
                isDisabled={saving}
                isLoading={saving}
                label="Save project"
                variant="primary"
              />
            </Stack>
          </form>
        </Stack>

        <Divider />

        <Stack gap={2} hAlign="start">
          <Heading level={3} color="inherit">
            Agent question fallback policy
          </Heading>
          <Text as="p" display="block" type="supporting">
            Controls what happens when an agent question reaches its 1-hour response deadline
            without a human answer.
          </Text>
          <Selector
            label="Default fallback policy"
            id="project-fallback-policy"
            value={fallbackPolicy}
            isDisabled={savingPolicy}
            onChange={(value) => {
              const parsed = FallbackPolicy.safeParse(value);
              if (parsed.success && parsed.data !== project.fallbackPolicy) {
                void onPolicyChange(parsed.data);
              }
            }}
            options={[
              {
                value: "require_human",
                label: "Require human answer (pause at deadline)",
              },
              {
                value: "fallback_allowed",
                label: "Allow proposed fallback (continue at deadline)",
              },
            ]}
          />
          {policyError !== undefined && (
            <Banner
              status="error"
              role="alert"
              title="Could not update policy"
              description={policyError}
            />
          )}
        </Stack>
      </Stack>
    </Section>
  );
}

function ProjectAccess({ projectId }: { projectId: string }) {
  const { data: grants } = useSuspenseQuery(projectAccessQuery(projectId));
  const { data: eligibleMembers } = useSuspenseQuery(projectAccessCandidatesQuery(projectId));
  const candidates = projectAccessCandidates(
    eligibleMembers,
    grants.map((grant) => grant.humanId),
  );
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<ProjectAccessLevel>("read");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [updatingHumanId, setUpdatingHumanId] = useState<string>();
  const [confirmRevoke, setConfirmRevoke] = useState<ProjectAccessGrant>();

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectAccessQuery(projectId).queryKey }),
      queryClient.invalidateQueries({ queryKey: projectAccessCandidatesQuery(projectId).queryKey }),
    ]);
  }

  async function onGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await setProjectAccess(projectId, { email, level });
      setEmail("");
      await refresh();
      toast({ body: `Granted ${level} access to ${email}.` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not grant access.");
    } finally {
      setSaving(false);
    }
  }

  async function onChangeLevel(grant: ProjectAccessGrant, nextLevel: ProjectAccessLevel) {
    setUpdatingHumanId(grant.humanId);
    setError(undefined);
    try {
      await setProjectAccess(projectId, { email: grant.email, level: nextLevel });
      await refresh();
      toast({ body: `Updated ${grant.email} to ${nextLevel}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not update access level.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setUpdatingHumanId(undefined);
    }
  }

  async function onRevoke(grant: ProjectAccessGrant) {
    setUpdatingHumanId(grant.humanId);
    setError(undefined);
    try {
      await removeProjectAccess(projectId, grant.humanId);
      setConfirmRevoke(undefined);
      await refresh();
      toast({ body: `Revoked access for ${grant.email}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not revoke access.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setUpdatingHumanId(undefined);
    }
  }

  return (
    <Section padding={4}>
      <Stack gap={3}>
        <Heading level={2} color="inherit">
          Project access
        </Heading>
        {grants.length === 0 ? (
          <EmptyState
            title="No explicit project grants"
            description="Workspace owners always have manage access. Add workspace members below to grant read, contribute, or manage access."
            isCompact
            headingLevel={3}
          />
        ) : (
          <Table aria-label="Project access grants">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Member</TableHeaderCell>
                <TableHeaderCell>Access level</TableHeaderCell>
                <TableHeaderCell>Granted by</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((grant) => (
                <TableRow key={grant.humanId} data-project-access-for={grant.email}>
                  <TableCell>
                    <Text type="body" weight="semibold" color="primary">
                      {grant.email}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
                      <Token
                        label={grant.level}
                        color={
                          grant.level === "manage"
                            ? "orange"
                            : grant.level === "contribute"
                              ? "blue"
                              : "gray"
                        }
                        size="sm"
                        data-access-level={grant.level}
                      />
                      <Selector
                        label={`Permission for ${grant.email}`}
                        isLabelHidden
                        id={`access-level-${grant.humanId}`}
                        size="sm"
                        variant="ghost"
                        value={grant.level}
                        isDisabled={saving || updatingHumanId !== undefined}
                        onChange={(value) => {
                          const parsed = ProjectAccessLevel.safeParse(value);
                          if (parsed.success && parsed.data !== grant.level) {
                            void onChangeLevel(grant, parsed.data);
                          }
                        }}
                        options={[
                          { value: "read", label: "Read" },
                          { value: "contribute", label: "Contribute" },
                          { value: "manage", label: "Manage" },
                        ]}
                      />
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" color="secondary">
                      {grant.grantedBy.email}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setConfirmRevoke(grant)}
                      isDisabled={saving || updatingHumanId !== undefined}
                      label="Revoke access"
                      variant="destructive"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Divider />

        <Heading level={3} color="inherit">
          Grant project access
        </Heading>
        {error !== undefined && (
          <Banner status="error" role="alert" title="Could not update access" description={error} />
        )}
        {candidates.length === 0 ? (
          <EmptyState
            title="All workspace members already have access to this project."
            description="When someone new joins the workspace, you can grant them access here."
            isCompact
            headingLevel={4}
          />
        ) : (
          <form onSubmit={(event) => void onGrant(event)}>
            <Stack gap={3} hAlign="start">
              <Stack direction="horizontal" gap={2} wrap="wrap" vAlign="end">
                <Selector
                  label="Member"
                  id="access-member"
                  htmlName="email"
                  hasSearch
                  searchPlaceholder="Search workspace members"
                  placeholder="Choose a workspace member"
                  value={email}
                  onChange={setEmail}
                  isRequired
                  isDisabled={saving}
                  options={candidates.map((candidate) => ({
                    value: candidate.email,
                    label: candidate.label,
                    description: candidate.displayName === null ? undefined : candidate.email,
                    icon: (
                      <HumanAvatar
                        name={candidate.label}
                        avatarUrl={candidate.avatarUrl}
                        size="xsm"
                      />
                    ),
                  }))}
                  width="min(100%, 22rem)"
                />
                <Selector
                  label="Access level"
                  id="access-level"
                  htmlName="level"
                  value={level}
                  onChange={(value) => {
                    const next = ProjectAccessLevel.safeParse(value);
                    if (next.success) setLevel(next.data);
                  }}
                  options={[
                    { value: "read", label: "Read" },
                    { value: "contribute", label: "Contribute" },
                    { value: "manage", label: "Manage" },
                  ]}
                />
              </Stack>
              <Button
                type="submit"
                isDisabled={saving}
                isLoading={saving}
                label="Grant access"
                icon={<Icon icon={UserPlus} />}
                variant="primary"
              />
            </Stack>
          </form>
        )}
      </Stack>

      <AlertDialog
        isOpen={confirmRevoke !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmRevoke(undefined);
        }}
        title="Revoke project access?"
        description={
          confirmRevoke === undefined
            ? "Revoke access?"
            : `${confirmRevoke.email} will lose explicit ${confirmRevoke.level} access to this project.`
        }
        actionLabel="Revoke access"
        actionVariant="destructive"
        isActionLoading={confirmRevoke !== undefined && updatingHumanId === confirmRevoke.humanId}
        onAction={() => {
          if (confirmRevoke !== undefined) void onRevoke(confirmRevoke);
        }}
      />
    </Section>
  );
}

function Activity({ projectId }: { projectId: string }) {
  const { data: activity } = useSuspenseQuery(projectActivityQuery(projectId));
  if (activity.length === 0) {
    return (
      <Stack padding={4}>
        <EmptyState title="No activity yet" headingLevel={3} />
      </Stack>
    );
  }
  return (
    <Section padding={3}>
      <Table aria-label="Project activity">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Activity</TableHeaderCell>
            <TableHeaderCell>When</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activity.map((event) => {
            const target =
              event.issueId !== null ? (
                <Link to="/issues/$issueId" params={{ issueId: event.issueId }}>
                  {event.summary}
                </Link>
              ) : event.knowledgeEntryId !== null ? (
                <Link to="/knowledge/$entryId" params={{ entryId: event.knowledgeEntryId }}>
                  {event.summary}
                </Link>
              ) : (
                <>“{event.summary}”</>
              );

            return (
              <TableRow key={event.id} data-activity-type={event.type}>
                <TableCell>
                  <Stack direction="horizontal" gap={1.5} vAlign="center">
                    <HumanAvatar
                      name={event.actor.displayName}
                      avatarUrl={event.actor.avatarUrl}
                      size="sm"
                    />
                    <Text type="body" color="primary">
                      <strong>{event.actor.displayName}</strong> {activityLabels[event.type]}{" "}
                      {target}
                    </Text>
                  </Stack>
                </TableCell>
                <TableCell>
                  <Text type="supporting" color="secondary">
                    <time dateTime={event.createdAt} title={formatFullDateTime(event.createdAt)}>
                      {relativeTime(event.createdAt)}
                    </time>
                  </Text>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

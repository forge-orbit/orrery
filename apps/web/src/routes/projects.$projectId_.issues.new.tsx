import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Heading } from "@astryxdesign/core/Heading";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Layout, LayoutPanel } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { useToast } from "@astryxdesign/core/Toast";
import {
  type CreateIssueRequest,
  type IssueDetail,
  IssuePriority,
  IssueStatus,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { agentKeysQuery, workspaceAgentKeysQuery } from "../features/agents/index.ts";
import {
  type AssigneeCandidate,
  createIssue,
  missingProjectAccessHumanIds,
  projectAccessHumanIdsQuery,
  issueQuery,
  issuesQuery,
  issueStatusLabels,
  IssueMentionTextArea,
  PRIORITY_LABELS,
  projectActivityQuery,
  projectLabelsQuery,
  projectQuery,
  readyWorkQuery,
  ResourceLoadError,
} from "../features/projects/index.ts";
import { workspaceMembersQuery, workspaceQuery } from "../features/workspaces/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

const STATUSES: IssueStatus[] = ["backlog", "todo", "in_progress", "review", "done", "cancelled"];

export const Route = createFileRoute("/projects/$projectId_/issues/new")({
  validateSearch: (search: Record<string, unknown>) => {
    const parsed: { status?: IssueStatus; parentIssueId?: string } = {};
    const status = IssueStatus.safeParse(search.status);
    if (status.success) parsed.status = status.data;
    if (typeof search.parentIssueId === "string" && search.parentIssueId !== "") {
      parsed.parentIssueId = search.parentIssueId;
    }
    return parsed;
  },
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.ensureQueryData(workspaceQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(agentKeysQuery(project.workspaceId)),
      context.queryClient.ensureQueryData(issuesQuery(project.id)),
      context.queryClient.ensureQueryData(projectLabelsQuery(project.id)),
    ]);
  },
  component: NewIssuePage,
  errorComponent: ({ error }) => <ResourceLoadError resource="issue" error={error} />,
});

function NewIssuePage() {
  const { projectId } = Route.useParams();
  const { status: initialStatus, parentIssueId: initialParent } = Route.useSearch();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(projectId));
  const { data: workspace } = useSuspenseQuery(workspaceQuery(project.workspaceId));
  const { data: issues } = useSuspenseQuery(issuesQuery(projectId));
  const { data: labels } = useSuspenseQuery(projectLabelsQuery(projectId));
  const { data: myKeys } = useSuspenseQuery(agentKeysQuery(project.workspaceId));
  const canReadMembers =
    workspace.kind === "shared" &&
    (workspace.isOwner || workspace.canManageMemberPermissions || workspace.canRemoveMembers);
  const { data: members = [] } = useQuery({
    ...workspaceMembersQuery(project.workspaceId),
    enabled: canReadMembers,
  });
  const { data: grantedHumanIds = [] } = useQuery({
    ...projectAccessHumanIdsQuery(projectId),
    enabled: canReadMembers,
  });
  const withoutAccess = missingProjectAccessHumanIds(members, grantedHumanIds);
  const { data: workspaceKeys = [] } = useQuery({
    ...workspaceAgentKeysQuery(project.workspaceId),
    enabled: workspace.kind === "shared" && workspace.isOwner,
  });

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<IssueStatus>(initialStatus ?? "todo");
  const [priority, setPriority] = useState<IssuePriority>(IssuePriority.enum.none);
  const [assigneeValue, setAssigneeValue] = useState("");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [parentIssueId, setParentIssueId] = useState(initialParent ?? "");
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const candidates: AssigneeCandidate[] = [];
  const seenHumans = new Set<string>();
  for (const actor of [project.createdBy]) {
    if (actor.humanId != null && !seenHumans.has(actor.humanId)) {
      seenHumans.add(actor.humanId);
      candidates.push({
        value: `human:${actor.humanId}`,
        label: `Human · ${actor.email ?? actor.displayName}`,
        assignee: { type: "human" as const, id: actor.humanId },
        noProjectAccess: withoutAccess.has(actor.humanId),
      });
    }
  }
  for (const member of members) {
    if (seenHumans.has(member.humanId)) continue;
    seenHumans.add(member.humanId);
    candidates.push({
      value: `human:${member.humanId}`,
      label: `Human · ${member.email}`,
      assignee: { type: "human" as const, id: member.humanId },
      noProjectAccess: withoutAccess.has(member.humanId),
    });
  }
  const seenAgents = new Set<string>();
  for (const key of [...myKeys, ...workspaceKeys]) {
    if (key.revokedAt !== null || seenAgents.has(key.agentId)) continue;
    seenAgents.add(key.agentId);
    candidates.push({
      value: `agent:${key.agentId}`,
      label: `Agent · ${key.agentName}`,
      assignee: { type: "agent" as const, id: key.agentId },
    });
  }

  const noProjectAccess = candidates.find(
    (candidate) => candidate.value === assigneeValue,
  )?.noProjectAccess;
  const canContribute = project.accessLevel !== "read";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const chosen = candidates.find((candidate) => candidate.value === assigneeValue);
      const input: CreateIssueRequest = {
        title,
        body,
        status,
        priority,
        ...(chosen !== undefined ? { assignee: chosen.assignee } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(parentIssueId !== "" ? { parentIssueId } : {}),
      };
      const created = await createIssue(projectId, input);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issuesQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: projectActivityQuery(projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: readyWorkQuery(projectId).queryKey }),
      ]);
      queryClient.setQueryData<IssueDetail>(issueQuery(created.id).queryKey, {
        ...created,
        links: [],
        attachments: [],
      });
      if (createMore) {
        // The toast renders in a portal outside the router context, so use a plain link.
        toast({
          body: (
            <AstryxLink data-new-issue-created-link="" href={`/issues/${created.id}`}>
              Created {created.identifier}
            </AstryxLink>
          ),
        });
        setTitle("");
        setBody("");
      } else {
        await navigate({ to: "/issues/$issueId", params: { issueId: created.id } });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  const main = (
    <form data-new-issue-form="" onSubmit={(event) => void handleSubmit(event)}>
      <Stack gap={3} width="100%">
        <TextField
          label="Issue title"
          id="new-issue-title"
          htmlName="title"
          value={title}
          onChange={setTitle}
          required
          maxLength={200}
          width="100%"
        />
        <Stack data-new-issue-body="" gap={1.5} width="100%">
          <IssueMentionTextArea
            label="Description"
            id="new-issue-body"
            htmlName="body"
            value={body}
            onChange={setBody}
            rows={15}
            issues={issues}
            projectId={projectId}
          />
        </Stack>
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Stack direction="horizontal" hAlign="start" gap={2}>
          <Button
            type="submit"
            label="Create issue"
            variant="primary"
            isDisabled={submitting || !canContribute}
            isLoading={submitting}
          />
          <Button
            type="button"
            label="Cancel"
            variant="secondary"
            onClick={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}
          />
        </Stack>
      </Stack>
    </form>
  );

  const rail = (
    <Stack gap={3} width="100%">
      <Heading level={2} accessibilityLevel={3}>
        Triage
      </Heading>
      <Selector
        label="Status"
        id="new-issue-status"
        data-new-issue-status=""
        size="sm"
        width="100%"
        value={status}
        onChange={(value) => {
          const next = IssueStatus.safeParse(value);
          if (next.success) setStatus(next.data);
        }}
        options={STATUSES.map((option) => ({
          value: option,
          label: issueStatusLabels[option],
        }))}
      />
      <Selector
        label="Priority"
        id="new-issue-priority"
        size="sm"
        width="100%"
        value={priority}
        onChange={(value) => {
          const next = IssuePriority.safeParse(value);
          if (next.success) setPriority(next.data);
        }}
        options={IssuePriority.options.map((option) => ({
          value: option,
          label: PRIORITY_LABELS[option],
        }))}
      />
      <Selector
        label="Assignee"
        id="new-issue-assignee"
        size="sm"
        width="100%"
        value={assigneeValue}
        onChange={setAssigneeValue}
        options={[
          { value: "", label: "Unassigned" },
          ...candidates.map((candidate) => ({
            value: candidate.value,
            label: candidate.label,
            description: candidate.noProjectAccess === true ? "No project access" : undefined,
          })),
        ]}
      />
      {noProjectAccess === true && (
        <Banner
          status="warning"
          title="No project access"
          description="This member will not see the issue in My work until they are granted access to the project."
        />
      )}
      <MultiSelector
        label="Labels"
        id="new-issue-labels"
        size="sm"
        width="100%"
        triggerDisplay="labels"
        value={labelIds}
        onChange={setLabelIds}
        options={labels.map((label) => ({ value: label.id, label: label.name }))}
        placeholder="No labels"
      />
      <Selector
        label="Parent issue"
        id="new-issue-parent"
        size="sm"
        width="100%"
        value={parentIssueId}
        onChange={(value) => setParentIssueId(value ?? "")}
        hasClear
        placeholder="No parent"
        options={[
          { value: "", label: "No parent" },
          ...issues
            .filter((issue) => issue.parentIssueId === null)
            .map((issue) => ({
              value: issue.id,
              label: `${issue.identifier} ${issue.title}`,
            })),
          ...(parentIssueId !== "" && !issues.some((issue) => issue.id === parentIssueId)
            ? [{ value: parentIssueId, label: parentIssueId }]
            : []),
        ]}
      />
      <CheckboxInput
        label="Create more"
        description="Keep this page open and clear the title and description after each issue."
        value={createMore}
        onChange={setCreateMore}
      />
      {!canContribute && (
        <Banner
          status="warning"
          title="Read-only access"
          description="You cannot create issues here."
        />
      )}
    </Stack>
  );

  return (
    <Stack gap={4} data-new-issue-page="">
      <PageHeader
        breadcrumbs={[
          <Link key="project" to="/projects/$projectId" params={{ projectId }} color="secondary">
            Back to {project.name}
          </Link>,
        ]}
        title="New issue"
        badge={project.key}
        subtitle={`Create an issue in ${project.name}`}
      />
      <Layout
        height="auto"
        padding={0}
        content={<Stack paddingInlineEnd={6}>{main}</Stack>}
        end={
          <LayoutPanel
            width={320}
            padding={0}
            isScrollable={false}
            role="complementary"
            label="Issue triage"
          >
            <Stack paddingInlineStart={6}>{rail}</Stack>
          </LayoutPanel>
        }
      />
    </Stack>
  );
}

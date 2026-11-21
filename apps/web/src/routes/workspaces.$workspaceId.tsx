import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
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
import {
  ProjectAccessLevel,
  workspaceCapabilities,
  type InvitationSummary,
  type Workspace,
  type WorkspaceCapability,
  type WorkspaceMember,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import { AgentsSection, agentKeysQuery, agentsQuery } from "../features/agents/index.ts";
import { InvitationList } from "../features/invitations/index.ts";
import { createProject, projectQuery, projectsQuery } from "../features/projects/index.ts";
import { RunsSection, workspaceRunsQuery } from "../features/runs/index.ts";
import { WebhooksSection, workspaceWebhooksQuery } from "../features/webhooks/index.ts";
import { activeSessionsQuery as workspaceActiveSessionsQuery } from "../features/work-sessions/index.ts";
import {
  appointWorkspaceOwner,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  updateWorkspaceMember,
  workspaceInvitationsQuery,
  workspaceMembersQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

const capabilityLabels: Record<WorkspaceCapability, string> = {
  canCreateProjects: "Create projects",
  canInviteMembers: "Invite members",
  canRemoveMembers: "Remove members",
  canManageMemberPermissions: "Manage member permissions",
};

const capabilityDescriptions: Record<WorkspaceCapability, string> = {
  canCreateProjects: "Create new projects inside this workspace.",
  canInviteMembers: "Send and manage invitations to join this workspace.",
  canRemoveMembers: "Remove non-manager members from this workspace.",
  canManageMemberPermissions: "Delegate workspace permissions to other members.",
};

function mayManageMembers(workspace: Workspace): boolean {
  return (
    workspace.kind === "shared" &&
    (workspace.isOwner || workspace.canManageMemberPermissions || workspace.canRemoveMembers)
  );
}

function mayInvite(workspace: Workspace): boolean {
  return workspace.kind === "shared" && (workspace.isOwner || workspace.canInviteMembers);
}

function changeableCapabilities(
  workspace: Workspace,
  member: WorkspaceMember,
  ownEmail: string | undefined,
): readonly WorkspaceCapability[] {
  if (member.isOwner || member.email === ownEmail) return [];
  if (workspace.isOwner) return workspaceCapabilities;
  if (!workspace.canManageMemberPermissions) return [];
  return workspaceCapabilities.filter(
    (capability) => capability !== "canManageMemberPermissions" && workspace[capability],
  );
}

function mayRemove(
  workspace: Workspace,
  member: WorkspaceMember,
  ownEmail: string | undefined,
): boolean {
  if (member.email === ownEmail) return false;
  if (!workspace.isOwner && !workspace.canRemoveMembers) return false;
  return workspace.isOwner || (!member.isOwner && !member.canManageMemberPermissions);
}

type WorkspaceTab = "projects" | "agents" | "runs" | "members" | "webhooks";

export const Route = createFileRoute("/workspaces/$workspaceId")({
  loader: async ({ context, params }) => {
    const workspace = await context.queryClient.ensureQueryData(workspaceQuery(params.workspaceId));
    const loads = [
      context.queryClient.ensureQueryData(projectsQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(agentsQuery),
      context.queryClient.ensureQueryData(agentKeysQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(workspaceRunsQuery(params.workspaceId)),
      context.queryClient.ensureQueryData(workspaceActiveSessionsQuery(params.workspaceId)),
      ...(mayManageMembers(workspace)
        ? [context.queryClient.ensureQueryData(workspaceMembersQuery(params.workspaceId))]
        : []),
      ...(mayInvite(workspace)
        ? [context.queryClient.ensureQueryData(workspaceInvitationsQuery(params.workspaceId))]
        : []),
      ...(workspace.isOwner
        ? [context.queryClient.ensureQueryData(workspaceWebhooksQuery(params.workspaceId))]
        : []),
    ];
    await Promise.all(loads);
  },
  component: WorkspacePage,
});

function WorkspacePage() {
  const { workspaceId } = Route.useParams();
  const { data: workspace } = useSuspenseQuery(workspaceQuery(workspaceId));
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  const { data: agents } = useSuspenseQuery(agentsQuery);
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  const membersQuery = useQuery({
    ...workspaceMembersQuery(workspaceId),
    enabled: mayManageMembers(workspace),
  });
  const webhooksQuery = useQuery({
    ...workspaceWebhooksQuery(workspaceId),
    enabled: workspace.isOwner,
  });
  const [tab, setTab] = useState<WorkspaceTab>("projects");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const canCreate = workspace.isOwner || workspace.canCreateProjects;
  const showMembersTab = mayManageMembers(workspace) || mayInvite(workspace);
  const showWebhooksTab = workspace.isOwner;
  const activeTab: WorkspaceTab =
    (tab === "members" && !showMembersTab) || (tab === "webhooks" && !showWebhooksTab)
      ? "projects"
      : tab;

  return (
    <main>
      <PageHeader
        breadcrumbs={[
          <Link key="workspaces" to="/">
            Workspaces
          </Link>,
        ]}
        title={workspace.name}
        badge={
          workspace.kind === "personal"
            ? "Personal workspace"
            : `Shared workspace · ${workspace.isOwner ? "Owner" : "Member"}`
        }
        actions={
          <>
            {(workspace.isOwner || workspace.canManageMemberPermissions) && (
              <Link
                to="/history/workspace/$workspaceId"
                params={{ workspaceId: workspace.id }}
                color="inherit"
              >
                Access history
              </Link>
            )}
            {mayInvite(workspace) && (
              <Button
                type="button"
                label="Invite member"
                variant="secondary"
                size="sm"
                onClick={() => setInviteOpen(true)}
              />
            )}
            {canCreate && (
              <Button
                type="button"
                label="New project"
                variant="primary"
                size="sm"
                onClick={() => setCreateProjectOpen(true)}
              />
            )}
          </>
        }
      />

      <TabList
        value={activeTab}
        onChange={(value) => {
          if (
            value === "projects" ||
            value === "agents" ||
            value === "runs" ||
            value === "members" ||
            value === "webhooks"
          ) {
            setTab(value);
          }
        }}
        role="tablist"
        aria-label="Workspace sections"
        size="sm"
        hasDivider
      >
        <Tab
          value="projects"
          label="Projects"
          panelId="panel-projects"
          endContent={<Badge label={projects.length} />}
        />
        <Tab
          value="agents"
          label="Agents"
          panelId="panel-agents"
          endContent={<Badge label={agents.length} />}
        />
        <Tab
          value="runs"
          label="Runs"
          panelId="panel-runs"
          endContent={<Badge label={runs.length} />}
        />
        {showMembersTab && (
          <Tab
            value="members"
            label="Members"
            panelId="panel-members"
            endContent={
              membersQuery.data !== undefined ? (
                <Badge label={membersQuery.data.length} />
              ) : undefined
            }
          />
        )}
        {showWebhooksTab && (
          <Tab
            value="webhooks"
            label="Webhooks"
            panelId="panel-webhooks"
            endContent={
              webhooksQuery.data !== undefined ? (
                <Badge label={webhooksQuery.data.items.length} />
              ) : undefined
            }
          />
        )}
      </TabList>

      {activeTab === "projects" && (
        <section id="panel-projects" role="tabpanel" className="tab-panel">
          <Projects
            workspaceId={workspace.id}
            canCreate={canCreate}
            onCreateClick={() => setCreateProjectOpen(true)}
          />
        </section>
      )}

      {activeTab === "agents" && (
        <section id="panel-agents" role="tabpanel" className="tab-panel">
          <AgentsSection workspaceId={workspace.id} isOwner={workspace.isOwner} />
        </section>
      )}

      {activeTab === "runs" && (
        <section id="panel-runs" role="tabpanel" className="tab-panel">
          <RunsSection workspaceId={workspace.id} />
        </section>
      )}

      {activeTab === "members" && showMembersTab && (
        <section id="panel-members" role="tabpanel" className="tab-panel">
          <Stack gap={3}>
            {mayManageMembers(workspace) && (
              <WorkspaceMembers workspaceId={workspace.id} workspace={workspace} />
            )}
            {mayInvite(workspace) && <WorkspaceInvitations workspaceId={workspace.id} />}
          </Stack>
        </section>
      )}

      {activeTab === "webhooks" && showWebhooksTab && (
        <section id="panel-webhooks" role="tabpanel" className="tab-panel">
          <WebhooksSection workspaceId={workspace.id} projects={projects} />
        </section>
      )}

      <Drawer
        isOpen={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        purpose="form"
        label="New project"
        width="26rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title="New project"
              subtitle={workspace.name}
              onOpenChange={setCreateProjectOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            <CreateProjectForm
              workspaceId={workspace.id}
              onCreated={() => setCreateProjectOpen(false)}
            />
          </LayoutContent>
        </Layout>
      </Drawer>

      {mayInvite(workspace) && (
        <Drawer
          isOpen={inviteOpen}
          onOpenChange={setInviteOpen}
          purpose="form"
          label={`Invite someone to ${workspace.name}`}
          width="28rem"
        >
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title={`Invite to ${workspace.name}`}
                onOpenChange={setInviteOpen}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <InviteMemberForm workspaceId={workspace.id} workspace={workspace} />
            </LayoutContent>
          </Layout>
        </Drawer>
      )}
    </main>
  );
}

function Projects({
  workspaceId,
  canCreate,
  onCreateClick,
}: {
  workspaceId: string;
  canCreate: boolean;
  onCreateClick: () => void;
}) {
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));

  if (projects.length === 0) {
    return (
      <Stack className="empty-panel">
        <EmptyState
          title="No projects yet"
          description={
            canCreate
              ? "Create a project to organize issues, board columns, and agent work sessions."
              : "No projects have been shared with you yet."
          }
          icon={<Icon icon="viewColumns" size="lg" />}
          headingLevel={2}
          actions={
            canCreate ? (
              <Button label="Create project" variant="primary" onClick={onCreateClick} />
            ) : undefined
          }
        />
      </Stack>
    );
  }

  return (
    <ul className="entity-grid">
      {projects.map((project) => (
        <li key={project.id} data-project-id={project.id} className="entity-card">
          <Stack direction="horizontal" className="entity-card-top">
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="entity-card-title"
            >
              {project.name}
            </Link>
            <span className="issue-key">{project.key}</span>
          </Stack>
          <Stack direction="horizontal" className="entity-card-meta">
            <Text type="supporting" data-project-access-level={project.accessLevel}>
              {project.accessLevel}
            </Text>
            <Stack direction="horizontal" className="page-header-actions">
              <Link to="/board/$projectId" params={{ projectId: project.id }}>
                Board
              </Link>
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                Issues
              </Link>
            </Stack>
          </Stack>
        </li>
      ))}
    </ul>
  );
}

function CreateProjectForm({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const project = await createProject(workspaceId, { name });
      queryClient.setQueryData(projectQuery(project.id).queryKey, project);
      await queryClient.invalidateQueries({ queryKey: projectsQuery(workspaceId).queryKey });
      setName("");
      onCreated();
      toast({ body: `Created project "${project.name}".` });
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={3} hAlign="start">
        <TextField
          label="Project name"
          id="project-name"
          htmlName="name"
          value={name}
          onChange={setName}
          required
          maxLength={120}
          placeholder="e.g. Web Platform"
          width="100%"
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Button
          type="submit"
          isDisabled={submitting}
          isLoading={submitting}
          label="Create project"
          variant="primary"
        />
      </Stack>
    </form>
  );
}

function WorkspaceMembers({
  workspaceId,
  workspace,
}: {
  workspaceId: string;
  workspace: Workspace;
}) {
  const { data: members } = useSuspenseQuery(workspaceMembersQuery(workspaceId));
  const { data: session } = useSuspenseQuery(sessionQuery);
  const ownEmail = session.signedIn ? session.email : undefined;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [updating, setUpdating] = useState<string>();
  const [editingMemberId, setEditingMemberId] = useState<string>();
  const [confirmAppoint, setConfirmAppoint] = useState<WorkspaceMember>();
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceMember>();

  const toast = useToast();
  const editingMember =
    editingMemberId === undefined
      ? undefined
      : members.find((candidate) => candidate.humanId === editingMemberId);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workspaceMembersQuery(workspaceId).queryKey }),
      queryClient.invalidateQueries({ queryKey: workspaceQuery(workspaceId).queryKey }),
      queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
    ]);
  }

  async function onAppoint(member: WorkspaceMember) {
    setUpdating(member.humanId);
    setError(undefined);
    try {
      await appointWorkspaceOwner(workspaceId, member.humanId);
      setConfirmAppoint(undefined);
      if (editingMemberId === member.humanId) setEditingMemberId(undefined);
      await refresh();
      toast({ body: `${member.email} is now a workspace owner.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not appoint the owner.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setUpdating(undefined);
    }
  }

  async function onCapability(humanId: string, capability: WorkspaceCapability, enabled: boolean) {
    setUpdating(humanId);
    setError(undefined);
    const membersKey = workspaceMembersQuery(workspaceId).queryKey;
    const previous = queryClient.getQueryData<WorkspaceMember[]>(membersKey);
    queryClient.setQueryData<WorkspaceMember[]>(membersKey, (current) =>
      current?.map((candidate) =>
        candidate.humanId === humanId ? { ...candidate, [capability]: enabled } : candidate,
      ),
    );
    try {
      await updateWorkspaceMember(workspaceId, humanId, { [capability]: enabled });
      await refresh();
      toast({ body: "Member permissions updated." });
    } catch (cause) {
      if (previous !== undefined) queryClient.setQueryData(membersKey, previous);
      const msg = cause instanceof Error ? cause.message : "Could not change the capability.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setUpdating(undefined);
    }
  }

  async function onRemove(member: WorkspaceMember) {
    setUpdating(member.humanId);
    setError(undefined);
    try {
      await removeWorkspaceMember(workspaceId, member.humanId);
      setConfirmRemove(undefined);
      if (editingMemberId === member.humanId) setEditingMemberId(undefined);
      await refresh();
      toast({ body: `Removed ${member.email} from the workspace.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not remove the member.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setUpdating(undefined);
    }
  }

  return (
    <Section className="page-section" padding={3}>
      <Stack gap={3}>
        <Heading level={2} color="inherit">
          Members
        </Heading>
        {error !== undefined && (
          <Banner status="error" role="alert" title="Could not update member" description={error} />
        )}
        <Table aria-label="Workspace members">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Member</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Permissions</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const isSelf = member.email === ownEmail;
              const editableCaps = changeableCapabilities(workspace, member, ownEmail);
              const grantedCaps = workspaceCapabilities.filter((capability) => member[capability]);
              const canAppoint = !member.isOwner && workspace.isOwner;
              const canRemove = mayRemove(workspace, member, ownEmail);
              const hasActions = editableCaps.length > 0 || canAppoint || canRemove;

              return (
                <TableRow key={member.humanId} data-member-id={member.humanId}>
                  <TableCell>
                    <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
                      <Text type="body" weight="semibold" color="primary">
                        {member.email}
                      </Text>
                      {isSelf && <Token label="You" color="gray" size="sm" />}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Token
                      label={member.isOwner ? "Owner" : "Member"}
                      color={member.isOwner ? "orange" : "blue"}
                      size="sm"
                    />
                  </TableCell>
                  <TableCell>
                    {member.isOwner ? (
                      <Text type="supporting" color="secondary">
                        All workspace permissions
                      </Text>
                    ) : grantedCaps.length === 0 ? (
                      <Text type="supporting" color="secondary">
                        Standard member
                      </Text>
                    ) : (
                      <Stack direction="horizontal" gap={1} wrap="wrap">
                        {grantedCaps.map((capability) => (
                          <Token
                            key={capability}
                            label={capabilityLabels[capability]}
                            color="gray"
                            size="sm"
                            data-capability={capability}
                            data-enabled="true"
                          />
                        ))}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>
                    {hasActions ? (
                      <Stack direction="horizontal" gap={1} wrap="wrap">
                        {editableCaps.length > 0 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            label="Permissions"
                            isDisabled={updating !== undefined}
                            onClick={() => setEditingMemberId(member.humanId)}
                          />
                        )}
                        {canAppoint && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            label="Make owner"
                            isDisabled={updating !== undefined}
                            onClick={() => setConfirmAppoint(member)}
                          />
                        )}
                        {canRemove && (
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            data-action="remove-member"
                            label="Remove member"
                            isDisabled={updating !== undefined}
                            onClick={() => setConfirmRemove(member)}
                          />
                        )}
                      </Stack>
                    ) : (
                      <Text type="supporting" color="secondary">
                        —
                      </Text>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Stack>

      <Drawer
        isOpen={editingMember !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditingMemberId(undefined);
        }}
        purpose="form"
        label={
          editingMember === undefined
            ? "Member permissions"
            : `Permissions for ${editingMember.email}`
        }
        width="26rem"
      >
        {editingMember !== undefined && (
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title="Member permissions"
                subtitle={editingMember.email}
                onOpenChange={(open) => {
                  if (!open) setEditingMemberId(undefined);
                }}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <Stack gap={3}>
                <Text as="p" display="block" type="supporting">
                  Changes apply immediately. You can only delegate permissions you hold yourself.
                </Text>
                <Stack gap={2}>
                  {changeableCapabilities(workspace, editingMember, ownEmail).map((capability) => (
                    <Stack key={capability} gap={0.5} data-capability-control={capability}>
                      <CheckboxInput
                        label={capabilityLabels[capability]}
                        value={editingMember[capability]}
                        isDisabled={updating === editingMember.humanId}
                        onChange={(checked) =>
                          void onCapability(editingMember.humanId, capability, checked)
                        }
                      />
                      <Text type="supporting" color="secondary">
                        {capabilityDescriptions[capability]}
                      </Text>
                    </Stack>
                  ))}
                </Stack>
              </Stack>
            </LayoutContent>
          </Layout>
        )}
      </Drawer>

      <AlertDialog
        isOpen={confirmAppoint !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmAppoint(undefined);
        }}
        title="Appoint workspace owner?"
        description={
          confirmAppoint === undefined
            ? "Appoint this member as workspace owner?"
            : `${confirmAppoint.email} will gain full owner permissions, including managing all members, webhooks, and projects in ${workspace.name}.`
        }
        actionLabel="Appoint owner"
        actionVariant="primary"
        isActionLoading={confirmAppoint !== undefined && updating === confirmAppoint.humanId}
        onAction={() => {
          if (confirmAppoint !== undefined) void onAppoint(confirmAppoint);
        }}
      />

      <AlertDialog
        isOpen={confirmRemove !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(undefined);
        }}
        title="Remove member from workspace?"
        description={
          confirmRemove === undefined
            ? "Remove this member?"
            : `${confirmRemove.email} will lose access to ${workspace.name} and its projects.`
        }
        actionLabel="Remove member"
        actionVariant="destructive"
        isActionLoading={confirmRemove !== undefined && updating === confirmRemove.humanId}
        onAction={() => {
          if (confirmRemove !== undefined) void onRemove(confirmRemove);
        }}
      />
    </Section>
  );
}

function WorkspaceInvitations({ workspaceId }: { workspaceId: string }) {
  const { data: invitations } = useSuspenseQuery(workspaceInvitationsQuery(workspaceId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  async function run(
    invitation: InvitationSummary,
    action: () => Promise<unknown>,
    successMessage: string,
  ) {
    setBusyId(invitation.id);
    setError(undefined);
    try {
      await action();
      toast({ body: successMessage });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not change the invitation.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setBusyId(undefined);
      await queryClient.invalidateQueries({
        queryKey: workspaceInvitationsQuery(workspaceId).queryKey,
      });
    }
  }

  return (
    <InvitationList
      invitations={invitations}
      emptyMessage="No invitations yet."
      {...(busyId === undefined ? {} : { busyId })}
      {...(error === undefined ? {} : { error })}
      onResend={(invitation) =>
        run(
          invitation,
          () => resendWorkspaceInvitation(workspaceId, invitation.id),
          `Invitation resent to ${invitation.email}.`,
        )
      }
      onRevoke={(invitation) =>
        run(
          invitation,
          () => revokeWorkspaceInvitation(workspaceId, invitation.id),
          `Invitation to ${invitation.email} revoked.`,
        )
      }
    />
  );
}

function InviteMemberForm({
  workspaceId,
  workspace,
}: {
  workspaceId: string;
  workspace: Workspace;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  const selectable = workspace.isOwner
    ? projects
    : projects.filter((project) => project.accessLevel === "manage");
  const [email, setEmail] = useState("");
  const [offered, setOffered] = useState<Record<string, ProjectAccessLevel>>({});
  const [error, setError] = useState<string>();
  const [invited, setInvited] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function toggleProject(projectId: string, checked: boolean) {
    setOffered((current) => {
      const next = { ...current };
      if (checked) next[projectId] = next[projectId] ?? "read";
      else delete next[projectId];
      return next;
    });
  }

  function setLevel(projectId: string, level: ProjectAccessLevel) {
    setOffered((current) => ({ ...current, [projectId]: level }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setInvited(undefined);
    try {
      const invitation = await inviteWorkspaceMember(workspaceId, {
        email,
        projectGrants: Object.entries(offered).map(([projectId, level]) => ({
          projectId,
          level,
        })),
      });
      setInvited(invitation.email);
      setEmail("");
      setOffered({});
      toast({ body: `Invitation sent to ${invitation.email}.` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the invitation.");
    } finally {
      setSubmitting(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey }),
        queryClient.invalidateQueries({
          queryKey: workspaceInvitationsQuery(workspaceId).queryKey,
        }),
      ]);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={3} hAlign="start">
        <TextField
          label="Email"
          id="invite-email"
          htmlName="email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="off"
          placeholder="teammate@example.com"
          width="100%"
        />
        {selectable.length > 0 && (
          <fieldset>
            <legend>Project access (optional)</legend>
            <Stack gap={2}>
              {selectable.map((project) => (
                <Stack key={project.id} gap={1}>
                  <CheckboxInput
                    label={project.name}
                    value={project.id in offered}
                    onChange={(checked) => toggleProject(project.id, checked)}
                  />
                  <Selector
                    label="Level"
                    id={`invite-level-${project.id}`}
                    value={offered[project.id] ?? "read"}
                    onChange={(value) => setLevel(project.id, ProjectAccessLevel.parse(value))}
                    isDisabled={!(project.id in offered)}
                    options={[
                      { value: "read", label: "Read" },
                      { value: "contribute", label: "Contribute" },
                      { value: "manage", label: "Manage" },
                    ]}
                  />
                </Stack>
              ))}
            </Stack>
          </fieldset>
        )}
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        {invited !== undefined && (
          <Banner status="success" role="status" title={`Invitation sent to ${invited}.`} />
        )}
        <Button
          type="submit"
          isDisabled={submitting}
          isLoading={submitting}
          label="Send invitation"
          variant="primary"
        />
      </Stack>
    </form>
  );
}

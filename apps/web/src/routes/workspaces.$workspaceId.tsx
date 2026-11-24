import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Divider } from "@astryxdesign/core/Divider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
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
  type UpdateWorkspaceMemberRequest,
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
import { RunnersSection } from "../features/runners/index.ts";
import { RunsSection, workspaceRunsQuery } from "../features/runs/index.ts";
import { WebhooksSection, workspaceWebhooksQuery } from "../features/webhooks/index.ts";
import { activeSessionsQuery as workspaceActiveSessionsQuery } from "../features/work-sessions/index.ts";
import {
  appointWorkspaceOwner,
  humanSuggestionsQuery,
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
import { HumanAvatar } from "../lib/avatar.tsx";
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

type PermissionDraft = {
  humanId: string;
  // Only locally changed capabilities; an absent key means "use the saved value".
  capabilities: Partial<Record<WorkspaceCapability, boolean>>;
};

type WorkspaceTab = "projects" | "agents" | "runs" | "runners" | "members" | "webhooks";

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
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link key="workspaces" to="/" color="secondary" weight="medium">
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
                color="secondary"
                weight="medium"
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
            value === "runners" ||
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
        <Tab value="runners" label="Runners" panelId="panel-runners" />
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
        <Stack as="section" id="panel-projects" role="tabpanel" gap={4}>
          <Projects
            workspaceId={workspace.id}
            canCreate={canCreate}
            onCreateClick={() => setCreateProjectOpen(true)}
          />
        </Stack>
      )}

      {activeTab === "agents" && (
        <Stack as="section" id="panel-agents" role="tabpanel" gap={4}>
          <AgentsSection workspaceId={workspace.id} isOwner={workspace.isOwner} />
        </Stack>
      )}

      {activeTab === "runs" && (
        <Stack as="section" id="panel-runs" role="tabpanel" gap={4}>
          <RunsSection workspaceId={workspace.id} />
        </Stack>
      )}

      {activeTab === "runners" && (
        <Stack as="section" id="panel-runners" role="tabpanel" gap={4}>
          <RunnersSection workspaceId={workspace.id} />
        </Stack>
      )}

      {activeTab === "members" && showMembersTab && (
        <Stack as="section" id="panel-members" role="tabpanel" gap={4}>
          <Stack gap={3}>
            {mayManageMembers(workspace) && (
              <WorkspaceMembers workspaceId={workspace.id} workspace={workspace} />
            )}
            {mayInvite(workspace) && <WorkspaceInvitations workspaceId={workspace.id} />}
          </Stack>
        </Stack>
      )}

      {activeTab === "webhooks" && showWebhooksTab && (
        <Stack as="section" id="panel-webhooks" role="tabpanel" gap={4}>
          <WebhooksSection workspaceId={workspace.id} projects={projects} />
        </Stack>
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
    </Stack>
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
      <Stack paddingInline={5} paddingBlock={8}>
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
    <Grid columns={{ minWidth: 300, max: 3 }} gap={3}>
      {projects.map((project) => (
        <Card key={project.id} data-project-id={project.id} padding={4}>
          <Stack gap={3}>
            <Stack direction="horizontal" gap={2} justify="between" align="center">
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                weight="semibold"
                color="primary"
              >
                {project.name}
              </Link>
              <Token label={project.key} color="gray" size="sm" />
            </Stack>
            <Divider />
            <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
              <Text
                type="supporting"
                color="secondary"
                data-project-access-level={project.accessLevel}
              >
                Access: {project.accessLevel}
              </Text>
              <Stack direction="horizontal" gap={2} wrap="wrap" align="center">
                <Link to="/board/$projectId" params={{ projectId: project.id }} weight="medium">
                  Board
                </Link>
                <Link to="/projects/$projectId" params={{ projectId: project.id }} weight="medium">
                  Issues
                </Link>
              </Stack>
            </Stack>
          </Stack>
        </Card>
      ))}
    </Grid>
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
      <FormLayout>
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
        <Stack direction="horizontal" hAlign="start">
          <Button
            type="submit"
            isDisabled={submitting}
            isLoading={submitting}
            label="Create project"
            variant="primary"
          />
        </Stack>
      </FormLayout>
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
  const [permissionDraft, setPermissionDraft] = useState<PermissionDraft>();
  const [confirmAppoint, setConfirmAppoint] = useState<WorkspaceMember>();
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceMember>();

  const toast = useToast();
  const editingMember =
    editingMemberId === undefined
      ? undefined
      : members.find((candidate) => candidate.humanId === editingMemberId);
  // Ignore a draft left over from another member; the drawer is re-seeded on open.
  const draftCapabilities =
    editingMember === undefined || permissionDraft?.humanId !== editingMember.humanId
      ? undefined
      : permissionDraft.capabilities;
  const editableCapabilities =
    editingMember === undefined ? [] : changeableCapabilities(workspace, editingMember, ownEmail);
  const pendingChanges: UpdateWorkspaceMemberRequest = {};
  for (const capability of editableCapabilities) {
    const value = draftCapabilities?.[capability];
    if (value !== undefined && value !== editingMember?.[capability]) {
      pendingChanges[capability] = value;
    }
  }
  const hasPermissionChanges = Object.keys(pendingChanges).length > 0;
  const savingPermissions = editingMember !== undefined && updating === editingMember.humanId;

  function openPermissions(member: WorkspaceMember) {
    setPermissionDraft({ humanId: member.humanId, capabilities: {} });
    setEditingMemberId(member.humanId);
    setError(undefined);
  }

  function closePermissions() {
    setEditingMemberId(undefined);
    setPermissionDraft(undefined);
  }

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
      if (editingMemberId === member.humanId) closePermissions();
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

  async function onSavePermissions() {
    if (editingMember === undefined || !hasPermissionChanges) return;

    setUpdating(editingMember.humanId);
    setError(undefined);
    try {
      await updateWorkspaceMember(workspaceId, editingMember.humanId, pendingChanges);
      closePermissions();
      await refresh();
      toast({ body: "Member permissions updated." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not update the member.";
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
      if (editingMemberId === member.humanId) closePermissions();
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
    <Section padding={3}>
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
                      <HumanAvatar name={member.email} avatarUrl={member.avatarUrl} size="sm" />
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
                            onClick={() => openPermissions(member)}
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
                            label="Remove"
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
          if (!open) closePermissions();
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
                  if (!open) closePermissions();
                }}
                hasDivider
              />
            }
          >
            <LayoutContent>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void onSavePermissions();
                }}
              >
                <Stack gap={3}>
                  <Text as="p" display="block" type="supporting">
                    Changes are saved when you select Save permissions. You can only delegate
                    permissions you hold yourself.
                  </Text>
                  <Stack gap={2}>
                    {editableCapabilities.map((capability) => (
                      <Stack key={capability} gap={0.5} data-capability-control={capability}>
                        <CheckboxInput
                          label={capabilityLabels[capability]}
                          value={draftCapabilities?.[capability] ?? editingMember[capability]}
                          isDisabled={savingPermissions}
                          onChange={(checked) =>
                            setPermissionDraft((current) => ({
                              humanId: editingMember.humanId,
                              capabilities: {
                                ...(current?.humanId === editingMember.humanId
                                  ? current.capabilities
                                  : {}),
                                [capability]: checked,
                              },
                            }))
                          }
                        />
                        <Text type="supporting" color="secondary">
                          {capabilityDescriptions[capability]}
                        </Text>
                      </Stack>
                    ))}
                  </Stack>
                  <Stack direction="horizontal" hAlign="start" gap={2}>
                    <Button
                      type="submit"
                      label="Save permissions"
                      variant="primary"
                      isDisabled={!hasPermissionChanges || savingPermissions}
                      isLoading={savingPermissions}
                    />
                    <Button
                      type="button"
                      label="Cancel"
                      variant="secondary"
                      isDisabled={savingPermissions}
                      onClick={closePermissions}
                    />
                  </Stack>
                </Stack>
              </form>
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
  const [suggestionSearch, setSuggestionSearch] = useState("");
  const searchingKnownHumans = suggestionSearch.trim().length >= 2;
  const { data: suggestions = [] } = useQuery({
    ...humanSuggestionsQuery(workspaceId, suggestionSearch),
    enabled: searchingKnownHumans,
  });
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
      setSuggestionSearch("");
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
          onChange={(next) => {
            setEmail(next);
            setSuggestionSearch(next.trim());
          }}
          required
          autoComplete="off"
          placeholder="teammate@example.com"
          width="100%"
        />
        {searchingKnownHumans && suggestions.length > 0 && (
          <List header="Known people" density="compact" aria-label="Known people suggestions">
            {suggestions.map((suggestion) => (
              <ListItem
                key={suggestion.humanId}
                itemKey={suggestion.humanId}
                label={suggestion.displayName ?? suggestion.email}
                description={suggestion.email}
                startContent={
                  <HumanAvatar
                    name={suggestion.displayName ?? suggestion.email}
                    avatarUrl={suggestion.avatarUrl}
                    size="xsm"
                  />
                }
                onClick={() => {
                  setEmail(suggestion.email);
                  setSuggestionSearch("");
                }}
                data-human-suggestion={suggestion.email}
              />
            ))}
          </List>
        )}
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

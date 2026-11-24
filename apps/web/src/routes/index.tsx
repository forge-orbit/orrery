import { Avatar } from "@astryxdesign/core/Avatar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import type { InvitationSummary } from "@orrery/contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Plus, UserPlus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, setupStatusQuery } from "../features/accounts/index.ts";
import {
  installationInvitationsQuery,
  InvitationList,
  inviteInstallation,
  resendInstallationInvitation,
  revokeInstallationInvitation,
} from "../features/invitations/index.ts";
import { readinessQuery } from "../features/system/index.ts";
import { createWorkspace, workspaceQuery, workspacesQuery } from "../features/workspaces/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const [, session, setup] = await Promise.all([
      context.queryClient.ensureQueryData(readinessQuery),
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(setupStatusQuery),
    ]);
    if (!session.signedIn) {
      throw redirect({ to: setup.setupComplete ? "/signin" : "/setup" });
    }
    await Promise.all([
      context.queryClient.ensureQueryData(workspacesQuery),
      context.queryClient.ensureQueryData(installationInvitationsQuery),
    ]);
  },
  component: Home,
  errorComponent: () => (
    <Stack gap={5}>
      <Banner
        status="error"
        title="Server: unreachable"
        description="Could not reach the Orrery server. Check your connection and try reloading."
      />
    </Stack>
  ),
});

function Home() {
  useSuspenseQuery(readinessQuery);
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: workspaces } = useSuspenseQuery(workspacesQuery);
  const [createOpen, setCreateOpen] = useState(false);

  if (!session.signedIn) return null;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Workspaces"
        subtitle={`Signed in as ${session.email}.`}
        actions={
          <Button
            type="button"
            label="New workspace"
            icon={<Icon icon={Plus} />}
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          />
        }
      />

      <Section variant="transparent" padding={0}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
            <Heading level={2} color="inherit">
              Your workspaces
            </Heading>
            <Text type="supporting" color="secondary">
              {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}
            </Text>
          </Stack>
          <List hasDividers aria-label="Your workspaces">
            {workspaces.map((workspace) => (
              <ListItem
                key={workspace.id}
                itemKey={workspace.id}
                data-workspace-id={workspace.id}
                startContent={
                  <Avatar name={workspace.name} shape="rounded" size="sm" tooltip={false} />
                }
                label={
                  <Link
                    to="/workspaces/$workspaceId"
                    params={{ workspaceId: workspace.id }}
                    weight="semibold"
                    color="primary"
                  >
                    {workspace.name}
                  </Link>
                }
                description={
                  workspace.kind === "personal" ? "Private workspace" : "Shared team workspace"
                }
                endContent={
                  <Token
                    label={
                      workspace.kind === "personal"
                        ? "Personal"
                        : workspace.isOwner
                          ? "Owner"
                          : "Member"
                    }
                    color={
                      workspace.kind === "personal" ? "gray" : workspace.isOwner ? "orange" : "blue"
                    }
                    size="sm"
                  />
                }
              />
            ))}
          </List>
        </Stack>
      </Section>

      <InstallationInvitations />

      <Drawer
        isOpen={createOpen}
        onOpenChange={setCreateOpen}
        purpose="form"
        label="Create a shared workspace"
        width="26rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title="Create a shared workspace"
              onOpenChange={setCreateOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            <CreateWorkspaceForm onCreated={() => setCreateOpen(false)} />
          </LayoutContent>
        </Layout>
      </Drawer>
    </Stack>
  );
}

function CreateWorkspaceForm({ onCreated }: { onCreated: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const workspace = await createWorkspace({ name });
      await queryClient.ensureQueryData(workspaceQuery(workspace.id));
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      setName("");
      onCreated();
      toast({ body: `Created workspace "${workspace.name}".` });
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the workspace.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormLayout>
        <TextField
          label="Workspace name"
          id="workspace-name"
          htmlName="name"
          value={name}
          onChange={setName}
          required
          maxLength={120}
          placeholder="e.g. Core Engineering"
          width="100%"
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Stack direction="horizontal" hAlign="start">
          <Button
            type="submit"
            isDisabled={submitting}
            isLoading={submitting}
            label="Create workspace"
            variant="primary"
          />
        </Stack>
      </FormLayout>
    </form>
  );
}

function InstallationInvitations() {
  const { data: invitations } = useSuspenseQuery(installationInvitationsQuery);
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [inviteError, setInviteError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [inviting, setInviting] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const toast = useToast();
  if (invitations === null) return null;

  const reload = () =>
    queryClient.invalidateQueries({ queryKey: installationInvitationsQuery.queryKey });

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviting) return;
    setInviting(true);
    setInviteError(undefined);
    try {
      await inviteInstallation({ email });
      setEmail("");
      setInviteOpen(false);
      toast({ body: `Invitation sent to ${email}.` });
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "Could not send the invitation.");
    } finally {
      setInviting(false);
      await reload();
    }
  }

  async function run(invitation: InvitationSummary, action: () => Promise<unknown>) {
    setBusyId(invitation.id);
    setError(undefined);
    try {
      await action();
      toast({ body: "Invitation updated." });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not change the invitation.";
      setError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setBusyId(undefined);
      await reload();
    }
  }

  return (
    <Section variant="transparent" dividers={["top"]} padding={0} paddingBlockStart={5}>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
          <Stack gap={0.5}>
            <Heading level={2} color="inherit">
              Installation administration
            </Heading>
            <Text type="supporting" color="secondary">
              Invite people to create accounts on this installation.
            </Text>
          </Stack>
          <Stack direction="horizontal" gap={2} wrap="wrap" align="center">
            <Button
              type="button"
              label="Invite person"
              icon={<Icon icon={UserPlus} />}
              variant="secondary"
              size="sm"
              onClick={() => setInviteOpen(true)}
            />
          </Stack>
        </Stack>
        <InvitationList
          embedded
          invitations={invitations}
          emptyMessage="No installation invitations yet."
          emptyDescription="Pending and past invitations to join this installation will appear here."
          {...(busyId === undefined ? {} : { busyId })}
          {...(error === undefined ? {} : { error })}
          onResend={(invitation) =>
            run(invitation, () => resendInstallationInvitation(invitation.id))
          }
          onRevoke={(invitation) =>
            run(invitation, () => revokeInstallationInvitation(invitation.id))
          }
        />
      </Stack>

      <Drawer
        isOpen={inviteOpen}
        onOpenChange={setInviteOpen}
        purpose="form"
        label="Send installation invitation"
        width="26rem"
      >
        <Layout
          height="auto"
          header={
            <DrawerHeader
              title="Invite someone to Orrery"
              onOpenChange={setInviteOpen}
              hasDivider
            />
          }
        >
          <LayoutContent>
            <form onSubmit={(event) => void onInvite(event)}>
              <Stack gap={3} hAlign="start">
                <TextField
                  label="Email"
                  id="installation-invite-email"
                  htmlName="email"
                  type="email"
                  value={email}
                  onChange={setEmail}
                  required
                  autoComplete="off"
                  placeholder="teammate@example.com"
                  width="100%"
                />
                {inviteError !== undefined && (
                  <Banner status="error" role="alert" title={inviteError} />
                )}
                <Button
                  type="submit"
                  isDisabled={inviting}
                  isLoading={inviting}
                  label="Send installation invitation"
                  variant="primary"
                />
              </Stack>
            </form>
          </LayoutContent>
        </Layout>
      </Drawer>
    </Section>
  );
}

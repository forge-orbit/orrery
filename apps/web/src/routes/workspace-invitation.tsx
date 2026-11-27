import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { WorkspaceInvitationToken, type WorkspaceInvitationPreview } from "@orrery/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, signOut, type Session } from "../features/accounts/index.ts";
import {
  acceptWorkspaceInvitation,
  declineWorkspaceInvitation,
  registerThroughWorkspaceInvitation,
  workspaceInvitationPreviewQuery,
  workspaceQuery,
  workspacesQuery,
} from "../features/workspaces/index.ts";
import { ApiProblemError } from "../lib/api.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { formatDateTime, formatFullDateTime, relativeCountdown } from "../lib/time.ts";

export const Route = createFileRoute("/workspace-invitation")({
  staticData: { accessPage: true },
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  loaderDeps: ({ search: { token } }) => ({ token }),
  loader: async ({ context, deps }) => {
    if (!WorkspaceInvitationToken.safeParse(deps.token).success) return;
    await context.queryClient.ensureQueryData(sessionQuery);
    await context.queryClient.ensureQueryData(workspaceInvitationPreviewQuery(deps.token));
  },
  component: WorkspaceInvitationPage,
  errorComponent: ({ error }) => <InvitationLoadError error={error} />,
});

function InvalidInvitationLink() {
  return (
    <Stack as="main" gap={5}>
      <Stack gap={3}>
        <Heading level={1} color="inherit">
          Workspace invitation
        </Heading>
        <Banner
          status="error"
          role="alert"
          title="This invitation is invalid, expired, or already used."
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/">Go to your workspaces</Link>
        </Text>
      </Stack>
    </Stack>
  );
}

function InvitationLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const invalid = error instanceof ApiProblemError && error.code === "invitation_invalid";
  if (invalid) return <InvalidInvitationLink />;
  const stale = error instanceof ApiProblemError && error.code === "invitation_scope_invalid";
  return (
    <Stack as="main" gap={5}>
      <Stack gap={3} align="start">
        <Heading level={1} color="inherit">
          Workspace invitation
        </Heading>
        <Banner
          status="error"
          role="alert"
          title={
            stale
              ? "An offered project is no longer in this workspace. Ask for a new invitation."
              : "Could not load this invitation. Check your connection and try again."
          }
        />
        <Stack direction="horizontal" gap={3} align="center" wrap="wrap">
          {!stale && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Retry"
              onClick={() => void router.invalidate()}
            />
          )}
          <Link to="/" isStandalone hasUnderline>
            Go to your workspaces
          </Link>
        </Stack>
      </Stack>
    </Stack>
  );
}

function WorkspaceInvitationPage() {
  const { token } = Route.useSearch();
  if (token === "") {
    return (
      <Stack as="main" gap={5}>
        <Stack gap={3} align="start">
          <Heading level={1} color="inherit">
            Workspace invitation
          </Heading>
          <Banner
            status="error"
            role="alert"
            title="This invitation link is incomplete. Ask for a fresh invitation."
          />
          <Link to="/" isStandalone hasUnderline>
            Go to your workspaces
          </Link>
        </Stack>
      </Stack>
    );
  }
  if (!WorkspaceInvitationToken.safeParse(token).success) {
    return <InvalidInvitationLink />;
  }
  return <Invitation token={token} />;
}

function InvitationHeader({ preview }: { preview: WorkspaceInvitationPreview }) {
  return (
    <Stack as="header" gap={2}>
      <Stack direction="horizontal" gap={1.5} vAlign="center">
        <Avatar name={preview.workspaceName} shape="rounded" size="sm" tooltip={false} />
        <Text as="span" type="supporting" weight="semibold" color="secondary">
          Workspace invitation
        </Text>
      </Stack>
      <Heading level={1} color="inherit">
        Join {preview.workspaceName}
      </Heading>
      <Text as="p" display="block" type="supporting" color="secondary">
        {preview.invitedByEmail} invited <strong>{preview.email}</strong> to{" "}
        <strong>{preview.workspaceName}</strong>.
      </Text>
    </Stack>
  );
}

function Invitation({ token }: { token: string }) {
  const { data: preview } = useSuspenseQuery(workspaceInvitationPreviewQuery(token));
  const { data: session } = useSuspenseQuery(sessionQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const switchAccount = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      // Update the session in place so the destination route sees the signed-out state.
      // Clearing the cache here would make this route's mounted queries refetch first.
      queryClient.setQueryData<Session>(sessionQuery.queryKey, { signedIn: false });
      await navigate({
        to: "/signin",
        search: { next: `/workspace-invitation?token=${token}` },
        replace: true,
      });
      queryClient.clear();
    },
    onError: (cause) => {
      toast({ body: cause.message, type: "error" });
    },
  });

  if (!session.signedIn) {
    if (preview.accountExists) {
      return (
        <Stack as="main" gap={5}>
          <InvitationHeader preview={preview} />
          <InvitationScope preview={preview} />
          <Text as="p" display="block" type="supporting" color="secondary">
            Sign in with {preview.email} to join the workspace.
          </Text>
          <Stack gap={2} align="center">
            <Link
              to="/signin"
              search={{ next: `/workspace-invitation?token=${token}` }}
              color="accent"
              weight="semibold"
              isStandalone
              hasUnderline
            >
              Sign in
            </Link>
            <DeclineInvitation token={token} />
          </Stack>
        </Stack>
      );
    }

    return (
      <Stack as="main" gap={5}>
        <InvitationHeader preview={preview} />
        <InvitationScope preview={preview} />
        <NewAccountForm token={token} />
        <DeclineInvitation token={token} />
      </Stack>
    );
  }

  if (session.email !== preview.email) {
    return (
      <Stack as="main" gap={5}>
        <InvitationHeader preview={preview} />
        <InvitationScope preview={preview} />
        <Banner
          status="warning"
          role="alert"
          title={`This invitation was sent to ${preview.email}, but you are signed in as ${session.email}. Sign in with the invited account to accept it.`}
        />
        <Stack gap={2}>
          <Button
            type="button"
            variant="primary"
            size="lg"
            width="100%"
            label="Sign out and switch account"
            isLoading={switchAccount.isPending}
            onClick={() => switchAccount.mutate()}
          />
          <Stack gap={2} align="center">
            <Link to="/" color="secondary">
              Go to your workspaces
            </Link>
          </Stack>
        </Stack>
      </Stack>
    );
  }

  return <AcceptInvitation token={token} preview={preview} />;
}

function InvitationScope({ preview }: { preview: WorkspaceInvitationPreview }) {
  const projects = preview.grants.filter((grant) => grant.kind === "project_access");
  return (
    <Section variant="muted" padding={4} aria-label="Invitation details">
      <Stack gap={3}>
        <Stack gap={1}>
          <Text as="span" type="supporting" weight="semibold" color="secondary">
            Access
          </Text>
          <Text as="p" display="block" weight="medium">
            Offered access: workspace membership.
          </Text>
          <Text as="p" display="block" type="supporting" color="secondary">
            Workspace membership alone does not grant project access.
          </Text>
        </Stack>

        <Divider />

        <Stack gap={1.5}>
          <Text as="span" type="supporting" weight="semibold" color="secondary">
            Projects
          </Text>
          {projects.length > 0 ? (
            <Stack as="ul" direction="horizontal" gap={1.5} wrap="wrap" aria-label="Project access">
              {projects.map((grant) => (
                <Stack as="li" key={grant.projectId} data-project-grant-id={grant.projectId}>
                  {grant.projectName}: {grant.level}
                </Stack>
              ))}
            </Stack>
          ) : (
            <Text as="p" display="block" type="supporting" color="secondary">
              No projects included in this invitation.
            </Text>
          )}
        </Stack>

        <Divider />

        <Stack direction="horizontal" gap={1.5} vAlign="center">
          <Icon icon="clock" size="xsm" color="secondary" aria-hidden="true" />
          <Text as="span" type="supporting" color="secondary">
            This invitation expires{" "}
            <time dateTime={preview.expiresAt} title={formatFullDateTime(preview.expiresAt)}>
              {formatDateTime(preview.expiresAt)} ({relativeCountdown(preview.expiresAt)})
            </time>
            .
          </Text>
        </Stack>
      </Stack>
    </Section>
  );
}

function DeclineInvitation({ token }: { token: string }) {
  const [declined, setDeclined] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onDecline() {
    setSubmitting(true);
    setError(undefined);
    try {
      await declineWorkspaceInvitation({ token });
      setConfirmOpen(false);
      setDeclined(true);
    } catch (cause) {
      setConfirmOpen(false);
      setError(cause instanceof Error ? cause.message : "Could not decline the invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  if (declined) {
    return (
      <Stack gap={2}>
        <Banner
          status="info"
          role="status"
          title="You declined this invitation. The link no longer works."
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/">Go to your workspaces</Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap={2} align="center">
      <Button
        type="button"
        onClick={() => setConfirmOpen(true)}
        isDisabled={submitting}
        label="Decline invitation"
        variant="ghost"
        size="sm"
      />
      {error !== undefined && <Banner status="error" role="alert" title={error} />}
      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Decline workspace invitation?"
        description="Declining permanently invalidates this invitation link. You will need a new invitation to join later."
        actionLabel="Decline invitation"
        actionVariant="destructive"
        isActionLoading={submitting}
        onAction={() => void onDecline()}
      />
    </Stack>
  );
}

function AcceptInvitation({
  token,
  preview,
}: {
  token: string;
  preview: WorkspaceInvitationPreview;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onAccept() {
    setSubmitting(true);
    setError(undefined);
    try {
      const workspace = await acceptWorkspaceInvitation({ token });
      queryClient.setQueryData(workspaceQuery(workspace.id).queryKey, workspace);
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: workspace.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not accept the invitation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack as="main" gap={5}>
      <InvitationHeader preview={preview} />
      <InvitationScope preview={preview} />
      <Text as="p" display="block" type="supporting" color="secondary">
        You are signed in as {preview.email}. Accepting adds this shared workspace to your own
        workspace list.
      </Text>
      {error !== undefined && <Banner status="error" role="alert" title={error} />}
      <Stack gap={2}>
        <Button
          type="button"
          onClick={() => void onAccept()}
          isDisabled={submitting}
          isLoading={submitting}
          label="Accept invitation"
          variant="primary"
          size="lg"
          width="100%"
        />
        <DeclineInvitation token={token} />
      </Stack>
    </Stack>
  );
}

function NewAccountForm({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [createdEmail, setCreatedEmail] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const account = await registerThroughWorkspaceInvitation({ token, password });
      try {
        await signIn({ email: account.email, password });
      } catch {
        setCreatedEmail(account.email);
        return;
      }

      const session: Session = {
        signedIn: true,
        humanId: account.humanId,
        email: account.email,
        handle: account.handle,
        displayName: null,
        emailVerified: account.emailVerified,
        avatarUrl: null,
      };
      queryClient.setQueryData(sessionQuery.queryKey, session);
      await queryClient.invalidateQueries({ queryKey: workspacesQuery.queryKey });
      await navigate({ to: "/", replace: true });
      // The invitation was consumed by registration. Drop it only after the
      // invitation route and its suspense observers have unmounted.
      queryClient.removeQueries({ queryKey: workspaceInvitationPreviewQuery(token).queryKey });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (createdEmail !== undefined) {
    return (
      <Stack gap={2}>
        <Banner
          status="success"
          role="status"
          title={`Your account was created for ${createdEmail}.`}
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/signin">Sign in</Link> with the password you chose.
        </Text>
      </Stack>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FormLayout>
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            Create your account
          </Heading>
          <Text as="p" display="block" type="supporting" color="secondary">
            Choose a password to create your account and join this workspace.
          </Text>
        </Stack>
        <TextField
          label="Password"
          description="At least 8 characters."
          id="workspace-invitation-password"
          htmlName="password"
          type="password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          autoComplete="new-password"
          width="100%"
        />
        {error !== undefined && <Banner status="error" role="alert" title={error} />}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          width="100%"
          isDisabled={submitting}
          isLoading={submitting}
          label="Create account and join"
        />
      </FormLayout>
    </form>
  );
}

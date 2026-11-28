import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn, toSession } from "../features/accounts/index.ts";
import {
  declineInstallationInvitation,
  registerThroughInvitation,
} from "../features/invitations/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";

export const Route = createFileRoute("/register")({
  staticData: { accessPage: true },
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const { token } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();

  const [createdEmail, setCreatedEmail] = useState<string>();
  const [declined, setDeclined] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [confirmDeclineOpen, setConfirmDeclineOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onDecline() {
    setDeclining(true);
    setError(undefined);
    try {
      await declineInstallationInvitation({ token });
      setConfirmDeclineOpen(false);
      setDeclined(true);
    } catch (cause) {
      setConfirmDeclineOpen(false);
      setError(cause instanceof Error ? cause.message : "Could not decline the invitation.");
    } finally {
      setDeclining(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const account = await registerThroughInvitation({ token, password });

      try {
        await signIn({ email: account.email, password });
      } catch {
        setCreatedEmail(account.email);
        return;
      }

      queryClient.clear();
      queryClient.setQueryData(sessionQuery.queryKey, toSession(account));
      await navigate({ to: "/" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (createdEmail !== undefined) {
    return (
      <Stack as="main" gap={5}>
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
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

  if (declined) {
    return (
      <Stack as="main" gap={5}>
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
        <Banner
          status="info"
          role="status"
          title="You declined this invitation. The link no longer works."
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/">Go to Orrery</Link>
        </Text>
      </Stack>
    );
  }

  if (token === "") {
    return (
      <Stack as="main" gap={5}>
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
        <Stack gap={3} align="start">
          <Banner
            status="error"
            role="alert"
            title="This invitation link is incomplete. Ask for a fresh invitation."
          />
          <Link to="/signin" isStandalone hasUnderline>
            Back to sign in
          </Link>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack as="main" gap={5}>
      <Stack gap={1.5}>
        <Heading level={1} color="inherit">
          Accept your invitation
        </Heading>
        <Text as="p" display="block" type="supporting" color="secondary">
          You have been invited to join this Orrery installation. Choose a password to create your
          account and personal workspace.
        </Text>
      </Stack>
      <form onSubmit={(event) => void onSubmit(event)}>
        <FormLayout>
          <TextField
            label="Password"
            description="At least 8 characters."
            id="register-password"
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
            isDisabled={submitting || declining}
            isLoading={submitting}
            label="Register"
          />
        </FormLayout>
      </form>
      <Stack gap={2} align="center">
        <Button
          type="button"
          onClick={() => setConfirmDeclineOpen(true)}
          isDisabled={submitting || declining}
          label="Decline invitation"
          variant="ghost"
          size="sm"
        />
      </Stack>

      <AlertDialog
        isOpen={confirmDeclineOpen}
        onOpenChange={setConfirmDeclineOpen}
        title="Decline this invitation?"
        description="Declining permanently invalidates this invitation link. You will need a new invitation to join later."
        actionLabel="Decline invitation"
        actionVariant="destructive"
        isActionLoading={declining}
        onAction={() => void onDecline()}
      />
    </Stack>
  );
}

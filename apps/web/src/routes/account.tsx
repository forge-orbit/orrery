import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  changePassword,
  sessionQuery,
  signOut,
  updateProfile,
} from "../features/accounts/index.ts";
import { AppearancePicker } from "../lib/appearance.tsx";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/account")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (!session.signedIn) throw redirect({ to: "/signin" });
  },
  component: AccountPage,
});

function AccountPage() {
  const { data: session, isPending, isError, refetch } = useQuery(sessionQuery);

  if (isPending) {
    return (
      <Stack gap={5}>
        <Text as="p" display="block" type="supporting" role="status">
          Loading account…
        </Text>
      </Stack>
    );
  }
  if (isError || !session.signedIn) {
    return (
      <Stack gap={5}>
        <PageHeader title="Account" />
        <Banner
          status="error"
          title="Could not check your session"
          description="Try reloading or retrying the connection."
          endContent={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              label="Retry"
              onClick={() => void refetch()}
            />
          }
        />
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link key="home" to="/" color="secondary" weight="medium">
            Workspaces
          </Link>,
          <Text key="account" as="span" type="inherit" color="inherit">
            Account
          </Text>,
        ]}
        title={session.displayName ?? "Account"}
        subtitle={session.email}
        statusToken={
          <Token
            label={session.emailVerified ? "Email verified" : "Email unverified"}
            color={session.emailVerified ? "green" : "yellow"}
            size="sm"
          />
        }
      />
      <ProfileSection initialDisplayName={session.displayName} />
      <PasswordSection />
      <PreferencesSection />
      <SessionSection />
    </Stack>
  );
}

function ProfileSection({ initialDisplayName }: { initialDisplayName: string | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draftDisplayName, setDraftDisplayName] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const displayName = draftDisplayName ?? initialDisplayName ?? "";

  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: async () => {
      setDraftDisplayName(null);
      setSavedMessage("Profile saved.");
      toast({ body: "Profile saved." });
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(null);
    const trimmed = displayName.trim();
    mutation.mutate({ displayName: trimmed.length === 0 ? null : trimmed });
  }

  return (
    <Section padding={4}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            Profile
          </Heading>
          <Text as="p" display="block" type="supporting" color="secondary">
            Set the display name shown in your sidebar and account header. Leave it blank to show
            your email address instead.
          </Text>
        </Stack>
        <form onSubmit={onSubmit}>
          <FormLayout>
            <TextField
              id="account-display-name"
              label="Display name"
              placeholder="Your name"
              width="min(100%, 28rem)"
              maxLength={120}
              value={displayName}
              onChange={(value) => {
                setDraftDisplayName(value);
                setSavedMessage(null);
              }}
            />
            <Stack hAlign="start">
              <Button
                type="submit"
                variant="primary"
                label={mutation.isPending ? "Saving…" : "Save profile"}
                isLoading={mutation.isPending}
              />
            </Stack>
            {savedMessage !== null && (
              <Text as="p" display="block" type="supporting" role="status">
                {savedMessage}
              </Text>
            )}
            {mutation.isError && (
              <Banner
                status="error"
                title="Could not save profile"
                description={mutation.error.message}
              />
            )}
          </FormLayout>
        </form>
      </Stack>
    </Section>
  );
}

function PasswordSection() {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setClientError(null);
      const msg = "Password updated. Other browser sessions have been signed out.";
      setSavedMessage(msg);
      toast({ body: msg });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(null);
    if (newPassword !== confirmPassword) {
      setClientError("New passwords do not match.");
      return;
    }
    setClientError(null);
    mutation.mutate({ currentPassword, newPassword });
  }

  const errorMessage = clientError ?? (mutation.isError ? mutation.error.message : null);

  return (
    <Section padding={4}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            Password
          </Heading>
          <Text as="p" display="block" type="supporting" color="secondary">
            Changing your password signs out all other browsers while keeping this session signed
            in.
          </Text>
        </Stack>
        <form onSubmit={onSubmit}>
          <FormLayout>
            <TextField
              id="account-current-password"
              type="password"
              label="Current password"
              autoComplete="current-password"
              width="min(100%, 28rem)"
              required
              value={currentPassword}
              onChange={setCurrentPassword}
            />
            <TextField
              id="account-new-password"
              type="password"
              label="New password"
              description="At least 8 characters."
              autoComplete="new-password"
              width="min(100%, 28rem)"
              required
              minLength={8}
              value={newPassword}
              onChange={setNewPassword}
            />
            <TextField
              id="account-confirm-password"
              type="password"
              label="Confirm new password"
              autoComplete="new-password"
              width="min(100%, 28rem)"
              required
              minLength={8}
              value={confirmPassword}
              onChange={setConfirmPassword}
            />
            <Stack hAlign="start">
              <Button
                type="submit"
                variant="primary"
                label={mutation.isPending ? "Updating…" : "Update password"}
                isLoading={mutation.isPending}
              />
            </Stack>
            {savedMessage !== null && (
              <Text as="p" display="block" type="supporting" role="status">
                {savedMessage}
              </Text>
            )}
            {errorMessage !== null && (
              <Banner status="error" title="Could not update password" description={errorMessage} />
            )}
          </FormLayout>
        </form>
      </Stack>
    </Section>
  );
}

function PreferencesSection() {
  return (
    <Section padding={4}>
      <Stack gap={3} hAlign="start">
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            Appearance
          </Heading>
          <Text as="p" display="block" type="supporting" color="secondary">
            Choose how Orrery looks in this browser: follow your system theme, light mode, or dark
            mode.
          </Text>
        </Stack>
        <AppearancePicker />
      </Stack>
    </Section>
  );
}

function SessionSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      queryClient.clear();
      toast({ body: "Signed out." });
      await navigate({ to: "/signin", replace: true });
    },
    onError: (error) => {
      toast({ body: error.message, type: "error" });
    },
  });

  return (
    <Section padding={4}>
      <Stack gap={3} hAlign="start">
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            Session
          </Heading>
          <Text as="p" display="block" type="supporting" color="secondary">
            Sign out of Orrery on this browser.
          </Text>
        </Stack>
        <Button
          type="button"
          variant="secondary"
          label={logout.isPending ? "Signing out…" : "Sign out"}
          isLoading={logout.isPending}
          onClick={() => logout.mutate()}
        />
        {logout.isError && (
          <Banner status="error" title="Could not sign out" description={logout.error.message} />
        )}
      </Stack>
    </Section>
  );
}

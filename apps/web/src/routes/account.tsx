import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
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
  removeAvatar,
  sessionQuery,
  signOut,
  updateProfile,
  uploadAvatar,
  type Session,
} from "../features/accounts/index.ts";
import { AppearancePicker } from "../lib/appearance.tsx";
import { HumanAvatar } from "../lib/avatar.tsx";
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
      <ProfileSection
        initialDisplayName={session.displayName}
        initialHandle={session.handle}
        avatarUrl={session.avatarUrl}
        displayName={session.displayName ?? session.email}
      />
      <PasswordSection />
      <PreferencesSection />
      <SessionSection />
    </Stack>
  );
}

function ProfileSection({
  initialDisplayName,
  initialHandle,
  avatarUrl,
  displayName,
}: {
  initialDisplayName: string | null;
  initialHandle: string;
  avatarUrl: string | null;
  displayName: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draftDisplayName, setDraftDisplayName] = useState<string | null>(null);
  const [draftHandle, setDraftHandle] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const name = draftDisplayName ?? displayName;
  const currentDisplayName = draftDisplayName ?? initialDisplayName ?? "";
  const currentHandle = draftHandle ?? initialHandle;

  const mutation = useMutation({
    mutationFn: updateProfile,
    onSuccess: async () => {
      setDraftDisplayName(null);
      setDraftHandle(null);
      setSavedMessage("Profile saved.");
      toast({ body: "Profile saved." });
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  function applyAvatar(nextAvatarUrl: string | null) {
    queryClient.setQueryData<Session>(sessionQuery.queryKey, (current) =>
      current?.signedIn ? { ...current, avatarUrl: nextAvatarUrl } : current,
    );
  }

  const avatarMutation = useMutation({
    mutationFn: uploadAvatar,
    onSuccess: async (updated) => {
      setSelectedFile(null);
      setUploadError(null);
      applyAvatar(updated.avatarUrl);
      toast({ body: "Profile photo updated." });
      // Every Human-bearing response now carries a new avatarUrl, so refresh all
      // cached lists (members, issues, comments, activity, history) as well.
      await queryClient.invalidateQueries();
    },
  });

  const removeMutation = useMutation({
    mutationFn: removeAvatar,
    onSuccess: async (updated) => {
      setSelectedFile(null);
      setUploadError(null);
      applyAvatar(updated.avatarUrl);
      toast({ body: "Profile photo removed." });
      await queryClient.invalidateQueries();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(null);
    const trimmed = currentDisplayName.trim();
    mutation.mutate({
      displayName: trimmed.length === 0 ? null : trimmed,
      handle: currentHandle,
    });
  }

  async function onPhotoChange(files: File | File[] | null) {
    const file = Array.isArray(files) ? (files[0] ?? null) : files;
    setSelectedFile(file);
    setUploadError(null);
    if (file === null) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setUploadError("Choose a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("The image must be 5 MB or smaller.");
      return;
    }
    try {
      await avatarMutation.mutateAsync(file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Could not upload the photo.");
    }
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
        <Stack gap={3}>
          <HumanAvatar
            avatarUrl={avatarUrl}
            name={name}
            alt={`Profile photo for ${name}`}
            size={96}
            tooltip={false}
          />
          <FileInput
            label="Profile photo"
            value={selectedFile}
            onChange={(files) => {
              setSelectedFile(Array.isArray(files) ? (files[0] ?? null) : files);
              setUploadError(null);
            }}
            changeAction={(files) => onPhotoChange(files)}
            accept="image/jpeg,image/png,image/webp"
            maxSize={5 * 1024 * 1024}
            description="JPEG, PNG or WebP, up to 5 MB. Stored as a 256×256 square with metadata removed."
            isLoading={avatarMutation.isPending}
            width="min(100%, 28rem)"
            {...(uploadError === null
              ? {}
              : { status: { type: "error" as const, message: uploadError } })}
          />
          {avatarUrl !== null && (
            <Stack gap={2} hAlign="start">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                label={removeMutation.isPending ? "Removing…" : "Remove photo"}
                isLoading={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
              />
              {removeMutation.isError && (
                <Banner
                  status="error"
                  title="Could not remove photo"
                  description={removeMutation.error.message}
                />
              )}
            </Stack>
          )}
        </Stack>
        <form onSubmit={onSubmit}>
          <FormLayout>
            <TextField
              id="account-display-name"
              label="Display name"
              placeholder="Your name"
              width="min(100%, 28rem)"
              maxLength={120}
              value={currentDisplayName}
              onChange={(value) => {
                setDraftDisplayName(value);
                setSavedMessage(null);
              }}
            />
            <TextField
              id="account-handle"
              label="Handle"
              description="Used for @mentions. 2-39 lowercase letters, digits or hyphens."
              placeholder="your-handle"
              width="min(100%, 28rem)"
              maxLength={39}
              value={currentHandle}
              onChange={(value) => {
                setDraftHandle(value.toLowerCase());
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

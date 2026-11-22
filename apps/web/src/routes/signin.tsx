import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, signIn } from "../features/accounts/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";

const INVITATION_NEXT = /^\/workspace-invitation\?token=([A-Za-z0-9_-]+)$/;

function invitationTokenFrom(next: string | undefined): string | undefined {
  if (next === undefined) return undefined;
  return INVITATION_NEXT.exec(next)?.[1];
}

export const Route = createFileRoute("/signin")({
  staticData: { accessPage: true },
  validateSearch: (search: Record<string, unknown>) => {
    const next =
      typeof search.next === "string" && INVITATION_NEXT.test(search.next)
        ? search.next
        : undefined;
    return next === undefined ? {} : { next };
  },
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.fetchQuery(sessionQuery);
    if (session.signedIn) throw redirect({ to: "/" });
  },
  component: SignInPage,
});

function SignInPage() {
  const { next } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await signIn({ email, password });

      queryClient.clear();
      await queryClient.fetchQuery(sessionQuery);
      const token = invitationTokenFrom(next);
      if (token !== undefined) {
        await navigate({ to: "/workspace-invitation", search: { token } });
      } else {
        await navigate({ to: "/" });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack as="main" gap={5}>
      <Stack gap={1.5}>
        <Heading level={1} color="inherit">
          Sign in
        </Heading>
        <Text as="p" display="block" type="supporting" color="secondary">
          Sign in to your Orrery account to access your workspaces and projects.
        </Text>
      </Stack>
      <form onSubmit={(event) => void onSubmit(event)}>
        <FormLayout>
          <TextField
            label="Email"
            id="signin-email"
            htmlName="email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoComplete="username"
            width="100%"
          />

          <TextField
            label="Password"
            id="signin-password"
            htmlName="password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoComplete="current-password"
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
            label="Sign in"
          />
        </FormLayout>
      </form>
      <Text as="p" display="block" type="supporting">
        <Link to="/forgot-password">Forgot your password?</Link>
      </Text>
    </Stack>
  );
}

import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { createFirstAdministrator, setupStatusQuery } from "../features/accounts/index.ts";
import { TextField } from "../lib/fields.tsx";

export const Route = createFileRoute("/setup")({
  staticData: { accessPage: true },
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery);
    if (status.setupComplete) throw redirect({ to: "/signin" });
  },
  component: SetupPage,
});

function SetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [secret, setSecret] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await createFirstAdministrator({ secret, email, password });

      queryClient.setQueryData(setupStatusQuery.queryKey, { setupComplete: true });
      await navigate({ to: "/signin" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack as="main" gap={5}>
      <Heading level={1} color="inherit">
        Set up Orrery
      </Heading>
      <Text as="p" display="block" type="inherit" color="inherit">
        Create the first system administrator for this installation. Setup runs once.
      </Text>
      <form onSubmit={(event) => void onSubmit(event)}>
        <TextField
          label="Setup secret"
          id="setup-secret"
          htmlName="secret"
          description="Use the value of BOOTSTRAP_SECRET on your server."
          type="password"
          value={secret}
          onChange={setSecret}
          required
          autoComplete="off"
          width="100%"
        />
        <TextField
          label="Email"
          id="setup-email"
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
          id="setup-password"
          htmlName="password"
          description="At least 8 characters."
          type="password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          autoComplete="new-password"
          width="100%"
        />
        {error !== undefined && (
          <Text as="p" display="block" type="inherit" color="inherit" role="alert">
            {error}
          </Text>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          width="100%"
          label="Create administrator"
          isLoading={submitting}
        />
      </form>
    </Stack>
  );
}

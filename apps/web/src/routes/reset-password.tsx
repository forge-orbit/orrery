import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { createFileRoute } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { confirmPasswordReset } from "../features/recovery/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";

export const Route = createFileRoute("/reset-password")({
  staticData: { accessPage: true },
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await confirmPasswordReset({ token, password });
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset the password.");
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  if (token === "") {
    return (
      <Stack as="main" gap={5}>
        <Heading level={1} color="inherit">
          Choose a new password
        </Heading>
        <Banner
          status="error"
          role="alert"
          title="This reset link is incomplete. Ask for a fresh reset link."
        />
        <Text as="p" display="block" type="supporting">
          <Link to="/forgot-password">Request a reset link</Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack as="main" gap={5}>
      <Heading level={1} color="inherit">
        Choose a new password
      </Heading>
      {message !== undefined ? (
        <Stack gap={3}>
          <Banner status="success" role="status" title={message} />
          <Text as="p" display="block" type="supporting">
            <Link to="/signin">Sign in</Link>
          </Text>
        </Stack>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)}>
          <Stack gap={3}>
            <TextField
              label="New password"
              description="At least 8 characters."
              id="reset-password"
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
              label="Set new password"
            />
          </Stack>
        </form>
      )}
    </Stack>
  );
}

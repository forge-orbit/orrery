import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { createFileRoute } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { requestPasswordReset } from "../features/recovery/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";

export const Route = createFileRoute("/forgot-password")({
  staticData: { accessPage: true },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await requestPasswordReset({ email });
      setMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request a reset link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack as="main" gap={5}>
      <Stack gap={1.5}>
        <Heading level={1} color="inherit">
          Reset your password
        </Heading>
        <Text as="p" display="block" type="supporting" color="secondary">
          Enter your email address. If it can be recovered, we will send a reset link.
        </Text>
      </Stack>
      <form onSubmit={(event) => void onSubmit(event)}>
        <FormLayout>
          <TextField
            label="Email"
            id="forgot-email"
            htmlName="email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoComplete="username"
            width="100%"
          />
          {error !== undefined && <Banner status="error" role="alert" title={error} />}
          {message !== undefined && <Banner status="success" role="status" title={message} />}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            width="100%"
            isDisabled={submitting}
            isLoading={submitting}
            label="Send reset link"
          />
        </FormLayout>
      </form>
      <Text as="p" display="block" type="supporting">
        <Link to="/signin" hasUnderline isStandalone>
          <Stack as="span" direction="horizontal" gap={1} vAlign="center">
            <Icon icon="chevronLeft" size="xsm" aria-hidden="true" />
            Back to sign in
          </Stack>
        </Link>
      </Text>
    </Stack>
  );
}

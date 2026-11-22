import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import {
  SmtpSecurity,
  type SmtpSettings as SmtpSettingsInput,
  type SmtpSettingsResponse,
} from "@orrery/contract";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery, type Session } from "../features/accounts/index.ts";
import {
  saveSmtpSettings,
  sendTestEmail,
  smtpSettingsQuery,
  verifyEmail,
} from "../features/settings/index.ts";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { PageHeader } from "../lib/PageHeader.tsx";

export const Route = createFileRoute("/settings/smtp")({
  validateSearch: (search: Record<string, unknown>) => {
    const parsed: { token?: string } = {};
    if (typeof search.token === "string" && search.token.length > 0) parsed.token = search.token;
    return parsed;
  },
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionQuery),
      context.queryClient.ensureQueryData(smtpSettingsQuery),
    ]);
  },
  component: SmtpSettingsPage,
});

const SECURITY_OPTIONS: { value: SmtpSecurity; label: string }[] = [
  { value: "starttls", label: "STARTTLS" },
  { value: "tls", label: "TLS" },
  { value: "none", label: "None" },
];

function SmtpSettingsPage() {
  const { token: initialToken } = Route.useSearch();
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: settings } = useSuspenseQuery(smtpSettingsQuery);

  const emailVerified = session.signedIn && session.emailVerified;
  const configured = settings !== null && settings.host !== null;

  return (
    <Stack gap={5}>
      <PageHeader
        breadcrumbs={[
          <Link key="home" to="/">
            Back to your workspaces
          </Link>,
        ]}
        title="SMTP settings"
        subtitle="Configure outgoing email delivery and verify administrator email."
        statusToken={
          settings !== null ? (
            <Stack direction="horizontal" gap={1} wrap="wrap">
              <Token
                label={configured ? "Configured" : "Not configured"}
                color={configured ? "green" : "gray"}
                size="sm"
              />
              <Token
                label={emailVerified ? "Email verified" : "Email unverified"}
                color={emailVerified ? "green" : "yellow"}
                size="sm"
              />
            </Stack>
          ) : undefined
        }
      />
      {settings === null ? (
        <Banner
          status="error"
          title="Administrator access required"
          description="SMTP settings are available to system administrators only."
        />
      ) : (
        <>
          <SmtpForm settings={settings} />
          <TestAndVerification
            key={initialToken ?? ""}
            configured={configured}
            emailVerified={emailVerified}
            initialToken={initialToken ?? ""}
          />
        </>
      )}
    </Stack>
  );
}

function SmtpForm({ settings }: { settings: SmtpSettingsResponse }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState(settings.host ?? "");
  const [port, setPort] = useState(settings.port);
  const [invalidPortEntry, setInvalidPortEntry] = useState(false);
  const [security, setSecurity] = useState<SmtpSecurity>(settings.security ?? "starttls");
  const [from, setFrom] = useState(settings.from ?? "");
  const [username, setUsername] = useState(settings.username ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalidPortEntry || port === null || port < 1 || port > 65535) {
      setStatus(undefined);
      setError("Enter a port between 1 and 65535.");
      return;
    }
    setSaving(true);
    setStatus(undefined);
    setError(undefined);
    try {
      const input: SmtpSettingsInput = {
        host,
        port,
        security,
        username: username === "" ? null : username,
        password: password === "" ? null : password,
        from,
      };
      const saved = await saveSmtpSettings(input);
      queryClient.setQueryData(smtpSettingsQuery.queryKey, saved);
      setPassword("");
      setStatus("SMTP settings saved.");
      toast({ body: "SMTP settings saved." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the SMTP settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section padding={4}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Heading level={2} color="inherit">
            SMTP configuration
          </Heading>
          <Text as="p" display="block" type="supporting" color="secondary">
            Orrery uses this relay for invitations, password resets, and verification emails.
          </Text>
        </Stack>
        <form onSubmit={(event) => void onSubmit(event)}>
          <FormLayout>
            <TextField
              label="Host"
              id="smtp-host"
              htmlName="host"
              value={host}
              onChange={setHost}
              required
              maxLength={255}
              placeholder="smtp.example.com"
              width="min(100%, 28rem)"
            />

            <NumberInput
              label="Port"
              id="smtp-port"
              htmlName="port"
              value={port}
              onChange={setPort}
              onEntryErrorChange={(entry) => setInvalidPortEntry(entry !== null)}
              isIntegerOnly
              isRequired
              width="min(100%, 14rem)"
            />

            <Selector
              label="Security"
              id="smtp-security"
              htmlName="security"
              value={security}
              width="min(100%, 14rem)"
              onChange={(value) => {
                const parsed = SmtpSecurity.safeParse(value);
                if (parsed.success) setSecurity(parsed.data);
              }}
              options={SECURITY_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
            />

            <TextField
              label="From address"
              id="smtp-from"
              htmlName="from"
              type="email"
              value={from}
              onChange={setFrom}
              required
              placeholder="orrery@example.com"
              width="min(100%, 28rem)"
            />

            <TextField
              label="Username (optional)"
              id="smtp-username"
              htmlName="username"
              value={username}
              onChange={setUsername}
              maxLength={255}
              width="min(100%, 28rem)"
            />

            <TextField
              label="Password (optional)"
              id="smtp-password"
              htmlName="password"
              type="password"
              value={password}
              onChange={setPassword}
              maxLength={1024}
              autoComplete="new-password"
              width="min(100%, 28rem)"
            />
            {settings.hasPassword && (
              <Banner
                status="warning"
                title="A password is already stored"
                description="Saving replaces the whole configuration, so re-enter the password to keep it; leaving this field empty removes it."
              />
            )}

            {status !== undefined && (
              <Banner
                status="success"
                title={status}
                isDismissable
                onDismiss={() => setStatus(undefined)}
              />
            )}
            {error !== undefined && (
              <Banner status="error" title="Could not save SMTP settings" description={error} />
            )}
            <Stack hAlign="start">
              <Button
                type="submit"
                isDisabled={saving}
                isLoading={saving}
                label="Save SMTP settings"
                variant="primary"
              />
            </Stack>
          </FormLayout>
        </form>
      </Stack>
    </Section>
  );
}

function TestAndVerification({
  configured,
  emailVerified,
  initialToken,
}: {
  configured: boolean;
  emailVerified: boolean;
  initialToken: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [token, setToken] = useState(initialToken);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string>();

  async function onSend() {
    setSending(true);
    setSendStatus(undefined);
    setSendError(undefined);
    try {
      const result = await sendTestEmail();
      setSendStatus(`${result.message} Check ${result.sentTo} for the single-use token.`);
      toast({ body: `Test email sent to ${result.sentTo}.` });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Could not send the test email.";
      setSendError(msg);
      toast({ body: msg, type: "error" });
    } finally {
      setSending(false);
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerifying(true);
    setVerifyError(undefined);
    try {
      const account = await verifyEmail({ token });
      const prev = queryClient.getQueryData<Session>(sessionQuery.queryKey);
      const session: Session = {
        signedIn: true,
        email: account.email,
        displayName: prev?.signedIn ? prev.displayName : null,
        emailVerified: account.emailVerified,
      };
      queryClient.setQueryData(sessionQuery.queryKey, session);
      setToken("");
      toast({ body: "Email verified." });
    } catch (cause) {
      setVerifyError(cause instanceof Error ? cause.message : "Could not verify the email.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Section padding={4}>
      <Stack gap={3} hAlign="start">
        <Stack gap={1}>
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Heading level={2} color="inherit">
              Test email and verification
            </Heading>
            <Token
              label={emailVerified ? "Verified" : "Unverified"}
              color={emailVerified ? "green" : "yellow"}
              size="sm"
            />
          </Stack>
          <Text as="p" display="block" type="supporting" color="secondary">
            {emailVerified
              ? "Your email address is verified."
              : "Send a test email and paste the single-use token to verify your administrator email address."}
          </Text>
        </Stack>

        <Button
          type="button"
          onClick={() => void onSend()}
          isDisabled={sending || !configured}
          isLoading={sending}
          label="Send test email"
          variant="secondary"
        />

        {!configured && (
          <Banner
            status="info"
            title="Save SMTP settings first"
            description="Save your SMTP configuration above before sending a test email."
          />
        )}
        {sendStatus !== undefined && (
          <Banner
            status="success"
            title="Test email sent"
            description={sendStatus}
            isDismissable
            onDismiss={() => setSendStatus(undefined)}
          />
        )}
        {sendError !== undefined && (
          <Banner status="error" title="Could not send test email" description={sendError} />
        )}

        {!emailVerified && (
          <form onSubmit={(event) => void onVerify(event)}>
            <Stack gap={3} hAlign="start">
              <TextField
                label="Verification token from the test email"
                id="verify-token"
                htmlName="token"
                value={token}
                onChange={setToken}
                required
                autoComplete="off"
              />
              {verifyError !== undefined && (
                <Banner status="error" title="Verification failed" description={verifyError} />
              )}
              <Button
                type="submit"
                isDisabled={verifying}
                isLoading={verifying}
                label="Verify email"
                variant="primary"
              />
            </Stack>
          </form>
        )}
      </Stack>
    </Section>
  );
}

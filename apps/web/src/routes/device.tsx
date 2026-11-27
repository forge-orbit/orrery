import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Divider } from "@astryxdesign/core/Divider";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { UserCode } from "@orrery/contract";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowRight, Server, Terminal } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { sessionQuery } from "../features/accounts/index.ts";
import {
  approveDeviceCode,
  deviceCodePreviewQuery,
  studioNowQuery,
} from "../features/runners/index.ts";
import { ApiProblemError } from "../lib/api.ts";
import { HumanAvatar } from "../lib/avatar.tsx";
import { TextField } from "../lib/fields.tsx";
import { Link } from "../lib/Link.tsx";
import { formatDateTime, formatFullDateTime } from "../lib/time.ts";

export const Route = createFileRoute("/device")({
  staticData: {
    accessPage: true,
    accessCoverHeading: "Connect a local Runner host.",
    accessCoverBody:
      "Dispatch issues into isolated git worktrees behind NAT, with short-lived single-issue tokens and one-click revocation.",
  },
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code.trim().toUpperCase() : "",
  }),
  loaderDeps: ({ search: { code } }) => ({ code }),
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(sessionQuery);
    if (!UserCode.safeParse(deps.code).success) return;
    await context.queryClient.ensureQueryData(deviceCodePreviewQuery(deps.code));
  },
  component: DeviceApprovalPage,
  errorComponent: ({ error }) => <DeviceLoadError error={error} />,
});

/** Normalize typed or pasted 8-character codes into `XXXX-XXXX`. */
function formatUserCodeInput(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

/** Live mm:ss countdown for short-lived device codes. */
function formatExpiryCountdown(
  expiresAt: string,
  now: number | undefined,
): {
  expired: boolean;
  label: string;
} {
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return { expired: false, label: expiresAt };
  if (now === undefined) return { expired: false, label: `Expires ${formatDateTime(expiresAt)}` };
  const remainingSec = Math.floor((target - now) / 1000);
  if (remainingSec <= 0) return { expired: true, label: "Expired" };
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return { expired: false, label: `Expires in ${hours}h ${remMin}m` };
  }
  return {
    expired: false,
    label:
      minutes > 0
        ? `Expires in ${minutes}m ${String(seconds).padStart(2, "0")}s`
        : `Expires in ${seconds}s`,
  };
}

function DeviceCodeEntryForm({
  initialCode = "",
  invalidMessage,
}: {
  initialCode?: string;
  invalidMessage?: string;
}) {
  const navigate = useNavigate();
  const [input, setInput] = useState(formatUserCodeInput(initialCode));
  const [formError, setFormError] = useState<string>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formatted = formatUserCodeInput(input);
    const parsed = UserCode.safeParse(formatted);
    if (!parsed.success) {
      setFormError("Enter the 8-character code shown in your terminal (for example, ABCD-2345).");
      return;
    }
    setFormError(undefined);
    await navigate({ to: "/device", search: { code: parsed.data } });
  }

  return (
    <Stack as="main" gap={5} data-device-page="">
      <Stack gap={1.5}>
        <Stack direction="horizontal" gap={1.5} vAlign="center">
          <Icon icon={Terminal} size="sm" color="accent" />
          <Text as="span" type="supporting" weight="semibold" color="secondary">
            Runner host enrollment
          </Text>
        </Stack>
        <Heading level={1} color="inherit">
          Approve Runner host
        </Heading>
        <Text as="p" display="block" type="supporting" color="secondary">
          Enter the 8-character code printed by <Text type="code">orrery-runner login</Text> in your
          terminal.
        </Text>
      </Stack>

      {invalidMessage !== undefined && (
        <Banner status="error" role="alert" title={invalidMessage} collapsible={false} />
      )}

      <form onSubmit={(event) => void onSubmit(event)}>
        <FormLayout>
          <TextField
            label="Device code"
            id="device-code-input"
            htmlName="code"
            placeholder="ABCD-2345"
            value={input}
            onChange={(next) => {
              setInput(formatUserCodeInput(next));
              setFormError(undefined);
            }}
            required
            maxLength={9}
            autoComplete="off"
            width="100%"
            {...(formError === undefined
              ? {}
              : { status: { type: "error" as const, message: formError } })}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            width="100%"
            label="Continue"
            icon={<Icon icon={ArrowRight} />}
          />
        </FormLayout>
      </form>

      <Stack align="center">
        <Link to="/" color="secondary" weight="medium" isStandalone>
          Back to workspaces
        </Link>
      </Stack>
    </Stack>
  );
}

function DeviceLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const isGone =
    error instanceof ApiProblemError &&
    (error.status === 404 || error.status === 409 || error.status === 410);

  if (isGone) {
    return (
      <DeviceCodeEntryForm
        invalidMessage={
          error.message ||
          "This device code is invalid, expired, or already used. Run 'orrery-runner login' again."
        }
      />
    );
  }

  return (
    <Stack as="main" gap={5} data-device-page="">
      <Stack gap={2}>
        <Heading level={1} color="inherit">
          Approve Runner host
        </Heading>
        <Banner
          status="error"
          role="alert"
          title="Could not load this device code."
          description={
            error instanceof Error ? error.message : "Check your connection and try again."
          }
          collapsible={false}
        />
      </Stack>
      <Stack direction="horizontal" gap={3} align="center" wrap="wrap">
        <Button
          type="button"
          variant="secondary"
          label="Retry"
          onClick={() => void router.invalidate()}
        />
        <Link to="/" color="secondary" weight="medium" isStandalone>
          Back to workspaces
        </Link>
      </Stack>
    </Stack>
  );
}

function DeviceApprovalPage() {
  const { code } = Route.useSearch();
  if (code === "") {
    return <DeviceCodeEntryForm />;
  }
  const valid = UserCode.safeParse(code).success;
  if (!valid) {
    return <DeviceCodeEntryForm initialCode={code} invalidMessage="This device code is invalid." />;
  }
  return <ValidDeviceApproval code={code} />;
}

function ValidDeviceApproval({ code }: { code: string }) {
  const { data: preview } = useSuspenseQuery(deviceCodePreviewQuery(code));
  const { data: session } = useSuspenseQuery(sessionQuery);
  const { data: now } = useQuery(studioNowQuery());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const approve = useMutation({
    mutationFn: () => approveDeviceCode(code),
    onSuccess: async (result) => {
      toast({ body: `Runner host '${result.hostDisplayName}' approved.` });
      await queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] !== "runners" || query.queryKey[1] !== "device-code",
      });
    },
  });

  const expiry = formatExpiryCountdown(preview.expiresAt, now);
  const accountName = session.signedIn ? (session.displayName ?? session.email) : "";
  const accountEmail = session.signedIn ? session.email : "";
  const accountAvatar = session.signedIn ? session.avatarUrl : null;
  const serverHost = typeof window === "undefined" ? "Orrery" : window.location.host;

  if (approve.isSuccess) {
    return (
      <Stack as="main" gap={5} data-device-page="">
        <Stack gap={2}>
          <Stack direction="horizontal" gap={1.5} vAlign="center">
            <Icon icon={Terminal} size="sm" color="accent" />
            <Text as="span" type="supporting" weight="semibold" color="secondary">
              Runner host enrollment
            </Text>
          </Stack>
          <Heading level={1} color="inherit">
            Host connected
          </Heading>
        </Stack>

        <Banner
          status="success"
          title="Runner host approved"
          description="Return to your terminal — login will finish automatically. The credential is stored only on that machine."
          collapsible={false}
        />

        <Section variant="muted" padding={4}>
          <Stack gap={3}>
            <Stack direction="horizontal" justify="between" vAlign="center" gap={2} wrap="wrap">
              <Stack gap={0.5}>
                <Text type="supporting" color="secondary">
                  Runner host
                </Text>
                <Text weight="semibold" color="primary">
                  {preview.hostDisplayName}
                </Text>
              </Stack>
              <Token label={preview.platform} color="gray" size="sm" data-device-platform="" />
            </Stack>
            {session.signedIn && (
              <>
                <Divider />
                <Stack direction="horizontal" gap={2} vAlign="center">
                  <HumanAvatar name={accountName} avatarUrl={accountAvatar} size="sm" />
                  <Stack gap={0.5}>
                    <Text type="supporting" color="secondary">
                      Bound to account
                    </Text>
                    <Text weight="medium" color="primary">
                      {accountEmail}
                    </Text>
                  </Stack>
                </Stack>
              </>
            )}
          </Stack>
        </Section>

        <Stack gap={2}>
          <Text type="supporting" weight="semibold" color="secondary">
            Next in your terminal
          </Text>
          <CodeBlock
            code={"cd /path/to/repo\norrery-runner start"}
            language="bash"
            hasLanguageLabel={false}
          />
        </Stack>

        <Stack gap={2} align="center">
          <Button
            type="button"
            variant="secondary"
            width="100%"
            label="Go to workspaces"
            onClick={() => void navigate({ to: "/" })}
          />
          <Text type="supporting" color="secondary" justify="center">
            You can close this tab once your terminal confirms enrollment.
          </Text>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack as="main" gap={5} data-device-page="">
      <Stack gap={2}>
        <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap" data-device-handoff="">
          <Stack direction="horizontal" gap={1.5} vAlign="center" data-device-endpoint="">
            <Icon icon={Terminal} size="xsm" color="accent" />
            <Text type="supporting" weight="semibold" color="primary" maxLines={1}>
              Local terminal
            </Text>
          </Stack>
          <Icon icon={ArrowRight} size="xsm" color="secondary" />
          <Stack direction="horizontal" gap={1.5} vAlign="center" data-device-endpoint="">
            <Icon icon={Server} size="xsm" color="secondary" />
            <Text type="supporting" weight="medium" color="secondary" maxLines={1}>
              {serverHost}
            </Text>
          </Stack>
        </Stack>

        <Heading level={1} color="inherit">
          Approve Runner host
        </Heading>
        <Text as="p" display="block" type="supporting" color="secondary">
          Confirm the code below matches your terminal. Approval binds this Runner host to your
          account across this installation.
        </Text>
      </Stack>

      <Section variant="muted" padding={4} data-device-code-panel="">
        <Stack gap={3}>
          <Stack direction="horizontal" justify="between" vAlign="center" gap={2} wrap="wrap">
            <Text type="supporting" weight="semibold" color="secondary">
              Verification code
            </Text>
            <Stack direction="horizontal" gap={1} vAlign="center">
              <Icon icon="clock" size="xsm" color={expiry.expired ? "error" : "secondary"} />
              <Text
                type="supporting"
                color={expiry.expired ? "accent" : "secondary"}
                hasTabularNumbers
              >
                <time dateTime={preview.expiresAt} title={formatFullDateTime(preview.expiresAt)}>
                  {expiry.label}
                </time>
              </Text>
            </Stack>
          </Stack>

          <Stack align="center" justify="center" padding={3} data-device-code-well="">
            <Text
              type="code"
              weight="bold"
              color="primary"
              hasTabularNumbers
              data-device-code-value=""
            >
              {preview.userCode}
            </Text>
          </Stack>
        </Stack>
      </Section>

      <Section variant="muted" padding={4} aria-label="Enrollment details">
        <Stack gap={3}>
          <Stack direction="horizontal" justify="between" vAlign="center" gap={2} wrap="wrap">
            <Stack gap={0.5}>
              <Text type="supporting" color="secondary">
                Host display name
              </Text>
              <Text weight="semibold" color="primary">
                {preview.hostDisplayName}
              </Text>
            </Stack>
            <Token label={preview.platform} color="gray" size="sm" data-device-platform="" />
          </Stack>

          {session.signedIn && (
            <>
              <Divider />
              <Stack direction="horizontal" gap={2} vAlign="center">
                <HumanAvatar name={accountName} avatarUrl={accountAvatar} size="sm" />
                <Stack gap={0.5}>
                  <Text type="supporting" color="secondary">
                    Approving as
                  </Text>
                  <Text weight="medium" color="primary">
                    {accountEmail}
                  </Text>
                </Stack>
              </Stack>
            </>
          )}

          <Divider />

          <Stack gap={1.5}>
            <Text type="supporting" weight="semibold" color="secondary">
              What approval grants
            </Text>
            <Stack direction="horizontal" gap={1.5} vAlign="center">
              <Icon icon="check" size="xsm" color="accent" />
              <Text type="supporting" color="secondary">
                Outbound-only connection — no inbound ports opened
              </Text>
            </Stack>
            <Stack direction="horizontal" gap={1.5} vAlign="center">
              <Icon icon="check" size="xsm" color="accent" />
              <Text type="supporting" color="secondary">
                Short-lived single-issue tokens — no workspace API key on disk
              </Text>
            </Stack>
            <Stack direction="horizontal" gap={1.5} vAlign="center">
              <Icon icon="check" size="xsm" color="accent" />
              <Text type="supporting" color="secondary">
                Revocable anytime from your Orrery Runner hosts
              </Text>
            </Stack>
          </Stack>
        </Stack>
      </Section>

      {expiry.expired && (
        <Banner
          status="warning"
          role="alert"
          title="This device code has expired"
          description="Run 'orrery-runner login' again in your terminal to generate a fresh code."
          collapsible={false}
        />
      )}

      {approve.isError && (
        <Banner
          status="error"
          role="alert"
          title="Approval failed"
          description={
            approve.error instanceof ApiProblemError && approve.error.code === "too_many_attempts"
              ? "Too many failed attempts. Run 'orrery-runner login' again."
              : describeApprovalError(approve.error)
          }
          collapsible={false}
        />
      )}

      <Stack gap={3} align="center">
        <Button
          type="button"
          label="Approve this Runner host"
          icon={<Icon icon="check" />}
          variant="primary"
          size="lg"
          width="100%"
          isLoading={approve.isPending}
          isDisabled={expiry.expired}
          data-device-approve=""
          onClick={() => approve.mutate()}
        />
        <Link to="/" color="secondary" weight="medium" isStandalone>
          Cancel and return to workspaces
        </Link>
      </Stack>
    </Stack>
  );
}

function describeApprovalError(error: unknown): string {
  return error instanceof Error ? error.message : "The device code could not be approved.";
}

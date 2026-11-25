import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { UserCode } from "@orrery/contract";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError } from "../lib/api.ts";
import { Link } from "../lib/Link.tsx";
import { approveDeviceCode, deviceCodePreviewQuery } from "../features/runners/index.ts";

export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code.toUpperCase() : "",
  }),
  loaderDeps: ({ search: { code } }) => ({ code }),
  loader: async ({ context, deps }) => {
    if (!UserCode.safeParse(deps.code).success) return;
    await context.queryClient.ensureQueryData(deviceCodePreviewQuery(deps.code));
  },
  component: DeviceApprovalPage,
});

function DeviceApprovalPage() {
  const { code } = Route.useSearch();
  const valid = UserCode.safeParse(code).success;
  if (!valid) {
    return (
      <Stack as="main" gap={5} maxWidth="32rem" width="100%">
        <Stack gap={3} align="start">
          <Heading level={1} color="inherit">
            Runner host approval
          </Heading>
          <Banner status="error" title="This device code is invalid." />
          <Link to="/" isStandalone hasUnderline>
            Go to your workspaces
          </Link>
        </Stack>
      </Stack>
    );
  }
  return <ValidDeviceApproval code={code} />;
}

function ValidDeviceApproval({ code }: { code: string }) {
  const { data: preview } = useSuspenseQuery(deviceCodePreviewQuery(code));
  const queryClient = useQueryClient();
  const toast = useToast();
  const approve = useMutation({
    mutationFn: () => approveDeviceCode(code),
    onSuccess: async (result) => {
      toast({ body: `Runner host '${result.hostDisplayName}' approved.` });
      await queryClient.invalidateQueries();
    },
  });

  return (
    <Stack as="main" gap={5} maxWidth="32rem" width="100%">
      <Stack gap={3}>
        <Heading level={1} color="inherit">
          Approve Runner host
        </Heading>
        <Text type="supporting">
          Confirm that this is your machine before approving. Approval binds it to your account
          across this installation.
        </Text>
      </Stack>

      <Section padding={4}>
        <Stack gap={4}>
          <Stack gap={1} hAlign="start">
            <Text type="supporting" color="secondary">
              Device code
            </Text>
            <Text type="code" weight="semibold" color="primary">
              {preview.userCode}
            </Text>
          </Stack>
          <Stack gap={1} hAlign="start">
            <Text type="supporting" color="secondary">
              Host display name
            </Text>
            <Text weight="medium" color="primary">
              {preview.hostDisplayName}
            </Text>
          </Stack>
          <Stack gap={1} hAlign="start">
            <Text type="supporting" color="secondary">
              Platform
            </Text>
            <Token label={preview.platform} color="gray" size="sm" data-device-platform="" />
          </Stack>

          {approve.isError && (
            <Banner
              status="error"
              role="alert"
              title="Approval failed"
              description={
                approve.error instanceof ApiProblemError &&
                approve.error.code === "too_many_attempts"
                  ? "Too many failed attempts. Run 'orrery-runner login' again."
                  : describeApprovalError(approve.error)
              }
              collapsible={false}
            />
          )}

          {approve.isSuccess ? (
            <Banner
              status="success"
              title="Runner host approved"
              description="Return to your terminal to finish login. The credential is stored only on your machine."
              collapsible={false}
            />
          ) : (
            <Button
              type="button"
              label="Approve this Runner host"
              icon={<Icon icon="check" />}
              variant="primary"
              width="100%"
              isLoading={approve.isPending}
              data-device-approve=""
              onClick={() => approve.mutate()}
            />
          )}
        </Stack>
      </Section>

      <Link to="/" color="secondary" weight="medium" isStandalone>
        Back to workspaces
      </Link>
    </Stack>
  );
}

function describeApprovalError(error: unknown): string {
  return error instanceof Error ? error.message : "The device code could not be approved.";
}

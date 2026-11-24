import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
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
      <Stack as="main" gap={5}>
        <Stack gap={3}>
          <Heading level={1} color="inherit">
            Runner host approval
          </Heading>
          <Banner status="error" title="This device code is invalid." />
          <Text as="p" display="block" type="supporting">
            <Link to="/">Go to your workspaces</Link>
          </Text>
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
    <Stack as="main" gap={5}>
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
          <Stack gap={1}>
            <Text color="secondary">Device code</Text>
            <Text>{preview.userCode}</Text>
          </Stack>
          <Stack gap={1}>
            <Text color="secondary">Host display name</Text>
            <Text>{preview.hostDisplayName}</Text>
          </Stack>
          <Stack gap={1}>
            <Text color="secondary">Platform</Text>
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
              variant="primary"
              isLoading={approve.isPending}
              data-device-approve=""
              onClick={() => approve.mutate()}
            />
          )}
        </Stack>
      </Section>

      <Text as="p" display="block" type="supporting">
        <Link to="/">Back to workspaces</Link>
      </Text>
    </Stack>
  );
}

function describeApprovalError(error: unknown): string {
  return error instanceof Error ? error.message : "The device code could not be approved.";
}

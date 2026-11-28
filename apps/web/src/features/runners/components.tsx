import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Section } from "@astryxdesign/core/Section";
import { Stack } from "@astryxdesign/core/Stack";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type {
  ActiveWorkSession,
  FleetRunner,
  FleetRunnerHost,
  RunnerPresence,
} from "@orrery/contract";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessLogo, resolveHarnessKind } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { activeSessionsQuery } from "../work-sessions/index.ts";
import { revokeRunnerHost } from "./commands.ts";
import {
  issueDispatchesQuery,
  streamQuery,
  workspaceRunnersQuery,
  workspaceRunnersQueryKey,
} from "./queries.ts";
import { fleetStatus } from "./stream.ts";

const presenceColors = {
  online: "green",
  busy: "orange",
  offline: "gray",
} as const satisfies Record<RunnerPresence, "green" | "orange" | "gray">;

const presenceLabels = {
  online: "Online",
  busy: "Busy",
  offline: "Offline",
} as const satisfies Record<RunnerPresence, string>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "The Runner host could not be revoked.";
}

/** Correlates an active Runner slot with its dispatch and diagnostic state. */
/** Compact per-Runner Harness badges; model count, default model, and effort appear on hover. */
function HarnessCatalogCell({ runner }: { runner: FleetRunner }) {
  const harnesses = runner.harnessCatalog?.harnesses ?? [];
  if (harnesses.length === 0) {
    return <Text type="supporting">No harness probed yet</Text>;
  }
  return (
    <Stack direction="horizontal" gap={1} vAlign="center" wrap="wrap">
      {harnesses.map((harness) => {
        const effort = harness.models.find(
          (model) => model.id === harness.defaultModel,
        )?.defaultEffort;
        const kind = resolveHarnessKind(harness.id) ?? resolveHarnessKind(harness.displayName);
        const summary = [
          `${harness.models.length} model${harness.models.length === 1 ? "" : "s"}`,
          ...(harness.defaultModel === null ? [] : [harness.defaultModel]),
          ...(effort === undefined || effort === null ? [] : [`effort ${effort}`]),
        ].join(" · ");
        return (
          <Tooltip key={harness.id} content={summary} placement="above" alignment="start">
            <Token
              label={harness.displayName}
              icon={kind === null ? undefined : <HarnessLogo kind={kind} size={12} />}
              color="gray"
              size="sm"
              data-runner-harness={harness.id}
            />
          </Tooltip>
        );
      })}
    </Stack>
  );
}

function FleetLiveCell({
  workspaceId,
  runner,
  sessions,
}: {
  workspaceId: string;
  runner: FleetRunner;
  sessions: readonly ActiveWorkSession[];
}) {
  const queryClient = useQueryClient();
  const dispatchQueries = useQueries({
    queries: sessions.map((entry) => issueDispatchesQuery(entry.issueId)),
  });
  let matchedSession: ActiveWorkSession | undefined;
  let dispatch:
    | NonNullable<(typeof dispatchQueries)[number]["data"]>["dispatches"][number]
    | undefined;
  for (let index = 0; index < sessions.length; index++) {
    const candidate = dispatchQueries[index]?.data?.dispatches.find(
      (entry) => entry.runnerId === runner.id && entry.state !== "ended",
    );
    if (candidate !== undefined) {
      matchedSession = sessions[index];
      dispatch = candidate;
      break;
    }
  }
  const stream = useQuery({
    ...streamQuery(queryClient, runner.id, dispatch?.id ?? "", {
      active: dispatch !== undefined,
    }),
    enabled: dispatch !== undefined,
  });
  const status = fleetStatus(stream.data?.chunks ?? []);

  if (dispatch === undefined || matchedSession === undefined) {
    return <Text type="supporting">Project-bound Runner</Text>;
  }
  return (
    <Stack gap={1}>
      <Link
        to="/live/$runnerId/$dispatchId"
        params={{ runnerId: runner.id, dispatchId: dispatch.id }}
        search={{ issueId: matchedSession.issueId, workspaceId }}
        color="accent"
        hasUnderline
        data-fleet-live-link={dispatch.id}
      >
        Open Live Studio
      </Link>
      <Token
        label={status.label}
        color={status.color}
        size="sm"
        data-fleet-diagnostic={status.color}
      />
      {dispatch.state === "uncertain" && (
        <Token label="Needs resolution" size="sm" color="orange" />
      )}
    </Stack>
  );
}

export function RunnersSection({ workspaceId }: { workspaceId: string }) {
  const { data: fleet } = useQuery(workspaceRunnersQuery(workspaceId, true));
  const { data: activeSessions } = useQuery(activeSessionsQuery(workspaceId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmHost, setConfirmHost] = useState<FleetRunnerHost | null>(null);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const revoke = useMutation({
    mutationFn: (hostId: string) => revokeRunnerHost(hostId),
    onSuccess: async (result) => {
      setConfirmHost(null);
      toast({
        body: `Runner host revoked. ${result.revokedRunners} runner${result.revokedRunners === 1 ? "" : "s"} invalidated.`,
      });
      await queryClient.invalidateQueries({ queryKey: workspaceRunnersQueryKey(workspaceId) });
    },
    onError: (error: unknown) => {
      setActionError(
        error instanceof ApiProblemError && error.code === "host_not_found"
          ? "This Runner host is no longer available."
          : describeError(error),
      );
    },
  });

  const hosts = fleet?.hosts ?? [];

  return (
    <Section padding={3}>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
          <Stack gap={0}>
            <Heading level={2} color="inherit">
              Runners Fleet
            </Heading>
            <Text type="supporting">
              Enrolled machines and their project-bound Runners in this workspace.
            </Text>
          </Stack>
          <Text type="supporting">
            {hosts.length} runner host{hosts.length === 1 ? "" : "s"}
          </Text>
        </Stack>

        {actionError !== undefined && (
          <Banner
            status="error"
            title="Revoke failed"
            description={actionError}
            collapsible={false}
          />
        )}

        {hosts.length === 0 ? (
          <EmptyState
            title="No Runners here yet"
            description="Enroll a machine with 'orrery-runner login', then start a Runner in a project checkout with 'orrery-runner start'."
            headingLevel={3}
          />
        ) : (
          <Table aria-label="Workspace Runners Fleet">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Runner host</TableHeaderCell>
                <TableHeaderCell>Platform</TableHeaderCell>
                <TableHeaderCell>Presence</TableHeaderCell>
                <TableHeaderCell>Project runners</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hosts.map((host) => (
                <Fragment key={host.host.id}>
                  <TableRow data-runner-host-id={host.host.id}>
                    <TableCell>
                      <Stack gap={0}>
                        <Text>{host.host.displayName}</Text>
                        <Text type="supporting">Runner host</Text>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Token label={host.host.platform} color="gray" size="sm" />
                    </TableCell>
                    <TableCell>
                      <Token
                        label={presenceLabels[host.presence]}
                        color={presenceColors[host.presence]}
                        size="sm"
                        data-host-presence={host.presence}
                      />
                    </TableCell>
                    <TableCell>
                      <Text type="supporting">
                        {host.runners.length} runner{host.runners.length === 1 ? "" : "s"}
                      </Text>
                    </TableCell>
                    <TableCell>
                      {host.canRevoke ? (
                        <Button
                          type="button"
                          label="Revoke this laptop"
                          variant="destructive"
                          size="sm"
                          data-revoke-host={host.host.id}
                          onClick={() => {
                            setActionError(undefined);
                            setConfirmHost(host);
                          }}
                        />
                      ) : (
                        <Text type="supporting">Owner only</Text>
                      )}
                    </TableCell>
                  </TableRow>
                  {host.runners.map((runner) => (
                    <TableRow key={runner.id} data-runner-id={runner.id}>
                      <TableCell>
                        <Stack gap={1}>
                          <Text type="supporting">{runner.displayName}</Text>
                          <HarnessCatalogCell runner={runner} />
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Text type="supporting">{runner.repoFingerprint.slice(0, 12)}</Text>
                      </TableCell>
                      <TableCell>
                        <Token
                          label={presenceLabels[runner.presence]}
                          color={presenceColors[runner.presence]}
                          size="sm"
                          data-runner-presence={runner.presence}
                        />
                      </TableCell>
                      <TableCell>
                        <Text type="supporting">
                          {runner.activeSlotCount} / {runner.maxConcurrency} slots
                        </Text>
                      </TableCell>
                      <TableCell>
                        <FleetLiveCell
                          workspaceId={workspaceId}
                          runner={runner}
                          sessions={
                            activeSessions?.filter(
                              (entry) => entry.projectId === runner.projectId,
                            ) ?? []
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}

        <AlertDialog
          isOpen={confirmHost !== null}
          onOpenChange={(open) => {
            if (!open) setConfirmHost(null);
          }}
          title="Revoke this laptop?"
          description={
            confirmHost === null
              ? "This revokes the Runner host and every Runner on it."
              : `Revoke '${confirmHost.host.displayName}'? All ${confirmHost.runners.length} runners on that machine are invalidated immediately and local processes will stop at their next heartbeat.`
          }
          actionLabel="Revoke this laptop"
          actionVariant="destructive"
          isActionLoading={revoke.isPending}
          onAction={() => {
            if (confirmHost !== null) revoke.mutate(confirmHost.host.id);
          }}
        />
      </Stack>
    </Section>
  );
}

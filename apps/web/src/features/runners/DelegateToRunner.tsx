import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import type { Dispatch } from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { Link } from "../../lib/Link.tsx";
import { formatCompactDateTime } from "../../lib/time.ts";
import { createDispatch } from "./commands.ts";
import {
  issueDispatchesQuery,
  workspaceRunnersQuery,
  workspaceRunnersQueryKey,
} from "./queries.ts";

export interface DelegatableAgent {
  id: string;
  name: string;
}

const stateLabels: Record<Dispatch["state"], string> = {
  pending: "Waiting for the Runner",
  active: "Running",
  uncertain: "Reconnecting",
  ended: "Ended",
};

/** Manual, owner-only issue dispatch from the issue detail page. */
export function DelegateToRunner({
  issueId,
  workspaceId,
  projectId,
  agents,
}: {
  issueId: string;
  workspaceId: string;
  projectId: string;
  agents: readonly DelegatableAgent[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: fleet } = useQuery(workspaceRunnersQuery(workspaceId));
  const { data: dispatchList } = useQuery(issueDispatchesQuery(issueId));
  const [runnerId, setRunnerId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string>();

  const owned = (fleet?.hosts ?? [])
    .filter((host) => host.canRevoke)
    .flatMap((host) => host.runners)
    .filter(
      (runner) =>
        runner.projectId === projectId &&
        (runner.presence === "online" || runner.presence === "busy") &&
        runner.revokedAt === null,
    );

  const mutation = useMutation({
    mutationFn: () =>
      createDispatch(issueId, {
        runnerId,
        ...(agentId === "" ? {} : { agentId }),
      }),
    onSuccess: async (dispatch) => {
      setError(undefined);
      toast({
        body: `Delegated to ${owned.find((runner) => runner.id === dispatch.runnerId)?.displayName ?? "Runner"}.`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueDispatchesQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceRunnersQueryKey(workspaceId) }),
      ]);
    },
    onError: (cause: unknown) => {
      setError(
        cause instanceof ApiProblemError && cause.code === "issue_not_claimable"
          ? "This issue is not claimable by that Agent (check its assignee and status)."
          : cause instanceof Error
            ? cause.message
            : "The issue could not be delegated.",
      );
    },
  });

  return (
    <Stack gap={2}>
      <Heading level={3} color="inherit">
        Delegate to Runner
      </Heading>
      <Text type="supporting">
        Send this issue to one of your online Runners for this project. The issue assignee is not
        changed.
      </Text>
      {error !== undefined && (
        <Banner status="error" title="Delegation failed" description={error} collapsible={false} />
      )}
      <Selector
        label="Runner"
        placeholder={owned.length === 0 ? "No online Runners" : "Choose a Runner"}
        options={owned.map((runner) => ({
          value: runner.id,
          label: `${runner.displayName} · ${runner.presence}`,
        }))}
        value={runnerId}
        onChange={setRunnerId}
        isDisabled={owned.length === 0 || mutation.isPending}
      />
      <Selector
        label="Agent"
        isOptional
        placeholder="Use the Runner's default Agent"
        options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
        value={agentId}
        onChange={(value) => setAgentId(value ?? "")}
        hasClear
        isDisabled={mutation.isPending}
      />
      <Stack hAlign="start">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          label="Delegate to Runner"
          icon={<Icon icon={Send} />}
          isDisabled={runnerId === "" || mutation.isPending}
          isLoading={mutation.isPending}
          data-delegate-dispatch=""
          onClick={() => mutation.mutate()}
        />
      </Stack>
      {(dispatchList?.dispatches.length ?? 0) > 0 && (
        <Stack gap={1}>
          <Text type="supporting" weight="semibold">
            Recent dispatches
          </Text>
          {dispatchList?.dispatches.map((dispatch) => (
            <Stack key={dispatch.id} direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              <Text type="supporting" color="secondary">
                {stateLabels[dispatch.state]}
                {dispatch.acceptedAt !== null
                  ? ` · ${formatCompactDateTime(dispatch.acceptedAt)}`
                  : ""}
              </Text>
              <Link
                to="/live/$runnerId/$dispatchId"
                params={{ runnerId: dispatch.runnerId, dispatchId: dispatch.id }}
                search={{ issueId, workspaceId }}
              >
                {dispatch.state === "ended" ? "Replay" : "Open Live Studio"}
              </Link>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

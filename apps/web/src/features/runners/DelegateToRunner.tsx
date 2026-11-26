import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useToast } from "@astryxdesign/core/Toast";
import { MAX_DISPATCH_PROMPT_LENGTH, type Dispatch } from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessBadge } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { formatCompactDateTime } from "../../lib/time.ts";
import { createDispatch } from "./commands.ts";
import {
  issueDispatchesQuery,
  workspaceRunnersQuery,
  workspaceRunnersQueryKey,
} from "./queries.ts";
import {
  readDelegatePreference,
  resolveDelegateChoice,
  writeDelegatePreference,
  type DelegatePreference,
} from "./preferences.ts";

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

/**
 * Owner-only issue dispatch from the issue detail page. A compact trigger keeps
 * the Recent dispatches list visible and opens a focused form dialog (#239).
 */
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
  const [isOpen, setIsOpen] = useState(false);
  const [preference, setPreference] = useState<DelegatePreference>({ runnerId: "", agentId: "" });
  const [prompt, setPrompt] = useState("");
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

  // Validate the remembered choices against live data on every render, so a
  // Runner going offline or stale browser storage never breaks delegation.
  const choice = resolveDelegateChoice(preference, owned, agents);
  const { runnerId, agentId } = choice;
  const harness = choice.harness ?? "";
  const model = choice.model ?? "";
  const effort = choice.effort ?? "";
  const selectedRunner = owned.find((runner) => runner.id === runnerId);
  const harnesses = selectedRunner?.harnessCatalog.harnesses ?? [];
  const selectedHarness = harnesses.find((item) => item.id === harness);
  const models = selectedHarness?.models ?? [];
  const selectedModel = models.find((item) => item.id === model);
  const efforts = selectedModel?.supportedEfforts ?? [];
  const trimmedPrompt = prompt.trim();
  const promptTooLong = trimmedPrompt.length > MAX_DISPATCH_PROMPT_LENGTH;

  const openDialog = () => {
    setPreference(
      readDelegatePreference(projectId) ?? {
        runnerId: "",
        harness: "",
        model: "",
        effort: "",
        agentId: "",
      },
    );
    // A new delegation never carries the previous issue's instructions.
    setPrompt("");
    setError(undefined);
    setIsOpen(true);
  };

  const closeDialog = () => {
    setIsOpen(false);
    setPrompt("");
    setError(undefined);
  };

  const mutation = useMutation({
    mutationFn: () =>
      createDispatch(issueId, {
        runnerId,
        ...(agentId === "" ? {} : { agentId }),
        ...(trimmedPrompt === "" ? {} : { prompt: trimmedPrompt }),
        ...(harness === "" ? {} : { harness }),
        ...(model === "" ? {} : { model }),
        ...(effort === "" ? {} : { effort }),
      }),
    onSuccess: async (dispatch) => {
      setError(undefined);
      writeDelegatePreference(projectId, {
        runnerId: dispatch.runnerId,
        harness,
        model,
        effort,
        agentId,
      });
      closeDialog();
      toast({
        body: `Delegated to ${owned.find((runner) => runner.id === dispatch.runnerId)?.displayName ?? "Runner"}.`,
      });
      setIsOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueDispatchesQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceRunnersQueryKey(workspaceId) }),
      ]);
    },
    onError: (cause: unknown) => {
      setError(
        cause instanceof ApiProblemError && cause.code === "issue_not_claimable"
          ? "This issue is not claimable by that Agent (check its assignee and status)."
          : cause instanceof ApiProblemError && cause.code === "validation_failed"
            ? "The prompt is too long (16,000 characters max)."
            : cause instanceof Error
              ? cause.message
              : "The issue could not be delegated.",
      );
    },
  });

  const submit = () => {
    if (runnerId === "" || promptTooLong) return;
    mutation.mutate();
  };

  return (
    <Stack gap={2}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Heading level={3} color="inherit">
          Delegate to Runner
        </Heading>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          label="Delegate to Runner…"
          icon={<Icon icon={Send} />}
          data-delegate-trigger=""
          onClick={openDialog}
        />
      </HStack>
      <Text type="supporting">
        Send this issue to one of your online Runners for this project. The issue assignee is not
        changed.
      </Text>
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
              {(dispatch.harness !== undefined ||
                dispatch.model !== undefined ||
                dispatch.effort !== undefined) && (
                <Stack
                  direction="horizontal"
                  gap={1}
                  vAlign="center"
                  wrap="wrap"
                  data-dispatch-options=""
                >
                  <HarnessBadge harness={dispatch.harness ?? null} empty="harness unknown" />
                  <Text type="supporting" color="secondary">
                    {dispatch.model ?? "model unknown"}
                    {dispatch.effort === undefined ? "" : ` · ${dispatch.effort}`}
                  </Text>
                </Stack>
              )}
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
      <Dialog
        isOpen={isOpen}
        onOpenChange={(next) => (next ? undefined : closeDialog())}
        purpose="form"
        width={560}
      >
        <Layout
          header={
            <DialogHeader
              title="Delegate to Runner"
              subtitle="Choose a Runner and optionally steer how the Agent works on this issue."
              onOpenChange={(next) => (next ? undefined : closeDialog())}
            />
          }
          content={
            <LayoutContent>
              <VStack gap={4} data-delegate-dialog="">
                {error !== undefined && (
                  <Banner
                    status="error"
                    title="Delegation failed"
                    description={error}
                    collapsible={false}
                  />
                )}
                <Selector
                  label="Runner"
                  placeholder={owned.length === 0 ? "No online Runners" : "Choose a Runner"}
                  options={owned.map((runner) => ({
                    value: runner.id,
                    label: `${runner.displayName} · ${runner.presence}`,
                  }))}
                  value={runnerId}
                  onChange={(value) =>
                    setPreference((current) => ({ ...current, runnerId: value }))
                  }
                  isDisabled={owned.length === 0 || mutation.isPending}
                />
                {harnesses.length > 0 && (
                  <VStack gap={3}>
                    <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
                      <Selector
                        label="Harness"
                        placeholder="Choose a Harness"
                        options={harnesses.map((item) => ({
                          value: item.id,
                          label: item.displayName,
                        }))}
                        value={harness === "" ? null : harness}
                        hasClear
                        isOptional
                        onChange={(value) =>
                          // A Harness change invalidates both the Model and
                          // its Effort: never send a previous model's effort.
                          setPreference((current) => ({
                            ...current,
                            harness: value ?? "",
                            model: "",
                            effort: "",
                          }))
                        }
                        isDisabled={mutation.isPending}
                        data-delegate-harness=""
                      />
                      <HarnessBadge harness={harness === "" ? null : harness} empty="No Harness" />
                    </Stack>
                    {harness !== "" && (
                      <Selector
                        label="Model"
                        placeholder="Choose a model"
                        options={models.map((item) => ({
                          value: item.id,
                          label: item.label ?? item.id,
                          description:
                            item.reasoningDiscovery === "known"
                              ? "Reasoning levels available"
                              : "Reasoning levels not probed yet",
                        }))}
                        value={model ?? ""}
                        onChange={(value) =>
                          // Switching Model immediately clears stale Effort.
                          setPreference((current) => ({
                            ...current,
                            model: value ?? "",
                            effort: "",
                          }))
                        }
                        isDisabled={mutation.isPending}
                        data-delegate-model=""
                      />
                    )}
                    {model !== "" && efforts.length > 0 && (
                      <Selector
                        label="Effort"
                        placeholder="Choose a reasoning effort"
                        options={efforts.map((value) => ({ value, label: value }))}
                        value={effort === "" ? null : effort}
                        hasClear
                        isOptional
                        onChange={(value) =>
                          setPreference((current) => ({ ...current, effort: value ?? "" }))
                        }
                        isDisabled={mutation.isPending}
                        data-delegate-effort=""
                      />
                    )}
                  </VStack>
                )}
                <Selector
                  label="Agent"
                  isOptional
                  placeholder="Use the Runner's default Agent"
                  options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                  value={agentId}
                  onChange={(value) =>
                    setPreference((current) => ({ ...current, agentId: value ?? "" }))
                  }
                  hasClear
                  isDisabled={mutation.isPending}
                />
                <TextArea
                  label="Prompt / Instructions"
                  isOptional
                  description="Optional instructions for this Dispatch only, visible to everyone who can read the project. Never saved for the next issue."
                  placeholder="Tell the Agent how to approach this issue…"
                  value={prompt}
                  onChange={setPrompt}
                  rows={5}
                  maxLength={MAX_DISPATCH_PROMPT_LENGTH}
                  htmlMaxLength={MAX_DISPATCH_PROMPT_LENGTH}
                  {...(promptTooLong
                    ? {
                        status: {
                          type: "error" as const,
                          message: `Use at most ${MAX_DISPATCH_PROMPT_LENGTH.toLocaleString()} characters.`,
                        },
                      }
                    : {})}
                  isDisabled={mutation.isPending}
                />
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  type="button"
                  variant="secondary"
                  label="Cancel"
                  isDisabled={mutation.isPending}
                  onClick={closeDialog}
                />
                <Button
                  type="button"
                  variant="primary"
                  label="Delegate to Runner"
                  icon={<Icon icon={Send} />}
                  isDisabled={runnerId === "" || promptTooLong || mutation.isPending}
                  isLoading={mutation.isPending}
                  data-delegate-dispatch=""
                  onClick={submit}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </Stack>
  );
}

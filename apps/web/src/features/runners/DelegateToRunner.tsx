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
import {
  MAX_DISPATCH_PROMPT_LENGTH,
  type CatalogProbeRequest,
  type Dispatch,
} from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { useRef, useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessBadge } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { formatCompactDateTime } from "../../lib/time.ts";
import { createDispatch, probeRunnerCatalog } from "./commands.ts";
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

/** The enqueue response is not the probe result: keep the pending UI up until
 * the Runner publishes a catalog (picked up by the 4s fleet poll) or this cap. */
const PROBE_GRACE_MS = 8_000;

type ProbeInput = {
  runnerId: string;
  request: CatalogProbeRequest;
  key: string;
  baselineProbedAt: string;
  generation: number;
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
  const [isOpen, setIsOpen] = useState(false);
  // While the dialog is open Query keeps the fleet fresh, so a catalog the
  // Runner publishes after a probe appears without a React effect or a click.
  const { data: fleet } = useQuery(workspaceRunnersQuery(workspaceId, isOpen));
  const { data: dispatchList } = useQuery(issueDispatchesQuery(issueId));
  const [preference, setPreference] = useState<DelegatePreference>({ runnerId: "", agentId: "" });
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const [probeState, setProbeState] = useState<Omit<ProbeInput, "runnerId" | "request">>();
  const [probeExpired, setProbeExpired] = useState(false);
  const [probeFailed, setProbeFailed] = useState(false);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const probeGeneration = useRef(0);

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
  // A model with no reasoning options is published as `known` + empty efforts,
  // so the Effort control is hidden and selecting it does not re-probe forever.
  const knownWithoutEfforts =
    selectedModel !== undefined &&
    selectedModel.reasoningDiscovery === "known" &&
    efforts.length === 0;
  const probingKeyForModel = `${runnerId}\u0000${harness}\u0000${model}`;
  // The catalog the Runner publishes advances `probedAt`; derive the end of a
  // probe from that live query data instead of clearing on the enqueue reply.
  const catalogProbedAt = selectedRunner?.harnessCatalog.probedAt;
  const catalogUpdated =
    probeState !== undefined &&
    catalogProbedAt !== undefined &&
    Date.parse(catalogProbedAt) > Date.parse(probeState.baselineProbedAt);
  const probeActive = probeState !== undefined && !probeExpired && !probeFailed && !catalogUpdated;
  const probingEffort = probeActive && probeState.key === probingKeyForModel;
  const probingCatalog = probeActive && probeState.key === "catalog";
  const probeMessage =
    probeState !== undefined && !catalogUpdated && (probeFailed || probeExpired)
      ? probeState.key === "catalog"
        ? "Catalog refresh did not finish; you can still delegate."
        : "Reasoning levels could not be discovered; you can still delegate."
      : undefined;
  const effortDescription = probingEffort
    ? "Discovering reasoning levels…"
    : efforts.length === 0
      ? "Reasoning levels not discovered yet"
      : undefined;
  const trimmedPrompt = prompt.trim();
  const promptTooLong = trimmedPrompt.length > MAX_DISPATCH_PROMPT_LENGTH;

  const clearProbe = () => {
    if (probeTimer.current !== undefined) clearTimeout(probeTimer.current);
    probeTimer.current = undefined;
    setProbeState(undefined);
    setProbeExpired(false);
    setProbeFailed(false);
  };

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
    clearProbe();
    setIsOpen(true);
  };

  const closeDialog = () => {
    setIsOpen(false);
    setPrompt("");
    setError(undefined);
    clearProbe();
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

  // Probing is deliberately independent of the dispatch mutation: the Delegate
  // button stays clickable while the Runner discovers a model's effort levels.
  const probeMutation = useMutation({
    mutationFn: (input: ProbeInput) => probeRunnerCatalog(input.runnerId, input.request),
    onMutate: (input) => {
      if (probeTimer.current !== undefined) clearTimeout(probeTimer.current);
      probeTimer.current = undefined;
      probeGeneration.current = input.generation;
      setProbeState({
        key: input.key,
        baselineProbedAt: input.baselineProbedAt,
        generation: input.generation,
      });
      setProbeExpired(false);
      setProbeFailed(false);
    },
    onSettled: async (_data, _error, input) => {
      // An older enqueue settling must not cap a newer probe's indicator.
      if (input.generation !== probeGeneration.current) return;
      probeTimer.current = setTimeout(() => setProbeExpired(true), PROBE_GRACE_MS);
      await queryClient.invalidateQueries({ queryKey: workspaceRunnersQueryKey(workspaceId) });
    },
    onError: (_error, input) => {
      if (input.generation === probeGeneration.current) setProbeFailed(true);
    },
  });

  const startProbe = (request: CatalogProbeRequest, key: string) => {
    probeGeneration.current += 1;
    probeMutation.mutate({
      runnerId,
      request,
      key,
      baselineProbedAt: selectedRunner?.harnessCatalog.probedAt ?? "",
      generation: probeGeneration.current,
    });
  };

  const submit = () => {
    if (runnerId === "" || promptTooLong) return;
    mutation.mutate();
  };

  const selectModel = (value: string | null) => {
    const next = value ?? "";
    // Clear the stale Effort before anything async happens.
    setPreference((current) => ({ ...current, model: next, effort: "" }));
    const candidate = models.find((item) => item.id === next);
    if (candidate?.reasoningDiscovery === "unknown" && runnerId !== "" && harness !== "") {
      startProbe(
        { kind: "model", harness, model: next },
        `${runnerId}\u0000${harness}\u0000${next}`,
      );
    }
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
          isDisabled={owned.length === 0}
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
              <VStack gap={4}>
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
                {/* A Runner with an empty, never-probed catalog is exactly the
                    case that needs a manual refresh, so this action never sits
                    behind the harness list. */}
                {runnerId !== "" && (
                  <HStack gap={2} hAlign="end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      label="Refresh catalog"
                      icon={<Icon icon={RefreshCw} />}
                      isLoading={probingCatalog}
                      isDisabled={probingCatalog}
                      data-delegate-refresh-catalog=""
                      onClick={() => startProbe({ kind: "catalog" }, "catalog")}
                    />
                  </HStack>
                )}
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
                        onChange={selectModel}
                        isDisabled={mutation.isPending}
                        data-delegate-model=""
                      />
                    )}
                    {model !== "" && !knownWithoutEfforts && (
                      <Selector
                        label="Effort"
                        placeholder="Choose a reasoning effort"
                        options={efforts.map((value) => ({ value, label: value }))}
                        value={effort === "" ? null : effort}
                        hasClear
                        isOptional
                        {...(effortDescription === undefined
                          ? {}
                          : { description: effortDescription })}
                        isLoading={probingEffort}
                        onChange={(value) =>
                          setPreference((current) => ({ ...current, effort: value ?? "" }))
                        }
                        isDisabled={mutation.isPending}
                        data-delegate-effort=""
                      />
                    )}
                  </VStack>
                )}
                {probeMessage !== undefined && (
                  <Text type="supporting" color="secondary">
                    {probeMessage}
                  </Text>
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
                  description="Optional instructions for this Dispatch only. Never saved for the next issue."
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

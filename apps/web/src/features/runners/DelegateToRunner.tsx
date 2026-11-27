import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useToast } from "@astryxdesign/core/Toast";
import {
  MAX_DISPATCH_PROMPT_LENGTH,
  type CatalogProbeRequest,
  type Dispatch,
  type HarnessCatalogEntry,
} from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Send } from "lucide-react";
import { useRef, useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessBadge, HarnessLogo, resolveHarnessKind } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { formatCompactDateTime } from "../../lib/time.ts";
import { createDispatch, probeRunnerCatalog } from "./commands.ts";
import { harnessDisplayName } from "./dispatchOptions.ts";
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

/**
 * The enqueue response is not the probe result: keep the pending UI up until
 * the Runner publishes a catalog (picked up by the 4s fleet poll) or this cap.
 */
const PROBE_GRACE_MS = 8_000;

type ProbeInput = {
  runnerId: string;
  request: CatalogProbeRequest;
  key: string;
  baselineProbedAt: string;
  generation: number;
};

/**
 * Last-used execution choices per project (issue #241): the remembered Runner,
 * Harness, model, effort and Agent. Every field is optional so an older saved
 * value cannot break the modal.
 */
interface DelegateMemory {
  runnerId: string;
  harness: string;
  model: string;
  effort: string;
  agentId: string;
}

const memoryKey = (projectId: string) => `orrery.delegate.${projectId}`;

/** Last-used (runnerId, harness, model, effort, agentId); localStorage may be unavailable. */
function readDelegateMemory(projectId: string): DelegateMemory | undefined {
  try {
    const raw = window.localStorage.getItem(memoryKey(projectId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const runnerId = Reflect.get(parsed, "runnerId");
    if (typeof runnerId !== "string" || runnerId === "") return undefined;
    const field = (key: string): string => {
      const value = Reflect.get(parsed, key);
      return typeof value === "string" ? value : "";
    };
    return {
      runnerId,
      harness: field("harness"),
      model: field("model"),
      effort: field("effort"),
      agentId: field("agentId"),
    };
  } catch {
    return undefined;
  }
}

function writeDelegateMemory(projectId: string, memory: DelegateMemory): void {
  try {
    window.localStorage.setItem(memoryKey(projectId), JSON.stringify(memory));
  } catch {
    // A private window or full quota must never block delegating.
  }
}

/** The model a fresh Harness selection starts on: its default, else the first. */
function defaultModelId(harness: HarnessCatalogEntry | undefined): string {
  if (harness === undefined) return "";
  if (
    harness.defaultModel !== null &&
    harness.models.some((model) => model.id === harness.defaultModel)
  ) {
    return harness.defaultModel;
  }
  return harness.models[0]?.id ?? "";
}

/** Harness logos in Selector options; an unknown id falls back to its label. */
function harnessIcon(harnessId: string) {
  const kind = resolveHarnessKind(harnessId);
  return kind === null ? undefined : <HarnessLogo kind={kind} size={14} />;
}

const effortLabel = (level: string): string =>
  level === "" ? level : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

/** Manual, owner-only issue dispatch from the issue detail page. */
export function DelegateToRunner({
  issueId,
  workspaceId,
  projectId,
  agents,
  canDelegate = true,
}: {
  issueId: string;
  workspaceId: string;
  projectId: string;
  agents: readonly DelegatableAgent[];
  /** Readers see Recent dispatches but never the owner-only delegation form. */
  canDelegate?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  // Project readers see Recent dispatches but never the owner-only fleet.
  // While the dialog is open Query keeps the fleet fresh (4s poll), so a
  // catalog the Runner publishes after a probe appears without a React effect.
  const { data: fleet } = useQuery({
    ...workspaceRunnersQuery(workspaceId, isOpen),
    enabled: canDelegate,
  });
  const { data: dispatchList } = useQuery(issueDispatchesQuery(issueId));
  // Explicit user overrides. Undefined means "no choice yet", so a cold open
  // never clears a remembered choice while the fleet query is still loading.
  const [runnerOverride, setRunnerOverride] = useState<string | undefined>(undefined);
  const [harnessOverride, setHarnessOverride] = useState<string | undefined>(undefined);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [effortOverride, setEffortOverride] = useState<string | undefined>(undefined);
  const [agentOverride, setAgentOverride] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const [probeState, setProbeState] = useState<Omit<ProbeInput, "runnerId" | "request">>();
  const [probeExpired, setProbeExpired] = useState(false);
  const [probeFailed, setProbeFailed] = useState(false);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const probeGeneration = useRef(0);

  const allRunners = (fleet?.hosts ?? []).flatMap((host) => host.runners);
  const owned = (fleet?.hosts ?? [])
    .filter((host) => host.canRevoke)
    .flatMap((host) => host.runners)
    .filter(
      (runner) =>
        runner.projectId === projectId &&
        (runner.presence === "online" || runner.presence === "busy") &&
        runner.revokedAt === null,
    );

  // Validate remembered choices against live data on every render. Until the
  // fleet resolves there is nothing to validate against, so remembered values
  // survive a cold open and are applied as soon as data is present.
  const memory = readDelegateMemory(projectId);
  const rememberedRunner =
    fleet === undefined || memory === undefined
      ? undefined
      : owned.find((runner) => runner.id === memory.runnerId);
  const runnerId = runnerOverride ?? rememberedRunner?.id ?? "";
  const selectedRunner = owned.find((runner) => runner.id === runnerId);
  const harnessCatalog = selectedRunner?.harnessCatalog?.harnesses ?? [];
  const memoryApplies =
    runnerOverride === undefined && rememberedRunner !== undefined && memory !== undefined;
  const matchedMemoryHarness = memoryApplies
    ? harnessCatalog.find((entry) => entry.id === memory.harness)
    : undefined;
  const rawHarnessId =
    harnessOverride ??
    (memoryApplies ? (matchedMemoryHarness?.id ?? harnessCatalog[0]?.id ?? "") : "");
  const selectedHarness = harnessCatalog.find((entry) => entry.id === rawHarnessId);
  // Validate manual harnessOverride against the live catalog so a background
  // refetch that drops the chosen Harness never submits a vanished id.
  const harnessId = selectedHarness?.id ?? "";
  // Only a remembered Harness that still exists may restore the remembered
  // model; a fallback Harness always starts on its own default model.
  const matchedMemoryModel =
    harnessOverride === undefined && matchedMemoryHarness !== undefined && memory !== undefined
      ? matchedMemoryHarness.models.find((entry) => entry.id === memory.model)
      : undefined;
  const rawModelId =
    modelOverride ??
    (harnessOverride === undefined && memoryApplies
      ? (matchedMemoryModel?.id ?? defaultModelId(selectedHarness))
      : "");
  const selectedModel = selectedHarness?.models.find((entry) => entry.id === rawModelId);
  const modelId = selectedModel?.id ?? "";
  const supportedEfforts = selectedModel?.supportedEfforts ?? [];
  // A model with no reasoning options is published as `known` + empty efforts,
  // so the Effort control is hidden and selecting it does not re-probe forever.
  const knownWithoutEfforts =
    selectedModel !== undefined &&
    selectedModel.reasoningDiscovery === "known" &&
    supportedEfforts.length === 0;
  const probingKeyForModel = `${runnerId}\u0000${harnessId}\u0000${modelId}`;
  const probingKeyForCatalog = `catalog\u0000${runnerId}`;
  // Catalog refreshes finish when the runner publishes a newer `probedAt`.
  // Model probes finish when the *selected* model itself becomes `known`, so an
  // earlier model's probe completing first never stops the active spinner early.
  const catalogProbedAt = selectedRunner?.harnessCatalog?.probedAt;
  const catalogRefreshed =
    probeState !== undefined &&
    catalogProbedAt !== undefined &&
    (probeState.baselineProbedAt === "" ||
      Date.parse(catalogProbedAt) > Date.parse(probeState.baselineProbedAt));
  const probeCompleted =
    probeState !== undefined &&
    (probeState.key === probingKeyForCatalog
      ? catalogRefreshed
      : probeState.key === probingKeyForModel && selectedModel?.reasoningDiscovery === "known");
  const probeActive = probeState !== undefined && !probeExpired && !probeFailed && !probeCompleted;
  const probingEffort = probeActive && probeState.key === probingKeyForModel;
  const probingCatalog = probeActive && probeState.key === probingKeyForCatalog;
  const probeMatchesSelection =
    probeState !== undefined &&
    (probeState.key === probingKeyForCatalog || probeState.key === probingKeyForModel);
  const probeMessage =
    probeMatchesSelection && !probeCompleted && (probeFailed || probeExpired)
      ? probeState.key === probingKeyForCatalog
        ? "Catalog refresh did not finish; you can still delegate."
        : "Reasoning levels could not be discovered; you can still delegate."
      : undefined;
  const effortDescription = probingEffort
    ? "Discovering reasoning levels…"
    : supportedEfforts.length === 0
      ? "Reasoning levels not discovered yet"
      : undefined;
  // Effort is only restored when both the Harness and the Model matched;
  // a stale effort from a previous model is never sent with another.
  const rememberedEffort =
    harnessOverride === undefined &&
    modelOverride === undefined &&
    matchedMemoryHarness !== undefined &&
    matchedMemoryModel !== undefined &&
    memory !== undefined &&
    supportedEfforts.includes(memory.effort)
      ? memory.effort
      : "";
  const rawEffort = effortOverride ?? rememberedEffort;
  const effectiveEffort = supportedEfforts.includes(rawEffort) ? rawEffort : "";
  const agentId =
    agentOverride ??
    (rememberedRunner !== undefined &&
    memory !== undefined &&
    agents.some((agent) => agent.id === memory.agentId)
      ? memory.agentId
      : "");

  function clearProbe() {
    if (probeTimer.current !== undefined) clearTimeout(probeTimer.current);
    probeTimer.current = undefined;
    probeGeneration.current += 1;
    setProbeState(undefined);
    setProbeExpired(false);
    setProbeFailed(false);
  }

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

  function startProbe(request: CatalogProbeRequest, key: string, targetRunner = selectedRunner) {
    const targetId = targetRunner?.id ?? runnerId;
    if (targetId === "") return;
    probeGeneration.current += 1;
    probeMutation.mutate({
      runnerId: targetId,
      request,
      key,
      baselineProbedAt: targetRunner?.harnessCatalog?.probedAt ?? "",
      generation: probeGeneration.current,
    });
  }

  function probeIfUnknown(
    targetRunner: (typeof owned)[number] | undefined,
    entry: HarnessCatalogEntry | undefined,
    nextModel: string,
  ) {
    if (targetRunner === undefined || entry === undefined || nextModel === "") return;
    const candidate = entry.models.find((model) => model.id === nextModel);
    if (candidate?.reasoningDiscovery !== "unknown") return;
    startProbe(
      { kind: "model", harness: entry.id, model: nextModel },
      `${targetRunner.id}\u0000${entry.id}\u0000${nextModel}`,
      targetRunner,
    );
  }

  function chooseRunner(value: string | null) {
    const id = value ?? "";
    clearProbe();
    setRunnerOverride(id);
    const runner = owned.find((item) => item.id === id);
    const next = runner?.harnessCatalog?.harnesses[0];
    const nextModel = defaultModelId(next);
    setHarnessOverride(next?.id ?? "");
    setModelOverride(nextModel);
    setEffortOverride("");
    probeIfUnknown(runner, next, nextModel);
  }

  function chooseHarness(value: string | null) {
    const id = value ?? "";
    clearProbe();
    setHarnessOverride(id);
    const entry = harnessCatalog.find((item) => item.id === id);
    const nextModel = defaultModelId(entry);
    setModelOverride(nextModel);
    setEffortOverride("");
    probeIfUnknown(selectedRunner, entry, nextModel);
  }

  function chooseModel(value: string | null) {
    const next = value ?? "";
    clearProbe();
    setModelOverride(next);
    // Never carry the previous model's effort onto this one.
    setEffortOverride("");
    probeIfUnknown(selectedRunner, selectedHarness, next);
  }

  function closeDialog() {
    setIsOpen(false);
    setPrompt("");
    setError(undefined);
    clearProbe();
  }

  function openDialog() {
    // Prompt always starts blank; selections come from the derived memory
    // above, so a click before the fleet settles cannot reset them.
    setRunnerOverride(undefined);
    setHarnessOverride(undefined);
    setModelOverride(undefined);
    setEffortOverride(undefined);
    setAgentOverride(undefined);
    setPrompt("");
    setError(undefined);
    clearProbe();
    setIsOpen(true);
  }

  const mutation = useMutation({
    mutationFn: () =>
      createDispatch(issueId, {
        runnerId,
        ...(agentId === "" ? {} : { agentId }),
        ...(harnessId === "" ? {} : { harness: harnessId }),
        ...(modelId === "" ? {} : { model: modelId }),
        ...(effectiveEffort === "" ? {} : { effort: effectiveEffort }),
        ...(prompt.trim() === "" ? {} : { prompt: prompt.trim() }),
      }),
    onSuccess: async (dispatch) => {
      setError(undefined);
      writeDelegateMemory(projectId, {
        runnerId,
        harness: harnessId,
        model: modelId,
        effort: effectiveEffort,
        agentId,
      });
      toast({
        body: `Delegated to ${owned.find((runner) => runner.id === dispatch.runnerId)?.displayName ?? "Runner"}.`,
      });
      closeDialog();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: issueDispatchesQuery(issueId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceRunnersQueryKey(workspaceId) }),
      ]);
    },
    onError: (cause: unknown) => {
      setError(
        cause instanceof ApiProblemError && cause.code === "issue_not_claimable"
          ? "This issue is not claimable by that Agent (check its assignee and status)."
          : cause instanceof ApiProblemError && cause.code === "harness_unavailable"
            ? "That Harness is no longer available on this Runner. Reopen the dialog to refresh its catalog."
            : cause instanceof ApiProblemError && cause.code === "validation_failed"
              ? "The prompt is too long (16,000 characters max)."
              : cause instanceof Error
                ? cause.message
                : "The issue could not be delegated.",
      );
    },
  });

  // Code points, matching Postgres char_length and the contract refinement.
  const overLimit = Array.from(prompt.trim()).length > MAX_DISPATCH_PROMPT_LENGTH;

  return (
    <Stack gap={2}>
      {canDelegate && (
        <>
          <Stack direction="horizontal" gap={2} justify="between" vAlign="center" wrap="wrap">
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
          </Stack>
          <Text type="supporting">
            Send this issue to one of your online Runners for this project. The issue assignee is
            not changed.
          </Text>
        </>
      )}
      {canDelegate && (
        <Dialog
          isOpen={isOpen}
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          width={480}
          purpose="form"
        >
          <Layout
            header={
              <DialogHeader
                title="Delegate to Runner"
                hasDivider
                onOpenChange={(open) => {
                  if (!open) closeDialog();
                }}
              />
            }
            content={
              <LayoutContent isScrollable>
                <Stack gap={3} data-delegate-dialog="">
                  {error !== undefined && (
                    <Banner
                      status="error"
                      title="Delegation failed"
                      description={error}
                      collapsible={false}
                    />
                  )}
                  {/* Keep Refresh catalog beside the Runner field so a Runner
                      with an empty, never-probed catalog is still refreshable
                      without pushing Agent away. */}
                  <Stack direction="horizontal" gap={2} vAlign="end">
                    <StackItem size="fill">
                      <Selector
                        label="Runner"
                        width="100%"
                        placement="below"
                        placeholder={owned.length === 0 ? "No online Runners" : "Choose a Runner"}
                        options={owned.map((runner) => ({
                          value: runner.id,
                          label: `${runner.displayName} · ${runner.presence}`,
                        }))}
                        value={runnerId}
                        onChange={chooseRunner}
                        isDisabled={owned.length === 0 || mutation.isPending}
                      />
                    </StackItem>
                    {runnerId !== "" && (
                      <IconButton
                        type="button"
                        variant="secondary"
                        label="Refresh catalog"
                        tooltip="Refresh catalog"
                        icon={<Icon icon={RefreshCw} />}
                        isLoading={probingCatalog}
                        isDisabled={probingCatalog}
                        data-delegate-refresh-catalog=""
                        onClick={() => startProbe({ kind: "catalog" }, probingKeyForCatalog)}
                      />
                    )}
                  </Stack>
                  <Selector
                    label="Agent"
                    isOptional
                    placement="below"
                    placeholder="Use the Runner's default Agent"
                    options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                    value={agentId}
                    onChange={(value) => setAgentOverride(value ?? "")}
                    hasClear
                    isDisabled={mutation.isPending}
                  />
                  <Selector
                    label="Harness"
                    isOptional
                    placement="below"
                    placeholder={
                      selectedRunner === undefined
                        ? "Choose a Runner first"
                        : harnessCatalog.length === 0
                          ? "Use the Runner's default Harness"
                          : "Choose a Harness"
                    }
                    options={harnessCatalog.map((entry) => ({
                      value: entry.id,
                      label: entry.displayName,
                      icon: harnessIcon(entry.id),
                    }))}
                    value={harnessId}
                    onChange={chooseHarness}
                    hasClear
                    isDisabled={selectedRunner === undefined || mutation.isPending}
                    data-delegate-harness=""
                  />
                  <Selector
                    label="Model"
                    isOptional
                    placement="below"
                    placeholder={
                      selectedHarness === undefined
                        ? "Choose a Harness first"
                        : selectedHarness.models.length === 0
                          ? "Use the Harness default model"
                          : "Choose a model"
                    }
                    options={(selectedHarness?.models ?? []).map((model) => ({
                      value: model.id,
                      label: model.label ?? model.id,
                    }))}
                    value={modelId}
                    onChange={chooseModel}
                    hasClear
                    isDisabled={selectedHarness === undefined || mutation.isPending}
                    data-delegate-model=""
                  />
                  {modelId !== "" && !knownWithoutEfforts && (
                    <Selector
                      label="Effort"
                      isOptional
                      placement="below"
                      placeholder="Use the model default effort"
                      options={supportedEfforts.map((level) => ({
                        value: level,
                        label: effortLabel(level),
                      }))}
                      value={effectiveEffort}
                      onChange={(value) => setEffortOverride(value ?? "")}
                      hasClear
                      {...(effortDescription === undefined
                        ? {}
                        : { description: effortDescription })}
                      isLoading={probingEffort}
                      isDisabled={mutation.isPending}
                      data-delegate-effort=""
                    />
                  )}
                  {probeMessage !== undefined && (
                    <Text type="supporting" color="secondary">
                      {probeMessage}
                    </Text>
                  )}
                  <TextArea
                    label="Prompt / Instructions"
                    isOptional
                    value={prompt}
                    onChange={setPrompt}
                    rows={5}
                    placeholder="Optional steering for how the Agent behaves on this Dispatch…"
                    description="Appended after the Runner's preamble; visible to everyone who can read this project."
                    {...(overLimit
                      ? { status: { type: "error", message: "Over the 16,000-character limit." } }
                      : {})}
                    isDisabled={mutation.isPending}
                  />
                </Stack>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <Stack direction="horizontal" gap={2} justify="end">
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
                    isDisabled={runnerId === "" || overLimit || mutation.isPending}
                    isLoading={mutation.isPending}
                    data-delegate-dispatch=""
                    onClick={() => mutation.mutate()}
                  />
                </Stack>
              </LayoutFooter>
            }
          />
        </Dialog>
      )}
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
              {(dispatch.harness !== null ||
                dispatch.model !== null ||
                dispatch.effort !== null) && (
                <Stack
                  direction="horizontal"
                  gap={2}
                  vAlign="center"
                  wrap="wrap"
                  data-dispatch-options=""
                >
                  <HarnessBadge
                    harness={harnessDisplayName(
                      allRunners.find((runner) => runner.id === dispatch.runnerId),
                      dispatch.harness,
                    )}
                    empty="Runner default"
                  />
                  {dispatch.model !== null && (
                    <Text type="supporting" color="secondary">
                      {dispatch.model}
                    </Text>
                  )}
                  {dispatch.effort !== null && (
                    <Text type="supporting" color="secondary">
                      {dispatch.effort} effort
                    </Text>
                  )}
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
    </Stack>
  );
}

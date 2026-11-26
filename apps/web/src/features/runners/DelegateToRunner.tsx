import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useToast } from "@astryxdesign/core/Toast";
import {
  MAX_DISPATCH_PROMPT_LENGTH,
  type Dispatch,
  type HarnessCatalogEntry,
} from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessBadge, HarnessLogo, resolveHarnessKind } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { formatCompactDateTime } from "../../lib/time.ts";
import { createDispatch } from "./commands.ts";
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
  // Project readers see Recent dispatches but never the owner-only fleet.
  const { data: fleet } = useQuery({
    ...workspaceRunnersQuery(workspaceId),
    enabled: canDelegate,
  });
  const { data: dispatchList } = useQuery(issueDispatchesQuery(issueId));
  const [isOpen, setIsOpen] = useState(false);
  // Explicit user overrides. Undefined means "no choice yet", so a cold open
  // never clears a remembered choice while the fleet query is still loading.
  const [runnerOverride, setRunnerOverride] = useState<string | undefined>(undefined);
  const [harnessOverride, setHarnessOverride] = useState<string | undefined>(undefined);
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [effortOverride, setEffortOverride] = useState<string | undefined>(undefined);
  const [agentOverride, setAgentOverride] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();

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
  const harnessId =
    harnessOverride ??
    (memoryApplies ? (matchedMemoryHarness?.id ?? harnessCatalog[0]?.id ?? "") : "");
  const selectedHarness = harnessCatalog.find((entry) => entry.id === harnessId);
  // Only a remembered Harness that still exists may restore the remembered
  // model; a fallback Harness always starts on its own default model.
  const matchedMemoryModel =
    harnessOverride === undefined && matchedMemoryHarness !== undefined && memory !== undefined
      ? matchedMemoryHarness.models.find((entry) => entry.id === memory.model)
      : undefined;
  const modelId =
    modelOverride ??
    (harnessOverride === undefined && memoryApplies
      ? (matchedMemoryModel?.id ?? defaultModelId(selectedHarness))
      : "");
  const selectedModel = selectedHarness?.models.find((entry) => entry.id === modelId);
  const supportedEfforts = selectedModel?.supportedEfforts ?? [];
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

  function chooseRunner(value: string | null) {
    const id = value ?? "";
    setRunnerOverride(id);
    const next = owned.find((runner) => runner.id === id)?.harnessCatalog?.harnesses[0];
    setHarnessOverride(next?.id ?? "");
    setModelOverride(defaultModelId(next));
    setEffortOverride("");
  }

  function chooseHarness(value: string | null) {
    const id = value ?? "";
    setHarnessOverride(id);
    setModelOverride(defaultModelId(harnessCatalog.find((entry) => entry.id === id)));
    setEffortOverride("");
  }

  function chooseModel(value: string | null) {
    setModelOverride(value ?? "");
    // Never carry the previous model's effort onto this one.
    setEffortOverride("");
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
            if (!open) setIsOpen(false);
          }}
          width={480}
          purpose="form"
        >
          <Layout
            header={
              <DialogHeader
                title="Delegate to Runner"
                subtitle="Choose a Runner, an optional Agent and optional instructions for the Dispatch."
                onOpenChange={(open) => setIsOpen(open)}
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
                  <Selector
                    label="Runner"
                    placeholder={owned.length === 0 ? "No online Runners" : "Choose a Runner"}
                    options={owned.map((runner) => ({
                      value: runner.id,
                      label: `${runner.displayName} · ${runner.presence}`,
                    }))}
                    value={runnerId}
                    onChange={chooseRunner}
                    isDisabled={owned.length === 0 || mutation.isPending}
                  />
                  <Selector
                    label="Agent"
                    isOptional
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
                  {supportedEfforts.length > 0 && (
                    <Selector
                      label="Effort"
                      isOptional
                      placeholder="Use the model default effort"
                      options={supportedEfforts.map((level) => ({
                        value: level,
                        label: effortLabel(level),
                      }))}
                      value={effectiveEffort}
                      onChange={(value) => setEffortOverride(value ?? "")}
                      hasClear
                      isDisabled={mutation.isPending}
                      data-delegate-effort=""
                    />
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
                    onClick={() => setIsOpen(false)}
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

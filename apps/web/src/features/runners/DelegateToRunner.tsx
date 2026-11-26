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
import type { Dispatch, HarnessCatalogEntry } from "@orrery/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { HarnessBadge, HarnessLogo, resolveHarnessKind } from "../../lib/harness.tsx";
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

/** The maximum steering prompt a Dispatch may carry (shared contract limit). */
const PROMPT_LIMIT = 16000;

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
  const [runnerId, setRunnerId] = useState("");
  const [harnessId, setHarnessId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [agentId, setAgentId] = useState("");
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

  // Everything below is derived during render, so changing the Runner or
  // Harness immediately drops choices the new catalog does not offer.
  const selectedRunner = owned.find((runner) => runner.id === runnerId);
  const harnessCatalog = selectedRunner?.harnessCatalog?.harnesses ?? [];
  const selectedHarness = harnessCatalog.find((entry) => entry.id === harnessId);
  const selectedModel = selectedHarness?.models.find((entry) => entry.id === modelId);
  const effortLevels = selectedModel?.effortLevels ?? [];
  // A stale effort from a previously selected model is never sent with another.
  const effectiveEffort = effortLevels.includes(effort) ? effort : "";

  function chooseRunner(value: string | null) {
    const id = value ?? "";
    setRunnerId(id);
    const next = owned.find((runner) => runner.id === id)?.harnessCatalog?.harnesses[0];
    setHarnessId(next?.id ?? "");
    setModelId(defaultModelId(next));
    setEffort("");
  }

  function chooseHarness(value: string | null) {
    const id = value ?? "";
    setHarnessId(id);
    setModelId(defaultModelId(harnessCatalog.find((entry) => entry.id === id)));
    setEffort("");
  }

  function chooseModel(value: string | null) {
    setModelId(value ?? "");
    // Never carry the previous model's effort onto this one.
    setEffort("");
  }

  function openDialog() {
    // Remembered selections only apply while that Runner is still owned and
    // online for this project; an unavailable Runner or Harness falls back
    // cleanly. The prompt always starts blank.
    const memory = readDelegateMemory(projectId);
    const rememberedRunner =
      memory === undefined ? undefined : owned.find((runner) => runner.id === memory.runnerId);
    const catalog = rememberedRunner?.harnessCatalog?.harnesses ?? [];
    const rememberedHarness = catalog.find((entry) => entry.id === memory?.harness) ?? catalog[0];
    const rememberedModel =
      rememberedHarness?.models.find((entry) => entry.id === memory?.model) ??
      rememberedHarness?.models.find((entry) => entry.id === rememberedHarness.defaultModel) ??
      rememberedHarness?.models[0];
    const rememberedEffort =
      rememberedModel !== undefined &&
      memory !== undefined &&
      rememberedModel.effortLevels.includes(memory.effort)
        ? memory.effort
        : "";
    setRunnerId(rememberedRunner?.id ?? "");
    setHarnessId(rememberedHarness?.id ?? "");
    setModelId(rememberedModel?.id ?? "");
    setEffort(rememberedEffort);
    setAgentId(
      rememberedRunner !== undefined &&
        memory !== undefined &&
        agents.some((agent) => agent.id === memory.agentId)
        ? memory.agentId
        : "",
    );
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

  const overLimit = prompt.length > PROMPT_LIMIT;

  return (
    <Stack gap={2}>
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
        Send this issue to one of your online Runners for this project. The issue assignee is not
        changed.
      </Text>
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
                  onChange={(value) => setAgentId(value ?? "")}
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
                {effortLevels.length > 0 && (
                  <Selector
                    label="Effort"
                    isOptional
                    placeholder="Use the model default effort"
                    options={effortLevels.map((level) => ({
                      value: level,
                      label: effortLabel(level),
                    }))}
                    value={effectiveEffort}
                    onChange={(value) => setEffort(value ?? "")}
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
                  maxLength={PROMPT_LIMIT}
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
                    harness={
                      owned
                        .find((runner) => runner.id === dispatch.runnerId)
                        ?.harnessCatalog?.harnesses.find((entry) => entry.id === dispatch.harness)
                        ?.displayName ?? dispatch.harness
                    }
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

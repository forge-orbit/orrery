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
import { MAX_DISPATCH_PROMPT_LENGTH, type Dispatch } from "@orrery/contract";
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

interface DelegateMemory {
  runnerId: string;
  agentId: string;
}

const memoryKey = (projectId: string) => `orrery.delegate.${projectId}`;

/** Last-used (runnerId, agentId) per project, best-effort; localStorage may be unavailable. */
function readDelegateMemory(projectId: string): DelegateMemory | undefined {
  try {
    const raw = window.localStorage.getItem(memoryKey(projectId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const runnerId = Reflect.get(parsed, "runnerId");
    const agentId = Reflect.get(parsed, "agentId");
    if (typeof runnerId !== "string" || runnerId === "") return undefined;
    return { runnerId, agentId: typeof agentId === "string" ? agentId : "" };
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
  const { data: fleet } = useQuery(workspaceRunnersQuery(workspaceId));
  const { data: dispatchList } = useQuery(issueDispatchesQuery(issueId));
  const [isOpen, setIsOpen] = useState(false);
  const [runnerId, setRunnerId] = useState("");
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

  function openDialog() {
    // Remembered selections only apply while that Runner is still owned and
    // online for this project; the prompt always starts blank.
    const memory = readDelegateMemory(projectId);
    const rememberedRunner =
      memory === undefined ? undefined : owned.find((runner) => runner.id === memory.runnerId);
    setRunnerId(rememberedRunner?.id ?? "");
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
        ...(prompt.trim() === "" ? {} : { prompt: prompt.trim() }),
      }),
    onSuccess: async (dispatch) => {
      setError(undefined);
      writeDelegateMemory(projectId, { runnerId, agentId });
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
                  <TextArea
                    label="Prompt / Instructions"
                    isOptional
                    value={prompt}
                    onChange={setPrompt}
                    rows={5}
                    maxLength={MAX_DISPATCH_PROMPT_LENGTH}
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

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { RunChild, Runner, StreamChunk, RunnerHost } from "@orrery/contract";
import { useQuery } from "@tanstack/react-query";
import {
  categorizeChunk,
  chunkDetail,
  chunkDiff,
  chunkPath,
  chunkStatus,
  commandSummary,
  diagnosticView,
  formatCountdown,
  leaseSeconds,
  type ChangedFile,
  type DiagnosticEntry,
  type PlanItem,
} from "./stream.ts";
import { studioNowQuery } from "./queries.ts";
import { formatDateTime, relativeTime } from "../../lib/time.ts";

/** Ticks only while a lease countdown is actually shown. */
export function LeaseCountdown({
  leaseExpiresAt,
  enabled,
}: {
  leaseExpiresAt: string;
  enabled: boolean;
}) {
  const { data: now } = useQuery({ ...studioNowQuery(), enabled });
  if (!enabled || now === undefined) return null;
  return (
    <Token
      label={`Lease ${formatCountdown(leaseSeconds(leaseExpiresAt, now))}`}
      size="sm"
      color="orange"
      data-studio-lease=""
    />
  );
}

/** One prominent banner per active diagnostic kind in the Studio. */
export function DiagnosticBanners({ entries }: { entries: readonly DiagnosticEntry[] }) {
  const hasCountdown = entries.some(
    ({ diagnostic }) =>
      diagnostic.kind === "usage_limit" || diagnostic.kind === "provider_overload",
  );
  const { data: now } = useQuery({ ...studioNowQuery(), enabled: hasCountdown });
  if (entries.length === 0) return null;
  return (
    <Stack gap={2} data-diagnostic-banners="">
      {entries.map(({ seq, diagnostic }) => {
        const view = diagnosticView(diagnostic, now ?? 0);
        const countdown =
          view.countdownSeconds === undefined ? undefined : formatCountdown(view.countdownSeconds);
        const countdownLabel =
          diagnostic.kind === "provider_overload" ? "retrying in" : "resets in";
        return (
          <Banner
            key={`${seq}:${diagnostic.kind}`}
            status={view.status}
            {...(view.status === "error" ? { role: "alert" } : {})}
            title={view.title}
            description={
              countdown === undefined
                ? view.detail
                : `${view.detail} · ${countdownLabel} ${countdown}`
            }
            collapsible={false}
            data-diagnostic-kind={diagnostic.kind}
            data-diagnostic-seq={String(seq)}
          >
            {view.hint !== undefined && (
              <Text type="supporting" color="secondary">
                {view.hint}
              </Text>
            )}
          </Banner>
        );
      })}
    </Stack>
  );
}

function cardLabel(chunk: StreamChunk): string {
  const category = categorizeChunk(chunk);
  if (chunk.eventType === "agent_message") return "Assistant";
  switch (category) {
    case "edit":
      return `Edit · ${chunkPath(chunk) ?? "worktree file"}`;
    case "command":
      return commandSummary(chunk);
    case "diagnostic":
      return chunk.diagnostic?.message ?? chunk.summary ?? "Diagnostic";
    case "raw":
      return `Raw output · seq ${chunk.seq}`;
    case "thought":
      return `Thought · ${chunk.summary ?? chunk.eventType ?? "reasoning"}`;
    case "event":
      return `${chunk.eventType ?? "Event"} · ${chunk.summary ?? "stream event"}`;
    default:
      return chunk.summary ?? "Stream event";
  }
}

function cardBadge(chunk: StreamChunk): {
  label: string;
  color: "gray" | "green" | "orange" | "red" | "blue";
} {
  const category = categorizeChunk(chunk);
  if (chunk.eventType === "agent_message") return { label: "assistant", color: "blue" };
  if (category === "edit") return { label: "edit", color: "green" };
  if (category === "raw") return { label: "owner only", color: "orange" };
  if (category === "diagnostic") return { label: "diagnostic", color: "red" };
  if (category === "command") {
    const status = chunkStatus(chunk);
    if (status === "passed") return { label: "passed", color: "green" };
    if (status === "failed") return { label: "failed", color: "red" };
    if (status === "running") return { label: "running", color: "orange" };
    return { label: "command", color: "gray" };
  }
  return { label: category, color: "gray" };
}

/** A progressive-disclosure stream card; diffs render as collapsible unified diffs. */
export function StreamCard({
  chunk,
  isOpen,
  onOpenChange,
  highlighted,
}: {
  chunk: StreamChunk;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  highlighted: boolean;
}) {
  const category = categorizeChunk(chunk);
  const badge = cardBadge(chunk);
  const detail = chunkDetail(chunk);
  const trigger = (
    <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
      <Token label={badge.label} size="sm" color={badge.color} />
      <Text type="body" weight="semibold">
        {cardLabel(chunk)}
      </Text>
    </Stack>
  );

  return (
    <Card
      padding={3}
      variant={highlighted ? "orange" : "default"}
      data-stream-card=""
      data-stream-seq={String(chunk.seq)}
      data-stream-category={category}
      data-stream-open={String(isOpen)}
    >
      <Collapsible
        trigger={trigger}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        chevronPosition="start"
      >
        <Stack gap={2} paddingBlockStart={2}>
          {category === "edit" ? (
            <CodeBlock
              code={chunkDiff(chunk)}
              language="plaintext"
              isDiff
              title={chunkPath(chunk) ?? "Unified diff"}
              container="section"
              size="sm"
              maxHeight={420}
            />
          ) : category === "command" || category === "raw" ? (
            <CodeBlock
              code={detail}
              language="plaintext"
              container="section"
              size="sm"
              maxHeight={320}
            />
          ) : (
            <Text type="body" color={category === "thought" ? "secondary" : "primary"}>
              {detail}
            </Text>
          )}
        </Stack>
      </Collapsible>
    </Card>
  );
}

/** Pinned right-hand rail: plan, changed files, child workers and host health. */
export function ContextRail({
  plan,
  files,
  childWorkers,
  host,
  runner,
  prompt,
  selectedFile,
  onSelectFile,
}: {
  plan: readonly PlanItem[];
  files: readonly ChangedFile[];
  childWorkers: readonly RunChild[];
  host: RunnerHost | undefined;
  runner: Runner | undefined;
  prompt: string | undefined;
  selectedFile: string | undefined;
  onSelectFile: (path: string) => void;
}) {
  const done = plan.filter((item) => item.done).length;
  const firstPending = plan.findIndex((item) => !item.done);
  const presence = runner?.presence ?? (host === undefined ? "offline" : "online");
  const dispatchPrompt = prompt?.trim() ?? "";
  const promptIsLong = dispatchPrompt.length > 280;
  return (
    <Stack gap={4} data-context-rail="">
      {dispatchPrompt !== "" && (
        <>
          <Stack gap={2} data-dispatch-prompt="">
            <Heading level={3} color="inherit">
              Dispatch prompt
            </Heading>
            {promptIsLong ? (
              <Collapsible
                trigger={
                  <Text type="body" weight="semibold">
                    Show the full prompt
                  </Text>
                }
                defaultIsOpen={false}
              >
                <Stack paddingBlockStart={1}>
                  <Text type="body" color="secondary">
                    {dispatchPrompt}
                  </Text>
                </Stack>
              </Collapsible>
            ) : (
              <Text type="body" color="secondary">
                {dispatchPrompt}
              </Text>
            )}
          </Stack>
          <Divider />
        </>
      )}
      <Stack gap={2}>
        <Stack direction="horizontal" gap={2} justify="between" vAlign="center" wrap="wrap">
          <Heading level={3} color="inherit">
            Agent Plan
          </Heading>
          <Token
            label={`${done}/${plan.length}`}
            size="sm"
            color={done === plan.length && plan.length > 0 ? "green" : "orange"}
          />
        </Stack>
        {plan.length === 0 ? (
          <Text type="supporting" color="secondary">
            No plan chunks streamed yet.
          </Text>
        ) : (
          <Stack as="ul" gap={0.5} data-plan-checklist="">
            {plan.map((item, index) => {
              const status = item.done
                ? "done"
                : index === firstPending
                  ? "in progress"
                  : "pending";
              return (
                <Stack
                  as="li"
                  key={item.label}
                  direction="horizontal"
                  gap={1.5}
                  vAlign="center"
                  wrap="wrap"
                  data-plan-done={String(item.done)}
                  data-plan-status={status}
                >
                  <Text type="body" color="inherit">
                    {item.done ? "✓" : "○"} {item.label}
                  </Text>
                  <Token
                    label={status}
                    size="sm"
                    color={item.done ? "green" : status === "in progress" ? "orange" : "gray"}
                  />
                </Stack>
              );
            })}
          </Stack>
        )}
      </Stack>

      <Divider />

      <Stack gap={2}>
        <Heading level={3} color="inherit">
          Worktree Changed Files
        </Heading>
        {files.length === 0 ? (
          <Text type="supporting" color="secondary">
            No file edits streamed yet.
          </Text>
        ) : (
          <Stack as="ul" gap={0.5}>
            {files.map((file) => (
              <Stack as="li" key={file.path} data-changed-file={file.path}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  label={file.path}
                  isDisabled={selectedFile === file.path}
                  data-file-jump={file.path}
                  onClick={() => onSelectFile(file.path)}
                />
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>

      <Divider />

      <Stack gap={2}>
        <Heading level={3} color="inherit">
          Child Workers
        </Heading>
        {childWorkers.length === 0 ? (
          <Text type="supporting" color="secondary">
            No child workers started.
          </Text>
        ) : (
          <Stack as="ul" gap={0.5}>
            {childWorkers.map((child) => (
              <Stack
                as="li"
                key={child.id}
                direction="horizontal"
                gap={1.5}
                vAlign="center"
                wrap="wrap"
                data-child-worker={child.id}
              >
                <Text type="supporting" color="secondary">
                  {child.agentType ?? child.agentId ?? child.childRunId ?? "Child"}
                </Text>
                <Token
                  label={child.status}
                  size="sm"
                  color={child.status === "active" ? "green" : "gray"}
                />
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>

      <Divider />

      <Stack gap={2}>
        <Stack direction="horizontal" gap={2} justify="between" vAlign="center" wrap="wrap">
          <Heading level={3} color="inherit">
            Host Health
          </Heading>
          <Token
            label={presence}
            size="sm"
            color={presence === "busy" ? "orange" : presence === "offline" ? "gray" : "green"}
            data-host-health-presence=""
          />
        </Stack>
        <Text type="supporting" color="secondary">
          {host?.displayName ?? "Runner host"} · {host?.platform ?? "unknown platform"}
        </Text>
        <Text type="supporting" color="secondary">
          Last seen{" "}
          {host?.lastSeenAt === undefined || host.lastSeenAt === null
            ? "unknown"
            : relativeTime(host.lastSeenAt)}
        </Text>
        {runner?.lastSeenAt !== undefined && (
          <Text type="supporting" color="secondary">
            Runner heartbeat {formatDateTime(runner.lastSeenAt)}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

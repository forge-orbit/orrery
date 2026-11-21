import { Button } from "@astryxdesign/core/Button";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
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
import { Token } from "@astryxdesign/core/Token";
import type { RunChild, RunDetail, RunModelChange, RunStatus } from "@orrery/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { HarnessBadge } from "../../lib/harness.tsx";
import { workspaceRunsQuery } from "./queries.ts";

type StatusFilter = "all" | RunStatus;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return dateTimeFormatter.format(date);
}

function relativeTime(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(startedIso: string, endedIso: string | null): string {
  const start = new Date(startedIso).getTime();
  const end = endedIso === null ? Date.now() : new Date(endedIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatActivityCounts(run: RunDetail): string {
  const parts: string[] = [];
  if (run.modelHistory.length > 0) {
    parts.push(
      `${run.modelHistory.length} model change${run.modelHistory.length === 1 ? "" : "s"}`,
    );
  }
  if (run.children.length > 0) {
    parts.push(`${run.children.length} child${run.children.length === 1 ? "" : "ren"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function ModelHistory({ changes }: { changes: readonly RunModelChange[] }) {
  if (changes.length === 0) {
    return (
      <Text as="p" display="block" type="supporting" data-model-history-empty="">
        No model changes reported.
      </Text>
    );
  }
  return (
    <Table aria-label="Model changes" data-model-history="">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>From</TableHeaderCell>
          <TableHeaderCell>To</TableHeaderCell>
          <TableHeaderCell>Reported</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {changes.map((change) => (
          <TableRow key={change.id} data-model-change="">
            <TableCell>
              <code>{change.fromModel ?? "unknown"}</code>
            </TableCell>
            <TableCell>
              <code>{change.toModel}</code>
            </TableCell>
            <TableCell>
              <time
                dateTime={change.reportedAt}
                title={new Date(change.reportedAt).toLocaleString()}
              >
                {formatTime(change.reportedAt)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ChildWorkers({ workers }: { workers: readonly RunChild[] }) {
  if (workers.length === 0) {
    return (
      <Text as="p" display="block" type="supporting" data-children-empty="">
        No child workers reported.
      </Text>
    );
  }
  return (
    <Table aria-label="Child workers" data-children="">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Worker</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Model</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {workers.map((child) => (
          <TableRow
            key={child.id}
            data-child-id={child.id}
            data-child-agent-id={child.agentId ?? "unknown"}
            data-child-status={child.status}
          >
            <TableCell>
              <Stack gap={0}>
                <Text type="label" color="primary">
                  {child.agentId ?? "unknown"}
                </Text>
                {child.agentType !== null && <Text type="supporting">{child.agentType}</Text>}
              </Stack>
            </TableCell>
            <TableCell>
              <Token
                size="sm"
                color={child.status === "active" ? "green" : "gray"}
                label={child.status === "active" ? "Active" : "Ended"}
              />
            </TableCell>
            <TableCell>
              {child.model !== null ? <code>{child.model}</code> : <Text type="supporting">—</Text>}
            </TableCell>
            <TableCell>
              <time dateTime={child.startedAt} title={new Date(child.startedAt).toLocaleString()}>
                {formatTime(child.startedAt)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunDetailDrawer({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  return (
    <Layout
      height="auto"
      header={
        <DrawerHeader
          title={run.agentName}
          subtitle={`Run ${run.id.slice(0, 8)}`}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          hasDivider
        />
      }
    >
      <LayoutContent>
        <Stack gap={4} data-run-detail-drawer="">
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Token
              size="sm"
              color={run.status === "active" ? "green" : "gray"}
              label={run.status === "active" ? "Active" : "Ended"}
            />
            <Text type="supporting">
              {run.status === "active"
                ? `Running for ${formatDuration(run.createdAt, null)}`
                : `Ran for ${formatDuration(run.createdAt, run.endedAt)}`}
            </Text>
          </Stack>

          <Table aria-label="Run metadata">
            <TableBody>
              <TableRow>
                <TableHeaderCell>Run ID</TableHeaderCell>
                <TableCell>
                  <code>{run.id}</code>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableCell>{run.agentName}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Harness</TableHeaderCell>
                <TableCell>
                  <HarnessBadge harness={run.harness} version={run.harnessVersion} empty="—" />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableCell>
                  {run.model !== null ? (
                    <code>{run.model}</code>
                  ) : (
                    <Text type="supporting">Unknown</Text>
                  )}
                </TableCell>
              </TableRow>
              {run.nativeSessionId !== null && (
                <TableRow>
                  <TableHeaderCell>Session ID</TableHeaderCell>
                  <TableCell>
                    <code>{run.nativeSessionId}</code>
                  </TableCell>
                </TableRow>
              )}
              <TableRow>
                <TableHeaderCell>Started</TableHeaderCell>
                <TableCell>{formatTime(run.createdAt)}</TableCell>
              </TableRow>
              <TableRow>
                <TableHeaderCell>Last heartbeat</TableHeaderCell>
                <TableCell>{formatTime(run.lastHeartbeatAt)}</TableCell>
              </TableRow>
              {run.endedAt !== null && (
                <TableRow>
                  <TableHeaderCell>Ended</TableHeaderCell>
                  <TableCell>{formatTime(run.endedAt)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <Stack gap={2}>
            <Heading level={3} color="inherit">
              Model changes
            </Heading>
            <ModelHistory changes={run.modelHistory} />
          </Stack>

          <Stack gap={2}>
            <Heading level={3} color="inherit">
              Child workers
            </Heading>
            <ChildWorkers workers={run.children} />
          </Stack>
        </Stack>
      </LayoutContent>
    </Layout>
  );
}

export function RunsSection({ workspaceId }: { workspaceId: string }) {
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (runs.length === 0) {
    return (
      <Stack paddingInline={5} paddingBlock={8} data-runs-section="">
        <EmptyState
          title="No runs reported yet"
          description="Agent conversations connected over MCP or local hooks will appear here."
          headingLevel={2}
        />
      </Stack>
    );
  }

  const activeCount = runs.filter((run) => run.status === "active").length;
  const filtered = filter === "all" ? runs : runs.filter((run) => run.status === filter);
  const selectedRun = runs.find((run) => run.id === selectedId) ?? null;

  return (
    <Section padding={3} data-runs-section="">
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
            <Heading level={2} color="inherit">
              Runs
            </Heading>
            <Text type="supporting">
              {runs.length} total · {activeCount} active
            </Text>
          </Stack>
          <SegmentedControl
            label="Filter runs by status"
            size="sm"
            value={filter}
            onChange={(value) => {
              if (value === "all" || value === "active" || value === "ended") setFilter(value);
            }}
          >
            <SegmentedControlItem value="all" label="All" />
            <SegmentedControlItem value="active" label="Active" />
            <SegmentedControlItem value="ended" label="Ended" />
          </SegmentedControl>
        </Stack>

        {filtered.length === 0 ? (
          <EmptyState
            title={filter === "active" ? "No active runs" : "No ended runs"}
            description={
              filter === "active"
                ? "No agents are currently running in this workspace."
                : "No runs have ended yet."
            }
            headingLevel={3}
            actions={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                label="Show all runs"
                onClick={() => setFilter("all")}
              />
            }
          />
        ) : (
          <Table aria-label="Workspace runs">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Agent</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Harness</TableHeaderCell>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Activity</TableHeaderCell>
                <TableHeaderCell>Started</TableHeaderCell>
                <TableHeaderCell>Details</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((run) => (
                <TableRow
                  key={run.id}
                  data-run-id={run.id}
                  data-harness={run.harness ?? "unknown"}
                  data-model={run.model ?? "unknown"}
                >
                  <TableCell>
                    <Stack gap={0}>
                      <Text type="label" color="primary" data-agent-name="">
                        {run.agentName}
                      </Text>
                      <Text type="supporting" data-run-label="">
                        <code title={run.id}>{run.id.slice(0, 8)}</code>
                      </Text>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Token
                      size="sm"
                      color={run.status === "active" ? "green" : "gray"}
                      label={run.status === "active" ? "Active" : "Ended"}
                    />
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" color="primary">
                      <HarnessBadge harness={run.harness} version={run.harnessVersion} empty="—" />
                    </Text>
                  </TableCell>
                  <TableCell>
                    {run.model !== null ? (
                      <code>{run.model}</code>
                    ) : (
                      <Text type="supporting">Unknown</Text>
                    )}
                  </TableCell>
                  <TableCell>
                    <Text type="supporting">{formatActivityCounts(run)}</Text>
                  </TableCell>
                  <TableCell>
                    <Stack gap={0}>
                      <Text type="supporting" color="primary">
                        <time
                          dateTime={run.createdAt}
                          title={new Date(run.createdAt).toLocaleString()}
                        >
                          {relativeTime(run.createdAt)}
                        </time>
                      </Text>
                      <Text type="supporting">{formatDuration(run.createdAt, run.endedAt)}</Text>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      label="Inspect"
                      onClick={() => setSelectedId(run.id)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>

      <Drawer
        isOpen={selectedRun !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        purpose="info"
        label={selectedRun !== null ? `Run ${selectedRun.id.slice(0, 8)}` : "Run details"}
        width="36rem"
      >
        {selectedRun !== null && (
          <RunDetailDrawer run={selectedRun} onClose={() => setSelectedId(null)} />
        )}
      </Drawer>
    </Section>
  );
}

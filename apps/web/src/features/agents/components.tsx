import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Code } from "@astryxdesign/core/Code";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
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
import {
  AgentKeyValidity,
  ProjectAccessLevel,
  type Agent,
  type AgentKey,
  type Project,
  type RunDetail,
} from "@orrery/contract";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { TextField } from "../../lib/fields.tsx";
import { HarnessBadge } from "../../lib/harness.tsx";
import { Link } from "../../lib/Link.tsx";
import { TelemetryInline } from "../../lib/telemetry.tsx";
import { projectsQuery } from "../projects/index.ts";
import { workspaceRunsQuery } from "../runs/index.ts";
import { activeSessionsQuery, SessionStatus } from "../work-sessions/index.ts";
import {
  createAgent,
  issueAgentKey,
  ownerRevokeAgentKey,
  revokeAgentKey,
  rotateAgentKey,
} from "./commands.ts";
import { agentKeysQuery, agentsQuery, workspaceAgentKeysQuery } from "./queries.ts";

const validityOptions = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days (default)" },
  { value: "never", label: "Never expires" },
] as const;

const shortDateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

const levelRank = (level: ProjectAccessLevel) => ProjectAccessLevel.options.indexOf(level);
const levelsUpTo = (cap: ProjectAccessLevel) =>
  ProjectAccessLevel.options.filter((level) => levelRank(level) <= levelRank(cap));

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

function formatExpiry(key: AgentKey): string {
  if (key.validity === "never" || key.expiresAt === null) return "Never";
  const date = new Date(key.expiresAt);
  if (Number.isNaN(date.getTime())) return `${key.validity}d`;
  return `${key.validity}d · ${shortDateFormatter.format(date)}`;
}

function keyStatus(key: AgentKey): { label: string; color: "green" | "red" | "yellow" | "gray" } {
  if (key.revokedAt !== null) return { label: "Revoked", color: "red" };
  if (key.expiresAt !== null) {
    const msLeft = new Date(key.expiresAt).getTime() - Date.now();
    if (msLeft <= 0) return { label: "Expired", color: "gray" };
    if (msLeft <= 7 * 24 * 60 * 60 * 1000) return { label: "Expiring soon", color: "yellow" };
  }
  return { label: "Active", color: "green" };
}

function isKeyLive(key: AgentKey): boolean {
  if (key.revokedAt !== null) return false;
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function errorDetail(cause: unknown, fallback: string): string {
  if (cause instanceof ApiProblemError) return cause.message;
  return fallback;
}

export function AgentsSection({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const { data: agents } = useSuspenseQuery(agentsQuery);
  const { data: mine } = useSuspenseQuery(agentKeysQuery(workspaceId));
  const { data: projects } = useSuspenseQuery(projectsQuery(workspaceId));
  const { data: runs } = useSuspenseQuery(workspaceRunsQuery(workspaceId));
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(workspaceId));

  const workspaceKeys = useQuery({ ...workspaceAgentKeysQuery(workspaceId), enabled: isOwner });
  const queryClient = useQueryClient();
  const toast = useToast();
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [issueKeyAgentId, setIssueKeyAgentId] = useState<string | null>(null);
  const [keyFilter, setKeyFilter] = useState<"active" | "all">("active");
  const [confirmRevoke, setConfirmRevoke] = useState<{ key: AgentKey; asOwner: boolean } | null>(
    null,
  );

  async function copySecret(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ body: "API key copied to clipboard." });
    } catch {
      toast({
        body: "Could not access the clipboard. Select and copy the key manually.",
        type: "error",
      });
    }
  }

  const ownIds = new Set(mine.map((key) => key.id));
  const allKeysMap = new Map<string, AgentKey>();
  for (const key of mine) allKeysMap.set(key.id, key);
  for (const key of workspaceKeys.data ?? []) allKeysMap.set(key.id, key);
  const allKeys = [...allKeysMap.values()];
  const liveKeys = allKeys.filter(isKeyLive);
  const hasInactiveKeys = liveKeys.length < allKeys.length;
  const visibleKeys = keyFilter === "active" && hasInactiveKeys ? liveKeys : allKeys;

  const activeSessionAgentIds = new Set(sessions.map((session) => session.agentId));
  const latestRunByAgent = new Map<string, RunDetail>();
  for (const run of runs) {
    const existing = latestRunByAgent.get(run.agentId);
    const runAt = new Date(run.lastHeartbeatAt ?? run.updatedAt).getTime();
    const existingAt = existing
      ? new Date(existing.lastHeartbeatAt ?? existing.updatedAt).getTime()
      : -1;
    if (runAt > existingAt) latestRunByAgent.set(run.agentId, run);
  }

  async function invalidateKeys() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
      queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
    ]);
  }

  async function rotate(key: AgentKey) {
    setBusyKey(key.id);
    setError(undefined);
    try {
      const replacement = await rotateAgentKey(key.id);
      setSecret(replacement.secret);
      setCopied(false);
      toast({ body: `Rotated key for ${key.agentName}.` });
    } catch (cause) {
      setError(errorDetail(cause, "Could not rotate the key."));
    } finally {
      setBusyKey(undefined);
      await invalidateKeys();
    }
  }

  async function executeRevoke() {
    if (confirmRevoke === null) return;
    const { key, asOwner } = confirmRevoke;
    setBusyKey(key.id);
    setError(undefined);
    try {
      if (asOwner) await ownerRevokeAgentKey(workspaceId, key.id);
      else await revokeAgentKey(key.id);
      setConfirmRevoke(null);
      toast({ body: `Revoked key for ${key.agentName}.` });
    } catch (cause) {
      setConfirmRevoke(null);
      setError(errorDetail(cause, "Could not revoke the key."));
    } finally {
      setBusyKey(undefined);
      await invalidateKeys();
    }
  }

  return (
    <Stack gap={3}>
      {secret !== undefined && (
        <Section padding={3}>
          <Stack role="status" data-agent-secret="" gap={2}>
            <Banner
              status="warning"
              title="Copy this API key now"
              description="It is shown once and cannot be recovered later."
              collapsible={false}
            />
            <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
              <Code>{secret}</Code>
              <Stack direction="horizontal" gap={2} wrap="wrap" align="center">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void copySecret(secret)}
                  label={copied ? "Copied" : "Copy key"}
                  variant="primary"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setSecret(undefined);
                    setCopied(false);
                  }}
                  label="Dismiss"
                  variant="secondary"
                />
              </Stack>
            </Stack>
          </Stack>
        </Section>
      )}

      {error !== undefined && (
        <Banner
          container="section"
          status="error"
          title="Agent action failed"
          description={error}
          collapsible={false}
          isDismissable
          onDismiss={() => setError(undefined)}
        />
      )}

      <Section padding={3}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
            <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              <Heading level={2} color="inherit">
                Registered agents
              </Heading>
              <Text type="supporting">
                {agents.length} agent{agents.length === 1 ? "" : "s"} · {liveKeys.length} active key
                {liveKeys.length === 1 ? "" : "s"}
              </Text>
            </Stack>
            <Button
              type="button"
              label="Register agent"
              icon={<Icon icon={Plus} />}
              variant="primary"
              size="sm"
              onClick={() => setRegisterOpen(true)}
            />
          </Stack>

          {agents.length === 0 ? (
            <EmptyState
              title="No agents registered yet"
              description="Register an agent identity to issue workspace-scoped API keys and connect Claude Code, Codex, or MCP clients."
              headingLevel={3}
              actions={
                <Button
                  type="button"
                  label="Register agent"
                  icon={<Icon icon={Plus} />}
                  variant="primary"
                  size="sm"
                  onClick={() => setRegisterOpen(true)}
                />
              }
            />
          ) : (
            <Table aria-label="Registered agents">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Workspace keys</TableHeaderCell>
                  <TableHeaderCell>Project access</TableHeaderCell>
                  <TableHeaderCell>Last seen</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => {
                  const agentKeys = allKeys.filter((key) => key.agentId === agent.id);
                  const activeAgentKeys = agentKeys.filter(isKeyLive);
                  const grantedProjects = [
                    ...new Set(
                      activeAgentKeys.flatMap((key) =>
                        key.projects.map((grant) => `${grant.projectName} (${grant.level})`),
                      ),
                    ),
                  ];
                  const latestRun = latestRunByAgent.get(agent.id);
                  const hasSession = activeSessionAgentIds.has(agent.id);
                  const hasActiveRun = latestRun?.status === "active";
                  const statusToken = hasSession
                    ? { label: "Working", color: "green" as const }
                    : hasActiveRun
                      ? { label: "Connected", color: "green" as const }
                      : activeAgentKeys.length > 0
                        ? { label: "Ready", color: "blue" as const }
                        : { label: "No key", color: "gray" as const };
                  const lastSeenAt = latestRun?.lastHeartbeatAt ?? latestRun?.updatedAt ?? null;

                  return (
                    <TableRow key={agent.id} data-agent-id={agent.id}>
                      <TableCell>
                        <Text type="label" color="primary">
                          {agent.name}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Token size="sm" color={statusToken.color} label={statusToken.label} />
                      </TableCell>
                      <TableCell>
                        <Text
                          type="supporting"
                          color={activeAgentKeys.length > 0 ? "primary" : "secondary"}
                        >
                          {activeAgentKeys.length > 0 ? `${activeAgentKeys.length} active` : "None"}
                          {agentKeys.length > activeAgentKeys.length
                            ? ` · ${agentKeys.length - activeAgentKeys.length} inactive`
                            : ""}
                        </Text>
                      </TableCell>
                      <TableCell>
                        {grantedProjects.length > 0 ? (
                          <Text type="supporting" color="primary">
                            {grantedProjects.join(", ")}
                          </Text>
                        ) : (
                          <Text type="supporting">No projects</Text>
                        )}
                      </TableCell>
                      <TableCell>
                        {lastSeenAt !== null ? (
                          <Text type="supporting">
                            <time
                              dateTime={lastSeenAt}
                              title={new Date(lastSeenAt).toLocaleString()}
                            >
                              {relativeTime(lastSeenAt)}
                            </time>
                          </Text>
                        ) : (
                          <Text type="supporting">—</Text>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          label="Issue key"
                          icon={<Icon icon={KeyRound} />}
                          onClick={() => setIssueKeyAgentId(agent.id)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Section>

      <Section padding={3}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
            <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              <Heading level={2} color="inherit">
                Keys in this workspace
              </Heading>
              <Text type="supporting">
                {liveKeys.length} active
                {hasInactiveKeys ? ` · ${allKeys.length - liveKeys.length} revoked/expired` : ""}
              </Text>
            </Stack>
            <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              {hasInactiveKeys && (
                <SegmentedControl
                  label="Filter workspace keys"
                  size="sm"
                  value={keyFilter}
                  onChange={(value) => {
                    if (value === "active" || value === "all") setKeyFilter(value);
                  }}
                >
                  <SegmentedControlItem value="active" label="Active" />
                  <SegmentedControlItem value="all" label="All" />
                </SegmentedControl>
              )}
              {agents.length > 0 && (
                <Button
                  type="button"
                  label="Issue key"
                  icon={<Icon icon={KeyRound} />}
                  variant="secondary"
                  size="sm"
                  onClick={() => setIssueKeyAgentId(agents[0]?.id ?? "")}
                />
              )}
            </Stack>
          </Stack>

          {allKeys.length === 0 ? (
            <EmptyState
              title="No API keys in this workspace"
              description="Issue a workspace-scoped key to grant an agent Read or Contribute access to selected projects."
              headingLevel={3}
              actions={
                agents.length > 0 ? (
                  <Button
                    type="button"
                    label="Issue key"
                    icon={<Icon icon={KeyRound} />}
                    variant="secondary"
                    size="sm"
                    onClick={() => setIssueKeyAgentId(agents[0]?.id ?? "")}
                  />
                ) : undefined
              }
            />
          ) : visibleKeys.length === 0 ? (
            <EmptyState
              title="No active keys"
              description="All keys in this workspace are revoked or expired."
              headingLevel={3}
              actions={
                <Button
                  type="button"
                  label="Show all keys"
                  variant="secondary"
                  size="sm"
                  onClick={() => setKeyFilter("all")}
                />
              }
            />
          ) : (
            <Table aria-label="Workspace API keys">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Key</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Projects</TableHeaderCell>
                  <TableHeaderCell>Expires</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleKeys.map((key) => {
                  const status = keyStatus(key);
                  const isOwn = ownIds.has(key.id);
                  const busy = busyKey === key.id;
                  return (
                    <TableRow
                      key={key.id}
                      data-agent-key-id={key.id}
                      data-revoked={String(key.revokedAt !== null)}
                    >
                      <TableCell>
                        <Text type="label" color="primary">
                          {key.agentName}
                        </Text>
                      </TableCell>
                      <TableCell>
                        {key.keyHint !== null ? (
                          <Code data-agent-key-hint="">{key.keyHint}</Code>
                        ) : (
                          <code
                            data-agent-key-hint-legacy
                            title="Issued before key previews were stored (only the SHA-256 hash exists). Rotate or issue a new key to show its prefix preview."
                          >
                            legacy · {key.id.slice(0, 8)}
                          </code>
                        )}
                      </TableCell>
                      <TableCell>
                        <Token
                          size="sm"
                          color={status.color}
                          label={status.label}
                          {...(key.revokedAt !== null ? { "data-key-status": "" } : {})}
                        />
                      </TableCell>
                      <TableCell>
                        {key.projects.length > 0 ? (
                          <Stack direction="horizontal" gap={1} wrap="wrap">
                            {key.projects.map((grant) => (
                              <Token
                                key={grant.projectId}
                                size="sm"
                                color={grant.level === "contribute" ? "blue" : "default"}
                                label={`${grant.projectName} · ${grant.level}`}
                              />
                            ))}
                          </Stack>
                        ) : (
                          <Text type="supporting">No projects</Text>
                        )}
                      </TableCell>
                      <TableCell>
                        <Text type="supporting">{formatExpiry(key)}</Text>
                      </TableCell>
                      <TableCell>
                        <Stack direction="horizontal" gap={1} wrap="wrap">
                          {key.revokedAt !== null ? (
                            <Text type="supporting">—</Text>
                          ) : isOwn ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                isLoading={busy}
                                isDisabled={busy}
                                onClick={() => void rotate(key)}
                                label="Rotate"
                                variant="secondary"
                              />
                              <Button
                                type="button"
                                size="sm"
                                isDisabled={busy}
                                onClick={() => setConfirmRevoke({ key, asOwner: false })}
                                label="Revoke"
                                variant="destructive"
                              />
                            </>
                          ) : (
                            isOwner && (
                              <Button
                                type="button"
                                size="sm"
                                isDisabled={busy}
                                onClick={() => setConfirmRevoke({ key, asOwner: true })}
                                label="Revoke (owner)"
                                variant="destructive"
                              />
                            )
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Stack>
      </Section>

      <Section padding={3}>
        <Stack gap={3}>
          <Stack direction="horizontal" gap={2} wrap="wrap" justify="between" align="center">
            <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              <Heading level={2} color="inherit">
                Active work sessions
              </Heading>
              <Text type="supporting">
                {sessions.length === 0
                  ? "Idle"
                  : `${sessions.length} active claim${sessions.length === 1 ? "" : "s"}`}
              </Text>
            </Stack>
          </Stack>
          <ActiveSessions workspaceId={workspaceId} projects={projects} runs={runs} />
        </Stack>
      </Section>

      <Drawer
        isOpen={registerOpen}
        onOpenChange={setRegisterOpen}
        purpose="form"
        label="Register agent"
        width="26rem"
      >
        <Layout
          height="auto"
          header={<DrawerHeader title="Register agent" onOpenChange={setRegisterOpen} hasDivider />}
        >
          <LayoutContent>
            {registerOpen && (
              <RegisterAgentForm
                onCreated={() => {
                  setRegisterOpen(false);
                  toast({ body: "Agent registered." });
                }}
              />
            )}
          </LayoutContent>
        </Layout>
      </Drawer>

      {agents.length > 0 && (
        <Drawer
          isOpen={issueKeyAgentId !== null}
          onOpenChange={(open) => {
            if (!open) setIssueKeyAgentId(null);
          }}
          purpose="form"
          label="Issue workspace API key"
          width="28rem"
        >
          <Layout
            height="auto"
            header={
              <DrawerHeader
                title="Issue workspace API key"
                subtitle="Choose an agent, expiry, and per-project access level."
                onOpenChange={(open) => {
                  if (!open) setIssueKeyAgentId(null);
                }}
                hasDivider
              />
            }
          >
            <LayoutContent>
              {issueKeyAgentId !== null && (
                <IssueKeyForm
                  key={issueKeyAgentId}
                  agents={agents}
                  initialAgentId={issueKeyAgentId}
                  projects={projects}
                  workspaceId={workspaceId}
                  onIssued={(value) => {
                    setSecret(value);
                    setCopied(false);
                    setIssueKeyAgentId(null);
                    toast({ body: "API key issued." });
                  }}
                />
              )}
            </LayoutContent>
          </Layout>
        </Drawer>
      )}

      <AlertDialog
        isOpen={confirmRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRevoke(null);
        }}
        title="Revoke API key?"
        description={
          confirmRevoke !== null
            ? `Revoke ${confirmRevoke.key.agentName}'s key (${confirmRevoke.key.keyHint ?? confirmRevoke.key.id.slice(0, 8)})? Any running client using this key will lose access immediately.`
            : "Revoke this API key?"
        }
        actionLabel="Revoke key"
        actionVariant="destructive"
        isActionLoading={confirmRevoke !== null && busyKey === confirmRevoke.key.id}
        onAction={() => void executeRevoke()}
      />
    </Stack>
  );
}

function ActiveSessions({
  workspaceId,
  projects,
  runs,
}: {
  workspaceId: string;
  projects: readonly Project[];
  runs: readonly RunDetail[];
}) {
  const { data: sessions } = useSuspenseQuery(activeSessionsQuery(workspaceId));
  if (sessions.length === 0) {
    return (
      <Text as="p" display="block" type="supporting">
        No active work sessions. When an agent claims an issue in this workspace, its live lease and
        telemetry appear here.
      </Text>
    );
  }
  const levels = new Map(projects.map((project) => [project.id, project.accessLevel]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  return (
    <Table aria-label="Active work sessions">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Issue</TableHeaderCell>
          <TableHeaderCell>Runtime</TableHeaderCell>
          <TableHeaderCell>Lease & heartbeat</TableHeaderCell>
          <TableHeaderCell>Telemetry</TableHeaderCell>
          <TableHeaderCell>State</TableHeaderCell>
          <TableHeaderCell>Inspector</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => {
          const run = runById.get(session.runId);
          const canContribute = levels.get(session.projectId) !== "read";
          return (
            <TableRow
              key={session.id}
              data-agent-session-id={session.id}
              data-issue-id={session.issueId}
              {...(run?.harness ? { "data-session-harness": run.harness } : {})}
            >
              <TableCell>
                <Link to="/issues/$issueId" params={{ issueId: session.issueId }}>
                  Issue {session.issueId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell>
                <Stack gap={0}>
                  <Text type="supporting" color="primary">
                    <HarnessBadge harness={run?.harness} empty="unknown" />
                  </Text>
                  <Text type="supporting" data-session-model={run?.model ?? "unknown"}>
                    model: {run?.model ?? "unknown"}
                  </Text>
                  <Text type="supporting" data-subagent-count={String(run?.children.length ?? 0)}>
                    subagents: {run?.children.length ?? 0}
                  </Text>
                </Stack>
              </TableCell>
              <TableCell>
                <Stack gap={0}>
                  <Text type="supporting" data-lease-expires-at={session.leaseExpiresAt}>
                    lease until {dateTimeFormatter.format(new Date(session.leaseExpiresAt))}
                  </Text>
                  <Text type="supporting" data-last-heartbeat={session.updatedAt}>
                    check-in {relativeTime(session.updatedAt)}
                  </Text>
                  <Text type="supporting" data-run-heartbeat={run?.lastHeartbeatAt ?? ""}>
                    run heartbeat{" "}
                    {run?.lastHeartbeatAt !== null && run?.lastHeartbeatAt !== undefined
                      ? relativeTime(run.lastHeartbeatAt)
                      : "unknown"}
                  </Text>
                </Stack>
              </TableCell>
              <TableCell>
                <TelemetryInline
                  inputTokens={session.inputTokens}
                  outputTokens={session.outputTokens}
                  costUsdMicros={session.costUsdMicros}
                />
              </TableCell>
              <TableCell>
                <SessionStatus
                  issueId={session.issueId}
                  projectId={session.projectId}
                  canContribute={canContribute}
                  session={session}
                />
              </TableCell>
              <TableCell>
                <Link
                  to="/issues/$issueId"
                  params={{ issueId: session.issueId }}
                  search={{ inspector: true, session: session.id }}
                  data-sidecar-link=""
                >
                  Sidecar
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function RegisterAgentForm({ onCreated }: { onCreated?: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await createAgent(name);
      setName("");
      await queryClient.invalidateQueries({ queryKey: agentsQuery.queryKey });
      onCreated?.();
    } catch (cause) {
      setError(errorDetail(cause, "Could not register the agent."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={3}>
        {error !== undefined && (
          <Banner
            status="error"
            title="Could not register agent"
            description={error}
            collapsible={false}
          />
        )}
        <TextField
          label="Agent name"
          id="agent-name"
          htmlName="name"
          value={name}
          onChange={setName}
          placeholder="e.g. Claude Code, Codex"
          required
          maxLength={120}
          width="100%"
        />
        <Stack direction="horizontal" gap={2}>
          <Button
            type="submit"
            isLoading={submitting}
            isDisabled={submitting || name.trim() === ""}
            label="Register agent"
            variant="primary"
          />
        </Stack>
      </Stack>
    </form>
  );
}

function IssueKeyForm({
  agents,
  initialAgentId,
  projects,
  workspaceId,
  onIssued,
}: {
  agents: Agent[];
  initialAgentId: string;
  projects: readonly { id: string; name: string; accessLevel: ProjectAccessLevel }[];
  workspaceId: string;
  onIssued: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState(
    agents.some((agent) => agent.id === initialAgentId) ? initialAgentId : (agents[0]?.id ?? ""),
  );
  const [validity, setValidity] = useState<AgentKeyValidity>("90");
  const [selected, setSelected] = useState<Record<string, ProjectAccessLevel>>({});
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function toggle(projectId: string, checked: boolean) {
    setSelected((current) => {
      const next = { ...current };
      if (checked) next[projectId] = "read";
      else delete next[projectId];
      return next;
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const issued = await issueAgentKey({
        agentId,
        workspaceId,
        validity,
        projects: Object.entries(selected).map(([projectId, level]) => ({ projectId, level })),
      });
      onIssued(issued.secret);
      setSelected({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeysQuery(workspaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: workspaceAgentKeysQuery(workspaceId).queryKey }),
      ]);
    } catch (cause) {
      setError(errorDetail(cause, "Could not issue the key."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <Stack gap={3}>
        {error !== undefined && (
          <Banner
            status="error"
            title="Could not issue API key"
            description={error}
            collapsible={false}
          />
        )}

        <Selector
          label="Agent"
          id="key-agent"
          value={agentId}
          onChange={setAgentId}
          options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
        />

        <Selector
          label="Validity"
          id="key-validity"
          value={validity}
          onChange={(value) => setValidity(AgentKeyValidity.parse(value))}
          options={validityOptions.map((option) => ({ value: option.value, label: option.label }))}
        />

        <Stack gap={2}>
          <Heading level={3} color="inherit">
            Project access
          </Heading>
          {projects.length === 0 ? (
            <Text as="p" display="block" type="supporting">
              No projects in this workspace yet. You can still issue a key with no project grants.
            </Text>
          ) : (
            projects.map((project) => {
              const allowed = levelsUpTo(project.accessLevel);
              const current = selected[project.id] ?? "read";
              return (
                <Stack key={project.id} gap={1}>
                  <CheckboxInput
                    label={`${project.name} (your access: ${project.accessLevel})`}
                    value={project.id in selected}
                    onChange={(checked) => toggle(project.id, checked)}
                  />
                  {project.id in selected && (
                    <Stack paddingInlineStart={4}>
                      <Selector
                        label={`Level for ${project.name}`}
                        value={current}
                        onChange={(value) =>
                          setSelected((state) => ({
                            ...state,
                            [project.id]: ProjectAccessLevel.parse(value),
                          }))
                        }
                        options={allowed.map((level) => ({ value: level, label: level }))}
                      />
                    </Stack>
                  )}
                </Stack>
              );
            })
          )}
        </Stack>

        <Stack direction="horizontal" gap={2}>
          <Button
            type="submit"
            isLoading={submitting}
            isDisabled={submitting || agentId === ""}
            label="Issue key"
            variant="primary"
          />
        </Stack>
      </Stack>
    </form>
  );
}

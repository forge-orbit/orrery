import {
  type FleetRunnerHost,
  SessionDiagnostic,
  type StreamChunk,
  type StreamResponse,
} from "@orrery/contract";

/** Segments offered in the Live Session Studio stream pane. */
export type StudioFilter = "all" | "edits" | "commands" | "thoughts" | "diagnostics";

/** Semantic bucket derived from the contract's free-form `eventType`. */
export type ChunkCategory = "edit" | "command" | "thought" | "diagnostic" | "raw" | "event";

export type ChunkStatus = "passed" | "failed" | "running" | "info";

export interface StreamAccumulator {
  chunks: StreamChunk[];
  cursor: number;
  rolledUp: boolean;
}

export interface PlanItem {
  label: string;
  done: boolean;
}

export interface ChangedFile {
  path: string;
  diff: string;
  seq: number;
}

export interface DiagnosticEntry {
  seq: number;
  diagnostic: SessionDiagnostic;
}

export interface DiagnosticView {
  title: string;
  status: "error" | "warning" | "info";
  detail: string;
  hint?: string | undefined;
  countdownSeconds?: number | undefined;
}

const EDIT_HINTS = ["edit", "diff", "patch", "file", "write"];
const COMMAND_HINTS = ["command", "test", "shell", "tool_call", "build", "lint", "check"];
const THOUGHT_HINTS = ["thought", "think", "plan", "reason", "milestone"];

function matches(eventType: string, hints: readonly string[]): boolean {
  return hints.some((hint) => eventType.includes(hint));
}

/** Classify a chunk for filters and card rendering. Pure: no clock, no I/O. */
export function categorizeChunk(chunk: StreamChunk): ChunkCategory {
  if (chunk.kind === "raw_output" || chunk.visibility === "owner_only") return "raw";
  if (chunk.kind === "diagnostic" || chunk.diagnostic !== undefined) return "diagnostic";
  const eventType = (chunk.eventType ?? "").toLowerCase();
  if (matches(eventType, EDIT_HINTS)) return "edit";
  if (matches(eventType, COMMAND_HINTS)) return "command";
  if (matches(eventType, THOUGHT_HINTS)) return "thought";
  return "event";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value));
}

/** Derive a command's presentation status from its event data and summary. */
export function chunkStatus(chunk: StreamChunk): ChunkStatus {
  const data = asRecord(chunk.data);
  const explicit = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const eventType = (chunk.eventType ?? "").toLowerCase();
  const text = `${explicit} ${eventType} ${chunk.summary ?? ""}`;
  if (
    data.success === false ||
    data.failed === true ||
    (typeof data.exitCode === "number" && data.exitCode !== 0) ||
    matches(text, ["failed", "failure", "error"])
  ) {
    return "failed";
  }
  if (data.success === true || matches(text, ["passed", "success", "succeeded", "complete"])) {
    return "passed";
  }
  if (matches(text, ["running", "started", "starting", "in_progress"])) return "running";
  return "info";
}

/**
 * Passing commands start collapsed; running or failing commands start open.
 * Diagnostics always open so a human cannot miss them.
 */
export function defaultOpenFor(chunk: StreamChunk): boolean {
  const category = categorizeChunk(chunk);
  if (category === "diagnostic" || category === "raw") return true;
  if (category !== "command") return false;
  return chunkStatus(chunk) === "running" || chunkStatus(chunk) === "failed";
}

/** One-line summary used when a passing command is collapsed. */
export function commandSummary(chunk: StreamChunk): string {
  const status = chunkStatus(chunk);
  const prefix =
    status === "passed"
      ? "Passed"
      : status === "failed"
        ? "Failed"
        : status === "running"
          ? "Running"
          : "Command";
  return `${prefix} · ${chunk.summary ?? chunk.eventType ?? "tool call"}`;
}

function readText(data: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** The worktree path an edit chunk refers to, when it has one. */
export function chunkPath(chunk: StreamChunk): string | undefined {
  return readText(asRecord(chunk.data), ["path", "file", "filePath", "filename"]) ?? chunk.summary;
}

/** Unified diff payload carried by an edit chunk. */
export function chunkDiff(chunk: StreamChunk): string {
  return (
    readText(asRecord(chunk.data), ["diff", "patch", "unifiedDiff", "content", "text"]) ??
    chunk.summary ??
    ""
  );
}

/** Expanded body text for command, thought and raw chunks. */
export function chunkDetail(chunk: StreamChunk): string {
  const data = asRecord(chunk.data);
  return (
    readText(data, ["output", "detail", "message", "body", "text"]) ??
    chunk.summary ??
    chunk.eventType ??
    ""
  );
}

/** Live Agent Plan items, coalesced by label with the newest state winning. */
export function extractPlan(chunks: readonly StreamChunk[]): PlanItem[] {
  const items = new Map<string, PlanItem>();
  for (const chunk of chunks) {
    if (categorizeChunk(chunk) !== "thought") continue;
    const eventType = (chunk.eventType ?? "").toLowerCase();
    if (!matches(eventType, ["plan", "milestone"])) continue;
    const data = asRecord(chunk.data);
    const rawItems = Array.isArray(data.items) ? data.items : [];
    if (rawItems.length > 0) {
      for (const raw of rawItems) {
        const entry = asRecord(raw);
        const label = readText(entry, ["label", "text", "title", "name"]);
        if (label === undefined) continue;
        const done =
          entry.checked === true ||
          entry.done === true ||
          entry.completed === true ||
          entry.status === "completed";
        items.set(label, { label, done });
      }
      continue;
    }
    const label = readText(data, ["label", "text", "title"]) ?? chunk.summary;
    if (label === undefined) continue;
    const done =
      data.checked === true ||
      data.done === true ||
      data.completed === true ||
      chunkStatus(chunk) === "passed";
    items.set(label, { label, done });
  }
  return [...items.values()];
}

/** Worktree file index with the latest unified diff for each path. */
export function extractChangedFiles(chunks: readonly StreamChunk[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const chunk of chunks) {
    if (categorizeChunk(chunk) !== "edit") continue;
    const path = chunkPath(chunk);
    if (path === undefined) continue;
    const previous = files.get(path);
    if (previous !== undefined && previous.seq >= chunk.seq) continue;
    files.set(path, { path, diff: chunkDiff(chunk), seq: chunk.seq });
  }
  return [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

/** Newest diagnostic per kind, so each banner describes the current state. */
export function extractDiagnostics(chunks: readonly StreamChunk[]): DiagnosticEntry[] {
  const byKind = new Map<string, DiagnosticEntry>();
  for (const chunk of chunks) {
    const parsed =
      chunk.diagnostic !== undefined
        ? SessionDiagnostic.safeParse(chunk.diagnostic)
        : SessionDiagnostic.safeParse(asRecord(chunk.data).diagnostic);
    if (!parsed.success) continue;
    const previous = byKind.get(parsed.data.kind);
    if (previous !== undefined && previous.seq >= chunk.seq) continue;
    byKind.set(parsed.data.kind, { seq: chunk.seq, diagnostic: parsed.data });
  }
  return [...byKind.values()].toSorted((a, b) => b.seq - a.seq);
}

function untilTimestamp(value: string | undefined, now: number): number | undefined {
  if (value === undefined || now === 0) return undefined;
  const target = Date.parse(value);
  if (Number.isNaN(target)) return undefined;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

/** Remaining seconds for a diagnostic countdown; never depends on the wall clock itself. */
export function diagnosticCountdown(
  diagnostic: SessionDiagnostic,
  now: number,
): number | undefined {
  if (diagnostic.kind === "usage_limit") return untilTimestamp(diagnostic.resetsAt, now);
  if (diagnostic.kind === "provider_overload") {
    return (
      untilTimestamp(diagnostic.nextRetryAt, now) ??
      (diagnostic.countdownSeconds === undefined
        ? undefined
        : Math.max(0, diagnostic.countdownSeconds))
    );
  }
  return undefined;
}

function pluralSeconds(seconds: number): string {
  return `${seconds}s`;
}

/** Compact human countdown for banners and chips. */
export function formatCountdown(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  if (seconds < 60) return pluralSeconds(seconds);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** All eight diagnostic kinds get a stable title, status and actionable detail. */
export function diagnosticView(diagnostic: SessionDiagnostic, now = Date.now()): DiagnosticView {
  switch (diagnostic.kind) {
    case "acp_not_installed":
      return {
        title: "ACP harness not installed",
        status: "error",
        detail: diagnostic.message,
        hint: `Install ${diagnostic.harness ?? "the ACP harness"} on the Runner host, then restart the Runner.`,
      };
    case "acp_spawn_failed":
      return {
        title: "Agent failed to start",
        status: "error",
        detail:
          diagnostic.exitCode === undefined
            ? diagnostic.message
            : `${diagnostic.message} (exit code ${diagnostic.exitCode})`,
        hint: "Check the harness command and its local configuration on the Runner host.",
      };
    case "acp_crashed":
      return {
        title: "Agent process crashed",
        status: "error",
        detail:
          diagnostic.signal === undefined
            ? diagnostic.message
            : `${diagnostic.message} (signal ${diagnostic.signal})`,
        hint: "The worktree is left untouched. Resolve the crash before re-dispatching.",
      };
    case "auth_expired":
      return {
        title: "Agent authentication expired",
        status: "warning",
        detail: diagnostic.message,
        hint: diagnostic.remediation,
      };
    case "usage_limit":
      return {
        title: "Provider usage limit reached",
        status: "warning",
        detail: diagnostic.message,
        hint: "The agent resumes when the provider quota resets.",
        countdownSeconds: diagnosticCountdown(diagnostic, now),
      };
    case "provider_overload":
      return {
        title: "Provider overloaded",
        status: "warning",
        detail: `${diagnostic.message} (attempt ${diagnostic.attempt})`,
        hint: "The Runner will retry automatically.",
        countdownSeconds: diagnosticCountdown(diagnostic, now),
      };
    case "permission_denied":
      return {
        title: "Permission denied",
        status: "warning",
        detail: diagnostic.message,
        hint:
          diagnostic.tool === undefined
            ? "Review the local permission policy on the Runner host."
            : `Review the local permission policy for '${diagnostic.tool}'${diagnostic.path === undefined ? "" : ` on ${diagnostic.path}`}.`,
      };
    case "runner_disconnected":
      return {
        title: "Runner disconnected",
        status: "error",
        detail: diagnostic.message,
        hint: "The work session is parked until the Runner reconnects or a human resolves it.",
      };
  }
  return {
    title: "Session diagnostic",
    status: "info",
    detail: "An unrecognised diagnostic variant was reported.",
  };
}

/** Merge chunk pages by seq so overlapping polls and replay never duplicate cards. */
export function mergeStreamChunks(...groups: readonly (readonly StreamChunk[])[]): StreamChunk[] {
  const bySeq = new Map<number, StreamChunk>();
  for (const group of groups) {
    for (const chunk of group) bySeq.set(chunk.seq, chunk);
  }
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

/** Fold the next cursor page into the accumulated stream without a React effect. */
export function accumulateStream(
  previous: StreamAccumulator | undefined,
  response: StreamResponse,
): StreamAccumulator {
  return {
    chunks: mergeStreamChunks(previous?.chunks ?? [], response.chunks),
    cursor: Math.max(previous?.cursor ?? 0, response.nextAfterSeq),
    rolledUp: (previous?.rolledUp ?? false) || response.rolledUp,
  };
}

/** Split chunks into visible cards for one segmented filter selection. */
export function filterChunks(
  chunks: readonly StreamChunk[],
  filter: StudioFilter,
  options: { showRaw: boolean; file?: string | undefined } = { showRaw: false },
): StreamChunk[] {
  const visible = options.showRaw
    ? chunks
    : chunks.filter((chunk) => categorizeChunk(chunk) !== "raw");
  const file = options.file;
  return visible.filter((chunk) => {
    const category = categorizeChunk(chunk);
    if (filter === "edits" && file !== undefined) {
      return category === "edit" && chunkPath(chunk) === file;
    }
    switch (filter) {
      case "all":
        return true;
      case "edits":
        return category === "edit";
      case "commands":
        return category === "command";
      case "thoughts":
        return category === "thought" || category === "event";
      case "diagnostics":
        return category === "diagnostic";
      default:
        return true;
    }
  });
}

/** The fleet grants `canRevoke` only on hosts owned by the signed-in human. */
export function isOwnerOfRunner(
  hosts: readonly FleetRunnerHost[] | undefined,
  runnerId: string,
): boolean {
  if (hosts === undefined) return false;
  return hosts.some(
    (host) => host.canRevoke && host.runners.some((runner) => runner.id === runnerId),
  );
}

/** The fleet's status chip uses the highest-severity active diagnostic. */
export function fleetStatus(chunks: readonly StreamChunk[]): {
  label: string;
  color: "green" | "orange" | "red" | "gray";
} {
  const diagnostics = extractDiagnostics(chunks);
  if (diagnostics.length === 0) return { label: "No diagnostics", color: "gray" };
  const worst = diagnostics.find((entry) => diagnosticView(entry.diagnostic).status === "error");
  const selected = worst ?? diagnostics[0];
  if (selected === undefined) return { label: "No diagnostics", color: "gray" };
  const view = diagnosticView(selected.diagnostic);
  return { label: view.title, color: view.status === "error" ? "red" : "orange" };
}

/** Remaining lease time in whole seconds, clamped at zero. */
export function leaseSeconds(leaseExpiresAt: string, now: number): number {
  const target = Date.parse(leaseExpiresAt);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

/** Token/cost telemetry formatted from the linked Work session. */
export function telemetryText(input: {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
}): { tokens: string; cost: string } {
  const tokens = (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
  return {
    tokens: tokens.toLocaleString("en-US"),
    cost: `$${((input.costUsdMicros ?? 0) / 1_000_000).toFixed(2)}`,
  };
}

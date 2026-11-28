import type { StreamChunk, StreamResponse } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import {
  accumulateStream,
  categorizeChunk,
  chunkStatus,
  coalesceAcpChunks,
  commandSummary,
  defaultOpenFor,
  diagnosticCountdown,
  diagnosticView,
  extractChangedFiles,
  extractDiagnostics,
  extractPlan,
  filterChunks,
  fleetStatus,
  formatCountdown,
  isOwnerOfRunner,
  leaseSeconds,
  mergeStreamChunks,
  STUDIO_CONNECTION_BADGES,
  studioConnectionBadge,
  telemetryText,
} from "./stream.ts";

const chunk = (value: Partial<StreamChunk> & { seq: number }): StreamChunk => ({
  kind: "event",
  visibility: "project_readers",
  ...value,
});

const now = Date.parse("2026-11-25T12:00:00Z");

const response = (
  chunks: StreamChunk[],
  nextAfterSeq: number,
  rolledUp = false,
): StreamResponse => ({
  chunks,
  nextAfterSeq,
  rolledUp,
});

describe("stream classification", () => {
  it("classifies each semantic bucket and keeps raw output separate", () => {
    expect(categorizeChunk(chunk({ seq: 1, eventType: "file_diff" }))).toBe("edit");
    expect(categorizeChunk(chunk({ seq: 2, eventType: "tool_call" }))).toBe("command");
    expect(categorizeChunk(chunk({ seq: 3, eventType: "thought" }))).toBe("thought");
    expect(
      categorizeChunk(
        chunk({
          seq: 4,
          diagnostic: { kind: "acp_crashed", version: 1, message: "gone" },
        }),
      ),
    ).toBe("diagnostic");
    expect(categorizeChunk(chunk({ seq: 5, kind: "raw_output", visibility: "owner_only" }))).toBe(
      "raw",
    );
    expect(categorizeChunk(chunk({ seq: 6, eventType: "other" }))).toBe("event");
  });

  it("collapses passing commands but expands running and failing ones", () => {
    const passing = chunk({ seq: 1, eventType: "command", data: { status: "passed" } });
    const running = chunk({ seq: 2, eventType: "command", data: { status: "running" } });
    const failing = chunk({ seq: 3, eventType: "command", data: { exitCode: 1 } });
    expect(chunkStatus(passing)).toBe("passed");
    expect(chunkStatus(running)).toBe("running");
    expect(chunkStatus(failing)).toBe("failed");
    expect(defaultOpenFor(passing)).toBe(false);
    expect(defaultOpenFor(running)).toBe(true);
    expect(defaultOpenFor(failing)).toBe(true);
    expect(commandSummary(passing)).toBe("Passed · command");
  });
});

describe("cursor accumulation and filtering", () => {
  it("merges overlapping pages by seq and advances the cursor", () => {
    const first = accumulateStream(
      undefined,
      response([chunk({ seq: 1, summary: "a" }), chunk({ seq: 2, summary: "b" })], 2),
    );
    const second = accumulateStream(
      first,
      response([chunk({ seq: 2, summary: "b" }), chunk({ seq: 3, summary: "c" })], 3),
    );
    expect(second.chunks.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(second.cursor).toBe(3);
    expect(mergeStreamChunks([chunk({ seq: 1 })], [chunk({ seq: 1 })])).toHaveLength(1);
  });

  it("keeps rolledUp true once a replay has been observed", () => {
    const first = accumulateStream(undefined, response([], 0, false));
    const replay = accumulateStream(first, response([chunk({ seq: 1 })], 1, true));
    expect(replay.rolledUp).toBe(true);
  });

  it("filters raw output unless the owner opted in and scopes file selection", () => {
    const chunks = [
      chunk({ seq: 1, eventType: "file_diff", data: { path: "a.ts", diff: "+x" } }),
      chunk({ seq: 2, eventType: "file_diff", data: { path: "b.ts", diff: "+y" } }),
      chunk({ seq: 3, eventType: "command", data: { status: "passed" } }),
      chunk({ seq: 4, kind: "raw_output", visibility: "owner_only" }),
    ];
    expect(filterChunks(chunks, "all")).toHaveLength(3);
    expect(filterChunks(chunks, "all", { showRaw: true })).toHaveLength(4);
    expect(filterChunks(chunks, "edits")).toHaveLength(2);
    expect(filterChunks(chunks, "commands")).toHaveLength(1);
    expect(filterChunks(chunks, "edits", { showRaw: false, file: "b.ts" })).toHaveLength(1);
  });
});

describe("rail derivations", () => {
  it("coalesces plan items with the newest state", () => {
    const items = extractPlan([
      chunk({
        seq: 1,
        eventType: "plan",
        data: { items: [{ label: "Read code", checked: false }] },
      }),
      chunk({
        seq: 2,
        eventType: "plan",
        data: { items: [{ label: "Read code", checked: true }] },
      }),
      chunk({ seq: 3, eventType: "milestone", summary: "Write tests" }),
    ]);
    expect(items).toEqual([
      { label: "Read code", done: true },
      { label: "Write tests", done: false },
    ]);
  });

  it("indexes changed files by their latest diff", () => {
    const files = extractChangedFiles([
      chunk({ seq: 1, eventType: "file_diff", data: { path: "a.ts", diff: "-old" } }),
      chunk({ seq: 2, eventType: "file_diff", data: { path: "a.ts", diff: "+new" } }),
    ]);
    expect(files).toEqual([{ path: "a.ts", diff: "+new", seq: 2 }]);
  });
});

describe("diagnostics", () => {
  it("extracts the newest diagnostic per kind", () => {
    const entries = extractDiagnostics([
      chunk({
        seq: 1,
        diagnostic: { kind: "auth_expired", version: 1, message: "old", remediation: "login" },
      }),
      chunk({
        seq: 2,
        diagnostic: { kind: "auth_expired", version: 1, message: "new", remediation: "login" },
      }),
      chunk({
        seq: 3,
        data: { diagnostic: { kind: "acp_crashed", version: 1, message: "segfault" } },
      }),
    ]);
    expect(entries.map((entry) => entry.diagnostic.kind)).toEqual(["acp_crashed", "auth_expired"]);
    expect(entries[1]?.diagnostic.message).toBe("new");
  });

  it("describes all eight diagnostic kinds", () => {
    const kinds = [
      { kind: "acp_not_installed", version: 1, message: "missing", harness: "opencode" },
      { kind: "acp_spawn_failed", version: 1, message: "spawn", exitCode: 2 },
      { kind: "acp_crashed", version: 1, message: "crash", signal: "SIGSEGV" },
      { kind: "auth_expired", version: 1, message: "auth", remediation: "Run opencode auth login" },
      { kind: "usage_limit", version: 1, message: "quota", resetsAt: "2026-11-25T12:05:00Z" },
      {
        kind: "provider_overload",
        version: 1,
        message: "busy",
        attempt: 3,
        nextRetryAt: "2026-11-25T12:00:30Z",
      },
      { kind: "permission_denied", version: 1, message: "denied", tool: "bash", path: "/repo" },
      { kind: "runner_disconnected", version: 1, message: "offline", lastSeq: 9 },
    ] as const;
    expect(kinds.map((kind) => diagnosticView(kind).title)).toEqual([
      "ACP harness not installed",
      "Agent failed to start",
      "Agent process crashed",
      "Agent authentication expired",
      "Provider usage limit reached",
      "Provider overloaded",
      "Permission denied",
      "Runner disconnected",
    ]);
    expect(diagnosticView(kinds[3]).hint).toBe("Run opencode auth login");
    expect(diagnosticCountdown(kinds[4], now)).toBe(300);
    expect(diagnosticCountdown(kinds[5], now)).toBe(30);
    expect(formatCountdown(300)).toBe("5m 00s");
    expect(formatCountdown(42)).toBe("42s");
    expect(fleetStatus([chunk({ seq: 1, diagnostic: kinds[6] })]).color).toBe("orange");
  });
});

describe("header facts", () => {
  it("computes lease countdown, telemetry and fleet ownership", () => {
    expect(leaseSeconds("2026-11-25T12:01:00Z", now)).toBe(60);
    expect(leaseSeconds("2026-11-25T11:00:00Z", now)).toBe(0);
    expect(
      telemetryText({ inputTokens: 1000, outputTokens: 250, costUsdMicros: 1_250_000 }),
    ).toEqual({ tokens: "1,250", cost: "$1.25" });
    expect(
      isOwnerOfRunner(
        [
          {
            host: {
              id: "h1",
              humanId: "me",
              displayName: "Laptop",
              platform: "linux-x64",
              lastSeenAt: null,
              revokedAt: null,
              createdAt: "2026-11-25T11:00:00Z",
            },
            presence: "online",
            canRevoke: true,
            runners: [],
          },
        ],
        "missing",
      ),
    ).toBe(false);
  });
});

describe("ACP v1 chunk coalescing", () => {
  it("drops available_commands_update and coalesces thoughts, messages, and tool calls", () => {
    const raw = [
      chunk({
        seq: 1,
        eventType: "available_commands_update",
        data: { params: { update: { sessionUpdate: "available_commands_update" } } },
      }),
      chunk({
        seq: 2,
        eventType: "agent_thought_chunk",
        data: {
          params: {
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: "m1:reasoning",
              content: { type: "text", text: "Checking " },
            },
          },
        },
      }),
      chunk({
        seq: 3,
        eventType: "agent_thought_chunk",
        data: {
          params: {
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: "m1:reasoning",
              content: { type: "text", text: "DEMO-1." },
            },
          },
        },
      }),
      chunk({
        seq: 4,
        eventType: "agent_message_chunk",
        data: {
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "m1",
              content: { type: "text", text: "Added hello.txt." },
            },
          },
        },
      }),
      chunk({
        seq: 5,
        eventType: "tool_call",
        data: {
          params: {
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc1",
              title: "bash",
              status: "in_progress",
              rawInput: { command: "git status" },
            },
          },
        },
      }),
      chunk({
        seq: 6,
        eventType: "tool_call_update",
        data: {
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc1",
              status: "completed",
              content: [{ type: "content", content: { text: "clean" } }],
            },
          },
        },
      }),
    ];
    const coalesced = coalesceAcpChunks(raw);
    expect(coalesced).toHaveLength(3);
    expect(coalesced[0]?.eventType).toBe("thought");
    expect(coalesced[0]?.data).toEqual({ text: "Checking DEMO-1." });
    expect(coalesced[1]?.eventType).toBe("agent_message");
    expect(defaultOpenFor(coalesced[1]!)).toBe(true);
    expect(coalesced[2]?.eventType).toBe("tool_call");
    expect(chunkStatus(coalesced[2]!)).toBe("passed");
  });

  it("keeps the Live Session Studio connection badge steady across background polls", () => {
    expect(
      studioConnectionBadge({ bareUrl: false, active: true, isPending: false, isError: false }),
    ).toBe(STUDIO_CONNECTION_BADGES.live);
    expect(
      studioConnectionBadge({ bareUrl: true, active: false, isPending: false, isError: false }),
    ).toBe(STUDIO_CONNECTION_BADGES.connected);
    expect(
      studioConnectionBadge({ bareUrl: false, active: true, isPending: true, isError: false }),
    ).toBe(STUDIO_CONNECTION_BADGES.connecting);
    expect(
      studioConnectionBadge({ bareUrl: false, active: true, isPending: false, isError: true }),
    ).toBe(STUDIO_CONNECTION_BADGES.reconnecting);
    expect(
      studioConnectionBadge({ bareUrl: false, active: false, isPending: false, isError: false }),
    ).toBe(STUDIO_CONNECTION_BADGES.replay);
  });
});

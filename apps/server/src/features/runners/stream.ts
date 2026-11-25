import { createHash } from "node:crypto";
import { StreamChunk } from "@orrery/contract";

/** DB-time windows and caps for runner-to-server stream ingestion (#199). */
export const STREAM_WINDOW_SECONDS = 60;
export const MAX_STREAM_BATCHES_PER_WINDOW = 6;
export const STREAM_MILESTONE_COALESCE_SECONDS = 30;
export const DISPATCH_UNCERTAIN_AFTER_SECONDS = 30;
export const STREAM_CONTENT_TYPE = "application/x-ndjson";

export interface StreamMilestone {
  kind: "action" | "status";
  summary: string;
  detail: Record<string, unknown>;
}

/** One immutable blob per rollup: a re-rollup never overwrites an active key. */
export function streamObjectKey(workSessionId: string, objectId: string): string {
  return `streams/${workSessionId}/${objectId}.jsonl`;
}

/** Serialize the deduplicated, ordered chunks as one newline-delimited JSON blob. */
export function toJsonl(chunks: readonly StreamChunk[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  return Buffer.from(
    chunks.map((chunk) => JSON.stringify(StreamChunk.parse(chunk))).join("\n") + "\n",
    "utf8",
  );
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Archived JSONL is only ever read through ObjectStore, never trusted blindly. */
export function parseJsonl(bytes: Uint8Array): StreamChunk[] {
  const lines = Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
  const parsed: StreamChunk[] = [];
  for (const line of lines) {
    // A crash can truncate the trailing line; skip it without losing the rest.
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const result = StreamChunk.safeParse(value);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

/** Hot chunks win over archived lines with the same seq after a late batch. */
export function mergeChunks(...groups: readonly (readonly StreamChunk[])[]): StreamChunk[] {
  const bySeq = new Map<number, StreamChunk>();
  for (const group of groups) {
    for (const chunk of group) bySeq.set(chunk.seq, chunk);
  }
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

/**
 * Acknowledge only the contiguous prefix from the durable `previousAck`, never
 * jumping to `fromSeq`: a cross-batch gap must stall the cursor until the
 * missing chunk arrives, otherwise it is silently dropped.
 */
export function computeAckedSeq(
  previousAck: number,
  toSeq: number,
  presentSeqs: readonly number[],
): number {
  const available = new Set(presentSeqs);
  let ack = previousAck;
  while (ack < toSeq && available.has(ack + 1)) ack += 1;
  return ack;
}

const NOISY_STREAM_EVENT_TYPES = new Set([
  "available_commands_update",
  "agent_thought_chunk",
  "agent_message_chunk",
  "tool_call_update",
  "usage_update",
]);

/** Curated, coalesced timeline entries derived from a batch of raw chunks. */
export function milestonesFor(chunks: readonly StreamChunk[]): StreamMilestone[] {
  const bySummary = new Map<string, StreamMilestone>();
  for (const chunk of chunks) {
    if (chunk.kind === "raw_output") continue;
    if (chunk.eventType !== undefined && NOISY_STREAM_EVENT_TYPES.has(chunk.eventType)) continue;
    const summary =
      chunk.summary ?? (chunk.kind === "diagnostic" ? chunk.diagnostic?.message : undefined);
    if (summary === undefined) continue;
    const kind = chunk.kind === "diagnostic" ? "status" : "action";
    const key = `${kind}:${summary}`;
    if (bySummary.has(key)) continue;
    const detail: Record<string, unknown> = { seq: chunk.seq };
    if (chunk.eventType !== undefined) detail.eventType = chunk.eventType;
    if (chunk.diagnostic !== undefined) {
      detail.diagnostic = chunk.diagnostic.kind;
    }
    bySummary.set(key, { kind, summary, detail });
  }
  return [...bySummary.values()];
}

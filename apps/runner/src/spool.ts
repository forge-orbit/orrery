import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  StreamBatchResponse,
  StreamChunk,
  type StreamChunk as StreamChunkType,
} from "@orrery/contract";

/**
 * Local spool for structured ACP events (#199). This module never imports the
 * server: it writes JSONL to disk and flushes idempotent HTTP batches, so a
 * dropped connection can replay `fromSeq..toSeq` without duplicating chunks.
 */

/** The main checkout root, even when called from an isolated runner worktree. */
export function mainRepositoryRoot(repoPath: string): string {
  const commonGitDir = execFileSync(
    "git",
    ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  return dirname(commonGitDir);
}

/** Spool files live under the main checkout, never inside a runner worktree. */
export function spoolDirectory(mainRepoRoot: string): string {
  return join(mainRepoRoot, ".orrery", "runs");
}

export function spoolFilePath(spoolDir: string, dispatchAttemptId: string): string {
  return join(spoolDir, dispatchAttemptId, "stream.jsonl");
}

export interface SpoolEntry {
  kind: StreamChunkType["kind"];
  visibility?: StreamChunkType["visibility"];
  eventType?: string;
  summary?: string;
  data?: Record<string, unknown>;
  diagnostic?: StreamChunkType["diagnostic"];
}

export interface StreamSpoolOptions {
  /** Explicit spool root; tests pass an os.tmpdir() directory. */
  spoolDir: string;
  dispatchAttemptId: string;
  /** Server origin, e.g. http://127.0.0.1:8080. */
  apiBaseUrl: string;
  runnerId: string;
  dispatchId: string;
  /** Host credential (`orr_rh_...`) sent as a Bearer token. */
  credential: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxBatchSize?: number;
  maxAttempts?: number;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

export class StreamSpool {
  readonly file: string;
  private readonly options: StreamSpoolOptions;
  private nextSeq = 1;
  private ackedSeq = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (milliseconds: number) => Promise<void>;
  private readonly maxBatchSize: number;
  private readonly maxAttempts: number;

  constructor(options: StreamSpoolOptions) {
    this.options = options;
    this.file = spoolFilePath(options.spoolDir, options.dispatchAttemptId);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  /** Restore sequence numbers after a process restart; the file is the source of truth. */
  async open(): Promise<this> {
    let contents: string;
    try {
      contents = await readFile(this.file, "utf8");
    } catch {
      return this;
    }
    let highest = 0;
    for (const line of contents.split("\n")) {
      if (line === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        // A truncated trailing line after a crash must not drop valid chunks.
        continue;
      }
      const parsed = StreamChunk.safeParse(value);
      if (parsed.success) highest = Math.max(highest, parsed.data.seq);
    }
    this.nextSeq = highest + 1;
    return this;
  }

  /** Append one ordered line to the JSONL spool. */
  async append(entry: SpoolEntry): Promise<StreamChunkType> {
    // Allocate seq synchronously before any await and serialize appends so
    // concurrent producers (e.g. ACP updates + stderr) never duplicate seqs.
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const chunk = StreamChunk.parse({
      ...entry,
      ...(entry.kind === "raw_output" ? { visibility: "owner_only" as const } : {}),
      seq,
    });
    const write = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(chunk)}\n`, "utf8");
    });
    this.writeChain = write.catch(() => {});
    await write;
    return chunk;
  }

  /** Flush every unacknowledged line as idempotent `fromSeq..toSeq` windows. */
  async flush(): Promise<number> {
    for (;;) {
      // Re-slice from the durable cursor after every response: a partial ack
      // must replay the unacked tail instead of skipping to the next window.
      const pending = (await this.readSpooled())
        .filter((chunk) => chunk.seq > this.ackedSeq)
        .slice(0, this.maxBatchSize);
      if (pending.length === 0) return this.ackedSeq;
      const before = this.ackedSeq;
      const advanced = await this.sendWindow(pending);
      if (!advanced || this.ackedSeq === before) return this.ackedSeq;
    }
  }

  private async readSpooled(): Promise<StreamChunkType[]> {
    try {
      const contents = await readFile(this.file, "utf8");
      const chunks: StreamChunkType[] = [];
      for (const line of contents.split("\n")) {
        if (line === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          // A truncated trailing line after a crash must not drop valid chunks.
          continue;
        }
        const parsed = StreamChunk.safeParse(value);
        if (parsed.success) chunks.push(parsed.data);
      }
      return chunks.toSorted((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }

  private async sendWindow(window: readonly StreamChunkType[]): Promise<boolean> {
    const fromSeq = window[0]?.seq;
    const toSeq = window.at(-1)?.seq;
    if (fromSeq === undefined || toSeq === undefined) return false;
    const { apiBaseUrl, runnerId, dispatchId, credential, dispatchAttemptId } = this.options;
    const url = `${apiBaseUrl.replace(/\/$/, "")}/api/runners/${encodeURIComponent(runnerId)}/dispatches/${encodeURIComponent(dispatchId)}/stream`;
    let attempt = 0;
    for (;;) {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({ dispatchAttemptId, fromSeq, toSeq, chunks: window }),
      });
      if (response.status === 429) {
        // Native backpressure: wait for Retry-After, then replay the same window.
        const header = Number(response.headers.get("retry-after") ?? "1");
        const retryAfter = Math.max(0, Number.isFinite(header) ? header : 1);
        attempt += 1;
        if (attempt >= this.maxAttempts) {
          throw new Error(`stream batch still backpressured after ${attempt} attempts`);
        }
        await this.sleepFn(retryAfter * 1000);
        continue;
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt + 1 < this.maxAttempts) {
          attempt += 1;
          await this.sleepFn(100 * 2 ** attempt);
          continue;
        }
        throw new Error(`stream batch failed with HTTP ${response.status}`);
      }
      const body = StreamBatchResponse.parse(await response.json());
      const acked = Math.min(body.ackedSeq, toSeq);
      const advanced = acked > this.ackedSeq;
      this.ackedSeq = Math.max(this.ackedSeq, acked);
      return advanced;
    }
  }
}

export async function createStreamSpool(options: StreamSpoolOptions): Promise<StreamSpool> {
  return new StreamSpool(options).open();
}

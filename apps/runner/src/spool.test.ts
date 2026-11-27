import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import {
  createStreamSpool,
  mainRepositoryRoot,
  spoolDirectory,
  spoolFilePath,
  type StreamSpoolOptions,
} from "./spool.ts";

const directories: string[] = [];
const makeDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orrery-spool-test-"));
  directories.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

const SendSchema = z.object({
  fromSeq: z.number(),
  toSeq: z.number(),
  chunks: z.array(z.object({ seq: z.number() })),
});
type Send = z.infer<typeof SendSchema>;
const bodyAsSend = (init: RequestInit | undefined): Send =>
  SendSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

async function options(spoolDir: string): Promise<StreamSpoolOptions> {
  return {
    spoolDir,
    dispatchAttemptId: "attempt-199",
    apiBaseUrl: "http://127.0.0.1:8080",
    runnerId: "runner-1",
    dispatchId: "dispatch-1",
    credential: "orr_rh_test",
    sleep: async () => {},
  };
}

describe("local JSONL stream spool", () => {
  it("spools ordered JSONL outside a runner git worktree", async () => {
    const dir = await makeDir();
    const repo = join(dir, "checkout");
    const worktree = join(dir, "worktree");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "README.md"), "init\n", "utf8");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=spool@example.com",
      "-c",
      "user.name=Spool",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "spool-test", worktree]);

    const mainRoot = mainRepositoryRoot(worktree);
    expect(resolve(mainRoot)).toBe(resolve(repo));
    const dirForSpool = spoolDirectory(mainRoot);
    expect(dirForSpool).toBe(join(repo, ".orrery", "runs"));
    expect(dirForSpool.startsWith(worktree)).toBe(false);
    expect(spoolFilePath(dirForSpool, "attempt-199")).toBe(
      join(repo, ".orrery", "runs", "attempt-199", "stream.jsonl"),
    );
  });

  it("appends idempotent sequence numbers and survives a restart", async () => {
    const dir = await makeDir();
    const spool = await createStreamSpool(await options(dir));
    await spool.append({ kind: "event", eventType: "tool_call", summary: "npm test" });
    await spool.append({
      kind: "diagnostic",
      diagnostic: { kind: "usage_limit", version: 1, message: "rate limited" },
    });
    await spool.append({ kind: "raw_output", visibility: "owner_only", data: { line: "secret" } });

    const lines = (await readFile(spool.file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => z.object({ seq: z.number() }).parse(JSON.parse(line)));
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);

    const reopened = await createStreamSpool(await options(dir));
    const next = await reopened.append({ kind: "event", eventType: "file_diff" });
    expect(next.seq).toBe(4);
  });

  it("replays the same window after 429 Retry-After backpressure", async () => {
    const dir = await makeDir();
    const sends: Send[] = [];
    let backpressured = false;
    const fetchStub: typeof fetch = async (_input, init) => {
      sends.push(bodyAsSend(init));
      if (!backpressured) {
        backpressured = true;
        return json(429, { code: "stream_rate_limited" }, { "retry-after": "0" });
      }
      return json(200, { ackedSeq: 2 });
    };
    const spool = await createStreamSpool({ ...(await options(dir)), fetch: fetchStub });
    await spool.append({ kind: "event", summary: "one" });
    await spool.append({ kind: "event", summary: "two" });

    expect(await spool.flush()).toBe(2);
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ fromSeq: 1, toSeq: 2 });
    expect(sends[1]).toEqual(sends[0]);
    // Already acked: a second flush sends nothing.
    expect(await spool.flush()).toBe(2);
    expect(sends).toHaveLength(2);
  });

  it("re-slices from the acked cursor after a partial ack", async () => {
    const dir = await makeDir();
    const sends: Send[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      const body = bodyAsSend(init);
      sends.push(body);
      // Only the first window is partially acked; the retry then drains fully.
      return json(200, { ackedSeq: body.fromSeq === 1 ? 1 : body.toSeq });
    };
    const spool = await createStreamSpool({
      ...(await options(dir)),
      maxBatchSize: 2,
      fetch: fetchStub,
    });
    for (const summary of ["one", "two", "three", "four"]) {
      await spool.append({ kind: "event", summary });
    }

    expect(await spool.flush()).toBe(4);
    // The unacked tail is replayed from ackedSeq + 1, never skipped.
    expect(sends.map((send) => [send.fromSeq, send.toSeq])).toEqual([
      [1, 2],
      [2, 3],
      [4, 4],
    ]);
    expect(await spool.flush()).toBe(4);
    expect(sends).toHaveLength(3);
  });

  it("skips a truncated trailing JSONL line after a crash", async () => {
    const dir = await makeDir();
    const spool = await createStreamSpool(await options(dir));
    await spool.append({ kind: "event", summary: "valid" });
    await appendFile(spool.file, '{"seq":2,"kind":"event"\n', "utf8");

    const sends: Send[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      sends.push(bodyAsSend(init));
      return json(200, { ackedSeq: 2 });
    };
    const reopened = await createStreamSpool({ ...(await options(dir)), fetch: fetchStub });
    expect((await reopened.append({ kind: "event", summary: "next" })).seq).toBe(2);
    expect(await reopened.flush()).toBe(2);
    expect(sends[0]?.chunks.map((entry) => entry.seq)).toEqual([1, 2]);
  });
});

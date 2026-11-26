import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessCatalog } from "@orrery/contract";
import { harnessConfigKey, writeCachedCatalog } from "./catalog.ts";
import { loadSupervisionConfig } from "./config.ts";
import type { SlotController } from "./slots.ts";
import { repoFingerprint, start } from "./start.ts";
import { TestOrrery, type TestActivity, type TestSession } from "./test-orrery.ts";

interface Fixture {
  root: string;
  repo: string;
  worktrees: string;
  marker: string;
  control: TestOrrery;
  stop: AbortController;
  lines: string[];
  done: Promise<void>;
  controller?: SlotController | undefined;
}

interface MarkerEvent {
  at: number;
  event: string;
  [key: string]: unknown;
}

interface FixtureOptions {
  mode: string;
  concurrency?: number;
  leaseRenewMs?: number;
  cancelGraceMs?: number;
  sleepMs?: number;
  onController?: ((controller: SlotController) => void) | undefined;
  /** Seed the local Harness catalog cache before registration (issue #241). */
  cachedCatalog?: HarnessCatalog | undefined;
  /** CLI defaults for dispatches without per-dispatch overrides. */
  defaults?: { harness?: string; model?: string; effort?: string } | undefined;
  /** Stub seam: reject this model id (or `*`) over ACP. */
  rejectModel?: string | undefined;
  /** Stub seam: reject every effort config option. */
  rejectEffort?: boolean | undefined;
  /** Stub seam: the Harness's advertised current/default model. */
  defaultModel?: string | undefined;
}

const stubPath = fileURLToPath(new URL("./stub-acp.ts", import.meta.url));
const fixtures: Fixture[] = [];
const savedEnv = {
  STUB_ACP_MODE: process.env.STUB_ACP_MODE,
  STUB_ACP_MARKER: process.env.STUB_ACP_MARKER,
  STUB_ACP_SLEEP_MS: process.env.STUB_ACP_SLEEP_MS,
  STUB_ACP_DEFAULT_MODEL: process.env.STUB_ACP_DEFAULT_MODEL,
  STUB_ACP_REJECT_MODEL: process.env.STUB_ACP_REJECT_MODEL,
  STUB_ACP_REJECT_EFFORT: process.env.STUB_ACP_REJECT_EFFORT,
  ORRERY_RUNNER_CONFIG_DIR: process.env.ORRERY_RUNNER_CONFIG_DIR,
};
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      fixture.stop.abort();
      await Promise.race([fixture.done, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      await fixture.control.close();
      await rm(fixture.root, { recursive: true, force: true });
    }),
  );
});

const git = (cwd: string, args: string[]): void => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};

async function makeFixture(options: FixtureOptions): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "orrery-runner-supervise-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  const configDir = join(root, "config");
  const marker = join(root, "acp.jsonl");
  await mkdir(repo, { recursive: true });
  await mkdir(configDir, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "README.md"), "initial\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  await writeFile(
    join(configDir, "runner-credential.json"),
    JSON.stringify({
      server: "http://orrery.test",
      hostId: "host-1",
      credential: "orr_rh_local-credential-1234567890",
      displayName: "TestLaptop",
      platform: "linux-x64",
    }),
    { mode: 0o600 },
  );

  const control = await TestOrrery.start();
  process.env.ORRERY_RUNNER_CONFIG_DIR = configDir;
  process.env.STUB_ACP_MODE = options.mode;
  process.env.STUB_ACP_MARKER = marker;
  process.env.STUB_ACP_SLEEP_MS = String(options.sleepMs ?? 0);
  if (options.defaultModel === undefined) delete process.env.STUB_ACP_DEFAULT_MODEL;
  else process.env.STUB_ACP_DEFAULT_MODEL = options.defaultModel;
  if (options.rejectModel === undefined) delete process.env.STUB_ACP_REJECT_MODEL;
  else process.env.STUB_ACP_REJECT_MODEL = options.rejectModel;
  if (options.rejectEffort === true) process.env.STUB_ACP_REJECT_EFFORT = "1";
  else delete process.env.STUB_ACP_REJECT_EFFORT;
  const stop = new AbortController();
  const lines: string[] = [];
  const config = loadSupervisionConfig({
    acp: { command: process.execPath, args: [stubPath] },
    ...(options.leaseRenewMs === undefined ? {} : { leaseRenewMs: options.leaseRenewMs }),
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    ...(options.defaults?.harness === undefined ? {} : { harness: options.defaults.harness }),
    ...(options.defaults?.model === undefined ? {} : { model: options.defaults.model }),
    ...(options.defaults?.effort === undefined ? {} : { effort: options.defaults.effort }),
    worktreeRoot: worktrees,
  });
  // The cache is read before registration, exactly like a real cold start.
  if (options.cachedCatalog !== undefined) {
    await writeCachedCatalog(
      repoFingerprint(repo),
      options.cachedCatalog,
      configDir,
      harnessConfigKey({ acpOverride: config.acp }),
    );
  }
  const done = start({
    server: control.url,
    workspaceId: "workspace-1",
    projectId: "project-1",
    maxConcurrency: options.concurrency ?? 1,
    heartbeatMs: 100,
    commandWaitMs: 50,
    repoPath: repo,
    signal: stop.signal,
    supervision: config,
    write: (line) => lines.push(line),
    onController: options.onController,
  });
  const result: Fixture = { root, repo, worktrees, marker, control, stop, lines, done };
  fixtures.push(result);
  return result;
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (!(await predicate())) throw new Error("condition was not met before the timeout");
}

async function events(fixture: Fixture): Promise<MarkerEvent[]> {
  try {
    return (
      (await readFile(fixture.marker, "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line): MarkerEvent => {
          const parsed: unknown = JSON.parse(line);
          const record = recordOf(parsed) ?? {};
          const event: MarkerEvent = {
            at: typeof record.at === "number" ? record.at : 0,
            event: str(record.event),
          };
          for (const [key, value] of Object.entries(record)) {
            if (key !== "at" && key !== "event") event[key] = value;
          }
          return event;
        })
        // Catalog probes (issue #240) run the same stub; their records carry
        // `probe: true` and never count as dispatch-supervision activity.
        .filter((item) => item.probe !== true)
    );
  } catch {
    return [];
  }
}

const sessions = (fixture: Fixture): TestSession[] => fixture.control.state().sessions;
const activities = (fixture: Fixture): TestActivity[] => fixture.control.state().activities;

async function settledSession(fixture: Fixture, index = 0): Promise<TestSession> {
  await until(() => (sessions(fixture)[index]?.status ?? "active") !== "active");
  const session = sessions(fixture)[index];
  if (session === undefined) throw new Error("no session was recorded");
  return session;
}

describe("orrery-runner local ACP supervision", { timeout: 30_000 }, () => {
  it("creates an isolated worktree with a pre-wired /mcp config and completes a clean turn as review", async () => {
    const fixture = await makeFixture({ mode: "normal" });
    fixture.control.enqueueDispatch("TEST-1", "attempt-1");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");

    const recorded = await events(fixture);
    const created = recorded.find((item) => item.event === "session/new");
    expect(created).toBeDefined();
    const params = recordOf(created?.params) ?? {};
    expect(str(params.cwd)).toContain(fixture.worktrees);
    expect(str(params.cwd)).not.toBe(fixture.repo);
    const servers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    const mcp = recordOf(servers[0]) ?? {};
    expect(str(mcp.url)).toMatch(/\/mcp$/);
    expect(mcp.type).toBe("http");
    const headers = Array.isArray(mcp.headers) ? mcp.headers : [];
    expect(
      headers.some(
        (item) =>
          str(recordOf(item)?.name) === "authorization" &&
          str(recordOf(item)?.value).includes("orr_dt_"),
      ),
    ).toBe(true);
    const envList = Array.isArray(mcp.env) ? mcp.env : [];
    const env = Object.fromEntries(
      envList.map((item) => {
        const field = recordOf(item) ?? {};
        return [str(field.name), str(field.value)];
      }),
    );
    expect(env.ORRERY_WORK_SESSION_ID).toBe(session.id);
    expect(env.ORRERY_ISSUE_ID).toBe("TEST-1");

    const activity = activities(fixture).find((item) => item.summary.includes("Worktree clean"));
    const worktree = recordOf(activity?.detail?.worktree) ?? {};
    expect(worktree).toMatchObject({
      branch: expect.stringMatching(/^orrery\/test-42-[a-z0-9]+$/),
      dirty: false,
      unpushed: false,
      preserved: false,
    });
    const worktreeList = spawnSync("git", ["-C", fixture.repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(worktreeList).not.toContain(String(worktree?.branch));
  });

  it("enforces the local permission policy on ACP permission requests", async () => {
    const fixture = await makeFixture({ mode: "permission" });
    fixture.control.enqueueDispatch("TEST-2", "attempt-2");
    await settledSession(fixture);
    const results = (await events(fixture)).filter((item) => item.event === "permission_result");
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ id: 9001, optionId: "allow-once" });
    expect(results[1]).toMatchObject({ id: 9002, optionId: "reject-once" });
    expect(results[2]).toMatchObject({ id: 9003, optionId: "reject-once" });
  });

  it("renews the five-minute lease while the ACP process is alive", async () => {
    const fixture = await makeFixture({ mode: "normal", leaseRenewMs: 30, sleepMs: 250 });
    fixture.control.enqueueDispatch("TEST-3", "attempt-3");
    const session = await settledSession(fixture);
    expect(session.renewals).toBeGreaterThanOrEqual(3);
    expect(session.status).toBe("completed");
  });

  it("escalates cancel to the process group and preserves a draining slot until exit", async () => {
    const fixture = await makeFixture({ mode: "ignore-term", cancelGraceMs: 120 });
    fixture.control.enqueueDispatch("TEST-4", "attempt-4");
    await until(async () => (await events(fixture)).some((item) => item.event === "hanging"));

    // The first stub already captured `ignore-term`; the unrelated job that
    // follows must be a normal turn so a completed slot can be observed.
    process.env.STUB_ACP_MODE = "normal";
    fixture.control.enqueueCancel("attempt-4");
    fixture.control.enqueueDispatch("TEST-5", "attempt-5");

    await until(async () => {
      const created = (await events(fixture)).filter((item) => item.event === "session/new");
      return created.length === 2;
    });
    const recorded = await events(fixture);
    expect(recorded.some((item) => item.event === "cancel")).toBe(true);
    expect(recorded.some((item) => item.event === "sigterm")).toBe(true);
    const stubPid = Number(recorded.find((item) => item.event === "hanging")?.pid ?? -1);
    const grandchildPid = Number(recorded.find((item) => item.event === "grandchild")?.pid ?? -1);
    expect(stubPid).toBeGreaterThan(0);
    expect(grandchildPid).toBeGreaterThan(0);

    await until(() => (sessions(fixture)[1]?.status ?? "active") !== "active");
    expect(sessions(fixture)[0]?.status).toBe("released");
    expect(sessions(fixture)[1]?.status).toBe("completed");
    expect(sessions(fixture)[1]?.stopOutcome).toBe("review");

    // The entire detached process group (stub and grandchild independently)
    // is gone before the draining slot released and the unrelated job finished.
    await until(() => !alive(stubPid));
    await until(() => !alive(grandchildPid));
  });

  it("terminates local work on a 401 revocation without calling stop_session", async () => {
    const fixture = await makeFixture({ mode: "hang", cancelGraceMs: 50 });
    fixture.control.enqueueDispatch("TEST-6", "attempt-6");
    await until(async () => (await events(fixture)).some((item) => item.event === "hanging"));
    fixture.control.revoke();
    await until(() =>
      fixture.lines.some((line) => line.includes("Stopping local operation immediately")),
    );
    await until(async () => (await events(fixture)).some((item) => item.event === "cancel"));
    expect(sessions(fixture)[0]?.status).toBe("active");
    expect(sessions(fixture)[0]?.stopOutcome).toBeNull();
  });

  it("releases a crashed session", async () => {
    const fixture = await makeFixture({ mode: "crash" });
    fixture.control.enqueueDispatch("TEST-7", "attempt-7");
    const session = await settledSession(fixture);
    expect(session.status).toBe("released");
    expect(session.stopOutcome).toBe("released");
  });

  it("preserves and reports dirty and unpushed worktrees", async () => {
    const dirty = await makeFixture({ mode: "dirty" });
    dirty.control.enqueueDispatch("TEST-8", "attempt-8");
    await settledSession(dirty);
    const dirtyActivity = activities(dirty).find((item) => item.summary.includes("preserved"));
    expect(dirtyActivity?.detail?.worktree).toMatchObject({ dirty: true, preserved: true });
    const dirtyBranch = str(recordOf(dirtyActivity?.detail?.worktree)?.branch);
    const dirtyList = spawnSync("git", ["-C", dirty.repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(dirtyList).toContain(dirtyBranch);

    const unpushed = await makeFixture({ mode: "unpushed" });
    unpushed.control.enqueueDispatch("TEST-9", "attempt-9");
    await settledSession(unpushed);
    const unpushedActivity = activities(unpushed).find((item) =>
      item.summary.includes("preserved"),
    );
    expect(unpushedActivity?.detail?.worktree).toMatchObject({ unpushed: true, preserved: true });
  });

  it("does not re-stop a session the ACP agent stopped itself", async () => {
    const fixture = await makeFixture({ mode: "self-stop" });
    fixture.control.enqueueDispatch("TEST-10", "attempt-10");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    await until(() =>
      fixture.lines.some((line) => line.includes("the ACP agent stopped it itself")),
    );
  });

  it("runs independent dispatches concurrently when --concurrency is greater than one", async () => {
    const fixture = await makeFixture({ mode: "normal", concurrency: 2 });
    fixture.control.enqueueDispatch("TEST-11", "attempt-11");
    fixture.control.enqueueDispatch("TEST-12", "attempt-12");
    await until(
      () => sessions(fixture).filter((session) => session.status === "completed").length === 2,
    );
    expect((await events(fixture)).filter((item) => item.event === "session/new")).toHaveLength(2);
    const branches = activities(fixture)
      .map((activity) => str(recordOf(activity.detail?.worktree)?.branch))
      .filter((branch) => branch !== "");
    expect(new Set(branches).size).toBe(2);
  });

  it("re-reports live attempts with spool cursors after a transient disconnect", async () => {
    const fixture = await makeFixture({ mode: "chunk-hang" });
    fixture.control.enqueueDispatch("TEST-RECONNECT", "attempt-reconnect");
    await until(() => (sessions(fixture)[0]?.status ?? "active") === "active");
    await until(() => fixture.control.chunks().length > 0);

    const before = fixture.control.reconnectCalls;
    fixture.control.transientHeartbeatFailures = 1;
    await until(
      () =>
        fixture.control.reconnectCalls > before &&
        fixture.control.reconnectAttempts.some(
          (attempt) => attempt.dispatchAttemptId === "attempt-reconnect",
        ),
    );
    const attempt = fixture.control.reconnectAttempts.find(
      (item) => item.dispatchAttemptId === "attempt-reconnect",
    );
    expect(attempt).toBeDefined();
    expect(attempt?.lastSeq).toBeGreaterThan(0);
  });

  it("parks on an open question and resumes the same ACP session after a human answer", async () => {
    const fixture = await makeFixture({ mode: "needs-input", leaseRenewMs: 40 });
    fixture.control.enqueueDispatch("TEST-NEEDS-INPUT", "attempt-needs-input");
    await until(async () => (await events(fixture)).some((item) => item.event === "asked"));
    const question = fixture.control.questionsFor("TEST-NEEDS-INPUT")[0];
    expect(question?.status).toBe("open");
    const renewalsWhileParked = sessions(fixture)[0]?.renewals ?? 0;
    await until(() => (sessions(fixture)[0]?.renewals ?? 0) > renewalsWhileParked);

    fixture.control.enqueueInputResolved("attempt-needs-input", {
      questionId: question?.id ?? "",
      resolution: "answered",
      answer: "Use the additive migration",
    });
    await until(async () => (await events(fixture)).some((item) => item.event === "resumed"));
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    expect(fixture.control.recordedStopCalls()).toEqual(["review"]);

    const recorded = await events(fixture);
    const turns = recorded.filter(
      (item) => item.event === "prompt" && typeof item.turn === "number",
    );
    expect(turns).toHaveLength(2);
    expect(str(turns[0]?.cwd)).toBe(str(turns[1]?.cwd));
    expect(str(turns[1]?.text)).toContain("Use the additive migration");
  });

  it("resumes a parked session with an authorized fallback_used answer", async () => {
    const fixture = await makeFixture({ mode: "needs-input" });
    fixture.control.enqueueDispatch("TEST-FALLBACK", "attempt-fallback");
    await until(async () => (await events(fixture)).some((item) => item.event === "asked"));
    const question = fixture.control.questionsFor("TEST-FALLBACK")[0];
    fixture.control.enqueueInputResolved("attempt-fallback", {
      questionId: question?.id ?? "",
      resolution: "fallback_used",
      answer: question?.proposedFallback ?? "Use the additive migration",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    const resumed = (await events(fixture)).find(
      (item) => item.event === "prompt" && item.turn === 2,
    );
    expect(str(resumed?.text)).toContain("deadline passed");
    expect(str(resumed?.text)).toContain("Use the additive migration");
  });

  it("stops renewing, terminates ACP and preserves the worktree on a require_human deadline pause", async () => {
    const fixture = await makeFixture({
      mode: "needs-input",
      leaseRenewMs: 40,
      cancelGraceMs: 80,
    });
    fixture.control.enqueueDispatch("TEST-PAUSED", "attempt-paused");
    await until(async () => (await events(fixture)).some((item) => item.event === "asked"));
    const hanging = (await events(fixture)).find((item) => item.event === "asked");
    const stubPid = Number(hanging?.pid ?? -1);
    const renewalsBefore = sessions(fixture)[0]?.renewals ?? 0;
    await until(() => (sessions(fixture)[0]?.renewals ?? 0) > renewalsBefore);

    fixture.control.enqueueCancel("attempt-paused", "question_paused");
    await until(() => fixture.lines.some((line) => line.includes("question deadline paused")));
    const linesAfter = sessions(fixture)[0]?.renewals ?? 0;
    expect(sessions(fixture)[0]?.renewals ?? 0).toBe(linesAfter);
    expect(sessions(fixture)[0]?.status).toBe("released");
    expect(fixture.control.recordedStopCalls()).toEqual([]);
    const activity = activities(fixture).find((item) => item.summary.includes("Worktree"));
    expect(recordOf(activity?.detail?.worktree)?.preserved).toBe(true);
    const branch = str(recordOf(activity?.detail?.worktree)?.branch);
    const worktreeList = spawnSync("git", ["-C", fixture.repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(worktreeList).toContain(branch);
    if (stubPid > 0) await until(() => !alive(stubPid));
  });

  it("wakes a parked slot even while a dispatch waits for the only slot", async () => {
    const fixture = await makeFixture({ mode: "needs-input", concurrency: 1 });
    fixture.control.enqueueDispatch("TEST-HEAD-OF-LINE", "attempt-parked");
    await until(async () => (await events(fixture)).some((item) => item.event === "asked"));
    // With maxConcurrency=1 this dispatch cannot get a slot until the parked
    // one finishes; the input_resolved below must still reach the parked one.
    // The queued stub runs a normal turn so it can complete once unblocked.
    process.env.STUB_ACP_MODE = "normal";
    fixture.control.enqueueDispatch("TEST-QUEUED", "attempt-queued");
    const question = fixture.control.questionsFor("TEST-HEAD-OF-LINE")[0];
    fixture.control.enqueueInputResolved("attempt-parked", {
      questionId: question?.id ?? "",
      resolution: "answered",
      answer: "Proceed",
    });
    await until(
      () => sessions(fixture).filter((session) => session.status === "completed").length === 2,
    );
    expect((await events(fixture)).some((item) => item.event === "resumed")).toBe(true);
  });

  it("rejects an oversized permission request without selecting a standing grant", async () => {
    const fixture = await makeFixture({ mode: "oversized-permission" });
    fixture.control.enqueueDispatch("TEST-BIG-PERMISSION", "attempt-big-permission");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    const result = (await events(fixture)).find((item) => item.event === "permission_result");
    expect(result).toMatchObject({ id: 9100, outcome: "cancelled" });
    expect(result?.optionId).toBeUndefined();
  });

  it("does not park when a normal turn only mentions ask_for_input in its text", async () => {
    const fixture = await makeFixture({ mode: "mentions-input" });
    fixture.control.enqueueDispatch("TEST-MENTIONS", "attempt-mentions");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    expect(fixture.control.questionsFor("TEST-MENTIONS")).toHaveLength(0);
    expect(fixture.lines.some((line) => line.includes("parked the ACP session"))).toBe(false);
  });

  it("deduplicates a buffered input_resolved and ignores stale question ids", async () => {
    const fixture = await makeFixture({ mode: "needs-input" });
    fixture.control.enqueueDispatch("TEST-DEDUP", "attempt-dedup");
    await until(async () => (await events(fixture)).some((item) => item.event === "asked"));
    const question = fixture.control.questionsFor("TEST-DEDUP")[0];
    for (let index = 0; index < 3; index += 1) {
      fixture.control.enqueueInputResolved("attempt-dedup", {
        questionId: question?.id ?? "",
        resolution: "answered",
        answer: "Only once",
      });
    }
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    const prompts = (await events(fixture)).filter(
      (item) => item.event === "prompt" && typeof item.turn === "number",
    );
    expect(prompts).toHaveLength(2);
    expect(str(prompts[1]?.text)).toContain("Only once");
  });

  it("does not lose an input_resolved that arrives before the parked check", async () => {
    const fixture = await makeFixture({ mode: "needs-input" });
    fixture.control.enqueueDispatch("TEST-EARLY-ANSWER", "attempt-early-answer");
    fixture.control.enqueueInputResolved("attempt-early-answer", {
      questionId: "question-queued-before-park",
      resolution: "answered",
      answer: "Queued before the question was recorded",
    });
    const session = await settledSession(fixture).catch(async (error) => {
      throw new Error(
        `${String(error)} lines=${fixture.lines.join(" | ")} events=${JSON.stringify(await events(fixture))}`,
      );
    });
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    const resumed = (await events(fixture)).find(
      (item) => item.event === "prompt" && item.turn === 2,
    );
    expect(str(resumed?.text)).toContain("Queued before the question was recorded");
  });

  it("preserves a clean worktree when a deadline pause follows a racing 401 cancel", async () => {
    let controller: SlotController | undefined;
    const fixture = await makeFixture({
      mode: "needs-input",
      cancelGraceMs: 80,
      onController: (attached) => {
        controller = attached;
      },
    });
    fixture.control.enqueueDispatch("TEST-PAUSE-AFTER-401", "attempt-pause-after-401");
    await until(async () => (await events(fixture)).some((item) => item.event === "asked"));
    expect(controller).toBeDefined();
    controller?.requestCancel("revoked");
    controller?.requestCancel("question_paused");
    await until(() => fixture.lines.some((line) => line.includes("question deadline paused")));
    const activity = activities(fixture).find((item) =>
      item.summary.includes("Worktree preserved"),
    );
    expect(activity?.summary).toContain("paused=true");
    expect(recordOf(activity?.detail?.worktree)?.preserved).toBe(true);
    const branch = str(recordOf(activity?.detail?.worktree)?.branch);
    const worktreeList = spawnSync("git", ["-C", fixture.repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(worktreeList).toContain(branch);
    expect(fixture.control.recordedStopCalls()).toEqual([]);
  });

  it("drains a disconnected slot before shutdown completes", async () => {
    const fixture = await makeFixture({ mode: "ignore-term", cancelGraceMs: 80 });
    fixture.control.enqueueDispatch("TEST-13", "attempt-13");
    await until(async () => (await events(fixture)).some((item) => item.event === "hanging"));
    fixture.stop.abort();
    await until(async () => {
      const recorded = await events(fixture);
      return (
        recorded.some((item) => item.event === "cancel") &&
        recorded.some((item) => item.event === "sigterm")
      );
    });
    let resolved = false;
    void fixture.done.then(() => {
      resolved = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(resolved).toBe(false);
    await fixture.done;
    expect(resolved).toBe(true);
  });
});

const catalogWithDefault = (defaultModel: string): HarnessCatalog => {
  const at = new Date().toISOString();
  return {
    harnesses: [
      {
        id: "custom",
        displayName: "Node stub",
        source: "override",
        defaultModel,
        models: [
          {
            id: defaultModel,
            label: "Stub Deep",
            reasoningDiscovery: "known",
            supportedEfforts: ["low", "medium", "high"],
            defaultEffort: "medium",
            probedAt: at,
          },
        ],
        probedAt: at,
      },
    ],
    probedAt: at,
  };
};

describe("per-dispatch harness, model and effort (#241)", { timeout: 30_000 }, () => {
  it("applies the chosen Harness, model and effort over ACP", async () => {
    const fixture = await makeFixture({ mode: "normal" });
    fixture.control.enqueueDispatch("TEST-241-MODEL", undefined, {
      harness: "custom",
      model: "stub-deep",
      effort: "high",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const recorded = await events(fixture);
    const sets = recorded.filter((item) => item.event === "set_config_option");
    expect(sets.find((item) => item.configId === "model")?.value).toBe("stub-deep");
    expect(sets.find((item) => item.configId === "thought_level")?.value).toBe("high");
    // The model is applied before the turn starts, not after it.
    const promptAt = recorded.find((item) => item.event === "prompt")?.at ?? 0;
    const modelAt = sets.find((item) => item.configId === "model")?.at ?? Number.MAX_SAFE_INTEGER;
    expect(modelAt).toBeLessThanOrEqual(promptAt);
  });

  it("passes the cached Harness default model when the dispatch omits one", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      cachedCatalog: catalogWithDefault("stub-deep"),
      defaultModel: "stub-deep",
    });
    fixture.control.enqueueDispatch("TEST-241-DEFAULT", undefined, { harness: "custom" });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const sets = (await events(fixture)).filter((item) => item.event === "set_config_option");
    expect(sets.find((item) => item.configId === "model")?.value).toBe("stub-deep");
  });

  it("fails fast with a typed diagnostic when the Harness is not local", async () => {
    const fixture = await makeFixture({ mode: "normal" });
    fixture.control.enqueueDispatch("TEST-241-MISSING", undefined, {
      harness: "definitely-not-local",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("released");

    await until(() => fixture.control.chunks().some((chunk) => chunk.kind === "diagnostic"));
    const diagnostic = fixture.control
      .chunks()
      .find((chunk) => chunk.kind === "diagnostic")?.diagnostic;
    expect(diagnostic).toMatchObject({
      kind: "harness_unavailable",
      harness: "definitely-not-local",
    });
    // Local-only resolution never spawns the server-supplied id.
    expect((await events(fixture)).some((item) => item.event === "initialize")).toBe(false);
  });

  it("reports a rejected model as a typed diagnostic and releases the session", async () => {
    const fixture = await makeFixture({ mode: "normal", rejectModel: "stub-deep" });
    fixture.control.enqueueDispatch("TEST-241-REJECT", undefined, {
      harness: "custom",
      model: "stub-deep",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("released");

    await until(() => fixture.control.chunks().some((chunk) => chunk.kind === "diagnostic"));
    const diagnostic = fixture.control
      .chunks()
      .find((chunk) => chunk.kind === "diagnostic")?.diagnostic;
    expect(diagnostic).toMatchObject({ kind: "model_rejected", model: "stub-deep" });
    // The Harness did spawn before rejecting the model.
    expect((await events(fixture)).some((item) => item.event === "session/new")).toBe(true);
  });

  it("omits unsupported effort with a warning chunk and keeps the turn alive", async () => {
    const fixture = await makeFixture({ mode: "normal", rejectEffort: true });
    fixture.control.enqueueDispatch("TEST-241-EFFORT", undefined, {
      harness: "custom",
      effort: "high",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    await until(() =>
      fixture.control.chunks().some((chunk) => chunk.eventType === "effort_unsupported"),
    );
    const warning = fixture.control
      .chunks()
      .find((chunk) => chunk.eventType === "effort_unsupported");
    expect(warning?.summary).toContain("does not support effort 'high'");
    expect((await events(fixture)).some((item) => item.event === "prompt")).toBe(true);
  });

  it("uses local CLI defaults when the dispatch carries no options", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      defaults: { harness: "custom", model: "stub-deep", effort: "high" },
    });
    fixture.control.enqueueDispatch("TEST-241-CLI");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const sets = (await events(fixture)).filter((item) => item.event === "set_config_option");
    expect(sets.find((item) => item.configId === "model")?.value).toBe("stub-deep");
    expect(sets.find((item) => item.configId === "thought_level")?.value).toBe("high");
  });

  it("never bleeds CLI default model/effort onto a different Harness or model", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      defaults: { harness: "other-harness", model: "other-model", effort: "high" },
    });
    fixture.control.enqueueDispatch("TEST-241-NO-BLEED", undefined, { harness: "custom" });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const sets = (await events(fixture)).filter((item) => item.event === "set_config_option");
    expect(sets.some((item) => item.value === "other-model")).toBe(false);
    expect(sets.some((item) => item.value === "high")).toBe(false);
  });

  it("never inherits CLI default effort when the dispatch overrides the model", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      defaults: { harness: "custom", model: "stub-deep", effort: "high" },
    });
    fixture.control.enqueueDispatch("TEST-241-MODEL-OVERRIDE", undefined, {
      harness: "custom",
      model: "stub-fast",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const sets = (await events(fixture)).filter((item) => item.event === "set_config_option");
    expect(sets.find((item) => item.configId === "model")?.value).toBe("stub-fast");
    expect(sets.some((item) => item.configId === "thought_level")).toBe(false);
  });
});

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSupervisionConfig } from "./config.ts";
import type { HarnessCatalog } from "@orrery/contract";
import type { HarnessDefinition } from "./harnesses.ts";
import type { SlotController } from "./slots.ts";
import { start } from "./start.ts";
import { TestOrrery, type TestActivity, type TestSession } from "./test-orrery.ts";

interface Fixture {
  root: string;
  repo: string;
  worktrees: string;
  marker: string;
  defaultFile: string;
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
  harnessDefinitions?: HarnessDefinition[] | undefined;
  harnessCatalog?: HarnessCatalog | undefined;
  /** Simulated CLI default file used by targeted probe tests (#242). */
  defaultFile?: string | undefined;
  catalogProbeTimeoutMs?: number | undefined;
  defaults?: { harness?: string; model?: string; effort?: string } | undefined;
  onController?: ((controller: SlotController) => void) | undefined;
}

const stubPath = fileURLToPath(new URL("./stub-acp.ts", import.meta.url));
const fixtures: Fixture[] = [];
const savedEnv = {
  STUB_ACP_MODE: process.env.STUB_ACP_MODE,
  STUB_ACP_MARKER: process.env.STUB_ACP_MARKER,
  STUB_ACP_SLEEP_MS: process.env.STUB_ACP_SLEEP_MS,
  STUB_ACP_DEFAULT_FILE: process.env.STUB_ACP_DEFAULT_FILE,
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
  const defaultFile = join(root, "cli-default.txt");
  await writeFile(defaultFile, "stub-model-1");
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
  process.env.STUB_ACP_DEFAULT_FILE = options.defaultFile ?? defaultFile;
  process.env.STUB_ACP_SLEEP_MS = String(options.sleepMs ?? 0);
  const stop = new AbortController();
  const lines: string[] = [];
  const config = loadSupervisionConfig({
    acp: { command: process.execPath, args: [stubPath] },
    ...(options.leaseRenewMs === undefined ? {} : { leaseRenewMs: options.leaseRenewMs }),
    ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
    worktreeRoot: worktrees,
  });
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
    ...(options.harnessDefinitions === undefined
      ? {}
      : { harnessDefinitions: options.harnessDefinitions }),
    ...(options.harnessCatalog === undefined ? {} : { harnessCatalog: options.harnessCatalog }),
    ...(options.catalogProbeTimeoutMs === undefined
      ? {}
      : { catalogProbeTimeoutMs: options.catalogProbeTimeoutMs }),
    ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
  });
  const result: Fixture = {
    root,
    repo,
    worktrees,
    marker,
    defaultFile,
    control,
    stop,
    lines,
    done,
  };
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
    return (await readFile(fixture.marker, "utf8"))
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
      });
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

  it("appends requester instructions after the operational ACP preamble", async () => {
    const fixture = await makeFixture({ mode: "normal" });
    fixture.control.enqueueDispatch(
      "TEST-PROMPT",
      "attempt-prompt",
      "  Use an additive migration and add a regression test.  ",
    );
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const prompts = (await events(fixture)).filter((item) => item.event === "prompt");
    expect(prompts).toHaveLength(1);
    const text = str(prompts[0]?.text);
    expect(text).toContain("Work on issue TEST-42");
    expect(text).toContain("Do not write outside this worktree.");
    expect(text).toContain("Additional instructions from the requester:");
    expect(text).toContain("Use an additive migration and add a regression test.");
    expect(text.indexOf("Do not write outside this worktree.")).toBeLessThan(
      text.indexOf("Additional instructions from the requester:"),
    );
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

  it("applies the requested model and effort, using the cached defaultModel when omitted", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      harnessDefinitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          command: process.execPath,
          args: [stubPath],
        },
      ],
      harnessCatalog: {
        probedAt: "2026-01-01T00:00:00.000Z",
        harnesses: [
          {
            id: "opencode",
            displayName: "OpenCode",
            defaultModel: "stub-model-1",
            models: [
              {
                id: "stub-model-1",
                reasoningDiscovery: "known",
                supportedEfforts: ["low", "high"],
                defaultEffort: "low",
              },
            ],
            probedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    fixture.control.enqueueDispatch("TEST-241-1", "attempt-241-1", undefined, {
      harness: "opencode",
      effort: "high",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    const recorded = await events(fixture);
    expect(recorded.find((item) => item.event === "set_model")).toMatchObject({
      modelId: "stub-model-1",
    });
    expect(recorded.find((item) => item.event === "set_config_option")).toMatchObject({
      optionId: "thought_level",
      value: "high",
    });
  });

  it("fails fast with a typed diagnostic and releases the session for a missing Harness", async () => {
    const fixture = await makeFixture({ mode: "normal", harnessDefinitions: [] });
    fixture.control.enqueueDispatch("TEST-241-2", "attempt-241-2", undefined, {
      harness: "cursor",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("released");
    expect(session.stopOutcome).toBe("released");
    await until(() =>
      fixture.control.chunks().some((chunk) => chunk.diagnostic?.kind === "acp_not_installed"),
    );
    expect(fixture.control.chunks().find((chunk) => chunk.diagnostic !== undefined)).toMatchObject({
      diagnostic: { kind: "acp_not_installed", harness: "cursor" },
    });
    expect((await events(fixture)).some((item) => item.event === "prompt")).toBe(false);
  });

  it("fails fast with a typed diagnostic when the harness rejects the model", async () => {
    const fixture = await makeFixture({
      mode: "model-reject",
      harnessDefinitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          command: process.execPath,
          args: [stubPath],
        },
      ],
    });
    fixture.control.enqueueDispatch("TEST-241-3", "attempt-241-3", undefined, {
      harness: "opencode",
      model: "stub-model-2",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("released");
    await until(() =>
      fixture.control.chunks().some((chunk) => chunk.diagnostic?.kind === "acp_spawn_failed"),
    );
    expect((await events(fixture)).some((item) => item.event === "prompt")).toBe(false);
  });

  it("spools acp_spawn_failed and releases the session when the executable is missing", async () => {
    const missing = join(tmpdir(), `orrery-missing-harness-${Date.now()}`);
    const fixture = await makeFixture({
      mode: "normal",
      harnessDefinitions: [
        {
          id: "opencode",
          displayName: "Missing harness",
          command: missing,
          args: ["acp"],
        },
      ],
    });
    fixture.control.enqueueDispatch("TEST-241-5", "attempt-241-5", undefined, {
      harness: "opencode",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("released");
    await until(() =>
      fixture.control.chunks().some((chunk) => chunk.diagnostic?.kind === "acp_spawn_failed"),
    );
    expect(fixture.lines.join("\n")).toContain("ACP start failed");
    expect((await events(fixture)).some((item) => item.event === "prompt")).toBe(false);
  });

  it("omits an unsupported effort with a non-fatal warning and still completes", async () => {
    const fixture = await makeFixture({
      mode: "effort-reject",
      harnessDefinitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          command: process.execPath,
          args: [stubPath],
        },
      ],
    });
    fixture.control.enqueueDispatch("TEST-241-4", "attempt-241-4", undefined, {
      harness: "opencode",
      model: "stub-model-1",
      effort: "ultra",
    });
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    expect(session.stopOutcome).toBe("review");
    await until(() => fixture.control.chunks().some((chunk) => chunk.eventType === "warning"));
    expect(
      fixture.control.chunks().find((chunk) => chunk.eventType === "warning")?.summary,
    ).toContain("ultra");
    expect((await events(fixture)).some((item) => item.event === "prompt")).toBe(true);
  });

  it("does not re-apply start-time defaults to a queued Dispatch snapshot", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      harnessDefinitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          command: process.execPath,
          args: [stubPath],
        },
      ],
      // Current process flags; the server snapshot below was created without
      // them and must stay authoritative.
      defaults: { harness: "opencode", model: "stub-model-2", effort: "high" },
    });
    fixture.control.enqueueDispatch("TEST-241-5", "attempt-241-5");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    const recorded = await events(fixture);
    expect(
      recorded.filter((item) => item.event === "set_model").map((item) => item.modelId),
    ).not.toContain("stub-model-2");
    expect(
      recorded.filter((item) => item.event === "set_config_option").map((item) => item.value),
    ).not.toContain("high");
    expect(recorded.some((item) => item.event === "prompt")).toBe(true);
  });

  it("applies the cached default model of the local default Harness when nothing is selected", async () => {
    const fixture = await makeFixture({
      mode: "normal",
      harnessDefinitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          command: process.execPath,
          args: [stubPath],
        },
      ],
      harnessCatalog: {
        probedAt: "2026-01-01T00:00:00.000Z",
        harnesses: [
          {
            id: "opencode",
            displayName: "OpenCode",
            defaultModel: "stub-model-1",
            models: [
              {
                id: "stub-model-1",
                reasoningDiscovery: "known",
                supportedEfforts: ["low", "high"],
                defaultEffort: "low",
              },
            ],
            probedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    // No harness, model or effort on the Dispatch and no CLI defaults: the
    // Harness backing the effective ACP command supplies its cached default.
    fixture.control.enqueueDispatch("TEST-241-6", "attempt-241-6");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");
    const recorded = await events(fixture);
    expect(recorded.find((item) => item.event === "set_model")).toMatchObject({
      modelId: "stub-model-1",
    });
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

describe("on-demand catalog probes (#242)", { timeout: 30_000 }, () => {
  it("runs probe_catalog with every work slot busy and publishes the refresh", async () => {
    const fixture = await makeFixture({ mode: "hang", concurrency: 1 });
    fixture.control.enqueueDispatch("PROBE-BUSY", "attempt-probe-busy");
    await until(() => sessions(fixture).length === 1);
    expect(sessions(fixture)[0]?.status).toBe("active");

    fixture.control.enqueueProbe("probe_catalog");
    await until(async () => {
      const recorded = await events(fixture);
      return recorded.filter((item) => item.event === "catalog-probe").length >= 2;
    });

    // A busy work slot never head-of-line blocks the runner-level command.
    expect(sessions(fixture)[0]?.status).toBe("active");
    expect(fixture.control.publishedCatalogs().length).toBeGreaterThanOrEqual(2);
  });

  it("publishes an empty catalog for probe_catalog when the local registry is empty", async () => {
    const fixture = await makeFixture({ mode: "normal", harnessDefinitions: [] });
    await until(() => fixture.control.publishedCatalogs().length >= 1);
    expect(fixture.control.publishedCatalogs().at(-1)?.harnesses).toEqual([]);
    fixture.control.enqueueProbe("probe_catalog");
    await until(() => fixture.control.publishedCatalogs().length >= 2);
    expect(fixture.control.publishedCatalogs().at(-1)?.harnesses).toEqual([]);
  });

  it("does not wipe the catalog when every probe_catalog probe fails", async () => {
    const missing = join(tmpdir(), `orrery-missing-catalog-${Date.now()}`);
    const fixture = await makeFixture({
      mode: "normal",
      harnessDefinitions: [
        { id: "missing", displayName: "Missing", command: missing, args: ["acp"] },
      ],
      catalogProbeTimeoutMs: 300,
    });
    await until(() => fixture.lines.join("\n").includes("probe failed"));
    expect(fixture.control.publishedCatalogs()).toHaveLength(0);
    fixture.control.enqueueProbe("probe_catalog");
    await until(() => fixture.lines.join("\n").split("probe failed").length >= 3, 3000);
    expect(fixture.control.publishedCatalogs()).toHaveLength(0);
  });

  it("shares one lock with an alias dispatch and publishes discovered efforts", async () => {
    const stub = { command: process.execPath, args: [stubPath] };
    const definitions = [
      { id: "alias-a", displayName: "Alias A", ...stub, args: [...stub.args] },
      { id: "alias-b", displayName: "Alias B", ...stub, args: [...stub.args] },
    ];
    const fixture = await makeFixture({
      mode: "model-aware",
      concurrency: 1,
      harnessDefinitions: definitions,
      catalogProbeTimeoutMs: 1200,
    });
    await until(() => fixture.control.publishedCatalogs().length >= 1);

    fixture.control.enqueueProbe("probe_model", {
      harness: "alias-b",
      model: "stub-model-2",
    });
    fixture.control.enqueueDispatch("PROBE-LOCK", "attempt-probe-lock");
    const session = await settledSession(fixture);
    expect(session.status).toBe("completed");

    const recorded = await events(fixture);
    const indices = (predicate: (item: MarkerEvent) => boolean) =>
      recorded.flatMap((item, index) => (predicate(item) ? [index] : []));
    const switchIndex =
      indices((item) => item.event === "set_model" && item.modelId === "stub-model-2")[0] ?? -1;
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    const restoreIndex = recorded.findIndex(
      (item, index) => index > switchIndex && item.event === "set_model",
    );
    expect(restoreIndex).toBeGreaterThan(switchIndex);
    expect(recorded[restoreIndex]).toMatchObject({ modelId: "stub-model-1" });
    // One CLI default backs both aliases: no dispatch ACP session may start
    // between the probe's switch and its confirmed restore.
    expect(
      recorded.slice(switchIndex + 1, restoreIndex).filter((item) => item.event === "session/new"),
    ).toHaveLength(0);

    const published = fixture.control.publishedCatalogs().at(-1);
    expect(published?.harnesses.find((item) => item.id === "alias-b")?.models).toContainEqual(
      expect.objectContaining({
        id: "stub-model-2",
        reasoningDiscovery: "known",
        supportedEfforts: ["balanced", "fast"],
      }),
    );
    expect(await readFile(fixture.defaultFile, "utf8")).toBe("stub-model-1");
  });

  it("does not run a replayed probe twice while the first is active", async () => {
    const fixture = await makeFixture({
      mode: "probe-timeout",
      concurrency: 1,
      catalogProbeTimeoutMs: 300,
    });
    fixture.control.enqueueProbe("probe_model", {
      harness: "custom",
      model: "stub-model-2",
    });
    // The same command replayed with a new seq (as a missed ack would deliver).
    fixture.control.enqueueProbe("probe_model", {
      harness: "custom",
      model: "stub-model-2",
    });
    await until(async () =>
      (await events(fixture)).some(
        (item) => item.event === "set_model" && item.modelId === "stub-model-2",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const switchEvents = (await events(fixture)).filter(
      (item) => item.event === "set_model" && item.modelId === "stub-model-2",
    );
    expect(switchEvents).toHaveLength(1);
  });
});

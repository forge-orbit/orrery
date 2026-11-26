import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  DispatchAcceptance,
  DispatchCommandPayload,
  InputResolvedCommandPayload,
  SessionDiagnostic,
} from "@orrery/contract";
import { AcpStdioClient } from "./acp.ts";
import { adapterForHarness, type AdapterResolver } from "./adapter.ts";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import type { SupervisionConfig } from "./config.ts";
import { ephemeralMcpConfig } from "./config.ts";
import {
  harnessLockKey,
  HarnessLocks,
  resolveHarness,
  type HarnessDefinition,
} from "./harnesses.ts";
import { McpAuthError, RunnerMcpClient } from "./mcp-client.ts";
import {
  createStreamSpool,
  mainRepositoryRoot,
  spoolDirectory,
  type StreamSpool,
} from "./spool.ts";
import type { Slot, SlotController, SlotPool } from "./slots.ts";
import {
  cleanupWorktree,
  createWorktree,
  inspectWorktree,
  type WorktreeHandle,
} from "./worktree.ts";

export interface SupervisionOptions {
  server: string;
  repoPath: string;
  /** The enrolled host credential (`orr_rh_...`) the stream endpoint requires. */
  credential: string;
  config: SupervisionConfig;
  acceptance: DispatchAcceptance;
  command: DispatchCommandPayload;
  slot: Slot;
  pool: SlotPool;
  signal: AbortSignal;
  write: (line: string) => void;
  /** Shared across probes and dispatches so one Harness never spawns twice. */
  locks?: HarnessLocks | undefined;
  /** Test seam: inject a pure HarnessAdapter resolver; defaults to the registry. */
  adapterFor?: AdapterResolver | undefined;
  /** The Harness's cached default model, read from the local catalog. */
  defaultModelFor?: ((harnessId: string) => string | null) | undefined;
  /** Called as soon as the controller exists, before any local work starts. */
  onController?: ((controller: SlotController) => void) | undefined;
}

/** A dispatch option failure that must surface as a typed Studio diagnostic. */
class DispatchOptionError extends Error {
  readonly diagnostic: SessionDiagnostic;

  constructor(diagnostic: SessionDiagnostic) {
    super(diagnostic.message);
    this.name = "DispatchOptionError";
    this.diagnostic = diagnostic;
  }
}

type RaceResult =
  | { kind: "prompt"; value: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "cancel"; reason: string }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null };

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

/**
 * Supervise one accepted dispatch inside its isolated worktree: spawn ACP,
 * renew the lease, enforce the local permission policy, terminate on cancel or
 * revocation, then report and either prune or preserve the worktree.
 */
export async function superviseDispatch(options: SupervisionOptions): Promise<SlotController> {
  const { acceptance, command, slot, pool, config, write } = options;
  const { dispatch, session, run } = acceptance;
  const token = acceptance.dispatchToken;
  const issueId = command.issueId;
  const sessionId = session.id;
  const mcp = new RunnerMcpClient({ server: options.server, token, signal: options.signal });
  const dispatchClient = new OrreryClient({ server: options.server, credential: token });

  let resolveCancelled: ((reason: string) => void) | undefined;
  const cancelled = new Promise<string>((resolve) => {
    resolveCancelled = resolve;
  });
  let cancelledAlready = false;
  let cancelledReason = "";
  let revoked = false;
  let stopRenewal = false;
  const dispatchAbort = new AbortController();
  // A deadline pause can arrive after a racing renewal 401 already cancelled
  // the slot. Remember it independently so a clean worktree is still preserved.
  let pausedByDeadline = false;
  const resolvedQuestions = new Set<string>();
  const requestCancel = (reason: string): void => {
    if (reason === "question_paused" || reason === "input_deadline_paused") {
      pausedByDeadline = true;
    }
    if (cancelledAlready) return;
    cancelledAlready = true;
    cancelledReason = reason;
    if (reason === "revoked") revoked = true;
    // A cancel (deadline pause, teammate Stop or revocation) ends the claim:
    // no more lease renewals, even while a parked ACP process is winding down.
    stopRenewal = true;
    dispatchAbort.abort(reason);
    pool.markDraining(slot);
    resolveCancelled?.(reason);
  };

  // `input_resolved` commands can arrive before the slot parks (the deadline
  // sweep is fast) or be redelivered after an unacknowledged command. Keep a
  // deduplicated queue keyed by questionId so no wakeup is lost or applied
  // twice; stale question ids are dropped outright.
  let resolveInput: ((payload: InputResolvedCommandPayload) => void) | undefined;
  const bufferedInputs: InputResolvedCommandPayload[] = [];
  const isFreshInput = (payload: InputResolvedCommandPayload): boolean =>
    !resolvedQuestions.has(payload.questionId);
  const requestResumeInput = (payload: InputResolvedCommandPayload): void => {
    if (!isFreshInput(payload)) return;
    if (bufferedInputs.some((item) => item.questionId === payload.questionId)) return;
    const wake = resolveInput;
    if (wake === undefined) {
      bufferedInputs.push(payload);
      return;
    }
    // `settle` clears the resolver, so a racing cancel or ACP exit cannot
    // resolve the same park twice.
    wake(payload);
  };
  const nextBufferedInput = (): InputResolvedCommandPayload | undefined =>
    bufferedInputs.find(isFreshInput);
  const takeBufferedInput = (): InputResolvedCommandPayload | undefined => {
    const index = bufferedInputs.findIndex(isFreshInput);
    if (index < 0) return undefined;
    return bufferedInputs.splice(index, 1)[0];
  };

  let resolveFinished: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const controller: SlotController = {
    dispatchId: dispatch.id,
    dispatchAttemptId: command.dispatchAttemptId,
    issueId,
    requestCancel,
    cancelled,
    requestResumeInput,
    finished,
    outcome: "unknown",
    lastSeq: 0,
  };
  pool.attach(slot, controller);
  options.onController?.(controller);

  let watchdog: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let spool: StreamSpool | undefined;
  let activeFlush: Promise<number> | undefined;
  let renewing = false;
  let acpRunning = false;
  let worktree: WorktreeHandle | undefined;
  let acp: AcpStdioClient | undefined;

  // Coalesce every flush (periodic tick, pre-stop, final safety net) into one
  // chain; StreamSpool also serializes internally, so no duplicate POSTs race.
  const flushSpool = (): Promise<number> => {
    if (spool === undefined) return Promise.resolve(0);
    const current = spool;
    activeFlush = (activeFlush ?? Promise.resolve(0))
      .catch(() => {})
      .then(() => current.flush())
      .catch((error: unknown) => {
        write(`Stream flush failed; will retry: ${String(error)}`);
        return 0;
      });
    return activeFlush;
  };
  const STREAM_ONLY_ACP_EVENTS = new Set([
    "available_commands_update",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "usage_update",
  ]);
  const spoolEvent = (method: string, params: unknown): void => {
    if (spool === undefined) return;
    const fields = recordOf(params);
    const update = recordOf(fields?.update);
    const name = recordOf(update)?.sessionUpdate;
    const raw = typeof name === "string" && name !== "" ? name : method.replace(/^session\//, "");
    const eventType = (raw || "update").slice(0, 64);
    // High-frequency ACP token/tool chunks belong in Live Studio, not in the
    // curated work_session_activities timeline (ADR-0010).
    const summary = STREAM_ONLY_ACP_EVENTS.has(eventType) ? undefined : `ACP ${eventType}`;
    void spool
      .append({
        kind: "event",
        eventType,
        ...(summary === undefined ? {} : { summary }),
        data: { params },
      })
      .then((chunk) => {
        controller.lastSeq = Math.max(controller.lastSeq, chunk.seq);
      })
      .catch((error: unknown) => write(`Could not spool ACP update: ${String(error)}`));
  };
  const spoolStderr = (line: string): void => {
    if (spool === undefined) return;
    void spool
      .append({ kind: "raw_output", data: { line: line.slice(0, 2000) } })
      .then((chunk) => {
        controller.lastSeq = Math.max(controller.lastSeq, chunk.seq);
      })
      .catch((error: unknown) => write(`Could not spool ACP stderr: ${String(error)}`));
  };
  /** One typed diagnostic chunk, awaited so it lands before the session release. */
  const appendDiagnostic = async (diagnostic: SessionDiagnostic): Promise<void> => {
    write(`Dispatch option diagnostic (${diagnostic.kind}): ${diagnostic.message}`);
    if (spool === undefined) return;
    try {
      const chunk = await spool.append({
        kind: "diagnostic",
        diagnostic,
        summary: diagnostic.message,
      });
      controller.lastSeq = Math.max(controller.lastSeq, chunk.seq);
    } catch (error) {
      write(`Could not spool diagnostic: ${String(error)}`);
    }
  };

  const abortListener = () => requestCancel("shutdown");
  options.signal.addEventListener("abort", abortListener, { once: true });
  if (options.signal.aborted) requestCancel("shutdown");

  try {
    // The spool lives in the main checkout, never in the isolated worktree, so
    // a preserved dirty worktree cannot hide live Studio chunks (#199).
    try {
      spool = await createStreamSpool({
        spoolDir: spoolDirectory(mainRepositoryRoot(options.repoPath)),
        dispatchAttemptId: command.dispatchAttemptId,
        apiBaseUrl: options.server,
        runnerId: dispatch.runnerId,
        dispatchId: dispatch.id,
        credential: options.credential,
      });
      flushTimer = setInterval(() => {
        void flushSpool();
      }, 1000);
      flushTimer.unref();
    } catch (error) {
      write(`Stream spool unavailable for this dispatch: ${String(error)}`);
    }

    // Resolve the requested Harness strictly against the local registry before
    // any worktree or ACP spawn: the server never supplies an executable.
    const requestedHarness = command.harness ?? config.defaults.harness;
    let harness: HarnessDefinition;
    if (requestedHarness === undefined) {
      // No override: keep the configured ACP command as the Runner default.
      // Explicit --acp-command overrides are published under id "custom" (PR #260).
      const id = config.acpOverridden ? "custom" : basename(config.acp.command);
      harness = {
        id,
        displayName: basename(config.acp.command) || id,
        source: "override",
        command: config.acp.command,
        args: [...config.acp.args],
      };
    } else {
      const resolved = await resolveHarness(
        requestedHarness,
        config.acpOverridden ? { command: config.acp.command, args: config.acp.args } : undefined,
      );
      if (resolved === undefined) {
        throw new DispatchOptionError({
          kind: "harness_unavailable",
          version: 1,
          message: `Harness '${requestedHarness}' is not installed on this Runner.`,
          harness: requestedHarness,
        });
      }
      harness = resolved;
    }
    // Resolved from the local definition only: the server never selects an
    // adapter or supplies an executable path.
    const adapter = (options.adapterFor ?? adapterForHarness)(harness);
    // Only inherit CLI default model/effort when the dispatch stays on the
    // default Harness (and, for effort, on the same model) so one Harness's
    // CLI defaults never bleed into a dispatch targeting another Harness.
    const harnessMatchesDefault =
      command.harness === undefined || command.harness === config.defaults.harness;
    const cliDefaultModel = harnessMatchesDefault ? config.defaults.model : undefined;
    const modelMatchesDefault =
      command.model === undefined || command.model === config.defaults.model;
    const requestedEffort =
      command.effort ??
      (harnessMatchesDefault && modelMatchesDefault ? config.defaults.effort : undefined);

    // The claim is already active; start renewing before any local work begins.
    watchdog = setInterval(() => {
      if (renewing || !acpRunning || revoked || stopRenewal) return;
      renewing = true;
      void dispatchClient
        .renewWorkSession(issueId, sessionId)
        .catch((error: unknown) => {
          if (
            error instanceof McpAuthError ||
            (error instanceof RunnerRequestError && error.status === 401)
          ) {
            revoked = true;
            write(`Dispatch token revoked; terminating local ACP process group.`);
            requestCancel("revoked");
          } else if (error instanceof RunnerRequestError && error.status === 409) {
            // A require_human deadline released the claim in Postgres. Stop
            // renewing and park no longer: preserve the local worktree so a
            // human can explicitly re-dispatch instead of losing context.
            write(`Work session claim is no longer active; preserving local worktree.`);
            requestCancel("question_paused");
          } else {
            write(`Lease renewal failed: ${String(error)}`);
          }
        })
        .finally(() => {
          renewing = false;
        });
    }, config.leaseRenewMs);

    let issueKey = issueId;
    try {
      const result = await mcp.callTool("get_issue", { issueId });
      const identifier = recordOf(recordOf(result)?.issue)?.identifier;
      if (typeof identifier === "string" && identifier !== "") issueKey = identifier;
    } catch {
      write(`Could not read issue identifier; using ${issueId} for the branch name.`);
    }

    if (cancelledAlready) throw new Error("dispatch cancelled before worktree creation");
    // Hash the full attempt id so parallel attempts that share a prefix never
    // collide on the same branch/worktree.
    const shortId = createHash("sha256")
      .update(command.dispatchAttemptId)
      .digest("hex")
      .slice(0, 8);
    worktree = await createWorktree(options.repoPath, issueKey, shortId, {
      ...(config.worktreeRoot === undefined ? {} : { root: config.worktreeRoot }),
      write,
    });
    write(`Worktree ${worktree.branch} @ ${worktree.path} ready for ${issueKey}.`);

    const mcpConfig = ephemeralMcpConfig({
      server: options.server,
      dispatchToken: token,
      issueId,
      runId: run.id,
      workSessionId: sessionId,
      dispatchAttemptId: command.dispatchAttemptId,
    });
    const mcpServers = [mcpConfig];

    if (cancelledAlready) throw new Error("dispatch cancelled before ACP start");
    const locks = options.locks ?? new HarnessLocks();
    const worktreePath = worktree.path;
    const worktreeReal = worktree.realPath;
    acp = await locks.run(harnessLockKey(harness), async () => {
      if (cancelledAlready) throw new Error("dispatch cancelled before ACP start");
      // Read the cached Harness default inside the per-Harness lock so a
      // dispatch queued behind a startup probe sees the freshly probed default.
      const requestedModel =
        command.model ?? cliDefaultModel ?? options.defaultModelFor?.(harness.id) ?? undefined;
      const client = await AcpStdioClient.start({
        command: harness.command,
        args: harness.args,
        cwd: worktreePath,
        env: Object.fromEntries(mcpConfig.env.map((item) => [item.name, item.value])),
        worktreeReal,
        mcpServers,
        signal: dispatchAbort.signal,
        onUpdate: (method, params) => spoolEvent(method, params),
        onStderr: (line) => {
          write(`acp stderr: ${line}`);
          spoolStderr(line);
        },
      });
      try {
        if (cancelledAlready) throw new Error("dispatch cancelled during ACP start");
        let application;
        try {
          application = await adapter.applyDispatchOptions(client, {
            ...(requestedModel === undefined ? {} : { model: requestedModel }),
            ...(requestedEffort === undefined ? {} : { effort: requestedEffort }),
          });
        } catch (error) {
          if (requestedModel !== undefined) {
            throw new DispatchOptionError({
              kind: "model_rejected",
              version: 1,
              message: `Harness '${harness.id}' rejected model '${requestedModel}': ${
                error instanceof Error ? error.message : String(error)
              }`,
              harness: harness.id,
              model: requestedModel,
            });
          }
          throw error;
        }
        if (requestedEffort !== undefined && !application.effortApplied) {
          // Non-fatal (issue #241): omit effort, warn in the stream, continue.
          const warning = `Harness '${harness.id}' does not support effort '${requestedEffort}'; continuing without it.`;
          write(warning);
          if (spool !== undefined) {
            try {
              const chunk = await spool.append({
                kind: "event",
                eventType: "effort_unsupported",
                summary: warning,
              });
              controller.lastSeq = Math.max(controller.lastSeq, chunk.seq);
            } catch (error) {
              write(`Could not spool effort warning: ${String(error)}`);
            }
          }
        }
        return client;
      } catch (error) {
        // Never leak the detached process group when a dispatch option fails.
        await client.forceExit(config.cancelGraceMs);
        throw error;
      }
    });
    acpRunning = true;
    write(`ACP ${harness.id} started (pid ${acp.pid}) in ${worktree.branch}.`);

    type ParkWake =
      | { kind: "resume"; payload: InputResolvedCommandPayload }
      | { kind: "cancel"; reason: string }
      | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null };

    /** Ask Orrery under the Dispatch token whether the agent left an open question. */
    const openQuestion = async (): Promise<Record<string, unknown> | undefined> => {
      try {
        const result = await mcp.callTool("list_issue_questions", { issueId });
        const values = recordOf(result)?.questions;
        const rows = Array.isArray(values) ? values : [];
        return rows.find(
          (row) =>
            recordOf(row)?.status === "open" && !resolvedQuestions.has(String(recordOf(row)?.id)),
        );
      } catch (error) {
        write(`Could not check issue questions; not parking: ${String(error)}`);
        return undefined;
      }
    };

    /** Block until a durable `input_resolved` wakes us, a cancel arrives, or ACP exits. */
    const waitForPark = (): Promise<ParkWake> => {
      // A cancel that arrived while openQuestion() was in flight has priority:
      // never resume a parked session after its claim has been released.
      if (cancelledAlready) return Promise.resolve({ kind: "cancel", reason: cancelledReason });
      const buffered = takeBufferedInput();
      if (buffered !== undefined) return Promise.resolve({ kind: "resume", payload: buffered });
      return new Promise<ParkWake>((resolve) => {
        const settle = (wake: ParkWake): void => {
          if (resolveInput === undefined) return;
          resolveInput = undefined;
          resolve(wake);
        };
        resolveInput = (payload) => settle({ kind: "resume", payload });
        void cancelled.then((reason) => settle({ kind: "cancel", reason }));
        if (acp !== undefined) {
          void acp.exited.then(({ code, signal }) => settle({ kind: "exit", code, signal }));
        }
      });
    };

    const basePrompt = `Work on issue ${issueKey} (${issueId}). Your cwd is the isolated worktree ${worktree.path} on branch ${worktree.branch}. Your Orrery work session (sessionId: ${sessionId}, runId: ${run.id}) is ALREADY claimed and active — do NOT call claim_issue. Orrery MCP is pre-wired with a dispatch-scoped token; use get_issue, report_progress, log_session_activity, create_comment, and stop_session directly. Do not write outside this worktree.`;
    // The requester's custom prompt always comes after the operational
    // preamble, under an explicit section header (issue #239).
    const requestedPrompt = command.prompt?.trim() ?? "";
    const prompt =
      requestedPrompt === ""
        ? basePrompt
        : `${basePrompt}\n\nAdditional instructions from the requester:\n${requestedPrompt}`;
    let outcome = await raceWork(acp, prompt, cancelled, options.signal, requestCancel);

    // A finished turn with an open question is a park, not a handoff: keep the
    // live ACP session and worktree intact, keep renewing the lease, and wait
    // for the durable outbox to carry the human answer (or fallback) back.
    // `cancelledAlready`/`revoked` can flip from a cancel command, an abort or
    // a failed renewal while we await the parked wake-up.
    const stillWorking = () => !cancelledAlready && !revoked;
    while (outcome.kind === "prompt" && stillWorking()) {
      const question = await openQuestion();
      const queuedInput = nextBufferedInput();
      if (question === undefined && queuedInput === undefined) break;
      const questionId =
        typeof question?.id === "string" ? question.id : (queuedInput?.questionId ?? "unknown");
      write(
        `Question ${questionId} is open; parked the ACP session and ${worktree.branch} while renewing the lease.`,
      );
      if (spool !== undefined) {
        void spool
          .append({
            kind: "event",
            eventType: "needs_input",
            summary: `Needs input: ${questionId}`,
            data: { questionId },
          })
          .then((chunk) => {
            controller.lastSeq = Math.max(controller.lastSeq, chunk.seq);
          })
          .catch((error: unknown) => write(`Could not spool needs-input event: ${String(error)}`));
      }
      const wake = await waitForPark();
      if (wake.kind !== "resume") {
        outcome =
          wake.kind === "cancel"
            ? { kind: "cancel", reason: wake.reason }
            : { kind: "exit", code: wake.code, signal: wake.signal };
        break;
      }
      resolvedQuestions.add(wake.payload.questionId);
      const answer = wake.payload.answer === "" ? "(no answer supplied)" : wake.payload.answer;
      const followUp =
        wake.payload.resolution === "fallback_used"
          ? `Continue issue ${issueKey} (${issueId}). The one-hour deadline passed, so the proposed fallback was authorized. Use this fallback as the answer to question ${wake.payload.questionId}: ${answer}`
          : `Continue issue ${issueKey} (${issueId}). A human answered question ${wake.payload.questionId}: ${answer}`;
      write(
        `Input resolved (${wake.payload.resolution}) for question ${wake.payload.questionId}; resuming the same ACP session in ${worktree.branch}.`,
      );
      outcome = await raceWork(acp, followUp, cancelled, options.signal, requestCancel);
    }

    const exit =
      outcome.kind === "prompt"
        ? await acp.forceExit(config.cancelGraceMs)
        : await acp.cancelAndKill(config.cancelGraceMs);
    const normal = outcome.kind === "prompt" && !revoked && (exit.code === 0 || exit.code === null);
    const reason =
      outcome.kind === "cancel"
        ? outcome.reason
        : outcome.kind === "error"
          ? "acp_crashed"
          : "turn_finished";
    write(`ACP exited (code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"}); ${reason}.`);

    // Report branch and dirty state while the claim (and token) are still live.
    const state = await inspectWorktree(worktree);
    let pruned = false;
    try {
      const summary =
        state.dirty || state.unpushed || pausedByDeadline
          ? `Worktree preserved: ${worktree.branch} (dirty=${state.dirty}, unpushed=${state.unpushed}, paused=${pausedByDeadline})`
          : `Worktree clean and pushed: ${worktree.branch}`;
      await mcp.callTool("log_session_activity", {
        issueId,
        kind: "status",
        summary,
        sessionId,
        detail: {
          worktree: {
            branch: worktree.branch,
            directory: worktree.path.split("/").pop() ?? worktree.path,
            dirty: state.dirty,
            unpushed: state.unpushed,
            ahead: state.ahead,
            preserved: state.dirty || state.unpushed || pausedByDeadline,
          },
        },
      });
    } catch (error) {
      const offline =
        error instanceof McpAuthError ||
        (error instanceof RunnerRequestError && error.status === 401);
      write(
        offline
          ? "Session already ended or token revoked; skipped worktree report."
          : `Could not report worktree state to Orrery: ${String(error)}`,
      );
    }

    // A require_human deadline released the claim and told us to stop: keep
    // even a clean worktree so re-dispatch can resume the same local context.
    pruned = pausedByDeadline ? false : await cleanupWorktree(worktree, state, write);
    if (pausedByDeadline) {
      write(`Preserved ${worktree.branch} after the question deadline paused the session.`);
    }

    // stop_session rolls the stream up immediately in Postgres. Every ACP
    // update and stderr line must be flushed BEFORE that call, or the final
    // chunks would land in the archived blob too late (or be pruned entirely).
    if (acp !== undefined) await acp.exited;
    await flushSpool();

    if (!revoked) {
      let status = "active";
      try {
        const result = await mcp.callTool("get_work_session", { issueId, sessionId });
        const value = recordOf(recordOf(result)?.session)?.status;
        if (typeof value === "string") status = value;
      } catch (error) {
        // Offline: the lease is the hard backstop and the server reconciles.
        write(
          `Could not read session status (${error instanceof Error ? error.message : String(error)}); treating as ended.`,
        );
        status = "unknown";
      }
      let stopOutcome: "review" | "released" = normal ? "review" : "released";
      if (status === "active") {
        try {
          await mcp.callTool("stop_session", { issueId, outcome: stopOutcome, sessionId });
          write(`Stopped work session as ${stopOutcome}.`);
        } catch (error) {
          write(`Could not stop work session (${stopOutcome}): ${String(error)}`);
        }
      } else {
        write(`Session already ${status}; the ACP agent stopped it itself.`);
        // A self-released/expired session is not a successful review: the
        // one-shot CLI must exit non-zero, and no second stop is needed.
        stopOutcome = status === "completed" ? "review" : "released";
      }
      controller.outcome =
        outcome.kind === "cancel"
          ? "cancelled"
          : outcome.kind === "error" || outcome.kind === "exit"
            ? "failed"
            : stopOutcome === "review"
              ? "completed"
              : "released";
    } else {
      write("Revoked: left session state to the server; worktree preserved if dirty.");
      controller.outcome = "revoked";
    }

    if (state.dirty || state.unpushed || pausedByDeadline) {
      write(
        `Preserved ${worktree.branch} (dirty=${state.dirty}, unpushed=${state.unpushed}, paused=${pausedByDeadline}, pruned=${pruned}).`,
      );
    }
  } catch (error) {
    write(`Dispatch supervision failed: ${String(error)}`);
    // Harness/model failures are diagnostics a project reader can act on; the
    // session is released below, so the Dispatch never looks merely crashed.
    if (error instanceof DispatchOptionError) await appendDiagnostic(error.diagnostic);
    controller.outcome = revoked ? "revoked" : cancelledAlready ? "cancelled" : "failed";
    if (acp !== undefined) await acp.forceExit(config.cancelGraceMs);
    // A failure before the ACP turn started must still release the claim and
    // never destroy a dirty or unpushed worktree.
    if (worktree !== undefined) {
      try {
        await cleanupWorktree(worktree, await inspectWorktree(worktree), write);
      } catch (cleanupError) {
        write(`Could not inspect worktree after setup failure: ${String(cleanupError)}`);
      }
    }
    // Same ordering as the success path: flush before the rollup trigger.
    await flushSpool();
    if (!revoked) {
      try {
        await mcp.callTool("stop_session", { issueId, outcome: "released", sessionId });
      } catch (stopError) {
        write(`Could not release session after setup failure: ${String(stopError)}`);
      }
    }
  } finally {
    if (watchdog !== undefined) clearInterval(watchdog);
    if (flushTimer !== undefined) clearInterval(flushTimer);
    // Final flush safety net for error/abort paths; coalesced with any flush
    // already in flight, so a repeated call cannot duplicate HTTP batches.
    await flushSpool();
    options.signal.removeEventListener("abort", abortListener);
    acpRunning = false;
    if (acp !== undefined) await acp.exited;
    pool.markDraining(slot);
    pool.release(slot);
    resolveFinished?.();
  }
  return controller;
}

async function raceWork(
  acp: AcpStdioClient,
  prompt: string,
  cancelled: Promise<string>,
  signal: AbortSignal,
  requestCancel: (reason: string) => void,
): Promise<RaceResult> {
  const onAbort = () => requestCancel("shutdown");
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      acp.prompt(prompt).then(
        (value): RaceResult => ({ kind: "prompt", value }),
        (error: unknown): RaceResult => ({ kind: "error", error }),
      ),
      cancelled.then((reason): RaceResult => ({ kind: "cancel", reason })),
      acp.exited.then((exit): RaceResult => ({
        kind: "exit",
        code: exit.code,
        signal: exit.signal,
      })),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

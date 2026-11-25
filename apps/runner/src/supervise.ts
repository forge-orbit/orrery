import { createHash } from "node:crypto";
import type { DispatchAcceptance, DispatchCommandPayload } from "@orrery/contract";
import { AcpStdioClient } from "./acp.ts";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import type { SupervisionConfig } from "./config.ts";
import { ephemeralMcpConfig } from "./config.ts";
import { McpAuthError, RunnerMcpClient } from "./mcp-client.ts";
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
  config: SupervisionConfig;
  acceptance: DispatchAcceptance;
  command: DispatchCommandPayload;
  slot: Slot;
  pool: SlotPool;
  signal: AbortSignal;
  write: (line: string) => void;
  /** Called as soon as the controller exists, before any local work starts. */
  onController?: ((controller: SlotController) => void) | undefined;
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
  let revoked = false;
  const requestCancel = (reason: string): void => {
    if (cancelledAlready) return;
    cancelledAlready = true;
    if (reason === "revoked") revoked = true;
    pool.markDraining(slot);
    resolveCancelled?.(reason);
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
    finished,
  };
  pool.attach(slot, controller);
  options.onController?.(controller);

  let watchdog: ReturnType<typeof setInterval> | undefined;
  let renewing = false;
  let acpRunning = false;
  let worktree: WorktreeHandle | undefined;
  let acp: AcpStdioClient | undefined;

  const abortListener = () => requestCancel("shutdown");
  options.signal.addEventListener("abort", abortListener, { once: true });
  if (options.signal.aborted) requestCancel("shutdown");

  try {
    // The claim is already active; start renewing before any local work begins.
    watchdog = setInterval(() => {
      if (renewing || !acpRunning || revoked) return;
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
    acp = await AcpStdioClient.start({
      command: config.acp.command,
      args: config.acp.args,
      cwd: worktree.path,
      env: Object.fromEntries(mcpConfig.env.map((item) => [item.name, item.value])),
      worktreeReal: worktree.realPath,
      mcpServers,
      onStderr: (line) => write(`acp stderr: ${line}`),
    });
    acpRunning = true;
    write(`ACP ${config.acp.command} started (pid ${acp.pid}) in ${worktree.branch}.`);

    const prompt = `Work on issue ${issueKey} (${issueId}). Your cwd is the isolated worktree ${worktree.path} on branch ${worktree.branch}. Orrery MCP is pre-wired with a dispatch-scoped token; use it for issue details and progress. Do not write outside this worktree.`;
    const outcome = await raceWork(acp, prompt, cancelled, options.signal, requestCancel);

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
        state.dirty || state.unpushed
          ? `Worktree preserved: ${worktree.branch} (dirty=${state.dirty}, unpushed=${state.unpushed})`
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
            preserved: state.dirty || state.unpushed,
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

    pruned = await cleanupWorktree(worktree, state, write);

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
      if (status === "active") {
        const stopOutcome = normal ? "review" : "released";
        try {
          await mcp.callTool("stop_session", { issueId, outcome: stopOutcome, sessionId });
          write(`Stopped work session as ${stopOutcome}.`);
        } catch (error) {
          write(`Could not stop work session (${stopOutcome}): ${String(error)}`);
        }
      } else {
        write(`Session already ${status}; the ACP agent stopped it itself.`);
      }
    } else {
      write("Revoked: left session state to the server; worktree preserved if dirty.");
    }

    if (state.dirty || state.unpushed) {
      write(
        `Preserved ${worktree.branch} (dirty=${state.dirty}, unpushed=${state.unpushed}, pruned=${pruned}).`,
      );
    }
  } catch (error) {
    write(`Dispatch supervision failed: ${String(error)}`);
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
    if (!revoked) {
      try {
        await mcp.callTool("stop_session", { issueId, outcome: "released", sessionId });
      } catch (stopError) {
        write(`Could not release session after setup failure: ${String(stopError)}`);
      }
    }
  } finally {
    if (watchdog !== undefined) clearInterval(watchdog);
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

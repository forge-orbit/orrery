import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import { readCredential } from "./credential.ts";
import { loadSupervisionConfig, type SupervisionConfig } from "./config.ts";
import { delay } from "./delay.ts";
import { SlotPool } from "./slots.ts";
import { superviseDispatch } from "./supervise.ts";

export interface StartOptions {
  server: string;
  workspaceId: string;
  projectId: string;
  agentId?: string | undefined;
  displayName?: string | undefined;
  capabilities?: string[] | undefined;
  maxConcurrency?: number | undefined;
  heartbeatMs?: number | undefined;
  commandWaitMs?: number | undefined;
  repoPath?: string | undefined;
  signal?: AbortSignal | undefined;
  write?: ((line: string) => void) | undefined;
  supervision?: SupervisionConfig | undefined;
}

/** Opaque digest of a checkout; the raw local path never leaves the machine. */
export function repoFingerprint(repoPath: string): string {
  return createHash("sha256")
    .update(realpathSync(resolve(repoPath)))
    .digest("hex");
}

/**
 * Register a project-bound Runner, then supervise accepted dispatches in a
 * bounded slot pool while heartbeating. A 401 on any call is a hard revocation:
 * terminate every local process group and stop local operation immediately.
 */
export async function start(options: StartOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stored = await readCredential();
  const pool = new SlotPool(options.maxConcurrency ?? 1);
  const controller = new AbortController();
  let revoked = false;
  const revoke = (message: string): void => {
    if (revoked) return;
    revoked = true;
    write(message);
    controller.abort();
    pool.cancelAll("revoked");
  };
  const onExternalAbort = () => {
    controller.abort();
    pool.cancelAll("shutdown");
  };
  if (options.signal?.aborted === true) controller.abort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const client = new OrreryClient({
    server: options.server,
    credential: stored.credential,
    signal: controller.signal,
  });
  const supervision = options.supervision ?? loadSupervisionConfig();
  const runner = await client.registerRunner({
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    repoFingerprint: repoFingerprint(options.repoPath ?? process.cwd()),
    capabilities: options.capabilities ?? [],
    maxConcurrency: options.maxConcurrency ?? 1,
  });
  write(`Runner ${runner.id} registered (${runner.presence}).`);

  const pending = new Set<Promise<unknown>>();
  let lastPresence = runner.presence;
  const heartbeatLoop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        await delay(options.heartbeatMs ?? 5000, controller.signal, "Runner stopped.");
        const state = await client.heartbeat(runner.id, { activeSlotCount: pool.used });
        if (state.presence !== lastPresence) {
          lastPresence = state.presence;
          write(`Runner presence: ${state.presence}.`);
        }
      } catch (error) {
        if (error instanceof RunnerRequestError && error.status === 401) {
          revoke(
            error.code === "runner_revoked"
              ? "Runner credential rejected (401). Stopping local operation immediately."
              : "Host credential rejected (401). Stopping local operation immediately.",
          );
          return;
        }
        if (error instanceof Error && error.message === "Runner stopped.") return;
        write(
          `Heartbeat failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
        await delay(1000, controller.signal, "Runner stopped.").catch(() => {});
      }
    }
  };

  const commandLoop = async (): Promise<void> => {
    let afterSeq = 0;
    // Commands applied above the pinned cursor are replayed by the outbox but
    // must not be applied twice while a dispatch waits for a free slot.
    const replayed = new Set<number>();
    while (!controller.signal.aborted) {
      let batch: Awaited<ReturnType<OrreryClient["pollCommands"]>>;
      try {
        batch = await client.pollCommands(runner.id, {
          afterSeq,
          ...(options.commandWaitMs === undefined ? {} : { waitMs: options.commandWaitMs }),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RunnerRequestError && error.status === 401) {
          revoke("Control plane rejected the Runner (401). Stopping local operation immediately.");
          return;
        }
        write(`Command poll failed; retrying: ${String(error)}`);
        await delay(1000, controller.signal, "Runner stopped.").catch(() => {});
        continue;
      }

      let blockedSeq: number | undefined;
      for (const command of batch.commands) {
        if (controller.signal.aborted) return;
        if (command.seq <= afterSeq || replayed.has(command.seq)) continue;
        if (Date.parse(command.expiresAt) <= Date.now()) {
          replayed.add(command.seq);
          continue;
        }
        if (command.kind === "dispatch") {
          const slot = pool.acquire();
          if (slot === undefined) {
            // Pin the cursor before this dispatch, but keep scanning the batch
            // so a later `cancel` or `input_resolved` is not head-of-line blocked.
            blockedSeq = Math.min(blockedSeq ?? command.seq, command.seq);
            continue;
          }
          try {
            const acceptance = await client.acceptDispatch(runner.id, command.dispatchId);
            const running = superviseDispatch({
              server: options.server,
              repoPath: options.repoPath ?? process.cwd(),
              config: supervision,
              acceptance,
              command: command.payload,
              slot,
              pool,
              signal: controller.signal,
              write,
            });
            pending.add(running);
            void running.finally(() => pending.delete(running));
            replayed.add(command.seq);
          } catch (error) {
            pool.release(slot);
            if (error instanceof RunnerRequestError && error.status === 401) {
              revoke("Dispatch acceptance rejected (401). Stopping local operation immediately.");
              return;
            }
            if (error instanceof RunnerRequestError && error.status >= 400 && error.status < 500) {
              // A permanent refusal will not improve on retry.
              write(`Rejected dispatch ${command.dispatchId}: ${String(error)}`);
              replayed.add(command.seq);
            } else {
              // Transient 5xx / network failures must be retried.
              write(`Could not accept dispatch ${command.dispatchId}; retrying: ${String(error)}`);
              blockedSeq = Math.min(blockedSeq ?? command.seq, command.seq);
            }
          }
          continue;
        }
        if (command.kind === "cancel") {
          pool.controllerFor(command.dispatchAttemptId)?.requestCancel(command.payload.reason);
          replayed.add(command.seq);
          continue;
        }
        // input_resolved resumes belong to the parked-session layer; acknowledge
        // the durable command so the outbox does not replay it forever.
        write(`Input resolved for ${command.dispatchId} (${command.payload.resolution}).`);
        replayed.add(command.seq);
      }

      // Advance only across a contiguous run of applied commands, stopping at
      // the first dispatch that is still waiting for a slot.
      let ackTarget = afterSeq;
      const maxSeq = batch.commands.reduce((max, command) => Math.max(max, command.seq), afterSeq);
      for (let seq = afterSeq + 1; seq <= maxSeq; seq += 1) {
        if (seq === blockedSeq || !replayed.has(seq)) break;
        ackTarget = seq;
      }
      if (ackTarget > afterSeq) {
        try {
          await client.ackCommands(runner.id, { upToSeq: ackTarget });
          afterSeq = ackTarget;
          for (const seq of replayed) if (seq <= afterSeq) replayed.delete(seq);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof RunnerRequestError && error.status === 401) {
            revoke("Command ack rejected (401). Stopping local operation immediately.");
            return;
          }
          write(`Command ack failed; retrying: ${String(error)}`);
        }
      }
      if (blockedSeq !== undefined)
        await delay(100, controller.signal, "Runner stopped.").catch(() => {});
    }
  };

  await Promise.all([heartbeatLoop(), commandLoop()]);
  options.signal?.removeEventListener("abort", onExternalAbort);
  pool.cancelAll("shutdown");
  await Promise.all(pending);
  await pool.drain();
  write("Runner stopped.");
}

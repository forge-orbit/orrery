import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { HarnessCatalog, ReadyWorkFilter } from "@orrery/contract";
import {
  catalogWithProbedModel,
  CatalogPublisher,
  harnessConfigKey,
  probeHarness,
  probeModel,
  readCachedCatalog,
  runStartupCatalogProbe,
} from "./catalog.ts";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import { readCredential } from "./credential.ts";
import { loadSupervisionConfig, type SupervisionConfig } from "./config.ts";
import { delay } from "./delay.ts";
import { executionChoicePayload, type ExecutionChoice } from "./dispatch-options.ts";
import { detectHarnesses, type HarnessDefinition } from "./harnesses.ts";
import { SlotPool, type SlotController } from "./slots.ts";
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
  /** Test/observability seam: called as soon as a dispatch controller exists. */
  onController?: ((controller: SlotController) => void) | undefined;
  /** Opt-in autonomous pickup from the bound project's ready queue. */
  autoClaim?: boolean | undefined;
  autoClaimFilter?: ReadyWorkFilter | undefined;
  autoClaimPollMs?: number | undefined;
  /** Bounded time budget for the one startup catalog probe pass (default: 5s). */
  catalogProbeTimeoutMs?: number | undefined;
  /** Test seams: inject the harness list and observe each published catalog. */
  harnessDefinitions?: HarnessDefinition[] | undefined;
  harnessCatalog?: HarnessCatalog | undefined;
  onCatalog?: ((catalog: HarnessCatalog) => void) | undefined;
  /** CLI defaults registered with the server for Dispatches it creates. */
  defaults?: ExecutionChoice | undefined;
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
  const fingerprint = repoFingerprint(options.repoPath ?? process.cwd());
  const configKey = harnessConfigKey(
    supervision.acpOverridden ? { acpOverride: supervision.acp } : {},
  );
  // Only a cache hit seeds registration: omitting the field lets the server keep
  // a previously stored catalog when this Runner re-registers before probing.
  const cached = readCachedCatalog(fingerprint, undefined, configKey);
  const runner = await client.registerRunner({
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    repoFingerprint: fingerprint,
    capabilities: options.capabilities ?? [],
    ...(cached === null ? {} : { harnessCatalog: cached }),
    // The server records these on every Dispatch it creates for this Runner
    // (UI delegation and auto-claim), so metadata matches local execution.
    defaults: executionChoicePayload(options.defaults),
    maxConcurrency: options.maxConcurrency ?? 1,
    ephemeral: false,
  });
  write(`Runner ${runner.id} registered (${runner.presence}).`);
  const publisher = new CatalogPublisher({
    client,
    runnerId: runner.id,
    repoFingerprint: fingerprint,
    configKey,
    onUnauthorized: (message) => revoke(message),
  });

  const localDefinitions = (): HarnessDefinition[] =>
    options.harnessDefinitions ??
    detectHarnesses(supervision.acpOverridden ? { acpOverride: supervision.acp } : {});

  /**
   * One discovery pass shared by startup and the `probe_catalog` command. An
   * empty local registry publishes an empty catalog; a registry whose probes
   * all fail keeps the last good catalog (ADR-0011, #242 follow-up A).
   */
  const probeCatalogOnce = async (): Promise<void> => {
    try {
      await runStartupCatalogProbe({
        definitions: localDefinitions(),
        probe: (definition) =>
          probeHarness(definition, {
            cwd: options.repoPath ?? process.cwd(),
            timeoutMs: options.catalogProbeTimeoutMs ?? 5000,
          }),
        publish: async (catalog) => {
          await publisher.publish(catalog);
          options.onCatalog?.(publisher.current);
        },
        isAborted: () => controller.signal.aborted,
        write,
      });
    } catch (error) {
      // A 401 already revoked locally via CatalogPublisher's callback.
      if (!controller.signal.aborted) write(`Catalog publish failed: ${String(error)}`);
    }
  };

  // Startup/recovery reconciliation marks uncertain attempts and lets an
  // agent reconnecting after sleep stream into Live Session Studio seamlessly.
  const reconnected = await client.reconnect(runner.id, { activeAttempts: [] }).catch((error) => {
    if (error instanceof RunnerRequestError && error.status === 401) {
      revoke("Reconnect rejected (401). Stopping local operation immediately.");
      return undefined;
    }
    write(`Reconnect report failed; continuing: ${String(error)}`);
    return undefined;
  });
  if (reconnected !== undefined && reconnected.resolutions.length > 0) {
    write(`Reconnect reconciled ${reconnected.resolutions.length} dispatch attempt(s).`);
  }
  if (controller.signal.aborted) {
    options.signal?.removeEventListener("abort", onExternalAbort);
    return;
  }

  const pending = new Set<Promise<unknown>>();
  // A transient network/server failure means the server may have marked our
  // attempts uncertain. Reconcile with the live slot cursors once it recovers.
  let needsReconnect = false;
  const reportActiveReconnect = async (reason: string): Promise<void> => {
    if (!needsReconnect || controller.signal.aborted) return;
    needsReconnect = false;
    try {
      const result = await client.reconnect(runner.id, { activeAttempts: pool.activeAttempts() });
      if (result.resolutions.length > 0) {
        write(`Reconnect (${reason}) reconciled ${result.resolutions.length} dispatch attempt(s).`);
      }
    } catch (error) {
      needsReconnect = true;
      if (error instanceof RunnerRequestError && error.status === 401) {
        revoke("Reconnect rejected (401). Stopping local operation immediately.");
        return;
      }
      write(`Reconnect (${reason}) failed; will retry: ${String(error)}`);
    }
  };

  let lastPresence = runner.presence;
  const heartbeatLoop = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        await delay(options.heartbeatMs ?? 5000, controller.signal, "Runner stopped.");
        const state = await client.heartbeat(runner.id, { activeSlotCount: pool.used });
        await reportActiveReconnect("heartbeat recovered");
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
        needsReconnect = true;
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
    // A replayed probe command must never run a second ACP session while the
    // first one is still switching the Harness's CLI default.
    const activeProbes = new Set<string>();
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
        needsReconnect = true;
        write(`Command poll failed; retrying: ${String(error)}`);
        await delay(1000, controller.signal, "Runner stopped.").catch(() => {});
        continue;
      }
      await reportActiveReconnect("command poll recovered");

      let blockedSeq: number | undefined;
      for (const command of batch.commands) {
        if (controller.signal.aborted) return;
        if (command.seq <= afterSeq || replayed.has(command.seq)) continue;
        if (Date.parse(command.expiresAt) <= Date.now()) {
          replayed.add(command.seq);
          continue;
        }
        if (command.kind === "probe_model" || command.kind === "probe_catalog") {
          // Probes never acquire a work slot: a full pool or a queued dispatch
          // must not head-of-line block catalog discovery (#242).
          const key =
            command.kind === "probe_model"
              ? `model\u0000${command.payload.harness}\u0000${command.payload.model}`
              : "catalog";
          if (activeProbes.has(key)) {
            replayed.add(command.seq);
            continue;
          }
          activeProbes.add(key);
          replayed.add(command.seq);
          const task = (async () => {
            try {
              if (command.kind === "probe_catalog") {
                await probeCatalogOnce();
                return;
              }
              const { harness, model } = command.payload;
              const definition = localDefinitions().find((item) => item.id === harness);
              if (definition === undefined) {
                write(`Probe rejected: Harness ${harness} is not in the local registry.`);
                return;
              }
              const result = await probeModel(definition, model, {
                cwd: options.repoPath ?? process.cwd(),
                timeoutMs: options.catalogProbeTimeoutMs ?? 5000,
                fallbackModel: publisher.current.harnesses.find((item) => item.id === harness)
                  ?.defaultModel,
              });
              write(
                `Probe ${harness}/${model}: ${result.status}; restored=${String(result.restored)}${result.recovery ? " via recovery" : ""}.`,
              );
              if (result.model !== undefined && result.restored) {
                await publisher.publish(
                  catalogWithProbedModel(publisher.current, definition, result.model),
                );
                options.onCatalog?.(publisher.current);
              }
            } catch (error) {
              if (!controller.signal.aborted) write(`Catalog probe failed: ${String(error)}`);
            } finally {
              activeProbes.delete(key);
            }
          })();
          pending.add(task);
          void task.finally(() => pending.delete(task));
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
              credential: stored.credential,
              config: supervision,
              acceptance,
              command: command.payload,
              slot,
              pool,
              signal: controller.signal,
              write,
              onController: options.onController,
              harnessDefinitions: options.harnessDefinitions,
              harnessCatalog: options.harnessCatalog ?? publisher.current,
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
        // Wake a parked slot even when every slot is taken by a queued
        // `dispatch`: this branch never acquires a slot and is never pinned by
        // `blockedSeq`, so an answer cannot be head-of-line blocked.
        const parked = pool.controllerFor(command.dispatchAttemptId);
        if (parked === undefined) {
          write(
            `Input resolved for ${command.dispatchId} (${command.payload.resolution}); no live slot to wake.`,
          );
        } else {
          write(
            `Input resolved for ${command.dispatchId} (${command.payload.resolution}); waking parked slot.`,
          );
          parked.requestResumeInput(command.payload);
        }
        replayed.add(command.seq);
      }

      // Advance only across a contiguous run of applied commands, stopping at
      // the first dispatch that is still waiting for a slot. Walk the returned
      // batch (ordered ascending by seq) rather than `afterSeq + 1..maxSeq`,
      // because prior acked or expired commands leave legitimate gaps after a
      // restart and would otherwise pin `afterSeq` at 0 forever.
      let ackTarget = afterSeq;
      for (const command of batch.commands) {
        if (command.seq <= afterSeq) continue;
        if (blockedSeq !== undefined && command.seq >= blockedSeq) break;
        if (!replayed.has(command.seq)) break;
        ackTarget = command.seq;
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
          needsReconnect = true;
          write(`Command ack failed; retrying: ${String(error)}`);
        }
      }
      if (blockedSeq !== undefined)
        await delay(100, controller.signal, "Runner stopped.").catch(() => {});
    }
  };

  const autoClaimLoop = async (): Promise<void> => {
    if (options.autoClaim !== true) return;
    const interval = options.autoClaimPollMs ?? 1000;
    while (!controller.signal.aborted) {
      try {
        await delay(interval, controller.signal, "Runner stopped.");
      } catch {
        return;
      }
      if (controller.signal.aborted) return;
      // A slot is required before asking the server to create a Dispatch; the
      // server also fences by activeSlotCount + queued attempts, but this keeps
      // the local concurrency contract exact even with a stale heartbeat.
      if (pool.used >= (options.maxConcurrency ?? 1)) continue;
      try {
        const result = await client.autoClaim(runner.id, {
          filter: options.autoClaimFilter ?? "assignedToMe",
        });
        if (result.dispatch !== null) {
          write(
            `Auto-claimed ${result.dispatch.issueId} as Dispatch ${result.dispatch.id} (${result.dispatch.state}).`,
          );
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RunnerRequestError && error.status === 401) {
          revoke("Auto-claim rejected (401). Stopping local operation immediately.");
          return;
        }
        if (error instanceof RunnerRequestError && error.status === 429) {
          // Server backpressure is retryable, not a permanent refusal.
          write(`Auto-claim backpressured; retrying: ${String(error)}`);
          await delay(interval, controller.signal, "Runner stopped.").catch(() => {});
          continue;
        }
        if (error instanceof RunnerRequestError && error.status >= 400 && error.status < 500) {
          write(`Auto-claim refused: ${String(error)}`);
          return;
        }
        write(`Auto-claim failed; retrying: ${String(error)}`);
      }
    }
  };

  /**
   * One bounded startup discovery pass, off the hot path. On-demand refreshes
   * arrive in #242 via `probe_catalog`; publishing through the serialized writer
   * merges known effort entries instead of regressing them to `unknown`.
   */
  const startupCatalogProbe = async (): Promise<void> => {
    await probeCatalogOnce();
  };

  await Promise.all([heartbeatLoop(), commandLoop(), autoClaimLoop(), startupCatalogProbe()]);
  options.signal?.removeEventListener("abort", onExternalAbort);
  pool.cancelAll("shutdown");
  await Promise.all(pending);
  await pool.drain();
  write("Runner stopped.");
}

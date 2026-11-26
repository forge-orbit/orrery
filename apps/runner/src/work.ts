import { createHash, randomUUID } from "node:crypto";
import type { DispatchOptions } from "@orrery/contract";
import { harnessConfigKey, readCachedCatalog, verifiedDefaultModel } from "./catalog.ts";
import { runnerFingerprint } from "./checkout.ts";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import { readCredential } from "./credential.ts";
import { defaultWorkDisplayName } from "./display-name.ts";
import { loadSupervisionConfig, type SupervisionConfig } from "./config.ts";
import { delay } from "./delay.ts";
import { loadUserHarnesses, resolveDefaultHarness, validateExplicitHarness } from "./harnesses.ts";
import { resolveCredentialedOrigin } from "./origin.ts";
import { resolveWorkAgent } from "./resolution.ts";
import { validateCheckout } from "./checkout.ts";
import { SlotPool, type SlotController, type SupervisionOutcome } from "./slots.ts";
import { superviseDispatch } from "./supervise.ts";

export interface WorkOptions extends DispatchOptions {
  server?: string | undefined;
  /** Workspace id, name or slug used to disambiguate an issue key. */
  workspace?: string | undefined;
  repoPath?: string | undefined;
  agentId?: string | undefined;
  /** Optional requester steering text (from `--prompt`) carried on the Dispatch. */
  prompt?: string | undefined;
  signal?: AbortSignal | undefined;
  write?: ((line: string) => void) | undefined;
  supervision?: SupervisionConfig | undefined;
  heartbeatMs?: number | undefined;
  commandWaitMs?: number | undefined;
}

/**
 * Ephemeral one-shot mode: resolve one issue, register a single-use Runner on
 * the enrolled host, create and accept a Dispatch through the same server path
 * as manual delegation, supervise it in an isolated worktree, then revoke the
 * Runner. Returns the terminal outcome so the CLI can choose its exit code.
 */
export async function work(target: string, options: WorkOptions): Promise<SupervisionOutcome> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stored = await readCredential();
  const server = resolveCredentialedOrigin({
    storedServer: stored.server,
    ...(options.server === undefined ? {} : { serverFlag: options.server }),
    ...(process.env.ORRERY_URL === undefined ? {} : { envUrl: process.env.ORRERY_URL }),
  });
  const repoPath = options.repoPath ?? process.cwd();
  validateCheckout(repoPath);
  const supervision =
    options.supervision ??
    loadSupervisionConfig(options.harness === undefined ? {} : { harness: options.harness });
  // Eager startup validation (#266): a malformed harnesses.json, an unknown
  // or missing explicit --harness, and a missing omitted-harness default all
  // fail fast before any network call. One-shot work never warns-and-continues:
  // it needs a runnable default immediately.
  loadUserHarnesses();
  const detectionOptions = supervision.acpOverridden ? { acpOverride: supervision.acp } : {};
  const explicitHarness = options.harness ?? supervision.defaults.harness;
  if (explicitHarness !== undefined) {
    validateExplicitHarness(explicitHarness, detectionOptions);
  } else if (!supervision.acpOverridden && resolveDefaultHarness(detectionOptions) === undefined) {
    throw new Error(
      "Default Harness 'opencode' is not installed on PATH. Install it or pass --harness explicitly.",
    );
  }
  const client = new OrreryClient({
    server,
    credential: stored.credential,
    signal: options.signal,
  });
  // A human-readable `--agent` name resolves against the host's top-level
  // targets; UUID-shaped values pass through for server-side validation.
  const agentId =
    options.agentId === undefined ? undefined : await resolveWorkAgent(client, options.agentId);
  const resolved = await client.resolveIssue({
    target,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  write(
    `Resolved ${target} to ${resolved.identifier} in ${resolved.workspaceName}/${resolved.projectKey}.`,
  );

  // A fresh digest guarantees this Runner row is single-use and cannot reuse
  // (or overwrite) a persistent `start` Runner for the same checkout.
  const fingerprint = createHash("sha256")
    .update(`${runnerFingerprint(repoPath)}:${randomUUID()}`)
    .digest("hex");
  const runner = await client.registerRunner({
    workspaceId: resolved.workspaceId,
    projectId: resolved.projectId,
    ...(agentId === undefined ? {} : { agentId }),
    displayName: defaultWorkDisplayName(stored.displayName),
    repoFingerprint: fingerprint,
    capabilities: [],
    maxConcurrency: 1,
    ephemeral: true,
  });
  write(`Registered ephemeral Runner ${runner.id} for ${resolved.identifier}.`);

  // A long one-shot (or an agent that parks on a question) must keep proving
  // liveness and polling the outbox for `cancel` and `input_resolved` commands.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const sessionAbort = new AbortController();
  const onExternalAbort = () => sessionAbort.abort();
  if (options.signal?.aborted === true) sessionAbort.abort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let activeController: SlotController | undefined;
  let commandLoopPromise: Promise<void> | undefined;

  try {
    await client.reconnect(runner.id, { activeAttempts: [] });
    heartbeatTimer = setInterval(() => {
      void client.heartbeat(runner.id, { activeSlotCount: 1 }).catch((error: unknown) => {
        if (error instanceof RunnerRequestError && error.status === 401) {
          write("One-shot heartbeat rejected (401). Stopping local operation immediately.");
          activeController?.requestCancel("revoked");
          sessionAbort.abort();
          return;
        }
        write(`One-shot heartbeat failed: ${String(error)}`);
      });
    }, options.heartbeatMs ?? 5000);
    heartbeatTimer.unref();
    const dispatch = await client.createRunnerDispatch(runner.id, {
      issueId: resolved.issueId,
      ...(options.prompt === undefined || options.prompt.trim() === ""
        ? {}
        : { prompt: options.prompt }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    write(`Created Dispatch ${dispatch.id} for ${resolved.identifier}.`);
    const acceptance = await client.acceptDispatch(runner.id, dispatch.id);
    write(`Accepted Dispatch ${dispatch.id}; work session ${acceptance.session.id} active.`);

    const pool = new SlotPool(1);
    const slot = pool.acquire();
    if (slot === undefined) throw new Error("one-shot Runner has no free slot");

    const pollClient = new OrreryClient({
      server,
      credential: stored.credential,
      signal: sessionAbort.signal,
    });
    const runCommandLoop = async (): Promise<void> => {
      let afterSeq = 0;
      const attemptId = acceptance.dispatch.dispatchAttemptId;
      while (!sessionAbort.signal.aborted) {
        let batch: Awaited<ReturnType<OrreryClient["pollCommands"]>>;
        try {
          batch = await pollClient.pollCommands(runner.id, {
            afterSeq,
            waitMs: options.commandWaitMs ?? 5000,
          });
        } catch (error) {
          if (sessionAbort.signal.aborted) return;
          if (error instanceof RunnerRequestError && error.status === 401) {
            write("Control plane rejected one-shot Runner (401). Stopping local operation.");
            activeController?.requestCancel("revoked");
            sessionAbort.abort();
            return;
          }
          write(`One-shot command poll failed; retrying: ${String(error)}`);
          await delay(1000, sessionAbort.signal, "One-shot stopped.").catch(() => {});
          continue;
        }
        let ackTarget = afterSeq;
        for (const command of batch.commands) {
          if (command.seq <= afterSeq) continue;
          if (command.dispatchAttemptId === attemptId) {
            if (command.kind === "cancel") {
              activeController?.requestCancel(command.payload.reason);
            } else if (command.kind === "input_resolved") {
              write(
                `Input resolved for ${command.dispatchId} (${command.payload.resolution}); waking parked slot.`,
              );
              activeController?.requestResumeInput(command.payload);
            }
          }
          ackTarget = command.seq;
        }
        if (ackTarget > afterSeq) {
          try {
            await pollClient.ackCommands(runner.id, { upToSeq: ackTarget });
            afterSeq = ackTarget;
          } catch (error) {
            if (sessionAbort.signal.aborted) return;
            if (error instanceof RunnerRequestError && error.status === 401) {
              activeController?.requestCancel("revoked");
              sessionAbort.abort();
              return;
            }
            write(`One-shot command ack failed; retrying: ${String(error)}`);
          }
        }
      }
    };

    const configKey = harnessConfigKey(
      supervision.acpOverridden
        ? {
            acpOverride: supervision.acp,
            defaultHarness: resolveDefaultHarness({ acpOverride: supervision.acp }),
          }
        : { defaultHarness: resolveDefaultHarness({}) },
    );
    const cachedCatalog = readCachedCatalog(runnerFingerprint(repoPath), undefined, configKey);
    const controller = await superviseDispatch({
      server,
      repoPath,
      credential: stored.credential,
      config: supervision,
      acceptance,
      command: {
        dispatchId: acceptance.dispatch.id,
        dispatchAttemptId: acceptance.dispatch.dispatchAttemptId,
        issueId: resolved.issueId,
        projectId: resolved.projectId,
        workspaceId: resolved.workspaceId,
        agentId: acceptance.dispatch.agentId,
        // Programmatic callers may set these without populating supervision
        // defaults; the accepted Dispatch row is the fallback record.
        harness: options.harness ?? acceptance.dispatch.harness ?? undefined,
        model: options.model ?? acceptance.dispatch.model ?? undefined,
        effort: options.effort ?? acceptance.dispatch.effort ?? undefined,
      },
      slot,
      pool,
      signal: sessionAbort.signal,
      write,
      defaultModelFor: (harnessId) => verifiedDefaultModel(cachedCatalog, harnessId),
      onController: (ctrl) => {
        activeController = ctrl;
        commandLoopPromise = runCommandLoop();
      },
    });
    await controller.finished;
    return controller.outcome;
  } finally {
    sessionAbort.abort();
    options.signal?.removeEventListener("abort", onExternalAbort);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    await commandLoopPromise;
    // Teardown must run even on SIGINT/SIGTERM, when `options.signal` (and any
    // client bound to it) is already aborted. Use a fresh, bounded client.
    const teardown = new OrreryClient({
      server,
      credential: stored.credential,
      signal: AbortSignal.timeout(5_000),
    });
    try {
      await teardown.markRunnerOffline(runner.id);
      write(`Ephemeral Runner ${runner.id} marked offline.`);
    } catch (error) {
      write(`Could not mark ephemeral Runner offline: ${String(error)}`);
    }
  }
}

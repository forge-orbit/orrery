import { createHash, randomUUID } from "node:crypto";
import { OrreryClient } from "./client.ts";
import { readCredential } from "./credential.ts";
import { loadSupervisionConfig, type SupervisionConfig } from "./config.ts";
import { repoFingerprint } from "./start.ts";
import { SlotPool, type SupervisionOutcome } from "./slots.ts";
import { superviseDispatch } from "./supervise.ts";

export interface WorkOptions {
  server: string;
  /** Workspace id, name or slug used to disambiguate an issue key. */
  workspace?: string | undefined;
  repoPath?: string | undefined;
  agentId?: string | undefined;
  signal?: AbortSignal | undefined;
  write?: ((line: string) => void) | undefined;
  supervision?: SupervisionConfig | undefined;
  heartbeatMs?: number | undefined;
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
  const client = new OrreryClient({
    server: options.server,
    credential: stored.credential,
    signal: options.signal,
  });
  const resolved = await client.resolveIssue({
    target,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  write(
    `Resolved ${target} to ${resolved.identifier} in ${resolved.workspaceName}/${resolved.projectKey}.`,
  );

  const repoPath = options.repoPath ?? process.cwd();
  // A fresh digest guarantees this Runner row is single-use and cannot reuse
  // (or overwrite) a persistent `start` Runner for the same checkout.
  const fingerprint = createHash("sha256")
    .update(`${repoFingerprint(repoPath)}:${randomUUID()}`)
    .digest("hex");
  const runner = await client.registerRunner({
    workspaceId: resolved.workspaceId,
    projectId: resolved.projectId,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    displayName: `${stored.displayName} (one-shot)`,
    repoFingerprint: fingerprint,
    capabilities: [],
    maxConcurrency: 1,
    ephemeral: true,
  });
  write(`Registered ephemeral Runner ${runner.id} for ${resolved.identifier}.`);

  // A long one-shot (or an agent that parks on a question) must keep proving
  // liveness; otherwise the server's disconnect sweep marks it uncertain.
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await client.reconnect(runner.id, { activeAttempts: [] });
    heartbeatTimer = setInterval(() => {
      void client.heartbeat(runner.id, { activeSlotCount: 1 }).catch((error: unknown) => {
        write(`One-shot heartbeat failed: ${String(error)}`);
      });
    }, options.heartbeatMs ?? 5000);
    heartbeatTimer.unref();
    const dispatch = await client.createRunnerDispatch(runner.id, {
      issueId: resolved.issueId,
    });
    write(`Created Dispatch ${dispatch.id} for ${resolved.identifier}.`);
    const acceptance = await client.acceptDispatch(runner.id, dispatch.id);
    write(`Accepted Dispatch ${dispatch.id}; work session ${acceptance.session.id} active.`);

    const supervision = options.supervision ?? loadSupervisionConfig();
    const pool = new SlotPool(1);
    const slot = pool.acquire();
    if (slot === undefined) throw new Error("one-shot Runner has no free slot");
    const controller = await superviseDispatch({
      server: options.server,
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
      },
      slot,
      pool,
      signal: options.signal ?? new AbortController().signal,
      write,
    });
    await controller.finished;
    return controller.outcome;
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    // Teardown must run even on SIGINT/SIGTERM, when `options.signal` (and any
    // client bound to it) is already aborted. Use a fresh, bounded client.
    const teardown = new OrreryClient({
      server: options.server,
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

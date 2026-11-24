import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { OrreryClient, RunnerRequestError } from "./client.ts";
import { readCredential } from "./credential.ts";
import { delay } from "./delay.ts";

export interface StartOptions {
  server: string;
  workspaceId: string;
  projectId: string;
  agentId?: string | undefined;
  displayName?: string | undefined;
  capabilities?: string[] | undefined;
  maxConcurrency?: number | undefined;
  heartbeatMs?: number | undefined;
  repoPath?: string | undefined;
  signal?: AbortSignal | undefined;
  write?: ((line: string) => void) | undefined;
}

/** Opaque digest of a checkout; the raw local path never leaves the machine. */
export function repoFingerprint(repoPath: string): string {
  return createHash("sha256")
    .update(realpathSync(resolve(repoPath)))
    .digest("hex");
}

/**
 * Registers a project-bound Runner under the enrolled host, then heartbeats.
 * A 401 on any heartbeat means the host was revoked: stop immediately.
 */
export async function start(options: StartOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stored = await readCredential();
  const client = new OrreryClient({
    server: options.server,
    credential: stored.credential,
    signal: options.signal,
  });
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

  let lastPresence = runner.presence;
  for (;;) {
    try {
      await delay(options.heartbeatMs ?? 5000, options.signal, "Runner stopped.");
      const state = await client.heartbeat(runner.id, { activeSlotCount: 0 });
      if (state.presence !== lastPresence) {
        lastPresence = state.presence;
        write(`Runner presence: ${state.presence}.`);
      }
    } catch (error) {
      if (error instanceof RunnerRequestError && error.status === 401) {
        write("Host credential rejected (401). Stopping local operation immediately.");
        return;
      }
      if (error instanceof Error && error.message === "Runner stopped.") return;
      write(
        `Heartbeat failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

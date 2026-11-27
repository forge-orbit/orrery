import { validateCheckout } from "./checkout.ts";
import { OrreryClient } from "./client.ts";
import { readCredential } from "./credential.ts";
import { resolveCredentialedOrigin } from "./origin.ts";
import { findBinding, readReposFile, saveBinding } from "./repos.ts";
import { resolveTargets, type ChooseFn } from "./resolution.ts";

export interface InitOptions {
  server?: string | undefined;
  workspace?: string | undefined;
  project?: string | undefined;
  agentId?: string | undefined;
  repoPath?: string | undefined;
  signal?: AbortSignal | undefined;
  write?: ((line: string) => void) | undefined;
  choose?: ChooseFn | undefined;
  isTTY?: boolean | undefined;
}

/**
 * Resolve and save a checkout binding without registering a Runner (`init`,
 * #267). Interactive in a TTY, or flag-driven in non-TTY. Origin pinning and
 * git/`HEAD` validation run before any network call. Fully explicit UUIDs
 * skip `GET /api/runners/targets` so capped (`409 targets_too_large`)
 * accounts can still save bindings cleanly.
 */
export async function init(options: InitOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stored = await readCredential();
  // Origin pinning first: fail before any HTTP request on --server/ORRERY_URL
  // disagreement. Never fall back to http://localhost:8080 here.
  const server = resolveCredentialedOrigin({
    storedServer: stored.server,
    ...(options.server === undefined ? {} : { serverFlag: options.server }),
    ...(process.env.ORRERY_URL === undefined ? {} : { envUrl: process.env.ORRERY_URL }),
  });
  // Shared git/HEAD validator before any network call.
  const repoPath = options.repoPath ?? process.cwd();
  const { bindingFingerprint: fingerprint } = validateCheckout(repoPath);

  const client = new OrreryClient({
    server,
    credential: stored.credential,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const bindings = await readReposFile();
  const previous = findBinding(bindings, server, fingerprint);
  const resolved = await resolveTargets({
    client,
    flags: {
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.agentId === undefined ? {} : { agent: options.agentId }),
    },
    binding: previous,
    bindingFingerprint: fingerprint,
    storedHostId: stored.hostId,
    write,
    choose: options.choose,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    isTTY: options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY),
    alwaysSave: true,
  });
  if (resolved.bindingToSave === null) {
    throw new Error("init produced no binding to save.");
  }
  const path = await saveBinding(resolved.bindingToSave);
  const where =
    resolved.agentId === undefined ? "" : ` agent '${resolved.agentName ?? resolved.agentId}'`;
  write(
    `Saved binding for workspace '${resolved.workspaceName ?? resolved.workspaceId}' ` +
      `project '${resolved.projectKey ?? resolved.projectId}'${where} in ${path}.`,
  );
  write("Run 'orrery-runner start' in this checkout to start the Runner.");
}

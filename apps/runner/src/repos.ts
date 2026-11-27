import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Sha256Hex } from "@orrery/contract";
import { z } from "zod";
import { configDirectory } from "./credential.ts";
import { canonicalizeServerUrl } from "./origin.ts";

/**
 * Remembered per-checkout bindings (`repos.json`, #267). One entry maps the
 * canonical main-checkout fingerprint of a local repository to the
 * Workspace/Project (and optional default Agent) a `start` should register
 * with. `hostId` and the cached display names are informational only: they
 * are never used for authorization, and a changed `hostId` after
 * re-enrollment only prints a brief notice while `registerRunner` live RBAC
 * decides.
 */
export const RepoBinding = z
  .object({
    server: z.string().min(1),
    bindingFingerprint: Sha256Hex,
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
    workspaceName: z.string().min(1).optional(),
    projectKey: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .meta({ id: "RepoBinding" });
export type RepoBinding = z.infer<typeof RepoBinding>;

const ReposFile = z
  .object({
    version: z.literal(1),
    bindings: z.array(RepoBinding),
  })
  .meta({ id: "ReposFile" });

/** Uniqueness scope: one binding per canonical server and checkout. */
export function bindingKey(canonicalServer: string, bindingFingerprint: string): string {
  return `${canonicalServer}\u0000${bindingFingerprint}`;
}

export function reposPath(configDir?: string): string {
  return join(configDir ?? configDirectory(), "repos.json");
}

function duplicateKeyError(path: string): Error {
  return new Error(
    `Duplicate binding entries in ${path}. Remove the duplicates manually, then retry.`,
  );
}

function malformedError(path: string): Error {
  return new Error(
    `The saved runner bindings file ${path} is malformed or has an unknown version. ` +
      `Inspect or repair it manually (keeping a backup); it was left unchanged. ` +
      `Run 'orrery-runner init --workspace <ID> --project <ID>' to recreate the binding for this checkout.`,
  );
}

/**
 * Read the remembered bindings. A missing file means "no bindings yet".
 * Malformed content, an unknown `version`, or duplicate
 * `(server, bindingFingerprint)` entries fail fast naming the file path
 * without wiping user state.
 */
export async function readReposFile(configDir?: string): Promise<RepoBinding[]> {
  const path = reposPath(configDir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw malformedError(path);
  }
  const file = ReposFile.safeParse(parsed);
  if (!file.success) throw malformedError(path);
  const seen = new Set<string>();
  for (const binding of file.data.bindings) {
    let canonical: string;
    try {
      canonical = canonicalizeServerUrl(binding.server);
    } catch {
      throw malformedError(path);
    }
    const key = bindingKey(canonical, binding.bindingFingerprint);
    if (seen.has(key)) throw duplicateKeyError(path);
    seen.add(key);
  }
  return file.data.bindings;
}

/** Find the remembered binding for this server and checkout, if any. */
export function findBinding(
  bindings: RepoBinding[],
  server: string,
  bindingFingerprint: string,
): RepoBinding | undefined {
  const canonical = canonicalizeServerUrl(server);
  return bindings.find(
    (binding) =>
      binding.bindingFingerprint === bindingFingerprint &&
      canonicalizeServerUrl(binding.server) === canonical,
  );
}

/**
 * Insert or replace the binding for `(server, bindingFingerprint)` with an
 * atomic temp-file + `rename` write (`0700` dir, `0600` file). Never stores
 * `displayName` or credentials: callers only pass IDs plus informational
 * cached names.
 */
export async function saveBinding(binding: RepoBinding, configDir?: string): Promise<string> {
  const dir = configDir ?? configDirectory();
  const path = reposPath(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await readReposFile(dir);
  const canonical = canonicalizeServerUrl(binding.server);
  const stored: RepoBinding = {
    ...binding,
    server: canonical,
    updatedAt: new Date().toISOString(),
  };
  const key = bindingKey(canonical, stored.bindingFingerprint);
  const next = existing.filter(
    (entry) => bindingKey(canonicalizeServerUrl(entry.server), entry.bindingFingerprint) !== key,
  );
  next.push(stored);
  const body = `${JSON.stringify({ version: 1, bindings: next }, null, 2)}\n`;
  const tmp = join(dir, `repos.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, body, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
  return path;
}

import { basename } from "node:path";
import { MAX_RUNNER_HOST_DISPLAY_NAME_LENGTH, RunnerHostDisplayName } from "@orrery/contract";
import type { ValidatedCheckout } from "./checkout.ts";

/** Length measured in Unicode code points, not UTF-16 code units. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Truncate cleanly by code points without splitting surrogate pairs. */
export function truncateCodePoints(
  value: string,
  max: number = MAX_RUNNER_HOST_DISPLAY_NAME_LENGTH,
): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return points.slice(0, max).join("");
}

/** Validate an explicit `--name` / `--host-name` strictly (no truncation). */
export function validateDisplayName(value: string): string {
  const parsed = RunnerHostDisplayName.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid display name: ${parsed.error.issues[0]?.message ?? "too long"}`);
  }
  return parsed.data;
}

/** Truncate the OS-hostname fallback for `login` to 120 code points. */
export function defaultHostDisplayName(osHostname: string): string {
  return truncateCodePoints(osHostname);
}

/**
 * Default `start` display name: `<host> · <repo-dir>` at the main checkout,
 * `<host> · <repo-dir> (<worktree-dir>)` in a linked worktree when the
 * worktree directory basename differs from the main checkout basename.
 * Takes the already-validated checkout so no extra `git` call is needed.
 */
export function defaultStartDisplayName(
  hostDisplayName: string,
  checkout: ValidatedCheckout,
): string {
  const repoDir = basename(checkout.mainRoot);
  const worktreeDir = basename(checkout.repoRoot);
  if (checkout.repoRoot !== checkout.mainRoot && worktreeDir !== repoDir && worktreeDir !== "") {
    return truncateCodePoints(`${hostDisplayName} · ${repoDir} (${worktreeDir})`);
  }
  return truncateCodePoints(`${hostDisplayName} · ${repoDir}`);
}

/** Default `work` display name: `<host> (one-shot)`, truncated by code points. */
export function defaultWorkDisplayName(hostDisplayName: string): string {
  const suffix = " (one-shot)";
  const maxHost = MAX_RUNNER_HOST_DISPLAY_NAME_LENGTH - codePointLength(suffix);
  const truncatedHost = truncateCodePoints(hostDisplayName, Math.max(0, maxHost));
  return `${truncatedHost}${suffix}`;
}

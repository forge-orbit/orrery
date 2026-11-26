import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { RunnerHostDisplayName } from "@orrery/contract";
import { mainCheckoutRoot } from "./checkout.ts";

/** Shared 120-Unicode-code-point bound (matches Postgres `char_length`). */
export const MAX_DISPLAY_NAME_CODE_POINTS = 120;

/** Length measured in Unicode code points, not UTF-16 code units. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Truncate cleanly by code points without splitting surrogate pairs. */
export function truncateCodePoints(
  value: string,
  max: number = MAX_DISPLAY_NAME_CODE_POINTS,
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
  return truncateCodePoints(osHostname.trim() === "" ? osHostname : osHostname);
}

/**
 * Default `start` display name: `<host> · <repo-dir>` at the main checkout,
 * `<host> · <repo-dir> (<worktree-dir>)` in a linked worktree when the
 * worktree directory basename differs from the main checkout basename.
 */
export function defaultStartDisplayName(hostDisplayName: string, repoPath: string): string {
  const cwd = repoPath === "" ? "." : repoPath;
  try {
    const toplevel = realpathSync(
      resolve(
        execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
        }).trim(),
      ),
    );
    const main = mainCheckoutRoot(cwd);
    const toplevelBase = basename(toplevel);
    const repoDir = basename(main);
    if (toplevel !== main && toplevelBase !== repoDir && toplevelBase !== "") {
      return truncateCodePoints(`${hostDisplayName} · ${repoDir} (${toplevelBase})`);
    }
    return truncateCodePoints(`${hostDisplayName} · ${repoDir}`);
  } catch {
    // Outside git (validation reports the actionable error later): fall back
    // to the cwd basename so display-name construction never throws first.
    const fallback = basename(cwd) === "" || cwd === "." ? "repo" : basename(cwd);
    return truncateCodePoints(`${hostDisplayName} · ${fallback}`);
  }
}

/** Default `work` display name: `<host> (one-shot)`, truncated by code points. */
export function defaultWorkDisplayName(hostDisplayName: string): string {
  const suffix = " (one-shot)";
  const maxHost = MAX_DISPLAY_NAME_CODE_POINTS - codePointLength(suffix);
  const truncatedHost = truncateCodePoints(hostDisplayName, Math.max(0, maxHost));
  return `${truncatedHost}${suffix}`;
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Run a git subcommand synchronously, throwing a wrapped actionable error. */
function gitSync(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed in '${cwd}': ${String(error)}`, { cause: error });
  }
}

export interface ValidatedCheckout {
  /** The checkout's own top-level worktree root (real path). */
  repoRoot: string;
  /** The canonical main-checkout root shared by linked worktrees (real path). */
  mainRoot: string;
  /** Server-facing worktree-level fingerprint (distinct per linked worktree). */
  runnerFingerprint: string;
  /** Canonical main-checkout binding fingerprint shared by linked worktrees. */
  bindingFingerprint: string;
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Shared up-front repository validator for `start`, `work`, and `init`:
 * verify `git` exists, the path is inside a git work tree, and `HEAD` exists.
 * Runs before any network call and derives both checkout digests without
 * re-spawning git.
 */
export function validateCheckout(repoPath: string): ValidatedCheckout {
  const cwd = repoPath === "" ? "." : repoPath;
  if (!existsSync(cwd)) {
    throw new Error(`Repository path '${repoPath}' does not exist.`);
  }
  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
  } catch {
    throw new Error("git is not installed or not on PATH. Install git to run a Runner.");
  }
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`Directory '${repoPath}' is not inside a git work tree.`);
  }
  if (toplevel === "") throw new Error(`Directory '${repoPath}' is not inside a git work tree.`);
  let head: string;
  try {
    head = execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      `Repository at '${repoPath}' has no HEAD commit (unborn repository). Commit before starting a Runner.`,
    );
  }
  if (head === "") {
    throw new Error(
      `Repository at '${repoPath}' has no HEAD commit (unborn repository). Commit before starting a Runner.`,
    );
  }
  const repoRoot = realpathSync(resolve(toplevel));
  const mainRoot = mainCheckoutRootFrom(cwd, repoRoot);
  return {
    repoRoot,
    mainRoot,
    runnerFingerprint: sha256Hex(repoRoot),
    bindingFingerprint: sha256Hex(mainRoot),
  };
}

function mainCheckoutRootFrom(cwd: string, toplevel: string): string {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
  } catch {
    return toplevel;
  }
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const candidateRaw = line.slice("worktree ".length).trim();
    if (candidateRaw === "") continue;
    // A submodule's worktree list points at its gitdir, not a checkout.
    if (candidateRaw.includes("/.git/") || candidateRaw.endsWith("/.git")) continue;
    try {
      const candidate = realpathSync(resolve(candidateRaw));
      if (candidate === toplevel) return toplevel;
      // The main root must itself be a worktree top level.
      const check = realpathSync(resolve(gitSync(candidate, ["rev-parse", "--show-toplevel"])));
      if (check === candidate) return candidate;
    } catch {
      continue;
    }
  }
  return toplevel;
}

/**
 * Canonical main-checkout root: the first `worktree ` entry of
 * `git worktree list --porcelain`. Works uniformly for main checkouts and
 * linked worktrees. Inside a submodule `worktree list` reports the submodule's
 * gitdir (`.git/modules/...`) rather than a worktree, so gitdir candidates
 * are ignored and the submodule's own top level is used (fixing the old
 * `--git-common-dir` resolution that escaped submodules into the superproject).
 */
export function mainCheckoutRoot(repoPath: string): string {
  const cwd = repoPath === "" ? "." : repoPath;
  const toplevel = realpathSync(resolve(gitSync(cwd, ["rev-parse", "--show-toplevel"])));
  return mainCheckoutRootFrom(cwd, toplevel);
}

/** Server-facing worktree-level fingerprint (distinct per linked worktree). */
export function runnerFingerprint(repoPath: string): string {
  const toplevel = gitSync(repoPath === "" ? "." : repoPath, ["rev-parse", "--show-toplevel"]);
  return sha256Hex(realpathSync(resolve(toplevel)));
}

/** Canonical main-checkout binding fingerprint shared by linked worktrees. */
export function bindingFingerprint(repoPath: string): string {
  return sha256Hex(mainCheckoutRoot(repoPath));
}

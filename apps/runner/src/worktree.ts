import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WorktreeHandle {
  /** The main checkout this worktree belongs to. */
  repoRoot: string;
  /** The isolated checkout's absolute path. */
  path: string;
  /** Local branch checked out in the worktree. */
  branch: string;
  /** Commit the branch was created from, used for unpushed detection. */
  baseSha: string;
  /** The real path of the worktree, used for permission confinement. */
  realPath: string;
}

export interface WorktreeState {
  dirty: boolean;
  unpushed: boolean;
  ahead: number;
}

export interface WorktreeOptions {
  root?: string | undefined;
  write?: ((line: string) => void) | undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";

export function branchNameFor(issueKey: string, shortId: string): string {
  return `orrery/${slug(issueKey)}-${slug(shortId).slice(0, 12)}`;
}

/**
 * Create a fresh worktree and branch for one dispatch attempt. A pre-existing
 * directory (a preserved dirty worktree from an earlier attempt) is never
 * reused or deleted; a numeric suffix keeps every attempt isolated.
 */
export async function createWorktree(
  repoPath: string,
  issueKey: string,
  shortId: string,
  options: WorktreeOptions = {},
): Promise<WorktreeHandle> {
  const repoRoot = await git(repoPath === "" ? "." : repoPath, ["rev-parse", "--show-toplevel"]);
  const baseSha = await git(repoRoot, ["rev-parse", "HEAD"]);
  const baseBranch = branchNameFor(issueKey, shortId);
  const parent = options.root ?? join(dirname(repoRoot), ".orrery-worktrees");
  await mkdir(parent, { recursive: true });
  const baseName = baseBranch.replace(/\//g, "-");
  let branch = baseBranch;
  let path = join(parent, baseName);
  for (let attempt = 1; ; attempt += 1) {
    let taken = false;
    try {
      await stat(path);
      taken = true;
    } catch {
      taken = false;
    }
    if (!taken) break;
    branch = `${baseBranch}-${attempt}`;
    path = join(parent, `${baseName}-${attempt}`);
  }
  await git(repoRoot, ["worktree", "add", "-b", branch, path, baseSha]);
  return { repoRoot, path, branch, baseSha, realPath: await realpath(path) };
}

/** Report uncommitted changes and commits that have not reached the remote. */
export async function inspectWorktree(handle: WorktreeHandle): Promise<WorktreeState> {
  const status = await git(handle.path, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = status !== "";
  const upstreamAhead = await tryGit(handle.path, ["rev-list", "--count", "@{u}..HEAD"]);
  const aheadFromBase = await tryGit(handle.path, [
    "rev-list",
    "--count",
    `${handle.baseSha}..HEAD`,
  ]);
  const ahead = Number(upstreamAhead ?? aheadFromBase ?? "0");
  return { dirty, unpushed: ahead > 0, ahead: Number.isFinite(ahead) ? ahead : 0 };
}

/**
 * Prune only clean, fully pushed worktrees. Anything dirty or ahead of its
 * base is preserved on disk so no local work is destroyed.
 */
export async function cleanupWorktree(
  handle: WorktreeHandle,
  state: WorktreeState,
  write: (line: string) => void = () => {},
): Promise<boolean> {
  if (state.dirty || state.unpushed) {
    write(`Preserving worktree ${handle.path} (${handle.branch}); local work was not destroyed.`);
    return false;
  }
  try {
    await git(handle.repoRoot, ["worktree", "remove", "--force", handle.path]);
    await git(handle.repoRoot, ["worktree", "prune"]);
    await git(handle.repoRoot, ["branch", "-d", handle.branch]);
    return true;
  } catch (error) {
    write(`Could not prune clean worktree ${handle.path}: ${String(error)}`);
    return false;
  }
}

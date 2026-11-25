import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local ACP permission policy (application-layer gate, NOT an OS/process sandbox).
 *
 * This module gates ACP `session/request_permission` and `fs/*` requests against
 * worktree confinement and a command allowlist/denylist. Once a command is
 * allowed (for example `pnpm`, `make`, or `git`), it executes with the host OS
 * user's privileges unless the operator runs `orrery-runner` inside a separate
 * OS confinement layer (container, VM, `bwrap`, or `sandbox-exec`).
 */

export interface PermissionDecision {
  allow: boolean;
  reason: string;
}

export interface PermissionResponse extends PermissionDecision {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

const PATH_KEYS = new Set([
  "path",
  "filePath",
  "file_path",
  "filename",
  "file",
  "uri",
  "cwd",
  "directory",
  "target",
  "destination",
  "dest",
  "from",
  "to",
  "newPath",
  "oldPath",
  "root",
]);

/** Safe commands a local agent may run without a remote approval button. */
const SAFE_COMMANDS = new Set([
  "cat",
  "cd",
  "cp",
  "echo",
  "git",
  "go",
  "grep",
  "head",
  "ls",
  "make",
  "mkdir",
  "mv",
  "npm",
  "npx",
  "oxfmt",
  "oxlint",
  "pnpm",
  "printf",
  "pwd",
  "rg",
  "sed",
  "tail",
  "test",
  "touch",
  "true",
  "false",
  "tsc",
  "vitest",
  "which",
  "pytest",
  "cargo",
  "rustc",
  "java",
  "gradle",
  "composer",
  "uname",
  "date",
  "sort",
  "wc",
  "diff",
  "tr",
  "cut",
  "tee",
  "ln",
  "stat",
  "du",
  "df",
  "sleep",
  "cc",
  "gcc",
]);

/** Commands and shell forms that must never be auto-allowed by a remote dispatch. */
const DESTRUCTIVE = [
  /(?:^|\s)sudo(?:\s|$)/,
  /\brm\s+-[a-z]*[rf]/i,
  /\brm\s+.*\s\/\S*/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bsystemctl\b/,
  /\bgit\s+push\b[^\n]*(?:\s-f\b|--force(?:\b|=)|\+[^\s:]+:[^\s]+)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bcurl\b[^\n]*\|\s*(?:ba)?sh/,
  /\bwget\b[^\n]*\|\s*(?:ba)?sh/,
  /\bchmod\s+(?:(?:-|)[rugoa+]*777|a\+w|o\+w)\b/,
  /:\(\)\s*\{/,
  /-exec\s+(?:dir)?/,
];

/** Any of these turns a "command" into arbitrary code execution. */
const SHELL_METACHARACTERS = /[\n\r`&~$]|<\(|>\(|>\s*&|\$\(/;

function inside(candidate: string, worktreeReal: string): boolean {
  const rel = relative(worktreeReal, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve a candidate inside the worktree, following symlinks on the deepest
 * existing ancestor so a symlink (including a dangling one) or a `..` segment
 * can never escape the slot. `file://` URIs are decoded first.
 */
export function confinedPath(candidate: string, worktreeReal: string): string | undefined {
  if (candidate === "") return worktreeReal;
  let value = candidate;
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  const absolute = resolve(worktreeReal, value);
  if (!inside(absolute, worktreeReal)) return undefined;
  let probe = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      const result = tail.length === 0 ? real : join(real, ...tail.toReversed());
      return inside(result, worktreeReal) ? result : undefined;
    } catch {
      try {
        // A dangling symlink whose target does not exist must not be treated as
        // a harmless missing path: it may point outside the worktree.
        if (lstatSync(probe).isSymbolicLink()) return undefined;
        return undefined;
      } catch {
        // The path does not exist yet; check its nearest existing ancestor.
      }
      const parent = dirname(probe);
      const name = basename(probe);
      if (name === "" || parent === probe) return undefined;
      tail.push(name);
      probe = parent;
    }
  }
}

function commandSegments(command: string): string[] {
  return command
    .split(/;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function firstCommand(segment: string): string {
  const tokens = segment.split(/\s+/);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  if (tokens[index] === "command" || tokens[index] === "exec") index += 1;
  return (tokens[index] ?? "").replace(/[^a-zA-Z0-9._-].*$/, "");
}

const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");

function evaluateCommand(command: string, worktreeReal: string): PermissionDecision | undefined {
  if (SHELL_METACHARACTERS.test(command)) {
    return { allow: false, reason: "shell metacharacter rejected" };
  }
  for (const pattern of DESTRUCTIVE) {
    if (pattern.test(command)) {
      return { allow: false, reason: `destructive command rejected: ${String(pattern)}` };
    }
  }
  // Cover `>`, `>>`, `2>`, `&>`, and input redirects, with quoted targets.
  const redirectTargets = [...command.matchAll(/(?:\d*>{1,2}\s*|&>\s*|<\s*)([^\s;&|]+)/g)].map(
    (match) => unquote(match[1] ?? ""),
  );
  for (const target of redirectTargets) {
    if (target === "&1" || target === "&2") continue;
    if (confinedPath(target, worktreeReal) === undefined) {
      return { allow: false, reason: `redirect outside the worktree rejected: ${target}` };
    }
  }
  for (const segment of commandSegments(command)) {
    const name = firstCommand(segment);
    if (!SAFE_COMMANDS.has(name)) {
      return { allow: false, reason: `command not on the local allowlist: ${name || segment}` };
    }
    for (const token of segment.split(/\s+/)) {
      const pathish = unquote(token);
      if (pathish.startsWith("/") || pathish.includes("..") || pathish.includes("/")) {
        if (confinedPath(pathish, worktreeReal) === undefined) {
          return { allow: false, reason: `path outside the worktree rejected: ${pathish}` };
        }
      }
    }
  }
  return undefined;
}

interface Extracted {
  paths: string[];
  commands: string[];
  recognized: boolean;
}

/** Collect path claims and command invocations, treating `{command, args}` as one call. */
function extract(value: unknown, key: string | undefined, out: Extracted): void {
  if (typeof value === "string") {
    if (key !== undefined && PATH_KEYS.has(key)) {
      out.paths.push(value);
      out.recognized = true;
    }
    if (key === "command" || key === "cmd") {
      out.commands.push(value);
      out.recognized = true;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extract(item, key, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    for (const [childKey, child] of Object.entries(record)) {
      if (childKey === "args" && Array.isArray(child)) {
        const command = record.command ?? record.cmd;
        if (typeof command === "string") {
          const parts = child.filter((item): item is string => typeof item === "string");
          out.commands.push([command, ...parts].join(" "));
          out.recognized = true;
          continue;
        }
      }
      extract(child, childKey, out);
    }
  }
}

/**
 * The strictly local, worktree-scoped permission policy. It runs entirely in
 * the Runner process: no remote approval button can widen it. Unrecognized
 * shapes are denied rather than allowed.
 */
export function evaluatePermission(params: unknown, worktreeReal: string): PermissionDecision {
  const out: Extracted = { paths: [], commands: [], recognized: false };
  extract(params, undefined, out);
  if (!out.recognized) {
    return { allow: false, reason: "unrecognized permission request denied by local policy" };
  }
  for (const command of out.commands) {
    const decision = evaluateCommand(command, worktreeReal);
    if (decision !== undefined) return decision;
  }
  for (const path of out.paths) {
    if (confinedPath(path, worktreeReal) === undefined) {
      return { allow: false, reason: `path outside the worktree rejected: ${path}` };
    }
  }
  return { allow: true, reason: "in-worktree operation allowed by local policy" };
}

interface PermissionOption {
  optionId?: string;
  name?: string;
  kind?: string;
}

/** Map a local decision onto the option ids offered by an ACP permission request. */
export function respondToPermission(
  params: unknown,
  decision: PermissionDecision,
): PermissionResponse {
  const raw =
    typeof params === "object" && params !== null ? Reflect.get(params, "options") : undefined;
  const options: PermissionOption[] = Array.isArray(raw)
    ? raw.filter((item): item is PermissionOption => typeof item === "object" && item !== null)
    : [];
  const wanted = (option: PermissionOption): boolean => {
    const kind = option.kind ?? "";
    const name = option.name ?? "";
    return decision.allow
      ? kind.startsWith("allow") || /allow/i.test(name)
      : kind.startsWith("reject") || /deny|reject/i.test(name);
  };
  const chosen = options.find(wanted);
  if (chosen?.optionId === undefined) {
    return { ...decision, outcome: { outcome: "cancelled" } };
  }
  return { ...decision, outcome: { outcome: "selected", optionId: chosen.optionId } };
}

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import { configDirectory } from "./credential.ts";

/** A locally executable ACP harness the Runner may probe and delegate to. */
export interface HarnessDefinition {
  id: string;
  displayName: string;
  command: string;
  args: string[];
}

/**
 * Built-in ACP presets shared with the planned `--harness` selector (#229).
 * A CLI is advertised only when its command is actually installed on PATH.
 */
export const BUILTIN_ACP_HARNESSES: readonly HarnessDefinition[] = [
  { id: "opencode", displayName: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "codex", displayName: "Codex", command: "codex", args: ["acp"] },
  { id: "claude", displayName: "Claude Code", command: "claude", args: ["--acp"] },
  { id: "omp", displayName: "Oh My Pi", command: "omp", args: ["acp"] },
  { id: "grok", displayName: "Grok", command: "grok", args: ["acp"] },
  { id: "hermes", displayName: "Hermes", command: "hermes", args: ["acp"] },
  { id: "cursor", displayName: "Cursor", command: "cursor", args: ["acp"] },
];

const UserHarness = z.object({
  id: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  command: z.string().min(1).max(2000),
  args: z.array(z.string().max(500)).max(64).optional(),
});

const HarnessesFile = z.union([
  z.array(UserHarness).max(64),
  z.object({ harnesses: z.array(UserHarness).max(64) }),
]);

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Never executes anything: just checks whether a command exists and is executable. */
export function commandOnPath(command: string, pathEnv = process.env.PATH ?? ""): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command);
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "" || !isExecutable(join(dir, command))) continue;
    return true;
  }
  return false;
}

export function harnessesJsonPath(configDir = configDirectory()): string {
  return join(configDir, "harnesses.json");
}

/** Optional user-defined ACP harnesses; a malformed file is a fail-fast config error. */
export function loadUserHarnesses(configDir = configDirectory()): HarnessDefinition[] {
  let text: string;
  try {
    text = readFileSync(harnessesJsonPath(configDir), "utf8");
  } catch {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid harnesses.json in ${configDir}: ${String(error)}`, { cause: error });
  }
  const parsed = HarnessesFile.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid harnesses.json in ${configDir}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const configured = Array.isArray(parsed.data) ? parsed.data : parsed.data.harnesses;
  return configured.map((item) => ({
    id: item.id,
    displayName: item.displayName,
    command: item.command,
    args: item.args === undefined ? ["acp"] : [...item.args],
  }));
}

export interface HarnessDetectionOptions {
  /** The effective `--acp-command` / `--acp-arg` supervision override. */
  acpOverride?: { command: string; args: string[] } | undefined;
  pathEnv?: string | undefined;
  configDir?: string | undefined;
}

/**
 * Auto-detect installed presets, add the CLI override as a `custom` entry and
 * layer optional user definitions on top (by id). No process is spawned here.
 */
export function detectHarnesses(options: HarnessDetectionOptions = {}): HarnessDefinition[] {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const detected: HarnessDefinition[] = [];
  for (const preset of BUILTIN_ACP_HARNESSES) {
    if (commandOnPath(preset.command, pathEnv)) {
      detected.push({ ...preset, args: [...preset.args] });
    }
  }

  // An explicit override is always advertised as its own custom entry, even if
  // its binary happens to share a name with an installed preset: the override's
  // arguments may differ and must be probed as given.
  const override = options.acpOverride;
  if (override !== undefined) {
    detected.push({
      id: "custom",
      displayName: basename(override.command) || "Custom ACP harness",
      command: override.command,
      args: [...override.args],
    });
  }

  for (const user of loadUserHarnesses(options.configDir ?? configDirectory())) {
    const index = detected.findIndex((item) => item.id === user.id);
    if (index < 0) detected.push(user);
    else detected[index] = user;
  }
  return detected;
}

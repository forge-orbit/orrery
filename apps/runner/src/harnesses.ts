import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { configDirectory } from "./credential.ts";

/**
 * The shared built-in ACP Harness preset registry (issue #240, designed to be
 * shared with the `--harness` presets of #229). `args` are best-effort defaults
 * for each harness's ACP stdio mode; an explicit `--acp-command` / `--acp-arg`
 * override or a `harnesses.json` entry always wins over a preset.
 */
export interface HarnessDefinition {
  id: string;
  displayName: string;
  source: "preset" | "override" | "user";
  command: string;
  args: string[];
}

export const ACP_HARNESS_PRESETS: HarnessDefinition[] = [
  { id: "opencode", displayName: "OpenCode", source: "preset", command: "opencode", args: ["acp"] },
  { id: "codex", displayName: "Codex", source: "preset", command: "codex", args: ["acp"] },
  {
    id: "claude",
    displayName: "Claude Code",
    source: "preset",
    command: "claude-code-acp",
    args: [],
  },
  { id: "omp", displayName: "omp", source: "preset", command: "omp", args: ["acp"] },
  { id: "grok", displayName: "Grok CLI", source: "preset", command: "grok", args: ["acp"] },
  { id: "hermes", displayName: "Hermes", source: "preset", command: "hermes", args: ["--acp"] },
  {
    id: "cursor",
    displayName: "Cursor",
    source: "preset",
    command: "cursor-agent",
    args: ["acp"],
  },
];

/** An explicit `--acp-command` / `--acp-arg` override from the CLI. */
export interface AcpOverride {
  command: string;
  args: string[];
}

/** Optional user-defined ACP Harnesses, read from the runner config directory. */
const UserHarnessesFile = z
  .object({
    harnesses: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64),
          displayName: z.string().trim().min(1).max(120).optional(),
          command: z.string().trim().min(1),
          args: z.array(z.string()).default([]),
        }),
      )
      .max(64),
  })
  .strict();

export function userHarnessesPath(configDir = configDirectory()): string {
  return join(configDir, "harnesses.json");
}

/** Reads optional user-defined harnesses; any malformed file is ignored. */
export async function loadUserHarnesses(
  configDir = configDirectory(),
): Promise<HarnessDefinition[]> {
  let text: string;
  try {
    text = await readFileSafe(userHarnessesPath(configDir));
  } catch {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A malformed file is ignored, never thrown.
    return [];
  }
  const parsed = UserHarnessesFile.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.harnesses.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    source: "user" as const,
    command: entry.command,
    args: entry.args,
  }));
}

async function readFileSafe(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

/** True when an executable with that name exists on PATH (or, for a path-like
 * command, is an executable file). No subprocess is spawned. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, 1 /* X_OK */);
    return true;
  } catch {
    return false;
  }
}

export async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/")) return await isExecutable(command);
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    if (await isExecutable(join(dir, command))) return true;
  }
  return false;
}

/** A harness display name never exceeds the contract's 120-character bound. */
function clampDisplayName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 119)}\u2026`;
}

/**
 * Builds the Harness candidates to probe, in probe order: the explicit
 * override first (it decides dispatch defaults, so it probes first), then
 * user-defined `harnesses.json` entries, then installed presets. Later
 * sources win over earlier ones for the same id, so an override or user
 * entry can refine a preset's command and args.
 */
export async function discoverHarnesses(
  override: AcpOverride | undefined,
  configDir = configDirectory(),
): Promise<HarnessDefinition[]> {
  const overrideEntry: HarnessDefinition | undefined =
    override === undefined
      ? undefined
      : {
          id: basename(override.command),
          displayName: clampDisplayName(`${override.command} ${override.args.join(" ")}`),
          source: "override",
          command: override.command,
          args: [...override.args],
        };
  const taken = new Set<string>(overrideEntry === undefined ? [] : [overrideEntry.id]);
  const user = (await loadUserHarnesses(configDir)).filter((entry) => {
    if (taken.has(entry.id)) return false;
    taken.add(entry.id);
    return true;
  });
  const presets: HarnessDefinition[] = [];
  for (const preset of ACP_HARNESS_PRESETS) {
    if (taken.has(preset.id)) continue;
    if (await commandExists(preset.command)) {
      taken.add(preset.id);
      presets.push(preset);
    }
  }
  return [...(overrideEntry === undefined ? [] : [overrideEntry]), ...user, ...presets];
}

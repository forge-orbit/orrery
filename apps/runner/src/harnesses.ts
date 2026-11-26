import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import { configDirectory } from "./credential.ts";

export type HarnessSourceKind = "preset" | "override" | "user";

/** A locally executable ACP harness the Runner may probe and delegate to. */
export interface HarnessDefinition {
  id: string;
  displayName: string;
  /** Where this definition came from; published in the catalog for the Fleet. */
  source?: HarnessSourceKind | undefined;
  command: string;
  args: string[];
}

/**
 * Built-in ACP presets shared with the planned `--harness` selector (#229).
 * Preset IDs are the stable contract carried on Dispatch.harness; the
 * underlying executable and args track each vendor's real ACP entrypoint.
 * A CLI is advertised only when its command is actually installed on PATH.
 */
export const BUILTIN_ACP_HARNESSES: readonly HarnessDefinition[] = [
  { id: "opencode", source: "preset", displayName: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "codex", source: "preset", displayName: "Codex", command: "codex-acp", args: [] },
  {
    id: "claude",
    source: "preset",
    displayName: "Claude Code",
    command: "claude-agent-acp",
    args: [],
  },
  { id: "omp", source: "preset", displayName: "Oh My Pi", command: "omp", args: ["acp"] },
  {
    id: "grok",
    source: "preset",
    displayName: "Grok",
    command: "grok",
    args: ["agent", "stdio"],
  },
  { id: "hermes", source: "preset", displayName: "Hermes", command: "hermes", args: ["acp"] },
  {
    id: "cursor",
    source: "preset",
    displayName: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
  },
];

/** Concise install hints shown when a known preset binary is missing from PATH. */
export const PRESET_INSTALL_HINTS: Readonly<Record<string, string>> = {
  opencode: "Install OpenCode: npm install -g opencode-ai (https://opencode.ai)",
  codex: "Install Muse: npm install -g @openai/codex",
  claude: "Install Claude Agent ACP: npm install -g @anthropic-ai/claude-agent-acp",
  omp: "Install Oh My Pi: npm install -g omp",
  grok: "Install the Grok CLI: see https://docs.x.ai",
  hermes: "Install Hermes: cargo install hermes-acp",
  cursor: "Install Cursor Agent: see https://cursor.com",
};

export function installHintForPreset(id: string): string {
  return PRESET_INSTALL_HINTS[id] ?? `Install the '${id}' ACP harness and ensure it is on PATH.`;
}

/** The `custom` Harness ID is reserved for the explicit `--acp-command` override. */
export function isReservedHarnessId(id: string): boolean {
  return id.toLowerCase() === "custom";
}

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
  const filePath = harnessesJsonPath(configDir);
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid harnesses.json at ${filePath}: ${String(error)}`, { cause: error });
  }
  const parsed = HarnessesFile.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const at = issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
        return `${at}${issue.message}`;
      })
      .join("; ");
    throw new Error(`Invalid harnesses.json at ${filePath}: ${details}`);
  }
  const configured = Array.isArray(parsed.data) ? parsed.data : parsed.data.harnesses;
  return configured.map((item) => {
    if (isReservedHarnessId(item.id)) {
      throw new Error(
        `Invalid harnesses.json at ${filePath}: harness id "custom" is reserved for --acp-command overrides`,
      );
    }
    return {
      id: item.id,
      displayName: item.displayName,
      source: "user" as const,
      command: item.command,
      args: item.args === undefined ? ["acp"] : [...item.args],
    };
  });
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
 * User harnesses whose command is not executable on PATH are excluded from the
 * advertised catalog so probing never spawns a missing binary.
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
      source: "override" as const,
      command: override.command,
      args: [...override.args],
    });
  }

  for (const user of loadUserHarnesses(options.configDir ?? configDirectory())) {
    if (!commandOnPath(user.command, pathEnv)) continue;
    const index = detected.findIndex((item) => item.id === user.id);
    if (index < 0) detected.push(user);
    else detected[index] = user;
  }
  return detected;
}

/**
 * IDs from `harnesses.json` that shadow a built-in preset ID. Reported by
 * offline `orrery-runner status`; the user entry wins in `detectHarnesses`
 * when its command is executable.
 */
export function shadowedPresetIds(configDir = configDirectory()): string[] {
  const presetIds = new Set(BUILTIN_ACP_HARNESSES.map((preset) => preset.id));
  const shadowed: string[] = [];
  for (const user of loadUserHarnesses(configDir)) {
    if (presetIds.has(user.id) && !shadowed.includes(user.id)) shadowed.push(user.id);
  }
  return shadowed;
}

/**
 * The omitted-harness default: the real `opencode` preset definition
 * (`source: "preset"`) when its binary is on PATH, otherwise undefined.
 * Dispatch supervision and the catalog cache key share this helper so probing
 * and dispatch agree on the default adapter.
 */
export function resolveDefaultHarness(
  options: {
    pathEnv?: string | undefined;
    acpOverride?: HarnessDetectionOptions["acpOverride"];
  } = {},
): HarnessDefinition | undefined {
  if (options.acpOverride !== undefined) {
    return {
      id: "custom",
      displayName: basename(options.acpOverride.command) || "Custom ACP harness",
      source: "override" as const,
      command: options.acpOverride.command,
      args: [...options.acpOverride.args],
    };
  }
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const preset = BUILTIN_ACP_HARNESSES.find((item) => item.id === "opencode");
  if (preset !== undefined && commandOnPath(preset.command, pathEnv)) {
    return { ...preset, args: [...preset.args] };
  }
  return undefined;
}

/**
 * Fail fast when an explicit `--harness` ID is unknown or not executable.
 * A known preset missing from PATH reports its install hint; a configured
 * user harness missing from PATH names its command; an unknown ID lists the
 * advertised alternatives.
 */
export function validateExplicitHarness(
  harnessId: string,
  options: HarnessDetectionOptions = {},
): HarnessDefinition {
  // Eager: malformed harnesses.json (or a reserved `custom` entry) throws here
  // with the file path instead of surfacing mid-probe.
  const detected = detectHarnesses(options);
  const match = detected.find((item) => item.id === harnessId);
  if (match !== undefined) return match;
  if (isReservedHarnessId(harnessId) && options.acpOverride === undefined) {
    throw new Error(
      `--harness "${harnessId}" requires --acp-command (or ORRERY_ACP_COMMAND): "custom" is reserved for explicit ACP overrides.`,
    );
  }
  const preset = BUILTIN_ACP_HARNESSES.find((item) => item.id === harnessId);
  if (preset !== undefined) {
    throw new Error(
      `Harness '${harnessId}' is not installed (missing '${preset.command}' on PATH). ${installHintForPreset(harnessId)}`,
    );
  }
  // A user harness may be configured but filtered out of the advertised
  // catalog because its command is not executable: name the command.
  for (const user of loadUserHarnesses(options.configDir ?? configDirectory())) {
    if (user.id === harnessId) {
      throw new Error(
        `Harness '${harnessId}' is configured in ${harnessesJsonPath(options.configDir ?? configDirectory())} but command '${user.command}' was not found on PATH.`,
      );
    }
  }
  const available = detected.map((item) => item.id);
  throw new Error(
    available.length === 0
      ? `Unknown --harness '${harnessId}': no Harnesses are installed on PATH.`
      : `Unknown --harness '${harnessId}'. Installed: ${available.join(", ")}.`,
  );
}

/**
 * Resolve a Dispatch's Harness id strictly against this Runner's local
 * registry: the explicit `--acp-command` override, `~/.config/orrery/
 * harnesses.json`, and installed presets. The server never sends a command, so
 * an id outside this allowlist is reported as unavailable, never executed.
 */
export async function resolveHarness(
  id: string,
  override: { command: string; args: string[] } | undefined,
  configDir = configDirectory(),
): Promise<HarnessDefinition | undefined> {
  return detectHarnesses({
    ...(override === undefined ? {} : { acpOverride: override }),
    configDir,
  }).find((entry) => entry.id === id);
}

/**
 * The lock identity is the local executable + args, not the advertised id: a
 * preset and an identical custom/user entry share the same on-disk CLI default
 * and must never mutate it concurrently (ADR-0011, #242).
 */
export function harnessLockKey(spec: { command: string; args: readonly string[] }): string {
  return JSON.stringify([spec.command, [...spec.args]]);
}

/**
 * A lightweight per-Harness mutex. Catalog probes temporarily switch a
 * Harness's default model, so a Dispatch for the same Harness must never spawn
 * ACP until the probe has restored it (issue #241). Work in the callback runs
 * in call order; a rejected callback never blocks later work.
 */
export class HarnessLocks {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(harnessId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(harnessId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(harnessId, tail);
    void tail.then(() => {
      if (this.tails.get(harnessId) === tail) this.tails.delete(harnessId);
    });
    return current;
  }
}

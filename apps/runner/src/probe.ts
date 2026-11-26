import type { HarnessCatalogEntry, HarnessModelCatalog } from "@orrery/contract";
import { AcpStdioClient } from "./acp.ts";
import type { HarnessDefinition } from "./harnesses.ts";

/**
 * Bounded-timeout ACP discovery of one locally installed Harness (issue #240):
 * spawn the harness's ACP stdio command detached, run `initialize` and
 * `session/new` under strict deadlines, read the advertised `models` and
 * `configOptions` (such as `thought_level` / `reasoning_effort`), then tear
 * the whole process group down cleanly so nothing leaks.
 */

/** Hard deadline for the whole `initialize` -> `session/new` handshake. */
export const PROBE_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Grace period for the final teardown; SIGTERM then SIGKILL the group. */
export const PROBE_TEARDOWN_GRACE_MS = 2_000;

export type ProbeOutcome =
  | { ok: true; models: HarnessModelCatalog[]; defaultModel: string | null; probedAt: string }
  | { ok: false; reason: string };

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A model reference: `{ modelId | id, name | label }` in any ACP dialect. */
function parseModelRef(value: unknown): { id: string; label?: string } | undefined {
  const record = recordOf(value);
  if (record === undefined) {
    // A bare string is accepted as a model id.
    const id = stringOf(value);
    return id === undefined ? undefined : { id };
  }
  const id =
    stringOf(record.modelId) ??
    stringOf(record.id) ??
    stringOf(record.name) ??
    stringOf(record.label);
  if (id === undefined) return undefined;
  const label = stringOf(record.name) ?? stringOf(record.label);
  return label === undefined ? { id } : { id, label };
}

function seedModel(
  models: Map<string, HarnessModelCatalog>,
  parsed: { id: string; label?: string },
): void {
  if (models.has(parsed.id)) return;
  models.set(parsed.id, {
    id: parsed.id,
    ...(parsed.label === undefined ? {} : { label: parsed.label }),
    reasoningDiscovery: "unknown",
    effortLevels: [],
    defaultEffort: null,
    probedAt: null,
  });
}

/** Models advertised on an `initialize` result under `models`. */
function parseInitializeModels(result: unknown): {
  models: Map<string, HarnessModelCatalog>;
  current: string | null;
} {
  const models = new Map<string, HarnessModelCatalog>();
  let current: string | null = null;
  const container = recordOf(result)?.models;
  if (container === undefined) return { models, current };
  const shape = recordOf(container);
  if (Array.isArray(container)) {
    for (const ref of container) seedModel(models, parseModelRef(ref) ?? { id: "" });
    return { models, current };
  }
  if (shape !== undefined) {
    const refs = [...list(shape.availableModels), ...list(shape.models)];
    for (const ref of refs) seedModel(models, parseModelRef(ref) ?? { id: "" });
    current = stringOf(shape.currentModel) ?? stringOf(shape.current) ?? null;
  }
  return { models, current };
}

/** The choices of one session-config option, in any ACP dialect. */
function parseOptionChoices(option: Record<string, unknown>): {
  values: string[];
  default: string | null;
} {
  const state = recordOf(option.state) ?? {};
  const raw = [
    ...list(option.options),
    ...list(option.choices),
    ...list(state.options),
    ...list(state.choices),
  ];
  const values: string[] = [];
  for (const choice of raw) {
    const choiceRecord = recordOf(choice);
    const value =
      choiceRecord === undefined
        ? stringOf(choice)
        : (stringOf(choiceRecord.value) ??
          stringOf(choiceRecord.modelId) ??
          stringOf(choiceRecord.optionId) ??
          stringOf(choiceRecord.id) ??
          stringOf(choiceRecord.level));
    if (value !== undefined && !values.includes(value)) values.push(value);
  }
  const defaultValue =
    stringOf(state.currentValue) ??
    stringOf(state.current) ??
    stringOf(option.currentValue) ??
    stringOf(option.current) ??
    stringOf(option.default) ??
    (values.length > 0 ? values[0]! : null);
  return { values, default: defaultValue };
}

const isEffortOption = (id: string, name: string): boolean =>
  id === "thought_level" || id === "reasoning_effort" || /thought|reasoning|effort/i.test(name);

const isModelOption = (id: string, name: string): boolean => id === "model" || /model/i.test(name);

/**
 * Candidate config ids for applying a reasoning effort to one model, in
 * preference order: the session's advertised effort option(s) scoped to that
 * model, then any global effort option, then the two well-known ACP ids.
 */
export function effortConfigIds(sessionResult: unknown, modelId: string | undefined): string[] {
  const ids: string[] = [];
  for (const raw of list(recordOf(sessionResult)?.configOptions)) {
    const option = recordOf(raw);
    if (option === undefined) continue;
    const id = stringOf(option.id) ?? stringOf(option.configId);
    const name = stringOf(option.name) ?? stringOf(option.description) ?? "";
    if (id === undefined || !isEffortOption(id, name)) continue;
    const scoped = stringOf(option.modelId) ?? stringOf(recordOf(option.scope)?.modelId);
    if (scoped !== undefined && scoped !== modelId) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  for (const fallback of ["thought_level", "reasoning_effort"]) {
    if (!ids.includes(fallback)) ids.push(fallback);
  }
  return ids;
}

/**
 * `configOptions` advertised on a `session/new` result: one option carries the
 * model list, one (per model or global) the effort levels. An effort option
 * carrying a `modelId` scopes to that model only; otherwise it applies to
 * every discovered model. Returns the session's default model, or null when
 * the harness advertised nothing.
 */
function parseConfigOptions(
  result: unknown,
  models: Map<string, HarnessModelCatalog>,
  probedAt: string,
): string | null {
  const options = list(recordOf(result)?.configOptions);
  if (options.length === 0) return null;
  let defaultModel: string | null = null;
  const scopedEfforts = new Map<string, { values: string[]; default: string | null }>();
  let globalEfforts: { values: string[]; default: string | null } | undefined;

  for (const raw of options) {
    const option = recordOf(raw);
    if (option === undefined) continue;
    const id = stringOf(option.id) ?? stringOf(option.configId) ?? "";
    const name = stringOf(option.name) ?? stringOf(option.description) ?? "";
    const modelId =
      stringOf(option.modelId) ?? stringOf(recordOf(option.scope)?.modelId) ?? undefined;
    if (isModelOption(id, name)) {
      const { values, default: current } = parseOptionChoices(option);
      for (const value of values) seedModel(models, { id: value });
      defaultModel = current ?? defaultModel;
      continue;
    }
    if (isEffortOption(id, name)) {
      const parsed = parseOptionChoices(option);
      if (modelId !== undefined) scopedEfforts.set(modelId, parsed);
      else globalEfforts = parsed;
    }
  }

  const withEfforts = (
    model: HarnessModelCatalog,
    efforts: { values: string[]; default: string | null },
  ): HarnessModelCatalog => ({
    ...model,
    reasoningDiscovery: "known",
    effortLevels: [...efforts.values],
    defaultEffort: efforts.default,
    probedAt,
  });
  for (const model of models.values()) {
    const scoped = scopedEfforts.get(model.id);
    if (scoped !== undefined) models.set(model.id, withEfforts(model, scoped));
    else if (globalEfforts !== undefined) models.set(model.id, withEfforts(model, globalEfforts));
  }
  return defaultModel;
}

/**
 * Probe one harness: spawn its ACP command, run the `initialize` and
 * `session/new` handshake under a strict deadline, read the discovery
 * payloads, then tear the probe process group down cleanly. A spawn failure
 * or a lost handshake returns `{ ok: false }` — the catalog keeps any
 * previously known entry for that harness instead.
 */
export async function probeHarness(
  harness: HarnessDefinition,
  options: {
    cwd: string;
    signal?: AbortSignal | undefined;
    /** Test seam: a smaller deadline keeps probe tests fast. */
    handshakeTimeoutMs?: number | undefined;
  },
): Promise<ProbeOutcome> {
  const probedAt = new Date().toISOString();
  if (options.signal?.aborted === true) return { ok: false, reason: "Runner stopped." };
  let client: AcpStdioClient | undefined;
  try {
    client = await AcpStdioClient.start({
      command: harness.command,
      args: harness.args,
      cwd: options.cwd,
      // A probe-specific env marker lets test stubs tell probe sessions apart
      // from real dispatch supervision sessions.
      env: { STUB_ACP_PROBE: "1" },
      mcpServers: [],
      worktreeReal: options.cwd,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? PROBE_HANDSHAKE_TIMEOUT_MS,
      captureHandshake: true,
      signal: options.signal,
      onUpdate: () => {},
      onStderr: () => {},
    });
    const initModels = parseInitializeModels(client.initResult);
    const models = initModels.models;
    const defaultModel = parseConfigOptions(client.sessionResult, models, probedAt);
    const resolvedDefault = defaultModel ?? initModels.current;
    return {
      ok: true,
      models: [...models.values()],
      defaultModel:
        resolvedDefault !== null && models.has(resolvedDefault) ? resolvedDefault : null,
      probedAt,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    // Never leak the detached process group, even when a deadline fired.
    if (client !== undefined) await client.forceExit(PROBE_TEARDOWN_GRACE_MS);
  }
}

/** Builds the catalog entry for a successful probe. */
export function entryFromProbe(
  harness: HarnessDefinition,
  outcome: Extract<ProbeOutcome, { ok: true }>,
): HarnessCatalogEntry {
  return {
    id: harness.id,
    displayName: harness.displayName,
    source: harness.source,
    defaultModel: outcome.defaultModel,
    models: outcome.models,
    probedAt: outcome.probedAt,
  };
}

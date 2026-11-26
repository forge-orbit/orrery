import type { HarnessModel } from "@orrery/contract";

/**
 * Dialect-tolerant ACP discovery parsing (ported from PR #255, issue #240).
 *
 * Harnesses disagree about where they advertise models and reasoning-effort
 * choices: `initialize.models`, `session/new.models.availableModels`, a
 * `model` config option, bare-string model ids, `options`/`choices`, and
 * effort options that are either global or scoped to one `modelId`. This
 * module reads all of those shapes without trusting the payload, and is the
 * single parser used by startup catalog discovery (ADR-0011).
 */

export interface Discovery {
  models: HarnessModel[];
  defaultModel: string;
  probedAt: string;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A model reference in any ACP dialect, including a bare string id. */
function parseModelRef(value: unknown): { id: string; label?: string } | undefined {
  const record = recordOf(value);
  if (record === undefined) {
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
  models: Map<string, HarnessModel>,
  parsed: { id: string; label?: string },
  probedAt: string,
): void {
  if (models.has(parsed.id)) return;
  models.set(parsed.id, {
    id: parsed.id,
    ...(parsed.label === undefined ? {} : { label: parsed.label }),
    reasoningDiscovery: "unknown",
    probedAt,
  });
}

/** Models advertised on an `initialize` result under `models`. */
function parseInitializeModels(
  result: unknown,
  models: Map<string, HarnessModel>,
  probedAt: string,
): string | null {
  const container = recordOf(result)?.models;
  if (container === undefined) return null;
  if (Array.isArray(container)) {
    for (const ref of container) {
      const parsed = parseModelRef(ref);
      if (parsed !== undefined) seedModel(models, parsed, probedAt);
    }
    return null;
  }
  const shape = recordOf(container);
  if (shape === undefined) return null;
  const refs = [...list(shape.availableModels), ...list(shape.models)];
  for (const ref of refs) {
    const parsed = parseModelRef(ref);
    if (parsed !== undefined) seedModel(models, parsed, probedAt);
  }
  return (
    stringOf(shape.currentModelId) ??
    stringOf(shape.currentModel) ??
    stringOf(shape.current) ??
    null
  );
}

/** The choices of one session-config option, in any ACP dialect. */
function parseOptionChoices(option: Record<string, unknown>): {
  values: string[];
  default: string | undefined;
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
    values[0];
  return { values, default: defaultValue };
}

const isEffortOption = (id: string, name: string): boolean =>
  id === "thought_level" || id === "reasoning_effort" || /thought|reasoning|effort/i.test(name);

const isModelOption = (id: string, name: string): boolean => id === "model" || /model/i.test(name);

type EffortChoice = { values: string[]; default: string | undefined };

/**
 * `configOptions` on a `session/new` (or model-switch) result: one option may
 * carry the model list, and one (per model or global) the effort levels. An
 * effort option carrying a `modelId` scopes to that model only. An unscoped
 * option describes the ACTIVE model only (the standard ACP shape) — applying
 * it to every model would falsely mark unprobed models `known` and break #242
 * on-demand probing. Returns the advertised default model id.
 */
function parseConfigOptions(
  result: unknown,
  models: Map<string, HarnessModel>,
  probedAt: string,
  activeModelHint: string | undefined,
): string | null {
  const options = list(recordOf(result)?.configOptions);
  if (options.length === 0) return null;
  let defaultModel: string | null = null;
  let configActive: string | undefined;
  const scopedEfforts = new Map<string, EffortChoice>();
  let globalEfforts: EffortChoice | undefined;

  for (const raw of options) {
    const option = recordOf(raw);
    if (option === undefined) continue;
    const id = stringOf(option.id) ?? stringOf(option.configId) ?? "";
    const name = stringOf(option.name) ?? stringOf(option.description) ?? "";
    const modelId =
      stringOf(option.modelId) ?? stringOf(recordOf(option.scope)?.modelId) ?? undefined;
    if (isModelOption(id, name)) {
      const { values, default: current } = parseOptionChoices(option);
      for (const value of values) seedModel(models, { id: value }, probedAt);
      defaultModel = current ?? defaultModel;
      configActive = current ?? configActive;
      continue;
    }
    if (isEffortOption(id, name)) {
      const parsed = parseOptionChoices(option);
      if (modelId !== undefined) scopedEfforts.set(modelId, parsed);
      else globalEfforts = parsed;
    }
  }

  const withEfforts = (model: HarnessModel, efforts: EffortChoice): HarnessModel => ({
    id: model.id,
    ...(model.label === undefined ? {} : { label: model.label }),
    reasoningDiscovery: "known",
    supportedEfforts: [...efforts.values],
    ...(efforts.default === undefined ? {} : { defaultEffort: efforts.default }),
    probedAt,
  });
  for (const model of models.values()) {
    const scoped = scopedEfforts.get(model.id);
    if (scoped !== undefined) models.set(model.id, withEfforts(model, scoped));
  }
  // Unscoped efforts belong to the one model the session actually selected.
  const active = configActive ?? activeModelHint;
  if (globalEfforts !== undefined && active !== undefined) {
    const model = models.get(active);
    if (model !== undefined) models.set(active, withEfforts(model, globalEfforts));
  }
  return defaultModel;
}

/** Current config-option values, restored after an on-demand model probe. */
export function currentConfigValues(result: unknown): Array<{ id: string; value: string }> {
  const values: Array<{ id: string; value: string }> = [];
  for (const raw of list(recordOf(result)?.configOptions)) {
    const option = recordOf(raw);
    if (option === undefined) continue;
    const id = stringOf(option.id) ?? stringOf(option.configId);
    const state = recordOf(option.state) ?? {};
    const value =
      stringOf(state.currentValue) ??
      stringOf(state.current) ??
      stringOf(option.currentValue) ??
      stringOf(option.current);
    if (id !== undefined && value !== undefined) values.push({ id, value });
  }
  return values;
}

/**
 * Parse one discovery payload pair into published catalog models. `seeds`
 * adds model ids that must be present even when the harness only reports
 * effort options for the active model.
 */
export function parseDiscovery(
  initResult: unknown,
  sessionResult: unknown,
  probedAt: string,
  seeds: readonly string[] = [],
): Discovery {
  const models = new Map<string, HarnessModel>();
  const initCurrent = parseInitializeModels(initResult, models, probedAt);
  // A session/new result may also advertise its own model list and active
  // model (the ACP dialect our stub uses); read it with the same helper.
  const sessionCurrent = parseInitializeModels(sessionResult, models, probedAt);
  for (const id of seeds) seedModel(models, { id }, probedAt);
  // Explicit seeds name the model being discovered, so they outrank the
  // session's own active-model hint.
  const activeModelHint = sessionCurrent ?? seeds[0] ?? initCurrent ?? undefined;
  const configCurrent = parseConfigOptions(sessionResult, models, probedAt, activeModelHint);
  const first = models.keys().next().value;
  const defaultModel = configCurrent ?? sessionCurrent ?? initCurrent ?? first ?? "default";
  // The advertised default may name a model the harness never seeded; keep it
  // as the default only when it is one we actually know about.
  return {
    models: [...models.values()],
    defaultModel:
      defaultModel !== null && models.has(defaultModel) ? defaultModel : (first ?? "default"),
    probedAt,
  };
}

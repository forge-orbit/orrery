/**
 * Per-project delegation preferences. The last-used Runner, Harness, Model,
 * Effort and Agent are remembered; the prompt is deliberately never persisted
 * (#236 user story 16). Browser storage can be disabled or full, so every
 * access is best-effort. Older preferences without execution choices still
 * parse and fall back cleanly (#241).
 */
import type { HarnessCatalog } from "@orrery/contract";

export interface DelegatePreference {
  runnerId: string;
  agentId: string;
  harness?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

const keyFor = (projectId: string) => `orrery.delegate.${projectId}`;

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

const isPreference = (value: unknown): value is DelegatePreference => {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    typeof record.runnerId === "string" &&
    typeof record.agentId === "string" &&
    optionalString(record.harness) &&
    optionalString(record.model) &&
    optionalString(record.effort)
  );
};

export function readDelegatePreference(projectId: string): DelegatePreference | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(keyFor(projectId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isPreference(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeDelegatePreference(projectId: string, preference: DelegatePreference): void {
  if (typeof window === "undefined") return;
  try {
    const stored: DelegatePreference = {
      runnerId: preference.runnerId,
      harness: preference.harness ?? "",
      model: preference.model ?? "",
      effort: preference.effort ?? "",
      agentId: preference.agentId,
    };
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(stored));
  } catch {
    // Storage is optional: delegation still works without remembered choices.
  }
}

/**
 * Validate remembered choices against the live, delegatable options on every
 * render. An offline Runner, unpublished Harness, retired Model or Effort the
 * model no longer supports is dropped instead of blocking delegation. A model
 * with no remembered value falls back to the Harness's published default.
 */
export function resolveDelegateChoice(
  preference: DelegatePreference | undefined,
  runners: readonly { id: string; harnessCatalog?: HarnessCatalog | undefined }[],
  agents: readonly { id: string }[],
): DelegatePreference {
  const rememberedRunner = preference?.runnerId;
  const rememberedAgent = preference?.agentId;
  const runnerId =
    rememberedRunner !== undefined && runners.some((runner) => runner.id === rememberedRunner)
      ? rememberedRunner
      : (runners[0]?.id ?? "");
  const agentId =
    rememberedAgent !== undefined && agents.some((agent) => agent.id === rememberedAgent)
      ? rememberedAgent
      : "";

  const runner = runners.find((item) => item.id === runnerId);
  const harnesses = runner?.harnessCatalog?.harnesses ?? [];
  const harness =
    preference?.harness !== undefined && harnesses.some((item) => item.id === preference.harness)
      ? preference.harness
      : "";
  const entry = harnesses.find((item) => item.id === harness);
  const models = entry?.models ?? [];
  const rememberedModel = preference?.model;
  const model =
    rememberedModel !== undefined && models.some((item) => item.id === rememberedModel)
      ? rememberedModel
      : models.some((item) => item.id === entry?.defaultModel)
        ? (entry?.defaultModel ?? "")
        : "";
  const rememberedEffort = preference?.effort;
  // A remembered effort belongs to the model it was chosen for: if the model
  // had to be replaced, drop the effort as well (#241).
  const effort =
    model === rememberedModel &&
    rememberedEffort !== undefined &&
    models.some(
      (item) => item.id === model && (item.supportedEfforts ?? []).includes(rememberedEffort),
    )
      ? rememberedEffort
      : "";
  return { runnerId, harness, model, effort, agentId };
}

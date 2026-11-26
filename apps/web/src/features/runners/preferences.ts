/**
 * Per-project delegation preferences. Only the last-used Runner and Agent are
 * remembered; the prompt is deliberately never persisted (#236 user story 16).
 * Browser storage can be disabled or full, so every access is best-effort.
 */

export interface DelegatePreference {
  runnerId: string;
  agentId: string;
}

const keyFor = (projectId: string) => `orrery.delegate.${projectId}`;

const isPreference = (value: unknown): value is DelegatePreference => {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return typeof record.runnerId === "string" && typeof record.agentId === "string";
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
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(preference));
  } catch {
    // Storage is optional: delegation still works without remembered choices.
  }
}

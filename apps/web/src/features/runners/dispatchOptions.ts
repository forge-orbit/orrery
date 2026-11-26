import type { Runner } from "@orrery/contract";

/**
 * The display name for a Dispatch's Harness id, read from the Runner's
 * published catalog. A stale or unknown id falls back to the id itself so the
 * UI never hides what was actually chosen.
 */
export function harnessDisplayName(
  runner: Runner | undefined,
  harnessId: string | null | undefined,
): string | null {
  if (harnessId === null || harnessId === undefined) return null;
  return (
    runner?.harnessCatalog?.harnesses.find((entry) => entry.id === harnessId)?.displayName ??
    harnessId
  );
}

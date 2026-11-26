/**
 * Per-Harness probe/spawn lock (ADR-0011). A Harness has one CLI default model:
 * a discovery probe temporarily switches it, so a Dispatch for that same
 * Harness must never start an ACP session while the probe is in flight. Each
 * Harness has its own queue, so unrelated Harnesses still start in parallel.
 */
const tails = new Map<string, Promise<void>>();

/** Run `task` after every earlier task for this Harness has settled. */
export function withHarnessLock<T>(harnessId: string, task: () => Promise<T>): Promise<T> {
  // `tails` only ever holds already-settled-safe promises, so `.then` cannot
  // inherit a rejection from a failed probe or session setup.
  const previous = tails.get(harnessId) ?? Promise.resolve();
  const result = previous.then(task);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(harnessId, tail);
  void tail.then(() => {
    if (tails.get(harnessId) === tail) tails.delete(harnessId);
  });
  return result;
}

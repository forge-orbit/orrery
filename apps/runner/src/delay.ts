/** Cancellable sleep shared by the login poller and the heartbeat loop. */
export function delay(
  ms: number,
  signal: AbortSignal | undefined,
  stopMessage: string,
): Promise<void> {
  return new Promise((finish, reject) => {
    if (signal?.aborted === true) {
      reject(new Error(stopMessage));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      finish();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(stopMessage));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

import type { Sql } from "../../platform/db.ts";

type Waiter = { fire: () => void };

export interface CommandNotifier {
  /** Resolve on an ID-only doorbell for this runner, or after `waitMs`. */
  wait(runnerId: string, waitMs: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/**
 * ONE dedicated LISTEN connection per service instance (per replica). Notifications
 * are a latency doorbell only: pollers always query Postgres before and after
 * waiting, so a dropped notification or listener restart cannot lose a command.
 */
export function createCommandNotifier(sql: Sql): CommandNotifier {
  const waiters = new Map<string, Set<Waiter>>();
  let listening: Awaited<ReturnType<Sql["listen"]>> | undefined;
  let listenPromise: ReturnType<Sql["listen"]> | undefined;
  let closed = false;

  const ensureListening = async () => {
    if (closed) throw new Error("command notifier is closed");
    // Assign the promise synchronously so concurrent pollers share one LISTEN.
    listenPromise ??= sql.listen("runner_commands", (runnerId: string) => {
      const bucket = waiters.get(runnerId);
      if (bucket === undefined) return;
      for (const waiter of bucket) waiter.fire();
    });
    listening ??= await listenPromise;
  };

  return {
    async wait(runnerId, waitMs, signal) {
      await ensureListening();
      return new Promise<void>((resolve) => {
        let bucket = waiters.get(runnerId);
        if (bucket === undefined) {
          bucket = new Set();
          waiters.set(runnerId, bucket);
        }
        const target = bucket;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          target.delete(waiter);
          if (target.size === 0) waiters.delete(runnerId);
          resolve();
        };
        const waiter: Waiter = { fire: done };
        timer = setTimeout(done, Math.max(1, waitMs));
        timer.unref?.();
        if (signal?.aborted === true) {
          done();
          return;
        }
        signal?.addEventListener("abort", done, { once: true });
        target.add(waiter);
      });
    },
    async close() {
      closed = true;
      for (const bucket of waiters.values()) {
        for (const waiter of bucket) waiter.fire();
      }
      waiters.clear();
      await listening?.unlisten();
      listening = undefined;
      listenPromise = undefined;
    },
  };
}

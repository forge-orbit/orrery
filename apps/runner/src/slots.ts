export type SlotState = "idle" | "running" | "draining";

/** The handle a running dispatch exposes so a `cancel` command can reach it. */
export interface SlotController {
  readonly dispatchId: string;
  readonly dispatchAttemptId: string;
  readonly issueId: string;
  requestCancel(reason: string): void;
  readonly cancelled: Promise<string>;
  readonly finished: Promise<void>;
}

export interface Slot {
  readonly index: number;
  state: SlotState;
  controller?: SlotController | undefined;
}

/**
 * Bounded concurrency slots. A slot is never returned to `idle` until the
 * supervision promises (and therefore the detached ACP process group) have
 * actually finished, including after a disconnect or an unacknowledged cancel.
 */
export class SlotPool {
  readonly size: number;
  private readonly slots: Slot[];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error("slot pool size must be >= 1");
    this.size = size;
    this.slots = Array.from({ length: size }, (_, index) => ({ index, state: "idle" as const }));
  }

  get used(): number {
    return this.slots.filter((slot) => slot.state !== "idle").length;
  }

  get states(): readonly SlotState[] {
    return this.slots.map((slot) => slot.state);
  }

  acquire(): Slot | undefined {
    const slot = this.slots.find((candidate) => candidate.state === "idle");
    if (slot === undefined) return undefined;
    slot.state = "running";
    return slot;
  }

  attach(slot: Slot, controller: SlotController): void {
    slot.controller = controller;
  }

  markDraining(slot: Slot): void {
    if (slot.state === "running") slot.state = "draining";
  }

  /** Called by supervision only after the ACP process group has exited. */
  release(slot: Slot): void {
    slot.state = "idle";
    slot.controller = undefined;
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }

  controllerFor(dispatchAttemptId: string): SlotController | undefined {
    return this.slots.find((slot) => slot.controller?.dispatchAttemptId === dispatchAttemptId)
      ?.controller;
  }

  cancelAll(reason: string): void {
    for (const slot of this.slots) {
      if (slot.state === "idle") continue;
      this.markDraining(slot);
      slot.controller?.requestCancel(reason);
    }
  }

  /** Wait for at least one idle slot without blocking the command poller. */
  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.slots.some((slot) => slot.state === "idle")) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.idleWaiters.indexOf(done);
        if (index >= 0) this.idleWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(done);
    });
  }

  async drain(): Promise<void> {
    for (;;) {
      const running: Promise<void>[] = [];
      for (const slot of this.slots) {
        if (slot.controller !== undefined) running.push(slot.controller.finished);
      }
      if (running.length === 0) return;
      await Promise.all(running);
      if (this.slots.every((slot) => slot.state === "idle")) return;
    }
  }
}

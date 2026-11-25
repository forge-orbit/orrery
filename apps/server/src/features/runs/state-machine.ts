import type { RunEndReason, RunEventType, RunStatus } from "@orrery/contract";
import { defineStateMachine } from "../../platform/state-machine.ts";

/**
 * A run with no liveness observation for this long, and no live work session,
 * is stale. Runs are observations, not claim leases, so the window is generous
 * enough to cover an idle conversation between tool calls.
 */
export const RUN_STALE_AFTER_SECONDS = 30 * 60;

export const runMachine = defineStateMachine<RunStatus>("Run", {
  active: ["active", "ended"],
  ended: ["active", "ended"],
});

/** Events that prove the harness is still alive (an explicit end is not one). */
export function observesRunLiveness(event: RunEventType, hasCheckIn: boolean): boolean {
  return event === "run_started" || event === "run_heartbeat" || hasCheckIn;
}

/**
 * A heartbeat may revive a run that expired on staleness, but never one the
 * harness explicitly ended; a late heartbeat must not undo `run_ended`.
 * A fresh `run_started` (a real session resume) revives either.
 */
export function nextRunStatus(
  current: RunStatus,
  event: RunEventType,
  endedReason: RunEndReason | null = null,
): RunStatus {
  if (event === "run_ended") return runMachine.assertTransition(current, "ended");
  if (event === "run_started" && current === "ended") {
    return runMachine.assertTransition(current, "active");
  }
  if (event === "run_heartbeat" && current === "ended" && endedReason === "stale") {
    return runMachine.assertTransition(current, "active");
  }
  return current;
}

export function nextChildRunStatus(event: RunEventType): RunStatus {
  return event === "child_ended" ? "ended" : "active";
}

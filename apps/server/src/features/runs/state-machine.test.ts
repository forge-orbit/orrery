import { describe, expect, it } from "vitest";
import { nextChildRunStatus, nextRunStatus, observesRunLiveness } from "./state-machine.ts";

describe("run state machine", () => {
  it("keeps an active run active for start, heartbeat and child observations", () => {
    expect(nextRunStatus("active", "run_started")).toBe("active");
    expect(nextRunStatus("active", "run_heartbeat")).toBe("active");
    expect(nextRunStatus("active", "child_started")).toBe("active");
    expect(nextRunStatus("active", "child_ended")).toBe("active");
  });

  it("ends on run_ended and treats a second end as idempotent", () => {
    expect(nextRunStatus("active", "run_ended")).toBe("ended");
    expect(nextRunStatus("ended", "run_ended", "reported")).toBe("ended");
    expect(nextRunStatus("ended", "run_ended", "stale")).toBe("ended");
  });

  it("resumes an explicitly ended run only on a fresh run_started", () => {
    expect(nextRunStatus("ended", "run_started", "reported")).toBe("active");
    expect(nextRunStatus("ended", "run_heartbeat", "reported")).toBe("ended");
    expect(nextRunStatus("ended", "child_started", "reported")).toBe("ended");
  });

  it("lets a heartbeat revive a run that expired on staleness", () => {
    expect(nextRunStatus("ended", "run_heartbeat", "stale")).toBe("active");
    expect(nextRunStatus("ended", "run_started", "stale")).toBe("active");
    expect(nextRunStatus("ended", "child_started", "stale")).toBe("ended");
  });

  it("does not revive legacy ended rows that have no recorded reason", () => {
    expect(nextRunStatus("ended", "run_heartbeat", null)).toBe("ended");
  });

  it("treats start, heartbeat and check-ins as liveness observations", () => {
    expect(observesRunLiveness("run_started", false)).toBe(true);
    expect(observesRunLiveness("run_heartbeat", false)).toBe(true);
    expect(observesRunLiveness("child_started", true)).toBe(true);
    expect(observesRunLiveness("child_started", false)).toBe(false);
    expect(observesRunLiveness("run_ended", false)).toBe(false);
  });

  it("maps child events to active and ended", () => {
    expect(nextChildRunStatus("child_started")).toBe("active");
    expect(nextChildRunStatus("child_ended")).toBe("ended");
    expect(nextChildRunStatus("run_heartbeat")).toBe("active");
  });
});

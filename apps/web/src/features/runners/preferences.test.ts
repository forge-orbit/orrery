import { describe, expect, it } from "vitest";
import { resolveDelegateChoice } from "./preferences.ts";

describe("delegate preference fallback", () => {
  it("keeps a remembered Runner and Agent while both are still available", () => {
    expect(
      resolveDelegateChoice(
        { runnerId: "remembered-runner", agentId: "remembered-agent" },
        [{ id: "other-runner" }, { id: "remembered-runner" }],
        [{ id: "other-agent" }, { id: "remembered-agent" }],
      ),
    ).toEqual({ runnerId: "remembered-runner", agentId: "remembered-agent" });
  });

  it("falls back to the first online Runner and no Agent when the remembered ones are stale", () => {
    expect(
      resolveDelegateChoice(
        { runnerId: "offline-runner", agentId: "removed-agent" },
        [{ id: "online-runner" }, { id: "busy-runner" }],
        [{ id: "active-agent" }],
      ),
    ).toEqual({ runnerId: "online-runner", agentId: "" });
  });

  it("leaves the modal empty when no Runner is delegatable", () => {
    expect(
      resolveDelegateChoice(
        { runnerId: "offline-runner", agentId: "agent" },
        [],
        [{ id: "agent" }],
      ),
    ).toEqual({ runnerId: "", agentId: "agent" });
  });

  it("handles absent browser storage", () => {
    expect(resolveDelegateChoice(undefined, [{ id: "only-runner" }], [{ id: "agent" }])).toEqual({
      runnerId: "only-runner",
      agentId: "",
    });
  });
});

import type { HarnessCatalog } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import {
  readDelegatePreference,
  resolveDelegateChoice,
  writeDelegatePreference,
} from "./preferences.ts";

const catalog: HarnessCatalog = {
  probedAt: "2026-01-01T00:00:00.000Z",
  harnesses: [
    {
      id: "opencode",
      displayName: "OpenCode",
      defaultModel: "stub-model-1",
      models: [
        {
          id: "stub-model-1",
          reasoningDiscovery: "known",
          supportedEfforts: ["low", "high"],
          defaultEffort: "low",
        },
        { id: "stub-model-2", reasoningDiscovery: "unknown" },
      ],
      probedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const runner = (id: string, harnessCatalog: HarnessCatalog = catalog) => ({
  id,
  harnessCatalog,
});

describe("delegate preference fallback", () => {
  it("keeps a remembered Runner and Agent while both are still available", () => {
    expect(
      resolveDelegateChoice(
        { runnerId: "remembered-runner", agentId: "remembered-agent" },
        [{ id: "other-runner" }, { id: "remembered-runner" }],
        [{ id: "other-agent" }, { id: "remembered-agent" }],
      ),
    ).toEqual({
      runnerId: "remembered-runner",
      harness: "",
      model: "",
      effort: "",
      agentId: "remembered-agent",
    });
  });

  it("falls back to the first online Runner and no Agent when the remembered ones are stale", () => {
    expect(
      resolveDelegateChoice(
        { runnerId: "offline-runner", agentId: "removed-agent" },
        [{ id: "online-runner" }, { id: "busy-runner" }],
        [{ id: "active-agent" }],
      ),
    ).toEqual({ runnerId: "online-runner", harness: "", model: "", effort: "", agentId: "" });
  });

  it("leaves the modal empty when no Runner is delegatable", () => {
    expect(
      resolveDelegateChoice(
        { runnerId: "offline-runner", agentId: "agent" },
        [],
        [{ id: "agent" }],
      ),
    ).toEqual({ runnerId: "", harness: "", model: "", effort: "", agentId: "agent" });
  });

  it("handles absent browser storage", () => {
    expect(resolveDelegateChoice(undefined, [{ id: "only-runner" }], [{ id: "agent" }])).toEqual({
      runnerId: "only-runner",
      harness: "",
      model: "",
      effort: "",
      agentId: "",
    });
  });
});

describe("remembered harness, model and effort (#241)", () => {
  it("keeps a remembered choice when the Runner and Harness are still available", () => {
    expect(
      resolveDelegateChoice(
        {
          runnerId: "runner-1",
          harness: "opencode",
          model: "stub-model-1",
          effort: "high",
          agentId: "agent-1",
        },
        [runner("runner-1")],
        [{ id: "agent-1" }],
      ),
    ).toEqual({
      runnerId: "runner-1",
      harness: "opencode",
      model: "stub-model-1",
      effort: "high",
      agentId: "agent-1",
    });
  });

  it("clears a stale Harness, Model and Effort when the Runner's catalog changed", () => {
    expect(
      resolveDelegateChoice(
        {
          runnerId: "runner-1",
          harness: "cursor",
          model: "old-model",
          effort: "ultra",
          agentId: "",
        },
        [runner("runner-1")],
        [],
      ),
    ).toEqual({ runnerId: "runner-1", harness: "", model: "", effort: "", agentId: "" });
  });

  it("clears a stale Effort when the remembered model no longer supports it", () => {
    expect(
      resolveDelegateChoice(
        {
          runnerId: "runner-1",
          harness: "opencode",
          model: "stub-model-1",
          effort: "ultra",
          agentId: "",
        },
        [runner("runner-1")],
        [],
      ),
    ).toMatchObject({ model: "stub-model-1", effort: "" });
  });

  it("falls back to the Harness's default model when the remembered model is gone", () => {
    expect(
      resolveDelegateChoice(
        {
          runnerId: "runner-1",
          harness: "opencode",
          model: "retired-model",
          effort: "high",
          agentId: "",
        },
        [runner("runner-1")],
        [],
      ),
    ).toMatchObject({ model: "stub-model-1", effort: "" });
  });

  it("accepts older stored preferences without dropping the Runner and Agent", () => {
    const raw = JSON.stringify({ runnerId: "runner-1", agentId: "agent-1" });
    const store = new Map([["orrery.delegate.project-1", raw]]);
    const previous = globalThis.window;
    // Minimal localStorage seam; the web app treats storage as best-effort.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
        },
      },
    });
    try {
      expect(readDelegatePreference("project-1")).toEqual({
        runnerId: "runner-1",
        agentId: "agent-1",
      });
      writeDelegatePreference("project-1", {
        runnerId: "runner-1",
        harness: "opencode",
        model: "stub-model-1",
        effort: "high",
        agentId: "agent-1",
      });
      expect(JSON.parse(store.get("orrery.delegate.project-1") ?? "{}")).toEqual({
        runnerId: "runner-1",
        harness: "opencode",
        model: "stub-model-1",
        effort: "high",
        agentId: "agent-1",
      });
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
    }
  });
});

import type { HarnessCatalog } from "@orrery/contract";
import { describe, expect, it } from "vitest";
import { withHarnessLock } from "./harness-lock.ts";
import { resolveExecutionChoice } from "./dispatch-options.ts";
import type { HarnessDefinition } from "./harnesses.ts";

const stub: HarnessDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  command: "/usr/bin/never-execute-from-server",
  args: ["acp"],
};

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
      ],
      probedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("local-only dispatch option resolution (#241)", () => {
  const context = {
    definitions: [stub],
    catalog,
    defaultCommand: { command: "opencode", args: ["acp"] },
  };

  it("resolves a Harness only through the local registry and never from server fields", () => {
    const resolved = resolveExecutionChoice(
      { harness: "opencode", model: "stub-model-2", effort: "high" },
      context,
    );
    expect(resolved).toMatchObject({
      kind: "harness",
      definition: stub,
      model: "stub-model-2",
      effort: "high",
    });
  });

  it("passes the Harness's cached defaultModel when a Dispatch omits model", () => {
    const resolved = resolveExecutionChoice({ harness: "opencode" }, context);
    expect(resolved).toMatchObject({
      kind: "harness",
      model: "stub-model-1",
      defaultModelUsed: true,
    });
  });

  it("fails locally when a Harness is not installed, even if the server published it", () => {
    const resolved = resolveExecutionChoice({ harness: "cursor" }, context);
    expect(resolved).toMatchObject({
      kind: "error",
      reason: "harness_not_installed",
      harness: "cursor",
    });
  });

  it("keeps the current ACP command when no Harness was selected", () => {
    const resolved = resolveExecutionChoice({ model: "stub-model-2" }, context);
    expect(resolved).toMatchObject({
      kind: "default",
      command: { command: "opencode", args: ["acp"] },
      model: "stub-model-2",
    });
  });
});

describe("per-Harness probe/spawn lock (#241)", () => {
  it("never overlaps two sessions for the same Harness", async () => {
    const order: string[] = [];
    let active = 0;
    const task = async (name: string, release: () => void): Promise<void> => {
      await withHarnessLock("opencode", async () => {
        active += 1;
        order.push(`${name}:start:${active}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        release();
        active -= 1;
        order.push(`${name}:end`);
      });
    };

    const secondStarted = new Promise<void>((resolve) => {
      void task("first", () => {});
      void withHarnessLock("opencode", async () => {
        active += 1;
        order.push("second:start");
        resolve();
        await new Promise<void>((done) => setTimeout(done, 20));
        active -= 1;
        order.push("second:end");
      });
    });
    await secondStarted;
    expect(order).toEqual(["first:start:1", "first:end", "second:start"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(active).toBe(0);
  });

  it("allows different Harnesses to start concurrently", async () => {
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      await withHarnessLock(Math.random().toString(), async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    };
    await Promise.all([task(), task()]);
    expect(peak).toBe(2);
  });
});

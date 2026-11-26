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

  it("uses the local default Harness and its cached model when both are omitted", () => {
    const installed: HarnessDefinition = {
      id: "opencode",
      displayName: "OpenCode",
      command: "opencode",
      args: ["acp"],
    };
    const resolved = resolveExecutionChoice(
      {},
      { definitions: [installed], catalog, defaultCommand: installed },
    );
    expect(resolved).toMatchObject({
      kind: "harness",
      definition: { id: "opencode", command: "opencode" },
      model: "stub-model-1",
      defaultModelUsed: true,
    });
  });

  it("keeps an explicit model while resolving the local default Harness", () => {
    const installed: HarnessDefinition = {
      id: "opencode",
      displayName: "OpenCode",
      command: "opencode",
      args: ["acp"],
    };
    const resolved = resolveExecutionChoice(
      { model: "stub-model-2" },
      { definitions: [installed], catalog, defaultCommand: installed },
    );
    expect(resolved).toMatchObject({
      kind: "harness",
      definition: { id: "opencode" },
      model: "stub-model-2",
      defaultModelUsed: false,
    });
  });
});

describe("default Harness identity for probe/spawn locking (#241)", () => {
  const override = { command: "/opt/agents/node", args: ["/srv/harness.mjs"] };
  const custom: HarnessDefinition = {
    id: "custom",
    displayName: "Custom ACP harness",
    command: override.command,
    args: [...override.args],
  };
  const customCatalog: HarnessCatalog = {
    probedAt: "2026-01-01T00:00:00.000Z",
    harnesses: [
      {
        id: "custom",
        displayName: "Custom ACP harness",
        defaultModel: "cached-model",
        models: [{ id: "cached-model", reasoningDiscovery: "unknown" }],
        probedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  it("resolves a custom command override to its registry id, not its executable path", () => {
    const resolved = resolveExecutionChoice(
      {},
      {
        definitions: [custom],
        catalog: customCatalog,
        defaultCommand: override,
        acpOverride: override,
      },
    );
    expect(resolved).toMatchObject({
      kind: "harness",
      definition: custom,
      model: "cached-model",
      defaultModelUsed: true,
    });
  });

  it("shares one queue for the registry id while a path alias is a different queue", async () => {
    const order: string[] = [];
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const task = (key: string, name: string, wait = 0): Promise<void> =>
      withHarnessLock(key, async () => {
        order.push(`${name}:start`);
        await (wait === 0 ? gate : new Promise<void>((resolve) => setTimeout(resolve, wait)));
        order.push(`${name}:end`);
      });
    const probe = task("custom", "probe");
    const spawn = task("custom", "spawn");
    // The executable path is a different key: it must not wait behind the
    // probe, which is exactly why spawn uses the registry id from resolution.
    const pathAlias = task(override.command, "path-alias", 1);
    const deadline = Date.now() + 2000;
    while (!order.includes("path-alias:start") && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    releaseProbe?.();
    await Promise.all([probe, spawn, pathAlias]);
    expect(order).toContain("path-alias:start");
    expect(order.indexOf("path-alias:end")).toBeLessThan(order.indexOf("probe:end"));
    expect(order.indexOf("spawn:start")).toBeGreaterThan(order.indexOf("probe:end"));
    expect(order.indexOf("spawn:end")).toBeGreaterThan(order.indexOf("spawn:start"));
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

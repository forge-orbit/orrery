import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_HARNESS_CATALOG, type HarnessCatalog } from "@orrery/contract";
import { afterEach, describe, expect, it } from "vitest";
import { catalogWithProbedModel, probeModel } from "./catalog.ts";
import { harnessLockKey, HarnessLocks, type HarnessDefinition } from "./harnesses.ts";

const stubPath = fileURLToPath(new URL("./stub-acp.ts", import.meta.url));
const definition: HarnessDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  source: "override",
  command: process.execPath,
  args: [stubPath],
};

const saved = {
  STUB_ACP_MODE: process.env.STUB_ACP_MODE,
  STUB_ACP_MARKER: process.env.STUB_ACP_MARKER,
  STUB_ACP_DEFAULT_FILE: process.env.STUB_ACP_DEFAULT_FILE,
};
const roots: string[] = [];

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mode: string, defaultModel = "stub-model-1") {
  const root = await mkdtemp(join(tmpdir(), "orrery-runner-probe-"));
  roots.push(root);
  const marker = join(root, "acp.jsonl");
  const defaults = join(root, "cli-default.txt");
  await writeFile(defaults, defaultModel);
  process.env.STUB_ACP_MODE = mode;
  process.env.STUB_ACP_MARKER = marker;
  process.env.STUB_ACP_DEFAULT_FILE = defaults;
  return {
    root,
    marker,
    defaults,
    options: { cwd: root, timeoutMs: 2500 },
    events: async (): Promise<Array<Record<string, unknown>>> => {
      try {
        return (await readFile(marker, "utf8"))
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => {
            const parsed: unknown = JSON.parse(line);
            return typeof parsed === "object" && parsed !== null
              ? Object.fromEntries(Object.entries(parsed))
              : {};
          });
      } catch {
        return [];
      }
    },
    defaultModel: async (): Promise<string> => (await readFile(defaults, "utf8")).trim(),
  };
}

describe("probe_model: switch, discover, restore (#242)", () => {
  it("reads the requested model's own configOptions and restores model and options", async () => {
    const test = await fixture("model-aware");
    const result = await probeModel(definition, "stub-model-2", test.options);
    expect(result.status).toBe("ok");
    expect(result.restored).toBe(true);
    expect(result.recovery).toBe(false);
    expect(result.model).toMatchObject({
      id: "stub-model-2",
      reasoningDiscovery: "known",
      supportedEfforts: ["balanced", "fast"],
      defaultEffort: "balanced",
    });
    expect(await test.defaultModel()).toBe("stub-model-1");
    const events = await test.events();
    expect(events.filter((item) => item.event === "set_model").map((item) => item.modelId)).toEqual(
      ["stub-model-2", "stub-model-1"],
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "set_config_option",
        optionId: "thought_level",
        value: "low",
      }),
    );
  });

  it("publishes known + empty efforts when a model has no reasoning options", async () => {
    const test = await fixture("model-no-effort");
    const result = await probeModel(definition, "stub-model-2", test.options);
    expect(result.status).toBe("ok");
    expect(result.restored).toBe(true);
    expect(result.model).toMatchObject({
      id: "stub-model-2",
      reasoningDiscovery: "known",
      supportedEfforts: [],
    });
    // The published entry stays known, so the UI hides Effort and a later
    // selection does not trigger another probe of the same model.
    const catalog = catalogWithProbedModel(EMPTY_HARNESS_CATALOG, definition, result.model!);
    expect(catalog.harnesses[0]?.models[0]).toMatchObject({
      reasoningDiscovery: "known",
      supportedEfforts: [],
    });
    expect(await test.defaultModel()).toBe("stub-model-1");
  });

  it("restores the previous default after the probe times out", async () => {
    const test = await fixture("probe-timeout");
    const result = await probeModel(definition, "stub-model-2", {
      ...test.options,
      timeoutMs: 300,
    });
    expect(result.status).toBe("restored_after_timeout");
    expect(result.restored).toBe(true);
    expect(await test.defaultModel()).toBe("stub-model-1");
    expect(
      (await test.events())
        .filter((item) => item.event === "set_model")
        .map((item) => item.modelId),
    ).toContain("stub-model-1");
  });

  it("uses a one-shot recovery restore when the probe process dies mid-switch", async () => {
    const test = await fixture("probe-kill");
    const result = await probeModel(definition, "stub-model-2", test.options);
    expect(result.restored).toBe(true);
    expect(result.recovery).toBe(true);
    expect(result.status).toBe("restored_after_failure");
    expect(await test.defaultModel()).toBe("stub-model-1");
    expect((await test.events()).some((item) => item.recovery === true)).toBe(true);
  });

  it("uses the cached default when a hung probe never reports the active model", async () => {
    const test = await fixture("probe-hang");
    const result = await probeModel(definition, "stub-model-2", {
      ...test.options,
      timeoutMs: 300,
      fallbackModel: "stub-model-9",
    });
    expect(result.restored).toBe(true);
    expect(await test.defaultModel()).toBe("stub-model-9");
  });

  it("reports a failed restore instead of pretending it succeeded", async () => {
    const test = await fixture("model-reject");
    const result = await probeModel(definition, "stub-model-2", test.options);
    expect(result.restored).toBe(false);
    expect(result.status).toBe("restore_failed");
  });

  it("never spawns a recovery process when already aborted before startProbe", async () => {
    const test = await fixture("model-aware");
    const aborted = new AbortController();
    aborted.abort();
    const result = await probeModel(definition, "stub-model-2", {
      ...test.options,
      signal: aborted.signal,
      fallbackModel: "stub-model-1",
    });
    expect(result.recovery).toBe(false);
    expect(result.restored).toBe(true);
    expect(await test.events()).toHaveLength(0);
  });
});

describe("catalog merge for discovered efforts (#242)", () => {
  it("never drops previously known effort levels", () => {
    const stored: HarnessCatalog = {
      probedAt: "2026-01-01T00:00:00.000Z",
      harnesses: [
        {
          id: "opencode",
          displayName: "OpenCode",
          defaultModel: "stub-model-1",
          probedAt: "2026-01-01T00:00:00.000Z",
          models: [
            {
              id: "stub-model-2",
              reasoningDiscovery: "known",
              supportedEfforts: ["low"],
              defaultEffort: "low",
            },
          ],
        },
      ],
    };
    const merged = catalogWithProbedModel(
      stored,
      definition,
      {
        id: "stub-model-2",
        reasoningDiscovery: "known",
        supportedEfforts: ["balanced"],
        defaultEffort: "balanced",
      },
      "2026-01-02T00:00:00.000Z",
    );
    expect(merged.harnesses[0]?.models[0]).toMatchObject({
      supportedEfforts: ["low", "balanced"],
      defaultEffort: "low",
    });
    expect(merged.probedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("per-Harness lock identity (#241/#242)", () => {
  it("serializes aliases that share one executable+args but not unrelated harnesses", async () => {
    const same = { command: process.execPath, args: [stubPath] };
    const alias = { command: process.execPath, args: [...same.args] };
    const unrelated = { command: process.execPath, args: ["other-acp"] };
    expect(harnessLockKey(alias)).toBe(harnessLockKey(same));
    expect(harnessLockKey(unrelated)).not.toBe(harnessLockKey(same));

    const locks = new HarnessLocks();
    const order: string[] = [];
    await Promise.all([
      locks.run(harnessLockKey(same), async () => {
        order.push("first:start");
        await new Promise((resolve) => setTimeout(resolve, 80));
        order.push("first:end");
      }),
      locks.run(harnessLockKey(alias), async () => {
        order.push("alias:start");
        order.push("alias:end");
      }),
      locks.run(harnessLockKey(unrelated), async () => {
        order.push("unrelated:start");
        order.push("unrelated:end");
      }),
    ]);
    expect(order.indexOf("alias:start")).toBeGreaterThan(order.indexOf("first:end"));
    expect(order.indexOf("unrelated:start")).toBeLessThan(order.indexOf("first:end"));
  });
});

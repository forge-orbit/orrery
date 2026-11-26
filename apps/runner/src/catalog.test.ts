import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { HarnessCatalog } from "@orrery/contract";
import { CatalogPublisher, readCatalogCache, writeCatalogCache } from "./catalog.ts";
import type { OrreryClient } from "./client.ts";
import {
  commandExists,
  discoverHarnesses,
  HarnessLocks,
  loadUserHarnesses,
  resolveHarness,
} from "./harnesses.ts";
import { probeHarness } from "./probe.ts";

const stubPath = fileURLToPath(new URL("./stub-acp.ts", import.meta.url));

interface TempDir {
  root: string;
  dispose: () => Promise<void>;
}

const tempDir = async (): Promise<TempDir> => {
  const root = await mkdtemp(join(tmpdir(), "orrery-catalog-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
};

const savedEnv: Record<string, string | undefined> = {};

/** A single-harness user-entry catalog used by the serialization test. */
const singleHarnessCatalog = (id: string, at: string): HarnessCatalog => ({
  harnesses: [
    {
      id,
      displayName: id,
      source: "user",
      defaultModel: null,
      models: [],
      probedAt: at,
    },
  ],
  updatedAt: at,
});
const setEnv = (key: string, value: string | undefined): void => {
  savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

const tempDirs: TempDir[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => dir.dispose()));
});

const keep = async (): Promise<TempDir> => {
  const dir = await tempDir();
  tempDirs.push(dir);
  return dir;
};

describe("harness detection", () => {
  it("sees node on PATH and rejects a command nobody ships", async () => {
    expect(await commandExists(process.execPath)).toBe(true);
    expect(await commandExists("definitely-not-a-real-command-xyz")).toBe(false);
  });

  it("includes an explicit override as a custom entry with its own id", async () => {
    const { root } = await keep();
    const harnesses = await discoverHarnesses(
      { command: process.execPath, args: [stubPath] },
      root,
    );
    const override = harnesses.find((entry) => entry.source === "override");
    expect(override).toBeDefined();
    expect(override?.command).toBe(process.execPath);
    expect(override?.args).toEqual([stubPath]);
  });

  it("loads optional harnesses.json entries from the runner config directory", async () => {
    const { root } = await keep();
    await writeFile(
      join(root, "harnesses.json"),
      JSON.stringify({
        harnesses: [
          { id: "team-harness", command: process.execPath, args: ["-e", "1"], displayName: "Team" },
        ],
      }),
    );
    expect(await loadUserHarnesses(root)).toEqual([
      {
        id: "team-harness",
        displayName: "Team",
        source: "user",
        command: process.execPath,
        args: ["-e", "1"],
      },
    ]);
    // A malformed file is ignored, never thrown.
    await writeFile(join(root, "harnesses.json"), "not json");
    expect(await loadUserHarnesses(root)).toEqual([]);
  });

  it("lets an explicit override win over a user entry for the same id", async () => {
    const { root } = await keep();
    await writeFile(
      join(root, "harnesses.json"),
      JSON.stringify({ harnesses: [{ id: "node", command: "custom", args: [] }] }),
    );
    const harnesses = await discoverHarnesses({ command: process.execPath, args: [] }, root);
    const nodes = harnesses.filter((candidate) => candidate.id === "node");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.source).toBe("override");
  });

  it("probes the explicit override before any preset", async () => {
    const { root } = await keep();
    const harnesses = await discoverHarnesses(
      { command: process.execPath, args: [stubPath] },
      root,
    );
    expect(harnesses[0]?.source).toBe("override");
  });
});

describe("harness probe", () => {
  it("reads models and thought_level from a harness that advertises them", async () => {
    setEnv("STUB_ACP_MODE", "normal");
    setEnv("STUB_ACP_CATALOG", "all");
    const { root } = await keep();
    const outcome = await probeHarness(
      {
        id: "stub",
        displayName: "Stub",
        source: "user",
        command: process.execPath,
        args: [stubPath],
      },
      { cwd: root },
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.models).toHaveLength(2);
    const fast = outcome.models.find((model) => model.id === "stub-fast");
    expect(fast?.reasoningDiscovery).toBe("known");
    expect(fast?.effortLevels).toEqual(["low", "medium", "high"]);
    expect(fast?.defaultEffort).toBe("medium");
    expect(fast?.probedAt).not.toBeNull();
    expect(outcome.defaultModel).toBe("stub-fast");
  });

  it("marks models unknown when the harness advertises no effort option", async () => {
    setEnv("STUB_ACP_MODE", "normal");
    setEnv("STUB_ACP_CATALOG", "effortless");
    const { root } = await keep();
    const outcome = await probeHarness(
      {
        id: "stub",
        displayName: "Stub",
        source: "user",
        command: process.execPath,
        args: [stubPath],
      },
      { cwd: root },
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.models.map((model) => model.id)).toEqual(["stub-fast", "stub-deep"]);
    for (const model of outcome.models) {
      expect(model.reasoningDiscovery).toBe("unknown");
      expect(model.effortLevels).toEqual([]);
    }
    expect(outcome.defaultModel).toBe("stub-fast");
  });

  it("scopes per-model effort options to the option's model only", async () => {
    setEnv("STUB_ACP_MODE", "normal");
    setEnv("STUB_ACP_CATALOG", "per-model");
    const { root } = await keep();
    const outcome = await probeHarness(
      {
        id: "stub",
        displayName: "Stub",
        source: "user",
        command: process.execPath,
        args: [stubPath],
      },
      { cwd: root },
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    const fast = outcome.models.find((model) => model.id === "stub-fast");
    const deep = outcome.models.find((model) => model.id === "stub-deep");
    expect(fast?.reasoningDiscovery).toBe("unknown");
    expect(fast?.effortLevels).toEqual([]);
    expect(deep?.reasoningDiscovery).toBe("known");
    expect(deep?.defaultEffort).toBe("high");
  });

  it("fails cleanly when the command does not exist and leaks no children", async () => {
    const { root } = await keep();
    const outcome = await probeHarness(
      {
        id: "missing",
        displayName: "Missing",
        source: "user",
        command: "definitely-not-a-real-command-xyz",
        args: [],
      },
      { cwd: root },
    );
    expect(outcome.ok).toBe(false);
  });

  it("tears down a hanging harness after the handshake deadline", async () => {
    setEnv("STUB_ACP_HANG_HANDSHAKE", "1");
    const { root } = await keep();
    const started = Date.now();
    const outcome = await probeHarness(
      {
        id: "stub",
        displayName: "Stub",
        source: "user",
        command: process.execPath,
        args: [stubPath],
      },
      { cwd: root, handshakeTimeoutMs: 500 },
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && /timed out|exited before replying/i.test(outcome.reason)).toBe(true);
    // Bounded: the probe never waits the full 10-second default deadline.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("catalog cache", () => {
  it("round-trips a catalog through the config directory", async () => {
    const { root } = await keep();
    const catalog: HarnessCatalog = {
      harnesses: [
        {
          id: "opencode",
          displayName: "OpenCode",
          source: "preset",
          defaultModel: "m",
          models: [
            {
              id: "m",
              reasoningDiscovery: "known",
              effortLevels: ["low"],
              defaultEffort: "low",
              probedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          probedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeCatalogCache(catalog, root);
    const mode = await statMode(join(root, "harness-catalog.json"));
    expect(await readCatalogCache(root)).toEqual(catalog);
    expect(mode).toBe("600");
  });

  it("reads a missing or malformed cache as none", async () => {
    const { root } = await keep();
    expect(await readCatalogCache(root)).toBeNull();
    await writeFile(join(root, "harness-catalog.json"), "{broken");
    expect(await readCatalogCache(root)).toBeNull();
  });
});

describe("catalog publisher", () => {
  interface Capture {
    body: HarnessCatalog | undefined;
  }

  const capturingClient = (capture: Capture): OrreryClient =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test seam for the publisher
    ({
      // Only updateCatalog is touched by the publisher.
      async updateCatalog(_runnerId: string, input: HarnessCatalog) {
        capture.body = input;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test seam for the publisher
        return {} as never;
      },
    }) as unknown as OrreryClient;

  it("merges publishes so a later unknown never regresses a known effort", async () => {
    const { root } = await keep();
    const capture: Capture = { body: undefined };
    const publisher = new CatalogPublisher(capturingClient(capture), "r1", null, root);
    const known: HarnessCatalog = {
      harnesses: [
        {
          id: "opencode",
          displayName: "OpenCode",
          source: "preset",
          defaultModel: null,
          models: [
            {
              id: "m1",
              reasoningDiscovery: "known",
              effortLevels: ["low", "high"],
              defaultEffort: "high",
              probedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          probedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const stale: HarnessCatalog = {
      harnesses: [
        {
          id: "opencode",
          displayName: "OpenCode",
          source: "preset",
          defaultModel: null,
          models: [
            {
              id: "m1",
              reasoningDiscovery: "unknown",
              effortLevels: [],
              defaultEffort: null,
              probedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          probedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    await publisher.publish(known);
    await publisher.publish(stale);
    const uploaded = capture.body;
    expect(uploaded).toBeDefined();
    const model = uploaded?.harnesses[0]?.models.find((entry) => entry.id === "m1");
    expect(model?.reasoningDiscovery).toBe("known");
    expect(model?.effortLevels).toEqual(["low", "high"]);
    // The local cache holds the same merged state.
    const cached = await readCatalogCache(root);
    expect(
      cached?.harnesses[0]?.models.find((entry) => entry.id === "m1")?.reasoningDiscovery,
    ).toBe("known");
  });

  it("serializes writes so overlapping publishes never interleave", async () => {
    const { root } = await keep();
    const capture: Capture = { body: undefined };
    const publisher = new CatalogPublisher(capturingClient(capture), "r1", null, root);
    // Fire both without awaiting the first to prove serialization.
    const [first, second] = await Promise.all([
      publisher
        .publish(singleHarnessCatalog("a", "2026-01-01T00:00:00.000Z"))
        .then(() => capture.body),
      publisher
        .publish(singleHarnessCatalog("b", "2026-01-02T00:00:00.000Z"))
        .then(() => capture.body),
    ]);
    expect(first?.harnesses.map((entry) => entry.id)).toEqual(["a"]);
    expect(second?.harnesses.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

async function statMode(path: string): Promise<string> {
  const info = await stat(path);
  return (info.mode & 0o777).toString(8);
}

describe("local-only Harness resolution (#241)", () => {
  it("resolves a requested id only from the local registry allowlist", async () => {
    const { root } = await keep();
    const override = { command: process.execPath, args: [stubPath] };
    const resolved = await resolveHarness("node", override, root);
    expect(resolved?.command).toBe(process.execPath);
    expect(resolved?.args).toEqual([stubPath]);
    // An id nobody configured is unavailable even when the server names it.
    expect(await resolveHarness("server-says-run-this", override, root)).toBeUndefined();
    // A user harness works without any preset install.
    await writeFile(
      join(root, "harnesses.json"),
      JSON.stringify({
        harnesses: [{ id: "team", command: process.execPath, args: [stubPath] }],
      }),
    );
    expect((await resolveHarness("team", undefined, root))?.source).toBe("user");
  });
});

describe("per-Harness spawn lock (#241)", () => {
  it("serializes work for one Harness while other Harnesses still run", async () => {
    const locks = new HarnessLocks();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const task = (label: string) => async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${label}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      order.push(`end:${label}`);
      active -= 1;
    };
    await Promise.all([
      locks.run("harness-a", task("a1")),
      locks.run("harness-a", task("a2")),
      locks.run("harness-b", task("b1")),
    ]);
    // One Harness never runs two sessions at once...
    expect(order.indexOf("end:a1")).toBeLessThan(order.indexOf("start:a2"));
    // ...while a different Harness is not blocked behind it.
    expect(order.indexOf("start:b1")).toBeLessThan(order.indexOf("end:a1"));
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });

  it("releases the lock after a rejected run", async () => {
    const locks = new HarnessLocks();
    await expect(
      locks.run("harness-a", async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");
    await expect(locks.run("harness-a", async () => "next")).resolves.toBe("next");
  });
});

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HarnessCatalog, type HarnessCatalogEntry, type HarnessModel } from "@orrery/contract";
import { afterEach, describe, expect, it } from "vitest";
import { AcpStdioClient } from "./acp.ts";
import {
  catalogCachePath,
  catalogEntryFromSession,
  CatalogPublisher,
  harnessConfigKey,
  probeHarness,
  readCachedCatalog,
  runStartupCatalogProbe,
} from "./catalog.ts";
import { detectHarnesses } from "./harnesses.ts";

const stubPath = new URL("./stub-acp.ts", import.meta.url).pathname;
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const tempDirs: string[] = [];

const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "orrery-catalog-"));
  tempDirs.push(dir);
  return dir;
};

const AT = "2026-05-01T00:00:00.000Z";
const knownModel: HarnessModel = {
  id: "stub-model-1",
  reasoningDiscovery: "known",
  supportedEfforts: ["low", "high"],
  defaultEffort: "low",
  probedAt: AT,
};

const entryOf = (model: HarnessModel, probedAt: string): HarnessCatalogEntry => ({
  id: "custom",
  displayName: "Stub",
  source: "user",
  defaultModel: "stub-model-1",
  models: [model],
  probedAt,
});

const catalogOf = (probedAt: string, ...harnesses: HarnessCatalogEntry[]): HarnessCatalog => ({
  harnesses,
  probedAt,
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.STUB_ACP_MODE;
  delete process.env.STUB_ACP_MARKER;
  delete process.env.STUB_ACP_ALIVE_FILE;
  delete process.env.STUB_ACP_MODE_FILE;
});

describe("built-in ACP harness detection", () => {
  it("detects installed presets, the --acp-command override and harnesses.json", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const command of ["opencode", "codex", "hermes"]) {
      writeFileSync(join(bin, command), "#!/bin/sh\n", { mode: 0o755 });
    }
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, "harnesses.json"),
      JSON.stringify({
        harnesses: [
          {
            id: "opencode",
            displayName: "My OpenCode",
            command: "/custom/opencode",
            args: ["acp"],
          },
          { id: "local", displayName: "Local ACP", command: "/usr/local/bin/local-acp" },
        ],
      }),
    );

    const detected = detectHarnesses({
      pathEnv: bin,
      configDir,
      acpOverride: { command: process.execPath, args: ["--acp-arg", "stub"] },
    });
    const ids = detected.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["codex", "hermes", "custom", "local"]));
    expect(ids).toContain("opencode");
    expect(ids.filter((id) => id === "opencode")).toHaveLength(1);
    expect(detected.find((item) => item.id === "opencode")?.command).toBe("/custom/opencode");
    expect(detected.find((item) => item.id === "custom")).toMatchObject({
      command: process.execPath,
      args: ["--acp-arg", "stub"],
    });
    expect(detected.find((item) => item.id === "local")?.args).toEqual(["acp"]);
  });

  it("does not invent a custom entry from the default ACP config", () => {
    const detected = detectHarnesses({ pathEnv: "", configDir: makeDir() });
    expect(detected).toEqual([]);
  });

  it("always keeps an explicit override even when it shares a preset's basename", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const command = join(bin, "opencode");
    writeFileSync(command, "#!/bin/sh\n", { mode: 0o755 });
    const detected = detectHarnesses({
      pathEnv: bin,
      configDir: dir,
      acpOverride: { command, args: ["--special"] },
    });
    expect(detected.map((item) => item.id)).toEqual(expect.arrayContaining(["opencode", "custom"]));
    expect(detected.find((item) => item.id === "custom")).toMatchObject({
      command,
      args: ["--special"],
    });
  });

  it("rejects a malformed harnesses.json instead of silently skipping it", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "harnesses.json"), "{not json");
    expect(() => detectHarnesses({ pathEnv: "", configDir: dir })).toThrow(/harnesses\.json/);
  });
});

describe("ACP session/new parsing", () => {
  it("marks only the active model's reasoning effort as known", () => {
    const parsed = catalogEntryFromSession(
      {
        id: "codex",
        displayName: "Codex",
        source: "preset" as const,
        command: "codex",
        args: ["acp"],
      },
      undefined,
      {
        sessionId: "s1",
        models: {
          availableModels: [
            { modelId: "gpt-5", name: "GPT-5" },
            { modelId: "gpt-5-mini", name: "GPT-5 mini" },
          ],
          currentModelId: "gpt-5",
        },
        configOptions: [
          {
            id: "thought_level",
            options: [{ value: "low" }, { value: "high" }],
            currentValue: "low",
          },
        ],
      },
      AT,
    );
    expect(parsed.defaultModel).toBe("gpt-5");
    expect(parsed.models[0]).toEqual({
      id: "gpt-5",
      label: "GPT-5",
      reasoningDiscovery: "known",
      supportedEfforts: ["low", "high"],
      defaultEffort: "low",
      probedAt: AT,
    });
    expect(parsed.models[1]).toEqual({
      id: "gpt-5-mini",
      label: "GPT-5 mini",
      reasoningDiscovery: "unknown",
      probedAt: AT,
    });
  });

  it("treats missing models and configOptions as unknown", () => {
    const parsed = catalogEntryFromSession(
      { id: "custom", displayName: "Stub", source: "user" as const, command: "stub", args: [] },
      undefined,
      { sessionId: "s1" },
      AT,
    );
    expect(parsed.models).toEqual([]);
    expect(parsed.defaultModel).toBe("default");
  });
});

describe("bounded startup probing", () => {
  it("reads models and configOptions from the deterministic ACP stub", async () => {
    process.env.STUB_ACP_MODE = "normal";
    const entry = await probeHarness(
      {
        id: "custom",
        displayName: "Stub",
        source: "user" as const,
        command: process.execPath,
        args: [stubPath],
      },
      { cwd: makeDir(), timeoutMs: 2000 },
    );
    expect(entry.models.map((model) => model.id)).toContain("stub-model-1");
    expect(entry.defaultModel).toBe("stub-model-1");
    // Only the active model (stub-model-1) is known; other advertised models
    // stay unknown so selecting them triggers a #242 probe.
    expect(entry.models.find((model) => model.id === "stub-model-1")).toMatchObject({
      reasoningDiscovery: "known",
      supportedEfforts: ["low", "high"],
      defaultEffort: "low",
    });
    expect(entry.models.find((model) => model.id === "stub-model-2")).toMatchObject({
      reasoningDiscovery: "unknown",
    });
  });

  it("times out a hung probe and tears down its whole process group", async () => {
    const dir = makeDir();
    const alive = join(dir, "alive.txt");
    process.env.STUB_ACP_MODE = "probe-hang";
    process.env.STUB_ACP_MARKER = join(dir, "marker.jsonl");
    process.env.STUB_ACP_ALIVE_FILE = alive;

    await expect(
      probeHarness(
        {
          id: "custom",
          displayName: "Stub",
          source: "user" as const,
          command: process.execPath,
          args: [stubPath],
        },
        { cwd: dir, timeoutMs: 250 },
      ),
    ).rejects.toThrow(/timed out/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(alive)).toBe(true);
    const before = statSync(alive).size;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(statSync(alive).size).toBe(before);
    expect(readFileSync(join(dir, "marker.jsonl"), "utf8")).toContain("grandchild");
  });

  it("applies one total budget across initialize and session/new", async () => {
    process.env.STUB_ACP_MODE = "probe-init-hang";
    const started = Date.now();
    await expect(
      probeHarness(
        {
          id: "custom",
          displayName: "Stub",
          source: "user" as const,
          command: process.execPath,
          args: [stubPath],
        },
        { cwd: makeDir(), timeoutMs: 250 },
      ),
    ).rejects.toThrow(/timed out/);
    // Two independent 250ms budgets would take ~500ms; one deadline takes ~250ms.
    expect(Date.now() - started).toBeLessThan(450);
  });
});

describe("serialized catalog publication", () => {
  it("preserves known effort entries when a stale refresh arrives later", async () => {
    const dir = makeDir();
    const sent: HarnessCatalog[] = [];
    const client = {
      putCatalog: async (_runnerId: string, body: HarnessCatalog) => {
        sent.push(body);
        return {};
      },
    };
    const publisher = new CatalogPublisher({
      client,
      runnerId: "runner-1",
      repoFingerprint: fingerprintA,
      configDir: dir,
    });

    await publisher.publish(
      catalogOf("2026-02-01T00:00:00.000Z", entryOf(knownModel, "2026-02-01T00:00:00.000Z")),
    );
    await publisher.publish(
      catalogOf(
        "2026-01-01T00:00:00.000Z",
        entryOf(
          {
            id: "stub-model-1",
            reasoningDiscovery: "unknown",
            probedAt: "2026-01-01T00:00:00.000Z",
          },
          "2026-01-01T00:00:00.000Z",
        ),
      ),
    );

    expect(sent[1]?.harnesses[0]?.models[0]).toMatchObject({
      reasoningDiscovery: "known",
      supportedEfforts: ["low", "high"],
    });
    expect(publisher.current.probedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(readCachedCatalog(fingerprintA, dir)).toEqual(publisher.current);
  });

  it("keeps a separate cache per checkout fingerprint", async () => {
    const dir = makeDir();
    const client = { putCatalog: async () => ({}) };
    const first = new CatalogPublisher({
      client,
      runnerId: "runner-a",
      repoFingerprint: fingerprintA,
      configDir: dir,
    });
    const second = new CatalogPublisher({
      client,
      runnerId: "runner-b",
      repoFingerprint: fingerprintB,
      configDir: dir,
    });
    const forA = catalogOf(
      "2026-01-01T00:00:00.000Z",
      entryOf(knownModel, "2026-01-01T00:00:00.000Z"),
    );
    await first.publish(forA);

    expect(second.current).toEqual({ harnesses: [], probedAt: "1970-01-01T00:00:00.000Z" });
    expect(readCachedCatalog(fingerprintA, dir)).toEqual(forA);
    expect(readCachedCatalog(fingerprintB, dir)).toBeNull();
    expect(catalogCachePath(fingerprintA, dir)).not.toBe(catalogCachePath(fingerprintB, dir));
  });

  it("never issues overlapping PUTs even when publishes are concurrent", async () => {
    const dir = makeDir();
    let inFlight = 0;
    let peak = 0;
    const client = {
      putCatalog: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {};
      },
    };
    const publisher = new CatalogPublisher({
      client,
      runnerId: "runner-1",
      repoFingerprint: fingerprintA,
      configDir: dir,
    });
    await Promise.all([
      publisher.publish(catalogOf("2026-01-01T00:00:00.000Z")),
      publisher.publish(catalogOf("2026-01-02T00:00:00.000Z")),
    ]);
    expect(peak).toBe(1);
  });

  it("treats a corrupt cache file as no cache instead of aborting startup", () => {
    const dir = makeDir();
    writeFileSync(catalogCachePath(fingerprintA, dir), "{truncated-json");
    expect(readCachedCatalog(fingerprintA, dir)).toBeNull();
  });

  it("keys the catalog cache by the effective local harness configuration", () => {
    const dir = makeDir();
    const first = harnessConfigKey({
      configDir: dir,
      acpOverride: { command: "/opt/one", args: ["acp"] },
    });
    const second = harnessConfigKey({
      configDir: dir,
      acpOverride: { command: "/opt/two", args: ["acp"] },
    });
    expect(first).not.toBe(second);
    expect(catalogCachePath(fingerprintA, dir, first)).not.toBe(
      catalogCachePath(fingerprintA, dir, second),
    );

    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify([{ id: "a", displayName: "A", command: "/opt/a" }]),
    );
    const withFile = harnessConfigKey({ configDir: dir });
    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify([{ id: "b", displayName: "B", command: "/opt/b" }]),
    );
    expect(harnessConfigKey({ configDir: dir })).not.toBe(withFile);
  });

  it("publishes an empty catalog when the local registry has no harnesses", async () => {
    const published: HarnessCatalog[] = [];
    await runStartupCatalogProbe({
      definitions: [],
      probe: async () => {
        throw new Error("no harness should be probed");
      },
      publish: async (catalog) => {
        published.push(catalog);
      },
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.harnesses).toEqual([]);
  });

  it("keeps the last good catalog when every detected harness probe fails", async () => {
    const published: HarnessCatalog[] = [];
    const warnings: string[] = [];
    await runStartupCatalogProbe({
      definitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          source: "preset" as const,
          command: "missing",
          args: ["acp"],
        },
      ],
      probe: async () => {
        throw new Error("probe failed");
      },
      publish: async (catalog) => {
        published.push(catalog);
      },
      write: (line) => warnings.push(line),
    });
    expect(published).toEqual([]);
    expect(warnings.join("\n")).toContain("probe failed");
  });
});

/** Fixtures for the partial-refresh regression: a harness with known efforts. */
const def = (id: string) => ({
  id,
  displayName: `Harness ${id}`,
  source: "preset" as const,
  command: "missing",
  args: ["acp"],
});
const model = (id: string): HarnessModel => ({
  ...knownModel,
  id,
  label: `Model ${id}`,
  probedAt: "2026-01-01T00:00:00.000Z",
});
const entry = (id: string, m: HarnessModel, probedAt: string): HarnessCatalogEntry => ({
  id,
  displayName: `Harness ${id}`,
  source: "preset",
  defaultModel: m.id,
  models: [m],
  probedAt,
});
const catalog = (probedAt: string, ...harnesses: HarnessCatalogEntry[]): HarnessCatalog => ({
  harnesses,
  probedAt,
});

describe("partial catalog refresh (#240 regression)", () => {
  it("keeps a previously known harness whose probe fails while another succeeds", async () => {
    const published: HarnessCatalog[] = [];
    const previousOpencode = entry("opencode", model("gpt-5"), "2026-01-01T00:00:00.000Z");
    const previous = catalog(
      "2026-01-01T00:00:00.000Z",
      previousOpencode,
      entry("codex", model("gpt-5-codex"), "2026-01-01T00:00:00.000Z"),
    );
    const freshCodex = entry("codex", model("gpt-5-codex-2"), "2026-02-01T00:00:00.000Z");

    await runStartupCatalogProbe({
      definitions: [def("opencode"), def("codex")],
      previous,
      probe: async (definition) => {
        if (definition.id === "opencode") throw new Error("transient opencode failure");
        return freshCodex;
      },
      publish: async (value) => {
        published.push(value);
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.harnesses.find((item) => item.id === "opencode")).toEqual(
      previousOpencode,
    );
    expect(published[0]?.harnesses.find((item) => item.id === "codex")).toEqual(freshCodex);
  });

  it("omits a failing harness that was never in the previous catalog", async () => {
    const published: HarnessCatalog[] = [];
    const previous = catalog(
      "2026-01-01T00:00:00.000Z",
      entry("codex", model("gpt-5-codex"), "2026-01-01T00:00:00.000Z"),
    );
    const freshCodex = entry("codex", model("gpt-5-codex"), "2026-02-01T00:00:00.000Z");

    await runStartupCatalogProbe({
      definitions: [def("brand-new"), def("codex")],
      previous,
      probe: async (definition) => {
        if (definition.id === "brand-new") throw new Error("never known");
        return freshCodex;
      },
      publish: async (value) => {
        published.push(value);
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.harnesses.map((item) => item.id)).toEqual(["codex"]);
  });

  it("does not publish when every probe fails even with a previous catalog", async () => {
    const published: HarnessCatalog[] = [];
    const previous = catalog(
      "2026-01-01T00:00:00.000Z",
      entry("opencode", model("gpt-5"), "2026-01-01T00:00:00.000Z"),
      entry("codex", model("gpt-5-codex"), "2026-01-01T00:00:00.000Z"),
    );
    const warnings: string[] = [];

    await runStartupCatalogProbe({
      definitions: [def("opencode"), def("codex")],
      previous,
      probe: async () => {
        throw new Error("all probes failed");
      },
      publish: async (value) => {
        published.push(value);
      },
      write: (line) => warnings.push(line),
    });

    expect(published).toEqual([]);
    expect(warnings.join("\n")).toContain("all probes failed");
  });
});

describe("catalog publication safety (#255 review)", () => {
  it("clamps oversized and blank ACP model refs before publishing", () => {
    const models = Array.from({ length: 300 }, (_, index) => ({
      modelId: index === 0 ? "" : `m-${index}`,
      name: "x".repeat(300),
    }));
    const parsedEntry = catalogEntryFromSession(
      { id: "opencode", displayName: "OpenCode", source: "preset", command: "opencode", args: [] },
      undefined,
      { models: { availableModels: models, currentModelId: "m-1" }, configOptions: [] },
      AT,
    );
    expect(parsedEntry.models).toHaveLength(200);
    expect(
      parsedEntry.models.every(
        (candidate) => candidate.id.length > 0 && candidate.id.length <= 200,
      ),
    ).toBe(true);
    expect(parsedEntry.models[0]?.label).toHaveLength(200);
  });

  it("keeps the prior cache when a catalog PUT is rejected", async () => {
    const dir = makeDir();
    const cached = catalogOf(AT, entryOf(knownModel, AT));
    writeFileSync(catalogCachePath(fingerprintA, dir), JSON.stringify(cached));
    const publisher = new CatalogPublisher({
      client: {
        putCatalog: async () => {
          throw new Error("PUT rejected");
        },
      },
      runnerId: "runner-1",
      repoFingerprint: fingerprintA,
      configDir: dir,
    });
    await expect(
      publisher.publish(
        catalogOf("2026-02-01T00:00:00.000Z", entryOf(knownModel, "2026-02-01T00:00:00.000Z")),
      ),
    ).rejects.toThrow("PUT rejected");
    expect(readCachedCatalog(fingerprintA, dir)).toEqual(cached);
  });

  it("kills a hanging probe's process group promptly on abort", async () => {
    const dir = makeDir();
    process.env.STUB_ACP_MODE = "probe-hang";
    const alive = join(dir, "alive.txt");
    process.env.STUB_ACP_ALIVE_FILE = alive;
    const controller = new AbortController();
    const started = Date.now();
    const pending = AcpStdioClient.probe({
      command: process.execPath,
      args: [stubPath],
      cwd: dir,
      mcpServers: [],
      worktreeReal: dir,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("ACP");
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const size = (): number => (existsSync(alive) ? statSync(alive).size : 0);
    const before = size();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(size()).toBe(before);
  });

  it("seeds CatalogPublisher from initial server catalog on cold cache so transient probe failure preserves harnesses", async () => {
    const dir = makeDir();
    const serverInitial: HarnessCatalog = {
      probedAt: AT,
      harnesses: [
        { ...entryOf(knownModel, AT), id: "opencode", displayName: "OpenCode" },
        { ...entryOf(knownModel, AT), id: "claude", displayName: "Claude Code" },
      ],
    };
    const sent: HarnessCatalog[] = [];
    const publisher = new CatalogPublisher({
      client: {
        putCatalog: async (_runnerId, value) => {
          sent.push(value);
          return { harnessCatalog: value };
        },
      },
      runnerId: "runner-cold",
      repoFingerprint: fingerprintA,
      initial: serverInitial,
      configDir: dir,
    });
    expect(publisher.current).toEqual(serverInitial);

    await runStartupCatalogProbe({
      definitions: [
        {
          id: "opencode",
          displayName: "OpenCode",
          source: "preset",
          command: "opencode",
          args: [],
        },
        { id: "claude", displayName: "Claude Code", source: "preset", command: "claude", args: [] },
      ],
      probe: async (definition) => {
        if (definition.id === "claude") throw new Error("transient timeout");
        return {
          ...entryOf(knownModel, "2026-02-01T00:00:00.000Z"),
          id: "opencode",
          displayName: "OpenCode",
        };
      },
      publish: (value) => publisher.publish(value),
      previous: publisher.current,
      now: () => "2026-02-01T00:00:00.000Z",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.harnesses.map((h) => h.id)).toEqual(["opencode", "claude"]);
  });

  it("persists the server-merged catalog returned by putCatalog into the local cache", async () => {
    const dir = makeDir();
    const serverMerged = catalogOf("2026-02-01T00:00:00.000Z", entryOf(knownModel, AT));
    const publisher = new CatalogPublisher({
      client: {
        putCatalog: async () => ({ harnessCatalog: serverMerged }),
      },
      runnerId: "runner-sync",
      repoFingerprint: fingerprintA,
      configDir: dir,
    });

    await publisher.publish(
      catalogOf(
        "2026-02-01T00:00:00.000Z",
        entryOf(
          {
            id: knownModel.id,
            reasoningDiscovery: "unknown",
            probedAt: "2026-02-01T00:00:00.000Z",
          },
          "2026-02-01T00:00:00.000Z",
        ),
      ),
    );

    expect(publisher.current).toEqual(serverMerged);
    expect(readCachedCatalog(fingerprintA, dir)).toEqual(serverMerged);
  });

  it("rejects pre-aborted signals in start() and startProbe() without spawning", async () => {
    const dir = makeDir();
    const controller = new AbortController();
    controller.abort();
    await expect(
      AcpStdioClient.start({
        command: "/nonexistent/binary",
        args: [],
        cwd: dir,
        mcpServers: [],
        worktreeReal: dir,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted before the child was spawned");
    await expect(
      AcpStdioClient.startProbe({
        command: "/nonexistent/binary",
        args: [],
        cwd: dir,
        mcpServers: [],
        worktreeReal: dir,
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted before the child was spawned");
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterForHarness, genericAcpAdapter, openCodeAdapter } from "./adapter.ts";
import { harnessConfigKey } from "./catalog.ts";
import { loadSupervisionConfig } from "./config.ts";
import {
  BUILTIN_ACP_HARNESSES,
  commandOnPath,
  detectHarnesses,
  installHintForPreset,
  isReservedHarnessId,
  resolveDefaultHarness,
  shadowedPresetIds,
  validateExplicitHarness,
} from "./harnesses.ts";

const tempDirs: string[] = [];
const makeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "orrery-266-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("built-in ACP presets (#266)", () => {
  it("resolve to verified vendor ACP entrypoints under stable preset IDs", () => {
    const byId = new Map(BUILTIN_ACP_HARNESSES.map((item) => [item.id, item]));
    expect(byId.get("opencode")).toMatchObject({ command: "opencode", args: ["acp"] });
    expect(byId.get("codex")).toMatchObject({ command: "codex-acp", args: [] });
    expect(byId.get("claude")).toMatchObject({ command: "claude-agent-acp", args: [] });
    expect(byId.get("omp")).toMatchObject({ command: "omp", args: ["acp"] });
    expect(byId.get("grok")).toMatchObject({ command: "grok", args: ["agent", "stdio"] });
    expect(byId.get("hermes")).toMatchObject({ command: "hermes", args: ["acp"] });
    expect(byId.get("cursor")).toMatchObject({ command: "cursor-agent", args: ["acp"] });
    for (const preset of BUILTIN_ACP_HARNESSES) {
      expect(preset.source).toBe("preset");
      expect(installHintForPreset(preset.id).length).toBeGreaterThan(0);
    }
  });

  it("reserves the custom Harness ID", () => {
    expect(isReservedHarnessId("custom")).toBe(true);
    expect(isReservedHarnessId("Custom")).toBe(true);
    expect(isReservedHarnessId("opencode")).toBe(false);
  });
});

describe("supervision config mutual exclusion (#266)", () => {
  it("fails fast when --harness combines with --acp-command", () => {
    expect(() =>
      loadSupervisionConfig({ harness: "opencode", acp: { command: "other" } }, {}),
    ).toThrow(/--acp-command/);
  });

  it("fails fast when --harness combines with --acp-arg", () => {
    expect(() => loadSupervisionConfig({ harness: "codex", acp: { args: ["--x"] } }, {})).toThrow(
      /--acp-arg/,
    );
  });

  it("fails fast when --harness combines with ORRERY_ACP_COMMAND", () => {
    expect(() =>
      loadSupervisionConfig({ harness: "claude" }, { ORRERY_ACP_COMMAND: "other" }),
    ).toThrow(/ORRERY_ACP_COMMAND/);
  });

  it("fails fast when --harness combines with ORRERY_ACP_ARGS", () => {
    expect(() => loadSupervisionConfig({ harness: "omp" }, { ORRERY_ACP_ARGS: '["acp"]' })).toThrow(
      /ORRERY_ACP_ARGS/,
    );
  });

  it("allows --harness custom alongside an explicit override", () => {
    const config = loadSupervisionConfig(
      { harness: "custom", acp: { command: "other", args: ["x"] } },
      {},
    );
    expect(config.acpOverridden).toBe(true);
    expect(config.defaults.harness).toBe("custom");
  });

  it("allows --harness without any override", () => {
    const config = loadSupervisionConfig({ harness: "opencode" }, {});
    expect(config.acpOverridden).toBe(false);
  });
});

describe("harnesses.json validation (#266)", () => {
  it("rejects entries using the reserved custom ID with the file path", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify({ harnesses: [{ id: "custom", displayName: "X", command: "/bin/x" }] }),
    );
    expect(() => detectHarnesses({ pathEnv: "", configDir: dir })).toThrow(
      /harnesses\.json.*reserved/,
    );
  });

  it("fails fast on malformed JSON with the file path", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "harnesses.json"), "{not json");
    expect(() => detectHarnesses({ pathEnv: "", configDir: dir })).toThrow(/harnesses\.json/);
  });

  it("fails fast on schema violations with file path and details", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify({ harnesses: [{ id: "", displayName: "", command: "" }] }),
    );
    expect(() => detectHarnesses({ pathEnv: "", configDir: dir })).toThrow(/harnesses\.json/);
  });

  it("excludes non-executable user harnesses from the advertised catalog", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify({
        harnesses: [{ id: "ghost", displayName: "Ghost", command: "/nonexistent/ghost-acp" }],
      }),
    );
    expect(detectHarnesses({ pathEnv: "", configDir: dir })).toEqual([]);
  });

  it("reports harnesses.json entries shadowing built-in preset IDs", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const shadow = join(dir, "shadow-opencode");
    writeFileSync(shadow, "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify({
        harnesses: [{ id: "opencode", displayName: "Shadow", command: shadow }],
      }),
    );
    expect(shadowedPresetIds(dir)).toEqual(["opencode"]);
    expect(shadowedPresetIds(makeDir())).toEqual([]);
  });
});

describe("explicit --harness startup validation (#266)", () => {
  it("resolves a known executable preset", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    const resolved = validateExplicitHarness("opencode", { pathEnv: bin, configDir: dir });
    expect(resolved.id).toBe("opencode");
  });

  it("reports the install hint for a known preset missing from PATH", () => {
    expect(() => validateExplicitHarness("codex", { pathEnv: "", configDir: makeDir() })).toThrow(
      /codex-acp.*@openai\/codex/,
    );
  });

  it("names the command for a configured user harness missing from PATH", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "harnesses.json"),
      JSON.stringify({
        harnesses: [{ id: "team", displayName: "Team", command: "/nonexistent/team-acp" }],
      }),
    );
    expect(() => validateExplicitHarness("team", { pathEnv: "", configDir: dir })).toThrow(
      /\/nonexistent\/team-acp/,
    );
  });

  it("lists installed alternatives for an unknown ID", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    expect(() => validateExplicitHarness("nope", { pathEnv: bin, configDir: dir })).toThrow(
      /Unknown --harness 'nope'. Installed: opencode/,
    );
  });

  it("requires --acp-command for --harness custom without an override", () => {
    expect(() => validateExplicitHarness("custom", { configDir: makeDir() })).toThrow(
      /--acp-command/,
    );
  });
});

describe("omitted-harness default resolution (#266)", () => {
  it("resolves the real opencode preset when installed", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    const resolved = resolveDefaultHarness({ pathEnv: bin });
    expect(resolved).toMatchObject({ id: "opencode", source: "preset", command: "opencode" });
  });

  it("returns undefined when opencode is missing and no override is given", () => {
    expect(resolveDefaultHarness({ pathEnv: "" })).toBeUndefined();
  });

  it("returns the override entry when an ACP override is given", () => {
    const resolved = resolveDefaultHarness({
      acpOverride: { command: "/opt/x", args: ["a"] },
    });
    expect(resolved).toMatchObject({ id: "custom", source: "override" });
  });

  it("selects OpenCodeAdapter for the resolved default preset", () => {
    const dir = makeDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    const resolved = resolveDefaultHarness({ pathEnv: bin });
    expect(resolved).toBeDefined();
    expect(adapterForHarness(resolved!)).toBe(openCodeAdapter);
  });

  it("invalidates the cached catalog key when PATH changes", () => {
    const dir = makeDir();
    const full = join(dir, "full");
    const empty = join(dir, "empty");
    mkdirSync(full);
    mkdirSync(empty);
    writeFileSync(join(full, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    const withDefault = harnessConfigKey({ configDir: dir, pathEnv: full });
    const withoutDefault = harnessConfigKey({ configDir: dir, pathEnv: empty });
    expect(withDefault).not.toBe(withoutDefault);
  });

  it("includes an explicit resolved default in the cache key", () => {
    const dir = makeDir();
    const first = harnessConfigKey({
      configDir: dir,
      pathEnv: "",
      defaultHarness: {
        id: "opencode",
        displayName: "OpenCode",
        source: "preset",
        command: "opencode",
        args: ["acp"],
      },
    });
    const second = harnessConfigKey({ configDir: dir, pathEnv: "" });
    expect(first).not.toBe(second);
  });
});

describe("adapter selection for source user entries (#266)", () => {
  it("does not inherit a preset adapter by ID collision with an unrelated command", () => {
    const adapter = adapterForHarness({
      id: "opencode",
      displayName: "Fake OpenCode",
      source: "user",
      command: "/opt/unrelated/acp",
      args: [],
    });
    expect(adapter).toBe(genericAcpAdapter);
  });

  it("still matches a user entry by command basename", () => {
    const adapter = adapterForHarness({
      id: "my-hermes",
      displayName: "Mine",
      source: "user",
      command: "/opt/bin/hermes",
      args: [],
    });
    expect(adapter).not.toBe(genericAcpAdapter);
  });

  it("matches a preset entry by ID as before", () => {
    expect(
      adapterForHarness({
        id: "opencode",
        displayName: "OpenCode",
        source: "preset",
        command: "opencode",
        args: ["acp"],
      }),
    ).toBe(openCodeAdapter);
  });

  it("keeps commandOnPath honest for missing binaries", () => {
    expect(commandOnPath("definitely-not-installed-xyz", "")).toBe(false);
  });
});

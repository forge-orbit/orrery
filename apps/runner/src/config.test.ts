import { describe, expect, it } from "vitest";
import { ephemeralMcpConfig, loadSupervisionConfig } from "./config.ts";

describe("supervision config", () => {
  it("defaults to one slot's worth of timing and the opencode ACP harness", () => {
    const config = loadSupervisionConfig({}, {});
    expect(config.acp).toEqual({ command: "opencode", args: ["acp"] });
    expect(config.leaseRenewMs).toBe(60_000);
    expect(config.cancelGraceMs).toBe(2_000);
    expect(config.defaults).toEqual({ harness: undefined, model: undefined, effort: undefined });
  });

  it("keeps per-dispatch CLI defaults from --harness, --model and --effort", () => {
    expect(
      loadSupervisionConfig({ harness: "codex", model: "gpt-5", effort: "high" }, {}).defaults,
    ).toEqual({ harness: "codex", model: "gpt-5", effort: "high" });
  });

  it("rejects zero, negative and non-integer timing overrides", () => {
    for (const leaseRenewMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => loadSupervisionConfig({ leaseRenewMs }, {})).toThrow(/positive integer/);
    }
    for (const cancelGraceMs of [0, -5, 2.2]) {
      expect(() => loadSupervisionConfig({ cancelGraceMs }, {})).toThrow(/positive integer/);
    }
    expect(() => loadSupervisionConfig({}, { ORRERY_LEASE_RENEW_MS: "0" })).toThrow(
      /positive integer/,
    );
  });

  it("does not clobber one ACP flag with the other field's default", () => {
    expect(loadSupervisionConfig({ acp: { args: ["--model", "x"] } }, {}).acp).toEqual({
      command: "opencode",
      args: ["--model", "x"],
    });
    expect(loadSupervisionConfig({ acp: { command: "codex" } }, {}).acp).toEqual({
      command: "codex",
      args: ["acp"],
    });
    expect(
      loadSupervisionConfig(
        { acp: { command: "codex", args: ["acp"] } },
        { ORRERY_ACP_COMMAND: "ignored" },
      ).acp,
    ).toEqual({ command: "codex", args: ["acp"] });
  });

  it("explains a malformed ORRERY_ACP_ARGS value", () => {
    expect(() => loadSupervisionConfig({}, { ORRERY_ACP_ARGS: "not-json" })).toThrow(
      /JSON array of strings/,
    );
    expect(() => loadSupervisionConfig({}, { ORRERY_ACP_ARGS: '["ok", 7]' })).toThrow(
      /JSON array of strings/,
    );
    expect(loadSupervisionConfig({}, { ORRERY_ACP_ARGS: '["acp","--verbose"]' }).acp.args).toEqual([
      "acp",
      "--verbose",
    ]);
  });

  it("wires the ACP HTTP MCP server shape with the dispatch token", () => {
    const mcp = ephemeralMcpConfig({
      server: "http://orrery.test/",
      dispatchToken: "orr_dt_secret",
      issueId: "ORR-1",
      runId: "run-1",
      workSessionId: "session-1",
      dispatchAttemptId: "attempt-1",
    });
    expect(mcp).toMatchObject({
      name: "orrery",
      type: "http",
      url: "http://orrery.test/mcp",
      headers: [{ name: "authorization", value: "Bearer orr_dt_secret" }],
    });
    expect(mcp.env).toEqual(
      expect.arrayContaining([
        { name: "ORRERY_DISPATCH_TOKEN", value: "orr_dt_secret" },
        { name: "ORRERY_WORK_SESSION_ID", value: "session-1" },
      ]),
    );
  });
});

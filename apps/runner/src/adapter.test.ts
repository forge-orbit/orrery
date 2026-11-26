import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpStdioClient, acpErrorDetail } from "./acp.ts";
import {
  adapterForHarness,
  GenericAcpAdapter,
  genericAcpAdapter,
  hermesAdapter,
  HermesAdapter,
  type AcpSession,
  type HarnessAdapter,
  ompAdapter,
  OpenCodeAdapter,
  openCodeAdapter,
  type ProbeSwitchResult,
} from "./adapter.ts";
import { catalogEntryFromSession, type ProbeClient, probeHarness, probeModel } from "./catalog.ts";
import type { HarnessDefinition } from "./harnesses.ts";

const AT = "2026-05-01T00:00:00.000Z";
const definition: HarnessDefinition = {
  id: "custom",
  displayName: "Custom",
  source: "override",
  command: "/usr/local/bin/custom-acp",
  args: ["acp"],
};

const of = (id: string, command = id): HarnessDefinition => ({
  id,
  displayName: id,
  source: "preset",
  command,
  args: [],
});

const effortOptions = (id: string, values: string[]) => ({
  configOptions: [
    {
      id,
      options: values.map((value) => ({ value })),
      currentValue: values[0],
    },
  ],
});

interface Call {
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number | undefined;
}

/** A pure ACP seam: no child process, just recorded RPCs and scripted replies. */
function sessionStub(
  sessionResult: unknown,
  reply: (method: string, params: Record<string, unknown>) => unknown,
): { session: AcpSession; calls: Call[] } {
  const calls: Call[] = [];
  const session: AcpSession = {
    id: "session-1",
    sessionResult,
    requestAcp: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      const value = reply(method, params);
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { session, calls };
}

function stubAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    probeTimeoutMs: 1234,
    modelSwitchMutatesCliDefault: false,
    probeCatalog: () => ({
      models: [
        {
          id: "injected-model",
          label: "Injected",
          reasoningDiscovery: "known",
          supportedEfforts: ["fast"],
          defaultEffort: "fast",
          probedAt: AT,
        },
      ],
      defaultModel: "injected-model",
      probedAt: AT,
    }),
    probeModel: async () => ({
      result: effortOptions("reasoning_effort", ["fast"]),
      switched: true,
    }),
    applyDispatchOptions: async () => ({ modelSwitched: false, effortApplied: false }),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adapterForHarness: pure registry", () => {
  it("resolves named presets to focused adapters and overrides to the safe default", () => {
    expect(adapterForHarness(of("opencode"))).toBe(openCodeAdapter);
    expect(adapterForHarness(of("hermes"))).toBe(hermesAdapter);
    expect(adapterForHarness(of("omp"))).toBe(ompAdapter);
    expect(adapterForHarness(definition)).toBe(genericAcpAdapter);
    expect(adapterForHarness(of("user-1", "/opt/acp/hermes-like"))).toBe(genericAcpAdapter);
    // The command basename is enough when a user renames the harness id.
    expect(adapterForHarness(of("user-2", "C:\\bin\\hermes.exe"))).toBe(hermesAdapter);
  });

  it("never lets an override or the custom id opt into session-scoped behavior", () => {
    expect(
      adapterForHarness({
        id: "hermes",
        source: "override",
        displayName: "Custom Hermes",
        command: "/opt/bin/hermes",
        args: [],
      }),
    ).toBe(genericAcpAdapter);
    expect(
      adapterForHarness({
        id: "custom",
        source: "override",
        displayName: "Custom",
        command: "/usr/local/bin/omp",
        args: [],
      }),
    ).toBe(genericAcpAdapter);
  });

  it("declares which switches may mutate the CLI default", () => {
    expect(genericAcpAdapter.modelSwitchMutatesCliDefault).toBe(true);
    expect(openCodeAdapter.modelSwitchMutatesCliDefault).toBe(true);
    expect(hermesAdapter.modelSwitchMutatesCliDefault).toBe(false);
    expect(ompAdapter.modelSwitchMutatesCliDefault).toBe(false);
    expect(genericAcpAdapter.probeTimeoutMs).toBe(5000);
    expect(hermesAdapter.probeTimeoutMs).toBe(8000);
    expect(new GenericAcpAdapter({ probeTimeoutMs: 750 }).probeTimeoutMs).toBe(750);
  });
});

describe("GenericAcpAdapter: conservative ACP v1 dialect", () => {
  it("parses catalog discovery from initialize and session/new payloads", () => {
    const discovery = genericAcpAdapter.probeCatalog(
      { models: [{ modelId: "m1", name: "Model 1" }] },
      {
        models: { currentModelId: "m1" },
        configOptions: [
          { id: "reasoning_effort", options: [{ value: "high" }], currentValue: "high" },
        ],
      },
      AT,
    );
    expect(discovery.defaultModel).toBe("m1");
    expect(discovery.models[0]).toMatchObject({
      id: "m1",
      reasoningDiscovery: "known",
      supportedEfforts: ["high"],
      defaultEffort: "high",
    });
  });

  it("switches with set_model, then reads fresh config options when the model option is advertised", async () => {
    const refreshed = effortOptions("reasoning_effort", ["high", "low"]);
    const { session, calls } = sessionStub(
      {
        models: { currentModelId: "old" },
        configOptions: [{ id: "model", options: [{ value: "old" }, { value: "new" }] }],
      },
      (method, params) => {
        if (method === "session/set_config_option" && params.configId === "model") return refreshed;
        return {};
      },
    );
    const result = await genericAcpAdapter.probeModel(session, "new", Date.now() + 1000);
    expect(calls[0]?.method).toBe("session/set_model");
    expect(calls[0]?.params).toMatchObject({ modelId: "new" });
    expect(calls[1]).toMatchObject({
      method: "session/set_config_option",
      params: { configId: "model", value: "new" },
    });
    expect(result.result).toEqual(refreshed);
    expect(result.switched).toBe(true);
    expect(calls.every((call) => typeof call.timeoutMs === "number" && call.timeoutMs > 0)).toBe(
      true,
    );
  });

  it("applies model then effort at dispatch time and skips a redundant setModel", async () => {
    const { session, calls } = sessionStub(
      { models: { currentModelId: "old" } },
      (method, params) => {
        if (method === "session/set_config_option" && params.configId === "model") {
          return effortOptions("thought_level", ["high"]);
        }
        return {};
      },
    );
    const result = await genericAcpAdapter.applyDispatchOptions(session, {
      model: "new",
      effort: "high",
    });
    expect(
      calls.map((call) =>
        [call.method, typeof call.params.configId === "string" ? call.params.configId : ""].join(
          ":",
        ),
      ),
    ).toEqual(["session/set_config_option:model", "session/set_config_option:thought_level"]);
    expect(result).toMatchObject({ modelSwitched: true, effortApplied: true });
    expect(calls.every((call) => call.timeoutMs === undefined)).toBe(true);

    const alreadyActive = sessionStub(
      {
        models: { currentModelId: "new" },
        configOptions: [{ id: "thought_level", options: [{ value: "high" }] }],
      },
      () => ({}),
    );
    const noSwitch = await genericAcpAdapter.applyDispatchOptions(alreadyActive.session, {
      model: "new",
      effort: "high",
    });
    expect(noSwitch.modelSwitched).toBe(false);
    expect(alreadyActive.calls).toHaveLength(1);
    expect(alreadyActive.calls[0]?.params).toMatchObject({
      configId: "thought_level",
      value: "high",
    });
  });

  it("falls back to session/set_model when the model config option is unsupported", async () => {
    const { session, calls } = sessionStub(
      { models: { currentModelId: "old" } },
      (method, params) => {
        if (method === "session/set_config_option" && params.configId === "model") {
          return new Error("unsupported config option model");
        }
        return {};
      },
    );
    const result = await genericAcpAdapter.applyDispatchOptions(session, { model: "new" });
    expect(calls.map((call) => call.method)).toEqual([
      "session/set_config_option",
      "session/set_model",
    ]);
    expect(result.modelSwitched).toBe(true);
  });
});

describe("HermesAdapter: one config-option RPC per switch, session-scoped", () => {
  it("reads fresh configOptions directly from its single probe switch", async () => {
    const refreshed = effortOptions("reasoning_effort", ["balanced", "fast"]);
    const { session, calls } = sessionStub({ models: { currentModelId: "old" } }, () => refreshed);
    const result = await hermesAdapter.probeModel(session, "new", Date.now() + 1000);
    expect(calls.map((call) => call.method)).toEqual(["session/set_config_option"]);
    expect(result.result).toEqual(refreshed);
    expect(hermesAdapter.probeTimeoutMs).toBe(8000);
    expect(hermesAdapter.modelSwitchMutatesCliDefault).toBe(false);
  });

  it("applies effort with the ids returned by its single dispatch switch", async () => {
    const { session, calls } = sessionStub(
      { models: { currentModelId: "old" } },
      (method, params) => {
        if (method === "session/set_config_option" && params.configId === "model") {
          return effortOptions("reasoning_effort", ["high"]);
        }
        return {};
      },
    );
    const result = await new HermesAdapter().applyDispatchOptions(session, {
      model: "new",
      effort: "high",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "session/set_config_option",
      "session/set_config_option",
    ]);
    expect(calls[0]?.params).toMatchObject({ configId: "model", value: "new" });
    expect(calls[1]?.params).toMatchObject({ configId: "reasoning_effort", value: "high" });
    expect(result).toMatchObject({ modelSwitched: true, effortApplied: true });
  });
});

describe("OpenCodeAdapter: native set_model dispatch", () => {
  it("uses session/set_model first and never switches an already-active model", async () => {
    const { session, calls } = sessionStub({ models: { currentModelId: "old" } }, () => ({}));
    const result = await new OpenCodeAdapter().applyDispatchOptions(session, { model: "new" });
    expect(calls[0]?.method).toBe("session/set_model");
    expect(result.modelSwitched).toBe(true);

    const active = sessionStub({ models: { currentModelId: "new" } }, () => ({}));
    await openCodeAdapter.applyDispatchOptions(active.session, { model: "new" });
    expect(active.calls).toHaveLength(0);
  });
});

describe("injected HarnessAdapter strategies", () => {
  it("drives catalog entry building from an injected discovery strategy", () => {
    const injected = stubAdapter();
    const entry = catalogEntryFromSession(definition, {}, {}, AT, injected);
    expect(entry.models.map((model) => model.id)).toEqual(["injected-model"]);
    expect(entry.defaultModel).toBe("injected-model");
  });

  it("uses the injected adapter's timeout budget and discovery result in probeHarness", async () => {
    const probe = vi
      .spyOn(AcpStdioClient, "probe")
      .mockResolvedValue({ session: {}, initResult: {} });
    const entry = await probeHarness(definition, { cwd: "/tmp", at: AT }, stubAdapter());
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1234 }));
    expect(entry.models[0]?.id).toEqual("injected-model");
  });

  it("skips CLI restore when an injected adapter declares session-scoped switches", async () => {
    const probeModelCall = vi.fn<
      (session: AcpSession, modelId: string, deadline: number) => Promise<ProbeSwitchResult>
    >(async () => ({
      result: effortOptions("reasoning_effort", ["fast"]),
      switched: true,
    }));
    let restoreCalls = 0;
    let exitCalls = 0;
    const stubClient: ProbeClient = {
      id: "session-1",
      sessionResult: { models: { currentModelId: "old" } },
      requestAcp: async () => ({}),
      requestInBudget: async () => {
        restoreCalls += 1;
        return {};
      },
      forceExit: async () => {
        exitCalls += 1;
        return { code: 0, signal: null };
      },
    };
    let starts = 0;
    const result = await probeModel(
      definition,
      "new",
      {
        cwd: "/tmp",
        at: AT,
        startProbe: async () => {
          starts += 1;
          return {
            client: stubClient,
            session: { models: { currentModelId: "old" } },
            deadline: Date.now() + 1000,
          };
        },
      },
      stubAdapter({ probeModel: probeModelCall }),
    );
    expect(result.status).toBe("ok");
    expect(result.restored).toBe(true);
    expect(result.recovery).toBe(false);
    expect(result.model).toMatchObject({ id: "new", supportedEfforts: ["fast"] });
    expect(starts).toBe(1);
    expect(probeModelCall).toHaveBeenCalledWith(stubClient, "new", expect.any(Number));
    expect(restoreCalls).toBe(0);
    expect(exitCalls).toBe(1);
  });
});

describe("probeModel switch decisions (#263 review)", () => {
  it("skips the switch when session/new already opened on the requested model", async () => {
    const { session, calls } = sessionStub(
      {
        models: { currentModelId: "new" },
        configOptions: [
          { id: "reasoning_effort", options: [{ value: "high" }], currentValue: "high" },
        ],
      },
      () => ({}),
    );
    const result = await genericAcpAdapter.probeModel(session, "new", Date.now() + 1000);
    expect(calls).toHaveLength(0);
    expect(result.switched).toBe(false);
  });

  it("falls back from session/set_model to the model config option when the extension is refused", async () => {
    const refreshed = effortOptions("reasoning_effort", ["fast"]);
    const { session, calls } = sessionStub(
      { models: { currentModelId: "old" } },
      (method, params) => {
        if (method === "session/set_model") return new Error("unsupported session/set_model");
        if (method === "session/set_config_option" && params.configId === "model") return refreshed;
        return {};
      },
    );
    const result = await genericAcpAdapter.probeModel(session, "new", Date.now() + 1000);
    expect(calls.map((call) => call.method)).toEqual([
      "session/set_model",
      "session/set_config_option",
    ]);
    expect(result.result).toEqual(refreshed);
    expect(result.switched).toBe(true);
  });

  it("reports the original failure when neither switch dialect succeeds", async () => {
    const { session } = sessionStub(
      { models: { currentModelId: "old" } },
      () => new Error("model rejected"),
    );
    await expect(genericAcpAdapter.probeModel(session, "new", Date.now() + 1000)).rejects.toThrow(
      "model rejected",
    );
  });

  it("keeps an empty configOptions result from a config-option-only adapter", async () => {
    const empty = { configOptions: [] };
    const { session, calls } = sessionStub(
      { models: { currentModelId: "old" } },
      (method, params) => {
        if (method === "session/set_config_option" && params.configId === "model") return empty;
        if (method === "session/set_model") return new Error("unsupported session/set_model");
        return {};
      },
    );
    const result = await new GenericAcpAdapter({ probeSwitchMethod: "config-option" }).probeModel(
      session,
      "new",
      Date.now() + 1000,
    );
    expect(calls.map((call) => call.method)).toEqual([
      "session/set_config_option",
      "session/set_model",
    ]);
    expect(result.result).toEqual(empty);
    expect(result.switched).toBe(true);
  });

  it("does not swallow a refresh timeout after a successful switch", async () => {
    const { session } = sessionStub(
      {
        models: { currentModelId: "old" },
        configOptions: [{ id: "model", options: [{ value: "old" }, { value: "new" }] }],
      },
      (method, params) => {
        if (method === "session/set_model") return {};
        if (method === "session/set_config_option" && params.configId === "model") {
          return new Error("ACP session/set_config_option timed out after 100ms");
        }
        return {};
      },
    );
    await expect(genericAcpAdapter.probeModel(session, "new", Date.now() + 1000)).rejects.toThrow(
      "timed out",
    );
  });

  it("does not mask a real dispatch model rejection with an unsupported fallback", async () => {
    const { session, calls } = sessionStub(
      { models: { currentModelId: "old" } },
      (method, params) => {
        if (method === "session/set_config_option" && params.configId === "model") {
          return new Error("unknown model new");
        }
        if (method === "session/set_model") return new Error("unsupported session/set_model");
        return {};
      },
    );
    await expect(genericAcpAdapter.applyDispatchOptions(session, { model: "new" })).rejects.toThrow(
      "unknown model new",
    );
    expect(calls).toHaveLength(1);
  });
});

const probeSession = (model: string, effort: string) => ({
  configOptions: [
    { id: "model", options: [{ value: model }], currentValue: model },
    { id: "thought_level", options: [{ value: effort }], currentValue: effort },
  ],
});

const recordingClient = (
  id: string,
  onRestore: (method: string, params: Record<string, unknown>) => void,
): ProbeClient => ({
  id,
  sessionResult: {},
  requestAcp: async () => ({}),
  requestInBudget: async (method, params) => {
    onRestore(method, params);
    return {};
  },
  forceExit: async () => ({ code: 0, signal: null }),
});

describe("previous model capture and one-shot recovery (#263 review)", () => {
  it("captures the active model from configOptions alone and restores it", async () => {
    const restoreCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client: ProbeClient = {
      id: "session-1",
      sessionResult: {},
      requestAcp: async (method, params) =>
        method === "session/set_config_option" && params.configId === "model"
          ? effortOptions("reasoning_effort", ["fast"])
          : {},
      requestInBudget: async (method, params) => {
        restoreCalls.push({ method, params });
        return {};
      },
      forceExit: async () => ({ code: 0, signal: null }),
    };
    const result = await probeModel(definition, "new", {
      cwd: "/tmp",
      at: AT,
      startProbe: async () => ({
        client,
        session: probeSession("old", "low"),
        deadline: Date.now() + 1000,
      }),
    });
    expect(result.status).toBe("ok");
    expect(restoreCalls).toContainEqual({
      method: "session/set_model",
      params: { sessionId: "session-1", modelId: "old" },
    });
    expect(restoreCalls).toContainEqual({
      method: "session/set_config_option",
      params: { sessionId: "session-1", configId: "thought_level", value: "low" },
    });
  });

  it("passes the abort signal, bounds the recovery budget and trusts a fully restored session", async () => {
    const signal = new AbortController().signal;
    const starts: Array<{
      signal?: AbortSignal | undefined;
      timeoutMs: number;
      sessionMeta?: Record<string, unknown> | undefined;
    }> = [];
    const firstRestore: string[] = [];
    const recoveryCalls: string[] = [];
    const first = recordingClient("probe-1", (method) => firstRestore.push(method));
    // Force the in-process restore to fail so the one-shot recovery session runs.
    const failing: ProbeClient = {
      ...first,
      requestInBudget: async (method) => {
        firstRestore.push(method);
        throw new Error(`restore failed: ${method}`);
      },
    };
    const recovery = recordingClient("recovery-1", (method) => recoveryCalls.push(method));
    let count = 0;
    const result = await probeModel(definition, "new", {
      cwd: "/tmp",
      at: AT,
      timeoutMs: 60_000,
      signal,
      startProbe: async (options) => {
        starts.push({
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: options.timeoutMs,
          ...(options.sessionMeta === undefined ? {} : { sessionMeta: options.sessionMeta }),
        });
        count += 1;
        return count === 1
          ? { client: failing, session: probeSession("old", "low"), deadline: Date.now() + 1000 }
          : { client: recovery, session: probeSession("old", "low"), deadline: Date.now() + 1000 };
      },
    });
    expect(result.status).toBe("ok");
    expect(result.restored).toBe(true);
    expect(result.recovery).toBe(true);
    expect(firstRestore).toContain("session/set_model");
    expect(starts[1]?.signal).toBe(signal);
    expect(starts[1]?.timeoutMs).toBe(5000);
    expect(starts[1]?.sessionMeta).toMatchObject({ orreryRecovery: true });
    // The fresh session already matched model AND options: no extra restore.
    expect(recoveryCalls).toHaveLength(0);
  });

  it("restores mismatched non-model options in the recovery session", async () => {
    const recoveryCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let count = 0;
    const result = await probeModel(definition, "new", {
      cwd: "/tmp",
      at: AT,
      startProbe: async () => {
        count += 1;
        return {
          client: recordingClient("recovery-2", (method, params) => {
            recoveryCalls.push({ method, params });
            if (count === 1) throw new Error("restore failed");
          }),
          session: count === 1 ? probeSession("old", "low") : probeSession("old", "high"),
          deadline: Date.now() + 1000,
        };
      },
    });
    expect(result.restored).toBe(true);
    expect(result.recovery).toBe(true);
    expect(recoveryCalls).toContainEqual({
      method: "session/set_config_option",
      params: { sessionId: "recovery-2", configId: "thought_level", value: "low" },
    });
  });

  it("restores via the model config option when a harness has no set_model RPC", async () => {
    const restoreCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client: ProbeClient = {
      id: "session-1",
      sessionResult: {},
      requestAcp: async () => ({}),
      requestInBudget: async (method, params) => {
        restoreCalls.push({ method, params });
        if (method === "session/set_model") throw new Error("unsupported session/set_model");
        return {};
      },
      forceExit: async () => ({ code: 0, signal: null }),
    };
    const result = await probeModel(definition, "new", {
      cwd: "/tmp",
      at: AT,
      startProbe: async () => ({
        client,
        session: probeSession("old", "low"),
        deadline: Date.now() + 1000,
      }),
    });
    expect(result.restored).toBe(true);
    expect(restoreCalls).toContainEqual({
      method: "session/set_model",
      params: { sessionId: "session-1", modelId: "old" },
    });
    expect(restoreCalls).toContainEqual({
      method: "session/set_config_option",
      params: { sessionId: "session-1", configId: "model", value: "old" },
    });
  });

  it("reads configId/state/choices uniformly for restore values and post-switch efforts", async () => {
    const restoreCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client: ProbeClient = {
      id: "session-1",
      sessionResult: {},
      requestAcp: async () => ({
        configOptions: [
          {
            configId: "reasoning_effort",
            state: { choices: [{ value: "high" }, { value: "low" }], currentValue: "high" },
          },
        ],
      }),
      requestInBudget: async (method, params) => {
        restoreCalls.push({ method, params });
        return {};
      },
      forceExit: async () => ({ code: 0, signal: null }),
    };
    const session = {
      configOptions: [
        { configId: "model", state: { options: [{ value: "old" }], currentValue: "old" } },
        {
          id: "thought_level",
          state: { choices: [{ value: "low" }, { value: "medium" }], currentValue: "low" },
        },
      ],
    };
    const result = await probeModel(definition, "new", {
      cwd: "/tmp",
      at: AT,
      startProbe: async () => ({ client, session, deadline: Date.now() + 1000 }),
    });
    expect(result.model).toMatchObject({
      id: "new",
      supportedEfforts: ["high", "low"],
      defaultEffort: "high",
    });
    expect(restoreCalls).toContainEqual({
      method: "session/set_config_option",
      params: { sessionId: "session-1", configId: "thought_level", value: "low" },
    });
  });
});

describe("bounded ACP error detail (#263 review)", () => {
  it("clips hostile error payloads well below the diagnostic contract limit", () => {
    const huge = "x".repeat(3000);
    expect(acpErrorDetail({ message: "model_switch_cancelled", data: { details: huge } })).toBe(
      `model_switch_cancelled (${"x".repeat(500)})`,
    );
    const both = acpErrorDetail({ message: huge, data: { message: huge } });
    expect(both.length).toBeLessThanOrEqual(1003);
    expect(acpErrorDetail({ message: "error", data: "   " })).toBe("error");
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchCommandPayload } from "@orrery/contract";
import { loadSupervisionConfig } from "./config.ts";
import type * as credential from "./credential.ts";
import type * as harnesses from "./harnesses.ts";
import { work } from "./work.ts";

const flags = vi.hoisted(() => ({ noOpencode: false }));

const captured = vi.hoisted(() => ({
  command: undefined as DispatchCommandPayload | undefined,
  getTargetsCalls: 0,
  registeredAgentId: undefined as string | undefined,
}));

const runner = {
  id: "runner-1",
  hostId: "host-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  agentId: "agent-1",
  displayName: "TestLaptop",
  repoFingerprint: "a".repeat(64),
  capabilities: [],
  harnessCatalog: null,
  maxConcurrency: 1,
  activeSlotCount: 0,
  lastSeenAt: new Date().toISOString(),
  disconnectedAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
  presence: "online",
} as const;

const dispatch = {
  id: "dispatch-1",
  runnerId: "runner-1",
  hostId: "host-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  issueId: "issue-1",
  requestedByHumanId: "human-1",
  agentId: "agent-1",
  dispatchAttemptId: "attempt-1",
  state: "pending",
  prompt: null,
  harness: null,
  model: null,
  effort: null,
  runId: null,
  workSessionId: null,
  lastUpSeq: 0,
  lastDownSeq: 0,
  branchName: null,
  dirtyWorktree: false,
  createdAt: new Date().toISOString(),
  acceptedAt: null,
  endedAt: null,
} as const;

vi.mock("./credential.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof credential>();
  return {
    ...actual,
    readCredential: async () => ({
      server: "http://127.0.0.1:8080",
      hostId: "host-1",
      credential: "orr_rh_local-credential-1234567890",
      displayName: "TestLaptop",
      platform: "linux-x64",
    }),
  };
});

vi.mock("./harnesses.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof harnesses>();
  return {
    ...actual,
    validateExplicitHarness: () => ({
      id: "node",
      displayName: "Node",
      source: "user" as const,
      command: process.execPath,
      args: [],
    }),
    commandOnPath: (...args: Parameters<typeof actual.commandOnPath>) => {
      if (flags.noOpencode) return false;
      return actual.commandOnPath(...args);
    },
    resolveDefaultHarness: (...args: Parameters<typeof actual.resolveDefaultHarness>) => {
      if (flags.noOpencode) return undefined;
      return actual.resolveDefaultHarness(...args);
    },
  };
});

vi.mock("./checkout.ts", () => ({
  validateCheckout: () => ({ repoRoot: "/tmp/repo", mainRoot: "/tmp/repo" }),
  runnerFingerprint: () => "a".repeat(64),
  bindingFingerprint: () => "b".repeat(64),
  mainCheckoutRoot: () => "/tmp/repo",
}));

vi.mock("./catalog.ts", () => ({
  harnessConfigKey: () => "default",
  readCachedCatalog: () => null,
  verifiedDefaultModel: () => null,
}));

vi.mock("./client.ts", () => {
  class RunnerRequestError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "RunnerRequestError";
      this.status = status;
    }
  }
  class OrreryClient {
    async resolveIssue() {
      return {
        issueId: "issue-1",
        workspaceId: "workspace-1",
        workspaceName: "Workspace",
        projectId: "project-1",
        projectKey: "KEY",
        identifier: "KEY-1",
        number: 1,
        title: "One-shot dispatch",
      };
    }
    async getTargets() {
      captured.getTargetsCalls += 1;
      return {
        workspaces: [],
        agents: [{ id: "agent-9", name: "Nina" }],
        defaultAgentId: "agent-9",
      };
    }
    async registerRunner(input: { agentId?: string }) {
      captured.registeredAgentId = input.agentId;
      return runner;
    }
    async reconnect() {
      return { resolutions: [] };
    }
    async heartbeat() {
      return runner;
    }
    async createRunnerDispatch() {
      return dispatch;
    }
    async acceptDispatch() {
      return {
        dispatch,
        run: {
          id: "run-1",
          agentId: "agent-1",
          workspaceId: "workspace-1",
          harness: null,
          harnessVersion: null,
          nativeSessionId: "attempt-1",
          model: null,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          endedAt: null,
          endedReason: null,
          lastHeartbeatAt: null,
        },
        session: {
          id: "session-1",
          agentId: "agent-1",
          runId: "run-1",
          workspaceId: "workspace-1",
          issueId: "issue-1",
          status: "active",
          leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          progress: "",
          progressUpdatedAt: null,
          stopRequested: false,
          stopRequestedAt: null,
          stopReason: null,
          inputTokens: null,
          outputTokens: null,
          costUsdMicros: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          endedAt: null,
        },
        dispatchToken: "orr_dt_test",
      };
    }
    async pollCommands() {
      return new Promise<never>(() => undefined);
    }
    async markRunnerOffline() {
      return { runnerId: "runner-1", revokedRunners: 1 };
    }
  }
  return { OrreryClient, RunnerRequestError };
});

vi.mock("./supervise.ts", () => ({
  superviseDispatch: async (options: { command: DispatchCommandPayload }) => {
    captured.command = options.command;
    return {
      dispatchId: "dispatch-1",
      dispatchAttemptId: "attempt-1",
      issueId: "issue-1",
      requestCancel: () => undefined,
      cancelled: new Promise<string>(() => undefined),
      requestResumeInput: () => undefined,
      finished: Promise.resolve(),
      outcome: "completed",
      lastSeq: 0,
    };
  },
}));

describe("one-shot work execution options (#241)", () => {
  let configDir = "";
  let savedConfigDir: string | undefined;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.ORRERY_RUNNER_CONFIG_DIR;
    savedUrl = process.env.ORRERY_URL;
    delete process.env.ORRERY_URL;
    // work() eagerly validates the real harnesses.json: isolate it per test.
    configDir = mkdtempSync(join(tmpdir(), "orrery-work-"));
    process.env.ORRERY_RUNNER_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.ORRERY_RUNNER_CONFIG_DIR;
    else process.env.ORRERY_RUNNER_CONFIG_DIR = savedConfigDir;
    if (savedUrl === undefined) delete process.env.ORRERY_URL;
    else process.env.ORRERY_URL = savedUrl;
    rmSync(configDir, { recursive: true, force: true });
  });
  it("forwards harness, model and effort without populated supervision defaults", async () => {
    const outcome = await work("KEY-1", {
      server: "http://127.0.0.1:8080",
      harness: "node",
      model: "stub-deep",
      effort: "high",
      // Deliberately no defaults: the flags themselves must reach supervision.
      supervision: loadSupervisionConfig({}, {}),
    });
    expect(outcome).toBe("completed");
    expect(captured.command).toMatchObject({
      harness: "node",
      model: "stub-deep",
      effort: "high",
    });
  });

  it("fails fast when the default opencode Harness is missing (#266)", async () => {
    flags.noOpencode = true;
    try {
      await expect(
        work("KEY-1", {
          server: "http://127.0.0.1:8080",
          supervision: loadSupervisionConfig({}, {}),
        }),
      ).rejects.toThrow(/opencode.*not installed/);
    } finally {
      flags.noOpencode = false;
    }
  });

  it("fails fast on a malformed harnesses.json before any network call (#266)", async () => {
    writeFileSync(join(configDir, "harnesses.json"), "{not json");
    await expect(
      work("KEY-1", {
        server: "http://127.0.0.1:8080",
        supervision: loadSupervisionConfig({}, {}),
      }),
    ).rejects.toThrow(/harnesses\.json/);
  });

  it("resolves a human-readable --agent name via targets (#267)", async () => {
    captured.getTargetsCalls = 0;
    captured.registeredAgentId = undefined;
    const outcome = await work("KEY-1", {
      server: "http://127.0.0.1:8080",
      agentId: "Nina",
      supervision: loadSupervisionConfig({}, {}),
    });
    expect(outcome).toBe("completed");
    expect(captured.getTargetsCalls).toBe(1);
    expect(captured.registeredAgentId).toBe("agent-9");
  });

  it("passes agent UUIDs through without a targets round-trip (#267)", async () => {
    captured.getTargetsCalls = 0;
    captured.registeredAgentId = undefined;
    const uuid = "12345678-1234-1234-1234-1234567890ab";
    const outcome = await work("KEY-1", {
      server: "http://127.0.0.1:8080",
      agentId: uuid,
      supervision: loadSupervisionConfig({}, {}),
    });
    expect(outcome).toBe("completed");
    expect(captured.getTargetsCalls).toBe(0);
    expect(captured.registeredAgentId).toBe(uuid);
  });

  it("fails an unknown --agent name without registering (#267)", async () => {
    captured.getTargetsCalls = 0;
    captured.registeredAgentId = undefined;
    await expect(
      work("KEY-1", {
        server: "http://127.0.0.1:8080",
        agentId: "Zed",
        supervision: loadSupervisionConfig({}, {}),
      }),
    ).rejects.toThrow(/No agent matches 'Zed'/);
    expect(captured.registeredAgentId).toBeUndefined();
  });
});

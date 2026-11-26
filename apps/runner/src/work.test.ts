import { describe, expect, it, vi } from "vitest";
import type { DispatchCommandPayload } from "@orrery/contract";
import { loadSupervisionConfig } from "./config.ts";
import { work } from "./work.ts";

const captured = vi.hoisted(() => ({
  command: undefined as DispatchCommandPayload | undefined,
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

vi.mock("./credential.ts", () => ({
  readCredential: async () => ({
    server: "http://127.0.0.1:8080",
    hostId: "host-1",
    credential: "orr_rh_local-credential-1234567890",
    displayName: "TestLaptop",
    platform: "linux-x64",
  }),
}));

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
    async registerRunner() {
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
  it("forwards harness, model and effort without populated supervision defaults", async () => {
    delete process.env.ORRERY_URL;
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
});

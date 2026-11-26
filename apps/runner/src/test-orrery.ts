/**
 * Test-only HTTP control plane speaking the Orrery Runner contracts. It is a
 * real HTTP server on a real socket; the production Runner talks to it over
 * the same black-box fetch/MCP client it uses against Orrery itself.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { EMPTY_HARNESS_CATALOG } from "@orrery/contract";

export interface TestSession {
  id: string;
  issueId: string;
  status: "active" | "completed" | "released" | "expired";
  renewals: number;
  stopOutcome: string | null;
  leaseExpiresAt: number;
}

export interface TestActivity {
  issueId: string;
  summary: string;
  detail: Record<string, unknown> | undefined;
}

export interface TestQuestion {
  id: string;
  issueId: string;
  question: string;
  proposedFallback: string;
  status: "open" | "answered" | "paused" | "fallback_used";
}

export interface TestStreamChunk {
  seq: number;
  kind: string;
  visibility?: string;
  eventType?: string;
  summary?: string;
  data?: Record<string, unknown>;
}

export interface TestCommand {
  commandId: string;
  runnerId: string;
  seq: number;
  dispatchId: string;
  dispatchAttemptId: string;
  createdAt: string;
  expiresAt: string;
  kind: "dispatch" | "cancel" | "input_resolved";
  payload: Record<string, unknown>;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const bodyOf = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(text === "" ? "{}" : text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const now = () => new Date().toISOString();

/** Mirrors the server's Dispatch-token allowlists so tests catch scope drift. */
const DISPATCH_TOOLS = new Set([
  "get_project",
  "get_issue",
  "list_comments",
  "list_blocked_by",
  "list_blocking",
  "list_knowledge",
  "get_knowledge",
  "list_labels",
  "get_work_session",
  "list_work_sessions",
  "list_session_activities",
  "list_issue_questions",
  "resume_work_session",
  "update_issue",
  "create_comment",
  "add_issue_link",
  "create_knowledge",
  "update_knowledge",
  "log_session_activity",
  "report_progress",
  "ask_for_input",
  "renew_claim",
  "stop_session",
]);

const DISPATCH_REST: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/api\/issues\/[^/]+$/ },
  { method: "PATCH", pattern: /^\/api\/issues\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/issues\/[^/]+\/work-sessions\/renew$/ },
  { method: "POST", pattern: /^\/api\/issues\/[^/]+\/work-sessions\/progress$/ },
  { method: "POST", pattern: /^\/api\/issues\/[^/]+\/work-sessions\/stop$/ },
  { method: "POST", pattern: /^\/api\/issues\/[^/]+\/work-sessions\/activities$/ },
  { method: "GET", pattern: /^\/api\/issues\/[^/]+\/work-sessions(?:\/all)?$/ },
];

export class TestOrrery {
  url = "";
  revoked = false;
  private readonly server: ReturnType<typeof createServer>;
  private seq = 0;
  private ackedSeq = 0;
  private readonly commands: TestCommand[] = [];
  private readonly sessions = new Map<string, TestSession>();
  private readonly activities: TestActivity[] = [];
  private readonly questions: TestQuestion[] = [];
  private readonly pendingResolutions = new Map<
    string,
    { resolution: "answered" | "fallback_used"; answer: string }
  >();
  private readonly stopCalls: string[] = [];
  private readonly dispatchIssues = new Map<string, string>();
  private readonly dispatchAttempts = new Map<string, string>();
  private readonly streamed: TestStreamChunk[] = [];
  reconnectCalls = 0;
  /** Number of heartbeats to answer with a transient 503 before recovering. */
  transientHeartbeatFailures = 0;
  reconnectAttempts: Array<{ dispatchAttemptId: string; lastSeq: number }> = [];
  private readonly scopes = new Map<
    string,
    { issueId: string; runId: string; sessionId: string }
  >();
  private readonly wake: Array<() => void> = [];

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  static async start(): Promise<TestOrrery> {
    const control = new TestOrrery();
    await control.ready();
    return control;
  }

  private readyPromise: Promise<void> | undefined;
  async ready(): Promise<void> {
    if (this.readyPromise !== undefined) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    await this.readyPromise;
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("no test listener");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  private runner(): Record<string, unknown> {
    return {
      id: "runner-test-1",
      hostId: "host-test-1",
      workspaceId: "workspace-test-1",
      projectId: "project-test-1",
      agentId: "agent-test-1",
      displayName: "TestLaptop",
      repoFingerprint: "0".repeat(64),
      capabilities: [],
      harnessCatalog: EMPTY_HARNESS_CATALOG,
      maxConcurrency: 1,
      activeSlotCount: 0,
      lastSeenAt: now(),
      disconnectedAt: null,
      revokedAt: this.revoked ? now() : null,
      createdAt: now(),
      presence: this.revoked ? "offline" : "online",
    };
  }

  private enqueue(
    kind: TestCommand["kind"],
    dispatchId: string,
    dispatchAttemptId: string,
    payload: Record<string, unknown>,
  ): TestCommand {
    this.seq += 1;
    const command: TestCommand = {
      commandId: `cmd-${this.seq}`,
      runnerId: "runner-test-1",
      seq: this.seq,
      dispatchId,
      dispatchAttemptId,
      createdAt: now(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      kind,
      payload,
    };
    this.commands.push(command);
    for (const wake of this.wake.splice(0)) wake();
    return command;
  }

  enqueueDispatch(issueId: string, attemptId: string = randomUUID()): TestCommand {
    const dispatchId = `dispatch-${issueId}`;
    this.dispatchIssues.set(dispatchId, issueId);
    this.dispatchAttempts.set(dispatchId, attemptId);
    return this.enqueue("dispatch", dispatchId, attemptId, {
      dispatchId,
      dispatchAttemptId: attemptId,
      issueId,
      projectId: "project-test-1",
      workspaceId: "workspace-test-1",
      agentId: "agent-test-1",
    });
  }

  enqueueCancel(dispatchAttemptId: string, reason = "human stop"): TestCommand {
    const command = this.commands.find((item) => item.dispatchAttemptId === dispatchAttemptId);
    const deadlinePause = reason === "question_paused" || reason === "input_deadline_paused";
    if (deadlinePause) {
      const issueId = str(command?.payload.issueId);
      for (const question of this.questionsFor(issueId)) {
        if (question.status === "open") question.status = "paused";
      }
      const session = this.sessionFor(issueId);
      if (session !== undefined) session.status = "released";
    }
    return this.enqueue(
      "cancel",
      command?.dispatchId ?? `dispatch-for-${dispatchAttemptId}`,
      dispatchAttemptId,
      {
        dispatchId: command?.dispatchId ?? `dispatch-for-${dispatchAttemptId}`,
        dispatchAttemptId,
        issueId: command?.payload.issueId ?? "TEST-1",
        reason,
      },
    );
  }

  /** Same payload the server's inbox sends when a question is resolved. */
  enqueueInputResolved(
    dispatchAttemptId: string,
    input: { questionId: string; resolution: "answered" | "fallback_used"; answer: string },
  ): TestCommand {
    const command = this.commands.find((item) => item.dispatchAttemptId === dispatchAttemptId);
    const payload = {
      dispatchId: command?.dispatchId ?? `dispatch-for-${dispatchAttemptId}`,
      dispatchAttemptId,
      issueId: str(command?.payload.issueId) || "TEST-1",
      ...input,
    };
    // A resolution queued before the question was recorded (or redelivered
    // with a synthetic id) still settles that issue's open question, so the
    // supervisor does not park again on a question it already consumed.
    const question =
      this.questions.find((item) => item.id === input.questionId) ??
      this.questionsFor(payload.issueId).find((item) => item.status === "open");
    if (question !== undefined) {
      question.status = input.resolution === "fallback_used" ? "fallback_used" : "answered";
    } else {
      // The answer arrived before the agent asked; apply it to that issue's
      // next question so the supervisor does not park a second time.
      this.pendingResolutions.set(payload.issueId, input);
    }
    return this.enqueue("input_resolved", payload.dispatchId, dispatchAttemptId, payload);
  }

  questionsFor(issueId: string): readonly TestQuestion[] {
    return this.questions.filter((question) => question.issueId === issueId);
  }

  recordedStopCalls(): readonly string[] {
    return this.stopCalls;
  }

  private attemptIdFor(dispatchId: string): string {
    return this.dispatchAttempts.get(dispatchId) ?? `attempt-${dispatchId}`;
  }

  revoke(): void {
    this.revoked = true;
  }

  /** Chunks flushed by the runner's StreamSpool (test seam for #202). */
  chunks(): readonly TestStreamChunk[] {
    return this.streamed;
  }

  state() {
    return {
      sessions: [...this.sessions.values()].map((session) => Object.assign({}, session)),
      activities: this.activities.map((activity) =>
        Object.assign({}, activity, {
          detail: activity.detail === undefined ? undefined : Object.assign({}, activity.detail),
        }),
      ),
      ackedSeq: this.ackedSeq,
      commands: this.commands.map((command) =>
        Object.assign({}, command, { payload: Object.assign({}, command.payload) }),
      ),
    };
  }

  /** Block until at least `count` activities have been recorded. */
  async waitForActivities(count: number, timeoutMs = 10_000): Promise<TestActivity[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.activities.length < count && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.wake.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.state().activities;
  }

  private sessionFor(issueId: string): TestSession | undefined {
    return [...this.sessions.values()].find((session) => session.issueId === issueId);
  }

  private toolResult(id: number, value: unknown): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "ok" }], structuredContent: value },
    });
  }

  private toolError(id: number, message: string): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: message }] },
    });
  }

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = recordOf(await bodyOf(req)) ?? {};
    const method = typeof body.method === "string" ? body.method : "";
    if (method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const id = typeof body.id === "number" ? body.id : -1;
    if (method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        this.toolResult(id, {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "orrery-test", version: "1" },
        }),
      );
      return;
    }
    if (method !== "tools/call") {
      sendJson(res, 400, { error: { code: -32601, message: `unknown method ${method}` } });
      return;
    }
    const token = req.headers.authorization ?? "";
    if (this.revoked || !token.includes("orr_dt_")) {
      sendJson(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
      return;
    }
    const params = recordOf(body.params) ?? {};
    const name = String(params.name);
    const args = recordOf(params.arguments) ?? {};
    const issueId = str(args.issueId);
    const sessionId = typeof args.sessionId === "string" ? args.sessionId : undefined;
    const scope = [...this.scopes.values()].find((item) => item.issueId === issueId);
    const forbidden = (): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolError(id, "dispatch_forbidden"));
    };
    if (!DISPATCH_TOOLS.has(name) || (issueId !== "" && scope === undefined)) {
      forbidden();
      return;
    }
    if (sessionId !== undefined && sessionId !== scope?.sessionId) {
      forbidden();
      return;
    }
    const runId = str(args.runId);
    if (runId !== "" && runId !== scope?.runId) {
      forbidden();
      return;
    }
    const outcome = str(args.outcome);
    if (outcome !== "" && !["review", "completed", "released"].includes(outcome)) {
      forbidden();
      return;
    }
    const session = this.sessionFor(issueId);

    if (name === "get_issue") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolResult(id, { issue: { identifier: "TEST-42", id: issueId } }));
      return;
    }
    if (name === "get_work_session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        this.toolResult(id, {
          session: { id: sessionId, issueId, status: session?.status ?? "expired" },
        }),
      );
      return;
    }
    if (name === "list_issue_questions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        this.toolResult(id, {
          questions: this.questionsFor(issueId).map((question) => Object.assign({}, question)),
        }),
      );
      return;
    }
    if (name === "ask_for_input") {
      const pending = this.pendingResolutions.get(issueId);
      this.pendingResolutions.delete(issueId);
      const question: TestQuestion = {
        id: `question-${randomUUID()}`,
        issueId,
        question: str(args.question) || "Which approach should I take?",
        proposedFallback: str(args.proposedFallback) || "Use the safe default",
        status:
          pending === undefined
            ? "open"
            : pending.resolution === "fallback_used"
              ? "fallback_used"
              : "answered",
      };
      this.questions.push(question);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolResult(id, { question: { ...question } }));
      return;
    }
    if (name === "log_session_activity") {
      const detail = recordOf(args.detail);
      this.activities.push({
        issueId,
        summary: str(args.summary),
        detail,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolResult(id, { activity: { id: randomUUID() } }));
      return;
    }
    if (session === undefined || session.status !== "active") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolError(id, "no live session"));
      return;
    }
    if (sessionId !== undefined && sessionId !== session.id) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolError(id, "stale session fence"));
      return;
    }
    if (name === "renew_claim") {
      session.renewals += 1;
      session.leaseExpiresAt = Date.now() + 300_000;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolResult(id, { session: { id: session.id, status: session.status } }));
      return;
    }
    if (name === "stop_session") {
      const stopOutcome = str(args.outcome) || "review";
      this.stopCalls.push(stopOutcome);
      session.status = stopOutcome === "released" ? "released" : "completed";
      session.stopOutcome = stopOutcome;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.toolResult(id, { session: { id: session.id, status: session.status } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(this.toolError(id, `unsupported tool ${name}`));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    if (path === "/mcp") {
      await this.mcp(req, res);
      return;
    }
    const bearer = req.headers.authorization ?? "";
    if (bearer.includes("orr_dt_") && path.startsWith("/api/")) {
      const allowed = DISPATCH_REST.some(
        (rule) => rule.method === req.method && rule.pattern.test(path),
      );
      if (!allowed) {
        sendJson(res, 403, {
          status: 403,
          code: "dispatch_forbidden",
          title: "This operation is outside the Dispatch token's single-issue scope.",
        });
        return;
      }
    }
    const renew = path.match(/^\/api\/issues\/([^/]+)\/work-sessions\/renew$/);
    if (req.method === "POST" && renew !== null) {
      if (this.revoked || !(req.headers.authorization ?? "").includes("orr_dt_")) {
        sendJson(res, 401, { status: 401, code: "invalid_credential", title: "Revoked" });
        return;
      }
      const session = this.sessionFor(decodeURIComponent(renew[1] ?? ""));
      if (session === undefined || session.status !== "active") {
        sendJson(res, 409, { status: 409, code: "session_not_active", title: "No live session" });
        return;
      }
      session.renewals += 1;
      session.leaseExpiresAt = Date.now() + 300_000;
      sendJson(res, 200, { id: session.id, status: "active", issueId: session.issueId });
      return;
    }
    if (req.method === "POST" && path === "/api/runners/register") {
      sendJson(res, 201, this.runner());
      return;
    }
    if (req.method === "POST" && path.endsWith("/reconnect")) {
      this.reconnectCalls += 1;
      const body = recordOf(await bodyOf(req)) ?? {};
      const attempts = Array.isArray(body.activeAttempts) ? body.activeAttempts : [];
      this.reconnectAttempts = attempts.flatMap((item) => {
        const record = recordOf(item);
        if (record === undefined) return [];
        return [
          {
            dispatchAttemptId:
              typeof record.dispatchAttemptId === "string" ? record.dispatchAttemptId : "",
            lastSeq: Number(record.lastSeq ?? 0),
          },
        ];
      });
      sendJson(res, 200, { resolutions: [] });
      return;
    }
    const ingest = path.match(/^\/api\/runners\/[^/]+\/dispatches\/([^/]+)\/stream$/);
    if (req.method === "POST" && ingest !== null) {
      const body = recordOf(await bodyOf(req)) ?? {};
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];
      for (const chunk of chunks) {
        const record = recordOf(chunk);
        if (record === undefined) continue;
        this.streamed.push({
          seq: Number(record.seq ?? 0),
          kind: typeof record.kind === "string" ? record.kind : "event",
          ...(typeof record.visibility === "string" ? { visibility: record.visibility } : {}),
          ...(typeof record.eventType === "string" ? { eventType: record.eventType } : {}),
          ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
          ...(typeof record.data === "object" && record.data !== null
            ? { data: Object.fromEntries(Object.entries(record.data)) }
            : {}),
        });
      }
      const toSeq = Number(body.toSeq ?? 0);
      sendJson(res, 200, { ackedSeq: toSeq });
      return;
    }
    if (req.method === "POST" && path.endsWith("/heartbeat")) {
      if (this.transientHeartbeatFailures > 0) {
        this.transientHeartbeatFailures -= 1;
        sendJson(res, 503, { status: 503, code: "temporarily_unavailable", title: "Try again" });
        return;
      }
      if (this.revoked) {
        sendJson(res, 401, {
          status: 401,
          code: "runner_revoked",
          title: "This Runner was revoked. Stop local operation.",
        });
        return;
      }
      sendJson(res, 200, this.runner());
      return;
    }
    if (req.method === "GET" && path.endsWith("/commands")) {
      const after = Number(url.searchParams.get("afterSeq") ?? "0");
      const waitMs = Number(url.searchParams.get("waitMs") ?? "0");
      const deadline = Date.now() + Math.min(waitMs, 1000);
      while (this.commands.every((command) => command.seq <= after) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          this.wake.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      sendJson(res, 200, {
        commands: this.commands.filter((command) => command.seq > after),
      });
      return;
    }
    if (req.method === "POST" && path.endsWith("/commands/ack")) {
      const body = recordOf(await bodyOf(req)) ?? {};
      this.ackedSeq = Math.max(this.ackedSeq, Number(body.upToSeq ?? 0));
      sendJson(res, 200, { ackedSeq: this.ackedSeq });
      return;
    }
    const accept = path.match(/^\/api\/runners\/[^/]+\/dispatches\/([^/]+)\/accept$/);
    if (req.method === "POST" && accept !== null) {
      if (this.revoked) {
        sendJson(res, 401, { status: 401, code: "runner_revoked", title: "Revoked" });
        return;
      }
      const dispatchId = decodeURIComponent(accept[1] ?? "");
      const issueId = this.dispatchIssues.get(dispatchId) ?? "TEST-1";
      const sessionId = `session-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      this.sessions.set(sessionId, {
        id: sessionId,
        issueId,
        status: "active",
        renewals: 0,
        stopOutcome: null,
        leaseExpiresAt: Date.now() + 300_000,
      });
      this.scopes.set(sessionId, { issueId, runId, sessionId });
      const stamp = now();
      sendJson(res, 200, {
        dispatch: {
          id: dispatchId,
          runnerId: "runner-test-1",
          hostId: "host-test-1",
          workspaceId: "workspace-test-1",
          projectId: "project-test-1",
          issueId,
          requestedByHumanId: "human-test-1",
          agentId: "agent-test-1",
          dispatchAttemptId: this.attemptIdFor(dispatchId),
          state: "active",
          runId,
          workSessionId: sessionId,
          lastUpSeq: 0,
          lastDownSeq: 0,
          branchName: null,
          dirtyWorktree: false,
          createdAt: stamp,
          acceptedAt: stamp,
          endedAt: null,
        },
        run: {
          id: runId,
          agentId: "agent-test-1",
          workspaceId: "workspace-test-1",
          harness: null,
          harnessVersion: null,
          nativeSessionId: this.attemptIdFor(dispatchId),
          model: null,
          status: "active",
          createdAt: stamp,
          updatedAt: stamp,
          endedAt: null,
          endedReason: null,
          lastHeartbeatAt: stamp,
        },
        session: {
          id: sessionId,
          agentId: "agent-test-1",
          runId,
          workspaceId: "workspace-test-1",
          issueId,
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
          createdAt: stamp,
          updatedAt: stamp,
          endedAt: null,
        },
        dispatchToken: `orr_dt_${randomUUID()}`,
      });
      return;
    }
    sendJson(res, 404, { status: 404, code: "not_found", title: "Not found" });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

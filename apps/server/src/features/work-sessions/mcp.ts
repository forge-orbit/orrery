import type { McpServer } from "@modelcontextprotocol/server";
import {
  ReadyWorkFilter,
  SessionActivityKind,
  type AgentIdentity,
  type SessionTelemetry,
  type StopOutcome,
} from "@orrery/contract";
import { sessionTools } from "@orrery/contract";
import {
  assertDispatchToolAllowed,
  isAgentError,
  type AgentAuthenticator,
} from "../agents/index.ts";
import { SessionsError, type SessionsService } from "./service.ts";

type Args = Record<string, unknown>;

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  return value;
};

const sessionFence = (args: Args): string | undefined =>
  typeof args.sessionId === "string" ? args.sessionId : undefined;

const telemetry = (args: Args): SessionTelemetry | undefined => {
  const reported: SessionTelemetry = {};
  if (typeof args.inputTokens === "number") reported.inputTokens = args.inputTokens;
  if (typeof args.outputTokens === "number") reported.outputTokens = args.outputTokens;
  if (typeof args.costUsdMicros === "number") reported.costUsdMicros = args.costUsdMicros;
  return Object.keys(reported).length === 0 ? undefined : reported;
};

const stopOutcome = (args: Args): StopOutcome =>
  args.outcome === "released" || args.outcome === "done" || args.outcome === "review"
    ? args.outcome
    : "completed";

const activityDetail = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
};

export function createSessionsMcp(service: SessionsService, authenticate: AgentAuthenticator) {
  const strategies: Record<string, (identity: AgentIdentity, args: Args) => Promise<Args>> = {
    claim_issue: async (identity, args) => ({
      session: await service.claim(
        { kind: "agent", identity },
        { issueId: str(args.issueId, "issueId"), runId: str(args.runId, "runId") },
      ),
    }),
    renew_claim: async (identity, args) => ({
      session: await service.renew(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
        sessionFence(args),
        telemetry(args),
      ),
    }),
    report_progress: async (identity, args) => ({
      session: await service.progress(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
        str(args.summary, "summary"),
        sessionFence(args),
        telemetry(args),
      ),
    }),
    stop_session: async (identity, args) => ({
      session: await service.stop(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),

        stopOutcome(args),
        sessionFence(args),
        telemetry(args),
      ),
    }),
    get_work_session: async (identity, args) => ({
      session: await service.getSession({ kind: "agent", identity }, str(args.issueId, "issueId")),
    }),
    resume_work_session: async (identity, args) => ({
      resume: await service.resume(
        { kind: "agent", identity },
        { issueId: str(args.issueId, "issueId"), runId: str(args.runId, "runId") },
      ),
    }),
    reacquire_issue: async (identity, args) => ({
      session: await service.reacquire(
        { kind: "agent", identity },
        { issueId: str(args.issueId, "issueId"), runId: str(args.runId, "runId") },
      ),
    }),
    list_work_sessions: async (identity, args) => ({
      sessions: await service.listSessions(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
      ),
    }),
    log_session_activity: async (identity, args) => ({
      activity: await service.logActivity(
        { kind: "agent", identity },
        {
          issueId: str(args.issueId, "issueId"),
          kind: SessionActivityKind.parse(args.kind),
          summary: str(args.summary, "summary"),
          detail: activityDetail(args.detail),
          sessionId: sessionFence(args),
        },
      ),
    }),
    list_session_activities: async (identity, args) => ({
      activities: await service.listActivities(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
        str(args.sessionId, "sessionId"),
      ),
    }),
    ready_work: async (identity, args) => ({
      issues: await service.readyWork(
        { kind: "agent", identity },
        str(args.projectId, "projectId"),
        args.filter === undefined ? undefined : ReadyWorkFilter.parse(args.filter),
      ),
    }),
  };

  for (const tool of sessionTools) {
    if (!(tool.name in strategies)) throw new Error(`no strategy for MCP tool ${tool.name}`);
  }

  return (server: McpServer, request: Request): void => {
    for (const tool of sessionTools) {
      const strategy = strategies[tool.name];
      if (strategy === undefined) continue;
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          outputSchema: tool.output,
        },
        async (rawArgs) => {
          try {
            const identity = await authenticate(request);
            if (identity === null) throw new SessionsError("not_signed_in");

            const parsed = tool.input.parse(rawArgs);
            assertDispatchToolAllowed(identity, tool.name, parsed);
            const result = await strategy(identity, parsed);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (isAgentError(error) || error instanceof SessionsError) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ code: error.kind, message: error.message }),
                  },
                ],
                structuredContent: { code: error.kind, message: error.message },
                isError: true,
              };
            }
            throw error;
          }
        },
      );
    }
  };
}

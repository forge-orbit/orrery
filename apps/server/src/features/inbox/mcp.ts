import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentIdentity } from "@orrery/contract";
import { questionTools } from "@orrery/contract";
import {
  assertDispatchToolAllowed,
  isAgentError,
  type AgentAuthenticator,
} from "../agents/index.ts";
import { InboxError, type InboxService } from "./service.ts";

type Args = Record<string, unknown>;

const str = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`missing ${field}`);
  return value;
};

export function createInboxMcp(service: InboxService, authenticate: AgentAuthenticator) {
  const strategies: Record<string, (identity: AgentIdentity, args: Args) => Promise<Args>> = {
    ask_for_input: async (identity, args) => ({
      question: await service.ask(
        { kind: "agent", identity },
        {
          issueId: str(args.issueId, "issueId"),
          runId: str(args.runId, "runId"),
          question: str(args.question, "question"),
          proposedFallback: str(args.proposedFallback, "proposedFallback"),
        },
      ),
    }),
    list_issue_questions: async (identity, args) => ({
      questions: await service.issueHistory(
        { kind: "agent", identity },
        str(args.issueId, "issueId"),
      ),
    }),
  };

  for (const tool of questionTools) {
    if (!(tool.name in strategies)) throw new Error(`no strategy for MCP tool ${tool.name}`);
  }

  return (server: McpServer, request: Request): void => {
    for (const tool of questionTools) {
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
            if (identity === null) throw new InboxError("not_signed_in");
            const parsed = tool.input.parse(rawArgs);
            assertDispatchToolAllowed(identity, tool.name, parsed);
            const result = await strategy(identity, parsed);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (isAgentError(error) || error instanceof InboxError) {
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

import type { McpServer } from "@modelcontextprotocol/server";
import { RunReportInput, runTools } from "@orrery/contract";
import {
  assertDispatchToolAllowed,
  isAgentError,
  type AgentAuthenticator,
} from "../agents/index.ts";
import { RunsError, type RunsService } from "./service.ts";

export function createRunsMcp(service: RunsService, authenticate: AgentAuthenticator) {
  return (server: McpServer, request: Request): void => {
    for (const tool of runTools) {
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
            const parsed = RunReportInput.parse(rawArgs);
            if (identity !== null) assertDispatchToolAllowed(identity, tool.name, parsed);
            const result = await service.report(identity, parsed);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            if (isAgentError(error) || error instanceof RunsError) {
              const code = error.kind;
              const message = error.message;
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }],
                structuredContent: { code, message },
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

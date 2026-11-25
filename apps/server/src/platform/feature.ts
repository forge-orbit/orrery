import type { OpenAPIHono } from "@hono/zod-openapi";
import type { McpServer } from "@modelcontextprotocol/server";

export interface Feature {
  name: string;

  rest?: OpenAPIHono;

  registerTools?: (server: McpServer, request: Request) => void;

  startBackgroundTasks?: () => void;

  stop?: () => void | Promise<void>;
}

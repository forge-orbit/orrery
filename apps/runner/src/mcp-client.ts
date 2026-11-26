/**
 * A deliberately small, dependency-free MCP client for the Runner's own
 * reliability calls (renew the lease, report worktree state, stop the
 * session). The ACP agent gets its own ephemeral MCP configuration via
 * `ephemeralMcpConfig`; the Runner speaks to the same stateless `/mcp`
 * endpoint over HTTP using JSON-RPC 2.0.
 */
export class McpAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "McpAuthError";
    this.status = status;
  }
}

export class McpToolError extends Error {
  readonly tool: string;
  constructor(tool: string, message: string) {
    super(message);
    this.name = "McpToolError";
    this.tool = tool;
  }
}

type RpcMessage = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
};

/** Narrow an untrusted JSON value to the few RPC fields the client uses. */
function asRpcMessage(value: unknown): RpcMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = Object.fromEntries(Object.entries(value));
  const message: RpcMessage = {};
  if (typeof record.id === "number") message.id = record.id;
  if (typeof record.method === "string") message.method = record.method;
  if (Object.hasOwn(record, "result")) message.result = record.result;
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const fields = Object.fromEntries(Object.entries(error));
    message.error = {
      ...(typeof fields.code === "number" ? { code: fields.code } : {}),
      ...(typeof fields.message === "string" ? { message: fields.message } : {}),
    };
  }
  return message;
}

const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = Reflect.get(value, "text");
    if (typeof text === "string") return text;
  }
  return "";
};

/** Decode either a JSON body or an SSE stream of JSON-RPC messages. */
function messagesFrom(body: string, contentType: string | null): RpcMessage[] {
  const messages: RpcMessage[] = [];
  if (contentType?.includes("text/event-stream") === true) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "") continue;
      try {
        const parsed: unknown = JSON.parse(payload);
        const message = asRpcMessage(parsed);
        if (message !== undefined) messages.push(message);
      } catch {
        // Ignore keep-alive comments and malformed frames.
      }
    }
    return messages;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const values: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const value of values) {
      const message = asRpcMessage(value);
      if (message !== undefined) messages.push(message);
    }
  } catch {
    // A malformed body yields no messages and surfaces as a protocol error.
  }
  return messages;
}

export interface RunnerMcpClientOptions {
  server: string;
  token: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export class RunnerMcpClient {
  readonly server: string;
  private readonly token: string;
  private readonly signal: AbortSignal | undefined;
  private readonly timeoutMs: number;
  private nextId = 1;
  private initialized = false;

  constructor(options: RunnerMcpClientOptions) {
    this.server = options.server.replace(/\/$/, "");
    this.token = options.token;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async rawPost(message: Record<string, unknown>): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.server}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(message),
        signal:
          this.signal === undefined
            ? AbortSignal.timeout(this.timeoutMs)
            : AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
    } catch (error) {
      throw new Error(`Cannot reach Orrery MCP at ${this.server}: ${String(error)}`, {
        cause: error,
      });
    }
    if (response.status === 401 || response.status === 403) {
      const body = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new McpAuthError(
        response.status,
        body === ""
          ? `Orrery rejected the Dispatch token (${response.status}).`
          : `Orrery rejected the Dispatch token (${response.status}): ${body}`,
      );
    }
    if (!response.ok) {
      throw new Error(`Orrery MCP returned ${response.status}: ${await response.text()}`);
    }
    return response;
  }

  private async post(message: Record<string, unknown>): Promise<RpcMessage> {
    const id = typeof message.id === "number" ? message.id : -1;
    const response = await this.rawPost(message);
    const messages = messagesFrom(await response.text(), response.headers.get("content-type"));
    const reply = messages.find((candidate) => candidate.id === id);
    if (reply === undefined) throw new Error(`Orrery MCP did not reply to request ${id}.`);
    if (reply.error !== undefined) {
      throw new Error(
        `Orrery MCP error ${reply.error.code ?? "unknown"}: ${reply.error.message ?? "unknown"}`,
      );
    }
    return reply;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "orrery-runner", version: "1" },
      },
    });
    await this.rawPost({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.initialize();
    const reply = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = reply.result;
    if (typeof result !== "object" || result === null) {
      throw new Error(`Orrery MCP tool ${name} returned no result.`);
    }
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(result));
    if (record.isError === true) {
      const content = Array.isArray(record.content) ? record.content.map(textOf).join("\n") : "";
      throw new McpToolError(name, content || `Orrery MCP tool ${name} failed.`);
    }
    const structured = record.structuredContent;
    if (typeof structured === "object" && structured !== null) {
      return Object.fromEntries(Object.entries(structured));
    }
    return {};
  }
}

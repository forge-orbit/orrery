import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PermissionResponse } from "./permission.ts";
import { confinedPath, evaluatePermission, respondToPermission } from "./permission.ts";

export interface AcpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AcpStartOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string> | undefined;
  /** Ephemeral MCP servers pre-wired into the ACP session. */
  mcpServers: unknown[];
  /** Worktree realpath used for the local permission policy. */
  worktreeReal: string;
  onPermission?: ((params: unknown) => PermissionResponse) | undefined;
  onUpdate?: ((method: string, params: unknown) => void) | undefined;
  onStderr?: ((line: string) => void) | undefined;
  /** Bound each JSON-RPC request; probes always pass an explicit timeout. */
  requestTimeoutMs?: number | undefined;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** A permission request larger than this is refused without evaluating it. */
export const MAX_PERMISSION_REQUEST_BYTES = 32 * 1024;

/**
 * Newline-delimited JSON-RPC 2.0 over stdio, with the child spawned as a
 * detached process-group leader so cancellation can signal the whole tree.
 */
/**
 * Strip host-level `ORRERY_*` env vars (such as `ORRERY_RUNNER_CONFIG_DIR` or
 * deployment secrets) before spawning an ACP agent, exposing only the explicit
 * dispatch-scoped variables in `scopedEnv`.
 */
export function sanitizeAcpEnv(
  hostEnv: NodeJS.ProcessEnv,
  scopedEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (key.startsWith("ORRERY_")) continue;
    clean[key] = value;
  }
  return scopedEnv === undefined ? clean : { ...clean, ...scopedEnv };
}

export class AcpStdioClient {
  readonly pid: number;
  readonly exited: Promise<AcpExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly worktreeReal: string;
  private readonly onPermission: (params: unknown) => PermissionResponse;
  private readonly onUpdate: (method: string, params: unknown) => void;
  private readonly onStderr: (line: string) => void;
  private readonly requestTimeoutMs: number | undefined;
  private nextId = 1;
  private sessionId = "";
  private buffer = "";
  private stderrBuffer = "";
  private spawnError: Error | undefined;
  private exitValue: AcpExit | undefined;
  cancelSent = false;
  termSent = false;
  killSent = false;

  private constructor(child: ChildProcessWithoutNullStreams, options: AcpStartOptions) {
    this.child = child;
    this.pid = child.pid ?? -1;
    this.worktreeReal = options.worktreeReal;
    this.onPermission =
      options.onPermission ??
      ((params) => respondToPermission(params, evaluatePermission(params, options.worktreeReal)));
    this.onUpdate = options.onUpdate ?? (() => {});
    this.onStderr = options.onStderr ?? (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.exited = new Promise<AcpExit>((resolve) => {
      child.once("close", (code, signal) => {
        const exit = { code, signal };
        this.exitValue = exit;
        // An early exit must never leave initialize/session/new waiting.
        this.rejectPending(
          new Error(`ACP exited before replying (code ${code}, signal ${signal})`),
        );
        resolve(exit);
      });
    });
    child.on("error", (error) => {
      this.spawnError = error;
      this.rejectPending(error);
    });
    // A peer that closes stdin while we are writing must not crash the runner.
    child.stdin.on("error", (error) => this.onStderr(`ACP stdin: ${String(error)}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      let newline = this.stderrBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.stderrBuffer.slice(0, newline);
        this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
        if (line !== "") this.onStderr(line);
        newline = this.stderrBuffer.indexOf("\n");
      }
    });
  }

  private static spawnClient(options: AcpStartOptions): AcpStdioClient {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: sanitizeAcpEnv(process.env, options.env),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AcpStdioClient(child, options);
  }

  static async start(options: AcpStartOptions): Promise<AcpStdioClient> {
    const client = AcpStdioClient.spawnClient(options);
    try {
      await client.initializeSession(options);
      return client;
    } catch (error) {
      // Never leak a detached process group when the handshake fails.
      await client.forceExit(500);
      throw error;
    }
  }

  /**
   * One bounded discovery session. The raw `session/new` result is returned so
   * callers can read `models` and `configOptions`; the process group is always
   * torn down, including on timeout or a hung harness (ADR-0011).
   */
  static async probe(
    options: AcpStartOptions & { timeoutMs: number; sessionMeta?: Record<string, unknown> },
  ): Promise<unknown> {
    const client = AcpStdioClient.spawnClient({ ...options, requestTimeoutMs: options.timeoutMs });
    try {
      await client.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "orrery-runner", version: "1" },
          clientCapabilities: {},
        },
        options.timeoutMs,
      );
      return await client.request(
        "session/new",
        {
          cwd: options.cwd,
          mcpServers: options.mcpServers,
          ...(options.sessionMeta === undefined ? {} : options.sessionMeta),
        },
        options.timeoutMs,
      );
    } finally {
      await client.forceExit(250);
    }
  }

  private async initializeSession(options: AcpStartOptions): Promise<void> {
    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "orrery-runner", version: "1" },
      clientCapabilities: {},
    });
    const session = await this.request("session/new", {
      cwd: options.cwd,
      mcpServers: options.mcpServers,
    });
    const sessionId = asRecord(session)?.sessionId;
    this.sessionId = typeof sessionId === "string" ? sessionId : "";
  }

  get id(): string {
    return this.sessionId;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(message: Record<string, unknown>): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | undefined = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.spawnError !== undefined) return Promise.reject(this.spawnError);
    const id = this.nextId++;
    const pendingRequest = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    if (timeoutMs === undefined) return pendingRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([pendingRequest, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() !== "") this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.onStderr(`non-JSON ACP stdout: ${line}`);
      return;
    }
    const record = asRecord(message);
    if (record === undefined) return;
    const id = record.id;
    if (typeof id === "number" && record.method === undefined) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      if (record.error !== undefined) {
        const error = asRecord(record.error);
        const detail = typeof error?.message === "string" ? error.message : "error";
        pending.reject(new Error(`ACP ${detail}`));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (typeof id === "number" && typeof record.method === "string") {
      this.handleAgentRequest(id, record.method, record.params);
      return;
    }
    if (typeof record.method === "string") this.onUpdate(record.method, record.params);
  }

  private reply(id: number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private fail(id: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  }

  private handleAgentRequest(id: number, method: string, rawParams: unknown): void {
    const params = asRecord(rawParams) ?? {};
    if (method === "session/request_permission" || method === "session/requestPermission") {
      // Fail closed on oversized payloads: a huge command must never reach the
      // policy evaluator and be auto-approved by a shallow match.
      let bytes = Number.POSITIVE_INFINITY;
      try {
        bytes = Buffer.byteLength(JSON.stringify(rawParams ?? null), "utf8");
      } catch {
        bytes = Number.POSITIVE_INFINITY;
      }
      if (bytes > MAX_PERMISSION_REQUEST_BYTES) {
        this.onStderr(
          `Rejected oversized ACP permission request (${bytes} bytes > ${MAX_PERMISSION_REQUEST_BYTES}).`,
        );
        this.reply(id, { outcome: { outcome: "cancelled" } });
        return;
      }
      const decision = this.onPermission(params);
      this.reply(id, { outcome: decision.outcome });
      return;
    }
    if (method === "fs/read_text_file" || method === "fs/readTextFile") {
      const target = asRecord(params)?.path;
      const safe = typeof target === "string" ? confinedPath(target, this.worktreeReal) : undefined;
      if (safe === undefined) {
        this.fail(id, "local policy denied reading outside the worktree");
        return;
      }
      void readFile(safe, "utf8").then(
        (content) => this.reply(id, { content }),
        (error: unknown) => this.fail(id, String(error)),
      );
      return;
    }
    if (method === "fs/write_text_file" || method === "fs/writeTextFile") {
      const fields = asRecord(params);
      const target = fields?.path;
      const content = fields?.content;
      const safe = typeof target === "string" ? confinedPath(target, this.worktreeReal) : undefined;
      if (safe === undefined || typeof content !== "string") {
        this.fail(id, "local policy denied writing outside the worktree");
        return;
      }
      void mkdir(dirname(safe), { recursive: true }).then(
        () =>
          writeFile(safe, content).then(
            () => this.reply(id, {}),
            (error: unknown) => this.fail(id, String(error)),
          ),
        (error: unknown) => this.fail(id, String(error)),
      );
      return;
    }
    this.fail(id, `unsupported ACP method: ${method}`);
  }

  async prompt(text: string): Promise<unknown> {
    return await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  sendCancel(): void {
    if (this.cancelSent || this.exitValue !== undefined) return;
    this.cancelSent = true;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.exitValue !== undefined || this.pid < 1) return;
    try {
      process.kill(-this.pid, signal);
    } catch {
      try {
        process.kill(this.pid, signal);
      } catch {
        // Already gone; the close event will settle `exited`.
      }
    }
  }

  private async waitForExit(ms: number): Promise<boolean> {
    if (this.exitValue !== undefined) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([this.exited.then(() => true), timeout]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  /**
   * Send `session/cancel`, then escalate SIGTERM -> grace -> SIGKILL to the
   * whole detached process group. Resolves only once the group has exited.
   */
  async cancelAndKill(graceMs: number): Promise<AcpExit> {
    this.sendCancel();
    if (!(await this.waitForExit(graceMs))) {
      this.termSent = true;
      this.signal("SIGTERM");
      if (!(await this.waitForExit(graceMs))) {
        this.killSent = true;
        this.signal("SIGKILL");
      }
    }
    return await this.exited;
  }

  /**
   * Close stdin first so a persistent ACP agent can finish its turn and exit
   * with code 0; only then escalate to the process group.
   */
  async forceExit(graceMs: number): Promise<AcpExit> {
    if (this.child.stdin.writable) this.child.stdin.end();
    if (!(await this.waitForExit(graceMs))) {
      this.termSent = true;
      this.signal("SIGTERM");
      if (!(await this.waitForExit(graceMs))) {
        this.killSent = true;
        this.signal("SIGKILL");
      }
    }
    return await this.exited;
  }

  stderr(): string {
    return this.stderrBuffer;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

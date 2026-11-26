/**
 * Deterministic ACP stdio agent used by the Runner integration tests. It
 * speaks real newline-delimited JSON-RPC 2.0, records what it receives, and
 * follows `STUB_ACP_MODE` for its terminal behaviour. Nothing here is used by
 * the production runner.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let mode = process.env.STUB_ACP_MODE ?? "normal";
if (process.env.STUB_ACP_MODE_FILE !== undefined) {
  try {
    mode = readFileSync(process.env.STUB_ACP_MODE_FILE, "utf8").trim();
  } catch {
    // Fall back to the env mode when no test has written the mode file yet.
  }
}
const marker = process.env.STUB_ACP_MARKER ?? "";
const sleepMs = Number(process.env.STUB_ACP_SLEEP_MS ?? "0");

const record = (event: Record<string, unknown>): void => {
  if (marker !== "") appendFileSync(marker, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
};
const send = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const reply = (id: unknown, result: unknown): void => {
  send({ jsonrpc: "2.0", id, result });
};
const wait = (ms: number): Promise<void> =>
  new Promise((finish) => {
    setTimeout(finish, ms);
  });
const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : undefined;

let cancelled = false;
let sessionId = "stub-session-1";
let promptId: unknown;
let promptCount = 0;
let lastPromptText = "";
let grandchild: ReturnType<typeof spawn> | undefined;

async function callMcp(name: string, args: Record<string, unknown>): Promise<number> {
  const url = process.env.ORRERY_MCP_URL;
  const token = process.env.ORRERY_DISPATCH_TOKEN;
  if (url === undefined || token === undefined) return -1;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5100 + promptCount,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  // Streamable HTTP can send headers before the tool transaction commits.
  // Drain the body so the question is visible before the turn ends.
  await response.text();
  return response.status;
}

if (mode === "ignore-term") {
  process.on("SIGTERM", () => record({ event: "sigterm" }));
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 25)"], {
    stdio: "ignore",
    detached: false,
  });
  record({ event: "grandchild", pid: grandchild.pid ?? -1 });
}

function pendingPermission(id: unknown, label: string, fields: Record<string, unknown>): void {
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolName: "stub.edit", arguments: { label, ...fields } },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

async function onPrompt(id: unknown): Promise<void> {
  promptId = id;
  record({ event: "prompt", cwd: process.cwd() });
  if (sleepMs > 0) await wait(sleepMs);
  if (mode === "crash") {
    record({ event: "crash" });
    process.exit(7);
  }
  if (mode === "permission") {
    pendingPermission(9001, "inside", { path: join(process.cwd(), "notes.txt") });
    pendingPermission(9002, "outside", { path: join(process.cwd(), "..", "outside.txt") });
    pendingPermission(9003, "destructive", { command: "rm -rf /" });
    return;
  }
  if (mode === "stderr") {
    // A real harness writes diagnostics here; the runner must spool them as
    // owner_only raw_output before stop_session rolls the stream up.
    process.stderr.write("stub diagnostic: secret owner-only line\n");
  }
  if (mode === "dirty") {
    writeFileSync(join(process.cwd(), "notes.txt"), "agent wrote this\n");
  }
  if (mode === "unpushed") {
    writeFileSync(join(process.cwd(), "notes.txt"), "committed locally\n");
    execFileSync("git", ["add", "notes.txt"], { cwd: process.cwd() });
    execFileSync(
      "git",
      ["-c", "user.email=stub@test", "-c", "user.name=Stub", "commit", "-m", "local work"],
      {
        cwd: process.cwd(),
      },
    );
  }
  if (mode === "mentions-input") {
    // Text that merely mentions the tool name must never make the Runner park:
    // only a real question in Orrery does.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "I considered ask_for_input but decided to finish the turn instead.",
          },
        },
      },
    });
    reply(id, { stopReason: "end_turn" });
    record({ event: "end_turn" });
    await wait(20);
    process.exit(0);
  }
  if (mode === "needs-input") {
    promptCount += 1;
    record({ event: "prompt", cwd: process.cwd(), turn: promptCount, text: lastPromptText });
    if (promptCount === 1) {
      const status = await callMcp("ask_for_input", {
        issueId: process.env.ORRERY_ISSUE_ID,
        runId: process.env.ORRERY_RUN_ID,
        question: "Which migration strategy should the agent use?",
        proposedFallback: "Use the additive migration",
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            title: "ask_for_input",
            status: "completed",
          },
        },
      });
      reply(id, { stopReason: "end_turn" });
      record({ event: "asked", status, pid: process.pid });
      return;
    }
    // The follow-up arrives on this same session and worktree after the runner
    // woke from its park; finish the turn so supervision ends as review.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "resumed" },
        },
      },
    });
    reply(id, { stopReason: "end_turn" });
    record({ event: "resumed" });
    await wait(20);
    process.exit(0);
  }
  if (mode === "oversized-permission") {
    send({
      jsonrpc: "2.0",
      id: 9100,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolName: "stub.edit", arguments: { blob: "x".repeat(40 * 1024) } },
        options: [
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "once", name: "Allow", kind: "allow_once" },
        ],
      },
    });
    return;
  }
  if (mode === "self-stop") {
    const url = process.env.ORRERY_MCP_URL;
    const token = process.env.ORRERY_DISPATCH_TOKEN;
    if (url !== undefined && token !== undefined) {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4242,
          method: "tools/call",
          params: {
            name: "stop_session",
            arguments: {
              issueId: process.env.ORRERY_ISSUE_ID,
              sessionId: process.env.ORRERY_WORK_SESSION_ID,
              outcome: "review",
            },
          },
        }),
      });
    }
    record({ event: "self-stop" });
  }
  if (mode === "chunk-hang") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } },
      },
    });
    record({ event: "hanging", pid: process.pid });
    return;
  }
  if (mode === "hang" || mode === "ignore-term") {
    record({ event: "hanging", pid: process.pid });
    return;
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
    },
  });
  reply(id, { stopReason: "end_turn" });
  record({ event: "end_turn" });
  await wait(20);
  process.exit(0);
}

function handle(message: Record<string, unknown>): void {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  if (method === "initialize") {
    record({ event: "initialize" });
    reply(id, {
      protocolVersion: 1,
      agentInfo: { name: "stub-acp", version: "1" },
      agentCapabilities: {},
    });
    return;
  }
  if (method === "session/new") {
    // Catalog discovery is a separate session; keeping it out of `session/new`
    // marker events keeps dispatch supervision assertions deterministic.
    const params = recordOf(message.params);
    record({
      event: params?.orreryProbe === true ? "catalog-probe" : "session/new",
      params: message.params,
    });
    const value = params?.sessionId;
    if (typeof value === "string") sessionId = value;
    if (mode === "probe-hang") {
      // Never reply: the runner must bound the wait and kill the whole group,
      // including this detached grandchild that keeps writing a heartbeat.
      const aliveFile = process.env.STUB_ACP_ALIVE_FILE;
      if (aliveFile !== undefined) {
        const heartbeat = [
          "setInterval(()=>{try{require('fs').appendFileSync(",
          JSON.stringify(aliveFile),
          ",'alive\\n')}catch{}},50)",
        ].join("");
        grandchild = spawn(process.execPath, ["-e", heartbeat], {
          stdio: "ignore",
          detached: false,
        });
        record({ event: "grandchild", pid: grandchild.pid ?? -1 });
      }
      return;
    }
    reply(id, {
      sessionId,
      models: {
        availableModels: [
          { modelId: "stub-model-1", name: "Stub Model 1" },
          { modelId: "stub-model-2", name: "Stub Model 2" },
        ],
        currentModelId: "stub-model-1",
      },
      configOptions: [
        {
          id: "thought_level",
          name: "Thinking level",
          type: "select",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
          currentValue: "low",
        },
      ],
    });
    return;
  }
  if (method === "session/prompt") {
    const items = recordOf(message.params)?.prompt;
    lastPromptText = Array.isArray(items)
      ? items
          .map((item) => {
            const field = recordOf(item);
            return typeof field?.text === "string" ? field.text : "";
          })
          .join("\n")
      : "";
    void onPrompt(id);
    return;
  }
  if (method === "session/cancel") {
    cancelled = true;
    record({ event: "cancel" });
    if (mode === "hang" || mode === "ignore-term") {
      if (mode === "hang") process.exit(0);
      return;
    }
    reply(id, {});
    return;
  }
  if (typeof id === "number" && method === "") {
    // A response to one of our permission requests.
    const result = recordOf(message.result);
    const outcome = recordOf(result?.outcome);
    const value = typeof outcome?.outcome === "string" ? outcome.outcome : "unknown";
    const optionId = typeof outcome?.optionId === "string" ? outcome.optionId : undefined;
    record({ event: "permission_result", id, outcome: value, optionId });
    if (id === 9003 || id === 9100) {
      reply(promptId, { stopReason: "end_turn" });
      record({ event: "end_turn" });
      void wait(20).then(() => process.exit(0));
    }
    return;
  }
  if (method !== "") {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported ${method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null)
          handle(Object.fromEntries(Object.entries(parsed)));
      } catch {
        // Ignore malformed input; the runner only sends ACP messages.
      }
    }
    newline = buffer.indexOf("\n");
  }
});

setInterval(() => {
  if (cancelled && mode === "ignore-term" && grandchild !== undefined && marker !== "") {
    record({ event: "still-alive", pid: process.pid });
  }
}, 100).unref();

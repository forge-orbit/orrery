import type { AgentIdentity } from "@orrery/contract";

export type AgentAuthenticator = (request: Request) => Promise<AgentIdentity | null>;

export function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  return /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? null;
}

export function isAgentError(error: unknown): error is Error & { kind: string } {
  return error instanceof Error && error.name === "AgentsError" && "kind" in error;
}

/** Dispatch-scope violations are refusals (403); credential failures are 401. */
export function agentErrorStatus(kind: string): 401 | 403 {
  return kind === "dispatch_forbidden" ? 403 : 401;
}

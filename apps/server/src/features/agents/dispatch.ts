import type { AgentIdentity } from "@orrery/contract";
import { AgentsError } from "./service.ts";

/**
 * A Dispatch token is a single-issue credential. This is the one allowlist
 * shared by every MCP tool and every agent-authenticated REST endpoint; the
 * white list is deliberate — a new tool or route is refused until it is
 * explicitly reviewed here.
 */
const dispatchTools = new Set([
  // Reads scoped to the dispatched issue or its own project.
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
  // Writes on the dispatched issue / its own project.
  "update_issue",
  "create_comment",
  "add_issue_link",
  "create_knowledge",
  "update_knowledge",
  "log_session_activity",
  "report_progress",
  "ask_for_input",
  "stop_session",
]);

export interface DispatchTarget {
  issueId?: string;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  outcome?: string;
}

function refuse(): never {
  throw new AgentsError("dispatch_forbidden");
}

function checkTarget(identity: AgentIdentity, target: DispatchTarget): void {
  const scope = identity.dispatchScope;
  if (scope === undefined) return;
  if (target.issueId !== undefined && target.issueId !== scope.issueId) refuse();
  if (target.projectId !== undefined && target.projectId !== scope.projectId) refuse();
  if (target.sessionId !== undefined && target.sessionId !== scope.workSessionId) refuse();
  if (target.runId !== undefined && target.runId !== scope.runId) refuse();
  if (
    target.outcome !== undefined &&
    target.outcome !== "review" &&
    target.outcome !== "completed" &&
    target.outcome !== "released"
  ) {
    refuse();
  }
}

/** MCP gate: called with the tool name and its parsed arguments. */
export function assertDispatchToolAllowed(
  identity: AgentIdentity,
  tool: string,
  args: Record<string, unknown>,
): void {
  if (identity.dispatchScope === undefined) return;
  if (!dispatchTools.has(tool)) refuse();
  const str = (key: string) => (typeof args[key] === "string" ? args[key] : undefined);
  const target: DispatchTarget = {};
  const issueId = str("issueId");
  const projectId = str("projectId");
  const sessionId = str("sessionId");
  const runId = str("runId");
  const outcome = str("outcome");
  if (issueId !== undefined) target.issueId = issueId;
  if (projectId !== undefined) target.projectId = projectId;
  if (sessionId !== undefined) target.sessionId = sessionId;
  if (runId !== undefined) target.runId = runId;
  if (outcome !== undefined) target.outcome = outcome;
  checkTarget(identity, target);
}

/** Body/param fence for REST handlers: every supplied id must be the scoped one. */
export function assertDispatchBodyAllowed(identity: AgentIdentity, target: DispatchTarget): void {
  if (identity.dispatchScope === undefined) return;
  checkTarget(identity, target);
}

type RestRule = { method: string; pattern: RegExp };

const issue = "(?<issueId>[^/]+)";
const project = "(?<projectId>[^/]+)";
const session = "(?<sessionId>[^/]+)";

/** REST gate: only these exact method/path pairs are reachable with a token. */
const dispatchRestRules: readonly RestRule[] = [
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}$`) },
  { method: "PATCH", pattern: new RegExp(`^/api/issues/${issue}$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/blocked-by$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/blocking$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/comments$`) },
  { method: "POST", pattern: new RegExp(`^/api/issues/${issue}/comments$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/links$`) },
  { method: "POST", pattern: new RegExp(`^/api/issues/${issue}/links$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/questions$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/work-sessions$`) },
  { method: "GET", pattern: new RegExp(`^/api/issues/${issue}/work-sessions/all$`) },
  {
    method: "POST",
    pattern: new RegExp(`^/api/issues/${issue}/work-sessions/activities$`),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/issues/${issue}/work-sessions/${session}/activities$`),
  },
  { method: "POST", pattern: new RegExp(`^/api/issues/${issue}/work-sessions/renew$`) },
  { method: "POST", pattern: new RegExp(`^/api/issues/${issue}/work-sessions/progress$`) },
  { method: "POST", pattern: new RegExp(`^/api/issues/${issue}/work-sessions/resume$`) },
  { method: "POST", pattern: new RegExp(`^/api/issues/${issue}/work-sessions/stop$`) },
  { method: "GET", pattern: new RegExp(`^/api/projects/${project}$`) },
  { method: "GET", pattern: new RegExp(`^/api/projects/${project}/knowledge$`) },
  { method: "POST", pattern: new RegExp(`^/api/projects/${project}/knowledge$`) },
  { method: "GET", pattern: new RegExp(`^/api/projects/${project}/labels$`) },
  { method: "GET", pattern: new RegExp(`^/api/projects/${project}/attachments$`) },
  { method: "POST", pattern: new RegExp(`^/api/projects/${project}/attachments$`) },
  { method: "GET", pattern: new RegExp(`^/api/projects/${project}/attachments/[^/]+$`) },
  { method: "GET", pattern: /^\/api\/knowledge\/[^/]+$/ },
  { method: "PATCH", pattern: /^\/api\/knowledge\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/questions$/ },
];

export function assertDispatchRestAllowed(
  identity: AgentIdentity,
  method: string,
  path: string,
): void {
  if (identity.dispatchScope === undefined) return;
  for (const rule of dispatchRestRules) {
    if (rule.method !== method.toUpperCase()) continue;
    // Rules without named groups still match an allowed route; an empty target
    // means "no id in the path to fence" (e.g. POST /api/questions).
    const match = rule.pattern.exec(path);
    if (match === null) continue;
    const groups = match.groups;
    const target: DispatchTarget = {};
    for (const key of ["issueId", "projectId", "sessionId", "runId", "outcome"] as const) {
      const value = groups?.[key];
      if (typeof value === "string") target[key] = value;
    }
    checkTarget(identity, target);
    return;
  }
  refuse();
}

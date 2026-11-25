import { randomUUID } from "node:crypto";
import {
  ProjectAccessLevel,
  ProjectActivityType,
  WorkSessionStatus,
  type ActiveWorkSession,
  type AgentIdentity,
  type AssigneeType,
  type Issue,
  type ReadyWorkFilter,
  type ReacquireWorkSessionInput,
  type ResumeDisposition,
  type ResumeWorkSessionInput,
  type ResumeWorkSessionResult,
  type LogSessionActivityInput,
  type SessionActivity,
  type SessionTelemetry,
  type StopOutcome,
  type WorkCompletionOutcome,
  type WorkSession,
  type WorkSessionOutcome,
} from "@orrery/contract";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgInsertValue } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import type { Logger } from "../../platform/log.ts";
import {
  agents,
  humans,
  issueDependencies,
  issues,
  projectActivity,
  projects,
  runs,
  workSessionActivities,
  workSessions,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { NotifyActivity } from "../notifications/index.ts";
import type { EnqueueIssueCommand } from "../runners/index.ts";
import type { EnqueueWebhookActivity } from "../webhooks/index.ts";
import { ProjectsError, type WorkActor } from "../projects/index.ts";
import { decideReacquire, resumeDispositionFor, workSessionMachine } from "./state-machine.ts";

export type SessionsErrorKind =
  | "not_signed_in"
  | "issue_not_found"
  | "project_not_found"
  | "run_not_found"
  | "insufficient_access"
  | "issue_claimed"
  | "issue_needs_input"
  | "issue_blocked"
  | "session_required"
  | "human_sign_in_required"
  | "agents_cannot_request_stop"
  | "session_not_active"
  | "session_not_found"
  | "issue_assigned_to_human"
  | "issue_assigned_to_other_agent";

const messages: Record<SessionsErrorKind, string> = {
  not_signed_in: "An agent key is required.",
  issue_not_found: "No such issue is in scope for this agent.",
  project_not_found: "No such project is in scope for the caller.",
  run_not_found: "No such run belongs to this agent in this workspace.",
  insufficient_access: "Contribute access is required to work on this issue.",
  issue_claimed: "Another worker holds the active session for this issue.",
  issue_needs_input: "This issue needs human input and cannot be claimed yet.",
  issue_blocked:
    "This issue is not ready work (todo) or is paused for input, so it cannot be claimed or reacquired.",
  session_required: "This agent holds no live session for this issue.",
  human_sign_in_required: "Sign in as a human to request a stop.",
  agents_cannot_request_stop: "Only a human with Contribute or Manage access may request a stop.",
  session_not_active: "The work session is no longer active.",
  session_not_found: "No such work session is in scope for the caller.",
  issue_assigned_to_human: "This issue is assigned to a human and cannot be claimed by an agent.",
  issue_assigned_to_other_agent: "This issue is assigned to another agent and cannot be claimed.",
};

export class SessionsError extends Error {
  readonly kind: SessionsErrorKind;

  constructor(kind: SessionsErrorKind) {
    super(messages[kind]);
    this.name = "SessionsError";
    this.kind = kind;
  }
}

const blockerIssue = alias(issues, "blocker_issue");

export type SessionsProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export type SessionsProjectAccessAtLeast = (
  actual: ProjectAccessLevel,
  required: ProjectAccessLevel,
) => boolean;

export interface SessionsDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: SessionsProjectAccessCeiling;
  projectAccessAtLeast: SessionsProjectAccessAtLeast;

  listIssues: (actor: WorkActor, projectId: string) => Promise<Issue[]>;

  questionLeaseDeadline?:
    | ((tx: DbTransaction, issueId: string) => Promise<Date | null>)
    | undefined;
  evaluateQuestionDeadline?: ((tx: DbTransaction, issueId: string) => Promise<void>) | undefined;
  /** Due-question discovery stays in the inbox feature; work-sessions never queries questions. */
  dueQuestionIssueIds?: (() => Promise<string[]>) | undefined;
  notifyActivity?: NotifyActivity | undefined;
  onActivity?: EnqueueWebhookActivity | undefined;
  onRunnerCommand?: EnqueueIssueCommand | undefined;
  log?: Logger | undefined;
}

export type AgentActor = { kind: "agent"; identity: AgentIdentity };

export interface SessionsService {
  claim(actor: AgentActor | null, input: { issueId: string; runId: string }): Promise<WorkSession>;

  renew(
    actor: AgentActor | null,
    issueId: string,
    sessionId?: string,
    telemetry?: SessionTelemetry,
  ): Promise<WorkSession>;
  progress(
    actor: AgentActor | null,
    issueId: string,
    summary: string,
    sessionId?: string,
    telemetry?: SessionTelemetry,
  ): Promise<WorkSession>;

  stop(
    actor: AgentActor | null,
    issueId: string,
    outcome: StopOutcome,
    sessionId?: string,
    telemetry?: SessionTelemetry,
  ): Promise<WorkSession>;

  requestStop(actor: WorkActor | null, issueId: string, reason?: string): Promise<WorkSession>;

  activeSessions(actor: WorkActor | null, workspaceId: string): Promise<ActiveWorkSession[]>;

  resume(actor: AgentActor | null, input: ResumeWorkSessionInput): Promise<ResumeWorkSessionResult>;
  reacquire(actor: AgentActor | null, input: ReacquireWorkSessionInput): Promise<WorkSession>;
  getSession(actor: WorkActor | null, issueId: string): Promise<WorkSession>;
  listSessions(actor: WorkActor | null, issueId: string): Promise<WorkSession[]>;

  logActivity(actor: AgentActor | null, input: LogSessionActivityInput): Promise<SessionActivity>;
  listActivities(
    actor: WorkActor | null,
    issueId: string,
    sessionId: string,
  ): Promise<SessionActivity[]>;

  readyWork(actor: WorkActor | null, projectId: string, filter?: ReadyWorkFilter): Promise<Issue[]>;

  agentHoldsSession(
    tx: DbTransaction,
    agentId: string,
    workspaceId: string,
    issueId: string,
  ): Promise<boolean>;

  issueHasLiveSession(tx: DbTransaction, issueId: string): Promise<boolean>;

  /** Proactively evaluates overdue claim leases and question deadlines. */
  sweep(): Promise<void>;
}

type SessionRow = typeof workSessions.$inferSelect;
export type SessionView = SessionRow & { effectiveStatus: string };

const sessionColumns = {
  id: workSessions.id,
  agentId: workSessions.agentId,
  runId: workSessions.runId,
  workspaceId: workSessions.workspaceId,
  issueId: workSessions.issueId,
  status: workSessions.status,
  effectiveStatus: sql<string>`case when ${workSessions.status} = 'active' and ${workSessions.leaseExpiresAt} <= statement_timestamp() then 'expired' else ${workSessions.status} end`,
  leaseExpiresAt: workSessions.leaseExpiresAt,
  progress: workSessions.progress,
  progressUpdatedAt: workSessions.progressUpdatedAt,
  stopRequestedAt: workSessions.stopRequestedAt,
  stopRequestedByHumanId: workSessions.stopRequestedByHumanId,
  stopReason: workSessions.stopReason,
  inputTokens: workSessions.inputTokens,
  outputTokens: workSessions.outputTokens,
  costUsdMicros: workSessions.costUsdMicros,
  createdAt: workSessions.createdAt,
  updatedAt: workSessions.updatedAt,
  endedAt: workSessions.endedAt,
};

function telemetryUpdate(
  telemetry: SessionTelemetry | undefined,
): Partial<typeof workSessions.$inferInsert> {
  const update: Partial<typeof workSessions.$inferInsert> = {};
  if (telemetry?.inputTokens !== undefined) update.inputTokens = telemetry.inputTokens;
  if (telemetry?.outputTokens !== undefined) update.outputTokens = telemetry.outputTokens;
  if (telemetry?.costUsdMicros !== undefined) update.costUsdMicros = telemetry.costUsdMicros;
  return update;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export function toSession(row: SessionView): WorkSession {
  return {
    id: row.id,
    agentId: row.agentId,
    runId: row.runId,
    workspaceId: row.workspaceId,
    issueId: row.issueId,
    status: WorkSessionStatus.parse(row.effectiveStatus ?? row.status),
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    progress: row.progress,
    progressUpdatedAt: iso(row.progressUpdatedAt),

    stopRequested: row.stopRequestedAt !== null,
    stopRequestedAt: iso(row.stopRequestedAt),
    stopReason: row.stopReason,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsdMicros: row.costUsdMicros,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: iso(row.endedAt),
  };
}

const activityColumns = {
  id: workSessionActivities.id,
  workSessionId: workSessionActivities.workSessionId,
  runId: workSessionActivities.runId,
  kind: workSessionActivities.kind,
  summary: workSessionActivities.summary,
  detail: workSessionActivities.detail,
  createdAt: workSessionActivities.createdAt,
};

type ActivityRow = typeof workSessionActivities.$inferSelect;

function toActivity(row: ActivityRow): SessionActivity {
  return {
    id: row.id,
    workSessionId: row.workSessionId,
    runId: row.runId,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function requireAgent(actor: AgentActor | null) {
  if (actor === null) throw new SessionsError("not_signed_in");
  return actor.identity;
}

function assertClaimAssignee(
  assigneeType: AssigneeType | null,
  assigneeId: string | null,
  agentId: string,
): void {
  if (assigneeType === "human") throw new SessionsError("issue_assigned_to_human");
  if (assigneeType === "agent" && assigneeId !== agentId) {
    throw new SessionsError("issue_assigned_to_other_agent");
  }
}

function assignedToActor(issue: Issue, actor: WorkActor): boolean {
  if (issue.assignee === null) return false;
  return actor.kind === "agent"
    ? issue.assignee.agentId === actor.identity.agentId
    : issue.assignee.humanId === actor.account.humanId;
}

async function humanStillHasWorkspaceAccess(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (workspace === undefined) return false;
  if (workspace.personalOwnerHumanId === humanId) return true;
  const [membership] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.humanId, humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

async function lockAgentWorkspaceAccess(tx: DbTransaction, identity: AgentIdentity): Promise<void> {
  const [owner] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, identity.humanId), isNull(humans.deactivatedAt)))
    .for("key share");
  if (owner === undefined) throw new SessionsError("insufficient_access");

  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, identity.workspaceId))
    .limit(1);
  if (workspace === undefined) throw new SessionsError("insufficient_access");
  if (workspace.personalOwnerHumanId === identity.humanId) return;
  const [membership] = await tx
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, identity.workspaceId),
        eq(workspaceMemberships.humanId, identity.humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .for("key share");
  if (membership === undefined) throw new SessionsError("insufficient_access");
}

export async function releaseMemberWorkSessions(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  const ownedAgents = tx.select({ id: agents.id }).from(agents).where(eq(agents.humanId, humanId));
  const claims = await tx
    .select({ id: workSessions.id, issueId: workSessions.issueId })
    .from(workSessions)
    .where(
      and(
        eq(workSessions.workspaceId, workspaceId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        inArray(workSessions.agentId, ownedAgents),
      ),
    );
  if (claims.length === 0) return;

  const issueIds = [...new Set(claims.map((claim) => claim.issueId))].toSorted();
  await tx
    .select({ id: issues.id })
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .orderBy(issues.id)
    .for("update");

  const claimIds = claims.map((claim) => claim.id);

  workSessionMachine.assertTransition("active", WorkSessionStatus.enum.expired);
  await tx
    .update(workSessions)
    .set({
      status: WorkSessionStatus.enum.expired,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.status, WorkSessionStatus.enum.active),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        inArray(workSessions.id, claimIds),
      ),
    );

  workSessionMachine.assertTransition("active", WorkSessionStatus.enum.released);
  await tx
    .update(workSessions)
    .set({
      status: WorkSessionStatus.enum.released,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.status, WorkSessionStatus.enum.active),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        inArray(workSessions.id, claimIds),
      ),
    );

  for (const issueId of issueIds) await revertIssueToTodo(tx, issueId);
}

export async function releaseIssueWorkSessions(
  tx: DbTransaction,
  issueId: string,
  liveOutcome: "released" | "completed" = WorkSessionStatus.enum.released,
): Promise<void> {
  workSessionMachine.assertTransition("active", WorkSessionStatus.enum.expired);
  await tx
    .update(workSessions)
    .set({
      status: WorkSessionStatus.enum.expired,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );

  workSessionMachine.assertTransition("active", liveOutcome);
  await tx
    .update(workSessions)
    .set({
      status: liveOutcome,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    );
}

async function lockIssue(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      needsInput: issues.needsInput,
      assigneeType: issues.assigneeType,
      assigneeId: issues.assigneeId,
    })
    .from(issues)

    .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
    .limit(1)
    .for("update");
  if (row === undefined) throw new SessionsError("issue_not_found");
  return row;
}

export async function revertIssueToTodo(tx: DbTransaction, issueId: string): Promise<void> {
  await tx
    .update(issues)
    .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
    .where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
}

async function expireStale(
  tx: DbTransaction,
  issueId: string,
  notify: NotifyActivity,
  onActivity: EnqueueWebhookActivity,
  knownProjectId?: string,
): Promise<void> {
  const projectId =
    knownProjectId ??
    (
      await tx
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
    )[0]?.projectId;
  const expired = await tx
    .update(workSessions)
    .set({
      status: WorkSessionStatus.enum.expired,
      endedAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
      ),
    )
    .returning({ id: workSessions.id, agentId: workSessions.agentId });

  if (expired.length > 0) await revertIssueToTodo(tx, issueId);
  if (expired.length > 0 && projectId !== undefined) {
    const activityId = randomUUID();
    const summary = "Work session expired: the five-minute claim lease lapsed";
    await tx.insert(projectActivity).values({
      id: activityId,
      projectId,
      issueId,
      type: ProjectActivityType.enum.issue_session_expired,
      actorAgentId: expired[0]!.agentId,
      summary,
      createdAt: sql`statement_timestamp()`,
    });
    await onActivity(tx, activityId);
    await notify(tx, {
      activityId,
      projectId,
      issueId,
      kind: "session_expired",
      summary,
      actorAgentId: expired[0]!.agentId,
    });
  }
}

const fiveMinutes = sql`statement_timestamp() + interval '5 minutes'`;

const liveLease = gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`);

async function findActive(tx: DbTransaction, issueId: string) {
  const [row] = await tx
    .select(sessionColumns)
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, WorkSessionStatus.enum.active),
        liveLease,
      ),
    )
    .limit(1);
  return row;
}

async function requireRun(tx: DbTransaction, identity: AgentIdentity, runId: string) {
  const [run] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.agentId, identity.agentId),
        eq(runs.workspaceId, identity.workspaceId),
      ),
    )
    .limit(1);
  if (run === undefined) throw new SessionsError("run_not_found");
  return run;
}

async function findLatestForRun(
  tx: DbTransaction,
  issueId: string,
  identity: AgentIdentity,
  runId: string,
) {
  const [row] = await tx
    .select(sessionColumns)
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.agentId, identity.agentId),
        eq(workSessions.workspaceId, identity.workspaceId),
        eq(workSessions.runId, runId),
      ),
    )
    .orderBy(desc(workSessions.createdAt), desc(workSessions.id))
    .limit(1);
  return row;
}

function isSameRun(
  session: SessionView | undefined,
  identity: AgentIdentity,
  runId: string,
): boolean {
  return (
    session !== undefined &&
    session.agentId === identity.agentId &&
    session.workspaceId === identity.workspaceId &&
    session.runId === runId
  );
}

async function insertFreshSession(
  tx: DbTransaction,
  issueId: string,
  values: PgInsertValue<typeof workSessions>,
  notify: NotifyActivity,
  onActivity: EnqueueWebhookActivity,
): Promise<SessionView | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [created] = await tx
      .insert(workSessions)
      .values(values)
      .onConflictDoNothing()
      .returning(sessionColumns);
    if (created !== undefined) return created;
    await expireStale(tx, issueId, notify, onActivity);
  }
  return undefined;
}

function requireAccessArgs(
  tx: DbTransaction,
  projectAccessCeiling: SessionsProjectAccessCeiling,
  projectAccessAtLeast: SessionsProjectAccessAtLeast,
) {
  return async (
    actor: WorkActor,
    projectId: string,
    required: ProjectAccessLevel,
    missing: "issue_not_found" | "project_not_found",
  ) => {
    const [project] = await tx
      .select({ id: projects.id, workspaceId: projects.workspaceId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (
      project === undefined ||
      (actor.kind === "agent" && project.workspaceId !== actor.identity.workspaceId)
    ) {
      throw new SessionsError(missing);
    }

    const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;

    if (!(await humanStillHasWorkspaceAccess(tx, project.workspaceId, humanId))) {
      throw new SessionsError("insufficient_access");
    }
    const ceiling = await projectAccessCeiling(tx, project.workspaceId, humanId, [projectId]);
    const humanLevel = ceiling.get(projectId) ?? null;
    let effective = humanLevel;
    if (actor.kind === "agent") {
      const keyLevel = actor.identity.projects.find(
        (grant) => grant.projectId === projectId,
      )?.level;
      if (keyLevel === undefined) throw new SessionsError(missing);
      effective =
        humanLevel === null
          ? null
          : projectAccessAtLeast(humanLevel, keyLevel)
            ? keyLevel
            : humanLevel;
    }
    if (effective === null || !projectAccessAtLeast(effective, required)) {
      throw new SessionsError("insufficient_access");
    }
    return project;
  };
}

async function requireHumanStopAccess(
  tx: DbTransaction,
  deps: Pick<SessionsDeps, "projectAccessCeiling" | "projectAccessAtLeast">,
  humanId: string,
  issueId: string,
) {
  const [issueRef] = await tx
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issueRef === undefined) throw new SessionsError("issue_not_found");
  const [projectRef] = await tx
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, issueRef.projectId))
    .limit(1);
  if (projectRef === undefined) throw new SessionsError("issue_not_found");

  const [caller] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .for("key share");
  if (caller === undefined) throw new SessionsError("issue_not_found");

  const [workspace] = await tx
    .select({ personalOwnerHumanId: workspaces.personalOwnerHumanId })
    .from(workspaces)
    .where(eq(workspaces.id, projectRef.workspaceId))
    .limit(1);
  if (workspace === undefined) throw new SessionsError("issue_not_found");
  if (workspace.personalOwnerHumanId !== humanId) {
    const [membership] = await tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, projectRef.workspaceId),
          eq(workspaceMemberships.humanId, humanId),
          isNull(workspaceMemberships.suspendedAt),
        ),
      )
      .for("key share");
    if (membership === undefined) throw new SessionsError("issue_not_found");
  }

  const issue = await lockIssue(tx, issueId);
  const ceiling = await deps.projectAccessCeiling(tx, projectRef.workspaceId, humanId, [
    issue.projectId,
  ]);
  const level = ceiling.get(issue.projectId) ?? null;
  if (level === null || !deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.contribute)) {
    throw new SessionsError("insufficient_access");
  }
  return issue;
}

async function requireActivityReadAccess(
  tx: DbTransaction,
  deps: Pick<SessionsDeps, "projectAccessCeiling" | "projectAccessAtLeast">,
  actor: WorkActor,
  issueId: string,
): Promise<void> {
  const [issue] = await tx
    .select({ projectId: issues.projectId })
    .from(issues)

    .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
    .limit(1);
  if (issue === undefined) throw new SessionsError("issue_not_found");
  const [project] = await tx
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  if (project === undefined) throw new SessionsError("issue_not_found");
  if (actor.kind === "agent" && actor.identity.workspaceId !== project.workspaceId) {
    throw new SessionsError("issue_not_found");
  }
  const humanId = actor.kind === "human" ? actor.account.humanId : actor.identity.humanId;

  const [caller] = await tx
    .select({ id: humans.id })
    .from(humans)
    .where(and(eq(humans.id, humanId), isNull(humans.deactivatedAt)))
    .limit(1);
  if (caller === undefined) throw new SessionsError("issue_not_found");
  if (!(await humanStillHasWorkspaceAccess(tx, project.workspaceId, humanId))) {
    throw new SessionsError("issue_not_found");
  }
  const ceiling = await deps.projectAccessCeiling(tx, project.workspaceId, humanId, [
    issue.projectId,
  ]);
  const humanLevel = ceiling.get(issue.projectId) ?? null;
  let level: ProjectAccessLevel | null = humanLevel;
  if (actor.kind === "agent") {
    const keyLevel = actor.identity.projects.find(
      (grant) => grant.projectId === issue.projectId,
    )?.level;
    if (keyLevel === undefined) throw new SessionsError("issue_not_found");
    level =
      humanLevel === null
        ? null
        : deps.projectAccessAtLeast(humanLevel, keyLevel)
          ? keyLevel
          : humanLevel;
  }
  if (level === null || !deps.projectAccessAtLeast(level, ProjectAccessLevel.enum.read)) {
    throw new SessionsError("issue_not_found");
  }
}

export interface ClaimInTransactionDeps {
  projectAccessCeiling: SessionsProjectAccessCeiling;
  projectAccessAtLeast: SessionsProjectAccessAtLeast;
  evaluateQuestionDeadline: (tx: DbTransaction, issueId: string) => Promise<void>;
  notifyActivity: NotifyActivity;
  onActivity: EnqueueWebhookActivity;
}

/** The exact Orrery claim rules, callable inside a caller-owned transaction. */
export async function claimInTransaction(
  tx: DbTransaction,
  identity: AgentIdentity,
  input: { issueId: string; runId: string },
  deps: ClaimInTransactionDeps,
): Promise<WorkSession> {
  await lockAgentWorkspaceAccess(tx, identity);
  const requireAccess = requireAccessArgs(tx, deps.projectAccessCeiling, deps.projectAccessAtLeast);
  const issue = await lockIssue(tx, input.issueId);
  await expireStale(tx, issue.id, deps.notifyActivity, deps.onActivity);
  await deps.evaluateQuestionDeadline(tx, issue.id);

  const [fresh] = await tx
    .select({ status: issues.status, needsInput: issues.needsInput })
    .from(issues)
    .where(eq(issues.id, issue.id))
    .limit(1);
  await requireAccess(
    { kind: "agent", identity },
    issue.projectId,
    ProjectAccessLevel.enum.contribute,
    "issue_not_found",
  );

  await requireRun(tx, identity, input.runId);
  assertClaimAssignee(issue.assigneeType, issue.assigneeId, identity.agentId);

  const existing = await findActive(tx, issue.id);
  if (existing !== undefined) {
    if (isSameRun(existing, identity, input.runId)) return toSession(existing);
    throw new SessionsError("issue_claimed");
  }

  if (fresh?.needsInput ?? false) throw new SessionsError("issue_needs_input");
  if (fresh?.status !== "todo") throw new SessionsError("issue_blocked");

  const created = await insertFreshSession(
    tx,
    issue.id,
    {
      id: randomUUID(),
      agentId: identity.agentId,
      runId: input.runId,
      workspaceId: identity.workspaceId,
      issueId: issue.id,
      status: WorkSessionStatus.enum.active,
      leaseExpiresAt: fiveMinutes,
      createdAt: sql`statement_timestamp()`,
      updatedAt: sql`statement_timestamp()`,
    },
    deps.notifyActivity,
    deps.onActivity,
  );
  if (created !== undefined) {
    await tx
      .update(issues)
      .set({ status: "in_progress", updatedAt: sql`statement_timestamp()` })
      .where(and(eq(issues.id, issue.id), eq(issues.status, "todo")));
    return toSession(created);
  }
  throw new SessionsError("issue_claimed");
}

export function createSessionsService({
  db,
  projectAccessCeiling,
  projectAccessAtLeast,
  listIssues,
  questionLeaseDeadline,
  evaluateQuestionDeadline,
  dueQuestionIssueIds: dueQuestionIssueIdsDep,
  notifyActivity: notifyActivityDep,
  onActivity = async () => {},
  onRunnerCommand,
  log,
}: SessionsDeps): SessionsService {
  const leaseDeadline = questionLeaseDeadline ?? (async () => null);
  const checkDeadline = evaluateQuestionDeadline ?? (async () => {});
  const dueQuestionIssueIds = dueQuestionIssueIdsDep ?? (async () => []);
  const notifyActivity: NotifyActivity = notifyActivityDep ?? (async () => {});

  // Only lock the issue when an expired lease actually exists (matching
  // deadlineCommitted and expireCommittedForProject), and lock issues before
  // work sessions so expireStale cannot invert lock order and deadlock against
  // a concurrent claim.
  const expireCommitted = async (issueId: string) => {
    const [stale] = await db
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(
        and(
          eq(workSessions.issueId, issueId),
          eq(workSessions.status, WorkSessionStatus.enum.active),
          lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        ),
      )
      .limit(1);
    if (stale === undefined) return;
    await db.transaction(async (tx) => {
      await lockIssue(tx, issueId);
      await expireStale(tx, issueId, notifyActivity, onActivity);
    });
  };

  const deadlineCommitted = async (issueId: string) => {
    if (evaluateQuestionDeadline === undefined) return;
    const deadline = await db.transaction((tx) => leaseDeadline(tx, issueId), {
      accessMode: "read only",
    });
    if (deadline === null) return;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
        .for("update");
      if (row === undefined) return;
      await checkDeadline(tx, issueId);
    });
  };

  const expireCommittedForProject = async (projectId: string) => {
    await db.transaction(async (tx) => {
      const stale = await tx
        .select({ issueId: workSessions.issueId })
        .from(workSessions)
        .innerJoin(issues, eq(workSessions.issueId, issues.id))
        .where(
          and(
            eq(issues.projectId, projectId),
            eq(workSessions.status, WorkSessionStatus.enum.active),
            lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
          ),
        );
      const issueIds = [...new Set(stale.map((row) => row.issueId))].toSorted();
      if (issueIds.length === 0) return;
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(inArray(issues.id, issueIds))
        .orderBy(issues.id)
        .for("update");

      for (const issueId of issueIds) {
        await expireStale(tx, issueId, notifyActivity, onActivity, projectId);
      }
    });
  };

  const withLiveSession = async <T>(
    actor: AgentActor | null,
    issueId: string,
    sessionId: string | undefined,
    write: (
      tx: DbTransaction,
      session: SessionView,
      issue: { id: string; projectId: string },
    ) => Promise<T | undefined>,
  ): Promise<T> => {
    const identity = requireAgent(actor);
    await deadlineCommitted(issueId);
    await expireCommitted(issueId);
    return db.transaction(async (tx) => {
      await lockAgentWorkspaceAccess(tx, identity);
      const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
      const issue = await lockIssue(tx, issueId);
      await expireStale(tx, issue.id, notifyActivity, onActivity);

      await checkDeadline(tx, issue.id);
      await requireAccess(
        { kind: "agent", identity },
        issue.projectId,
        ProjectAccessLevel.enum.contribute,
        "issue_not_found",
      );
      const [session] = await tx
        .select(sessionColumns)
        .from(workSessions)
        .where(
          and(
            eq(workSessions.issueId, issue.id),
            eq(workSessions.agentId, identity.agentId),
            eq(workSessions.workspaceId, identity.workspaceId),
            eq(workSessions.status, WorkSessionStatus.enum.active),
            liveLease,

            ...(sessionId === undefined ? [] : [eq(workSessions.id, sessionId)]),
          ),
        )
        .limit(1);

      if (session === undefined) throw new SessionsError("session_required");
      const result = await write(tx, session, issue);
      if (result === undefined) throw new SessionsError("session_required");
      return result;
    });
  };

  return {
    async claim(actor, input) {
      const identity = requireAgent(actor);
      await deadlineCommitted(input.issueId);
      await expireCommitted(input.issueId);
      return db.transaction((tx) =>
        claimInTransaction(tx, identity, input, {
          projectAccessCeiling,
          projectAccessAtLeast,
          evaluateQuestionDeadline: checkDeadline,
          notifyActivity,
          onActivity,
        }),
      );
    },

    async renew(actor, issueId, sessionId, telemetry) {
      return withLiveSession(actor, issueId, sessionId, async (tx, session, issue) => {
        const deadline = await leaseDeadline(tx, issue.id);
        const lease =
          deadline === null
            ? fiveMinutes
            : sql`least(statement_timestamp() + interval '5 minutes', ${deadline.toISOString()}::timestamptz)`;
        const [updated] = await tx
          .update(workSessions)
          .set({
            leaseExpiresAt: lease,
            updatedAt: sql`statement_timestamp()`,
            ...telemetryUpdate(telemetry),
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        return updated === undefined ? undefined : toSession(updated);
      });
    },

    async progress(actor, issueId, summary, sessionId, telemetry) {
      return withLiveSession(actor, issueId, sessionId, async (tx, session) => {
        const [updated] = await tx
          .update(workSessions)
          .set({
            progress: summary,
            progressUpdatedAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
            ...telemetryUpdate(telemetry),
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        return updated === undefined ? undefined : toSession(updated);
      });
    },

    async stop(actor, issueId, outcome, sessionId, telemetry) {
      const sessionOutcome: WorkSessionOutcome =
        outcome === "released" ? WorkSessionStatus.enum.released : WorkSessionStatus.enum.completed;
      const issueOutcome: WorkCompletionOutcome | null =
        outcome === "released" ? null : outcome === "done" ? "done" : "review";
      const nextStatus = workSessionMachine.assertTransition("active", sessionOutcome);
      return withLiveSession(actor, issueId, sessionId, async (tx, session, issue) => {
        if (issueOutcome !== null) {
          const [fresh] = await tx
            .select({ status: issues.status, needsInput: issues.needsInput })
            .from(issues)
            .where(eq(issues.id, issue.id))
            .limit(1);
          if (fresh?.needsInput ?? false) throw new SessionsError("issue_needs_input");
          if (fresh?.status !== "in_progress") throw new SessionsError("issue_blocked");
        }

        const [updated] = await tx
          .update(workSessions)
          .set({
            status: nextStatus,
            endedAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
            ...telemetryUpdate(telemetry),
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        if (updated === undefined) return undefined;

        if (issueOutcome === null) {
          await revertIssueToTodo(tx, issue.id);
          return toSession(updated);
        }

        const done = issueOutcome === "done";
        await tx
          .update(issues)
          .set({
            status: done ? "done" : "review",
            closedAt: done ? sql`statement_timestamp()` : null,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(eq(issues.id, issue.id));
        const activityId = randomUUID();
        await tx.insert(projectActivity).values({
          id: activityId,
          projectId: issue.projectId,
          issueId: issue.id,
          type: done
            ? ProjectActivityType.enum.issue_closed
            : ProjectActivityType.enum.issue_review_handoff,
          actorAgentId: session.agentId,
          summary: done ? "Work completed and issue closed" : "Work handed off for review",
          createdAt: sql`statement_timestamp()`,
        });
        await onActivity(tx, activityId);
        if (!done) {
          await notifyActivity(tx, {
            activityId,
            projectId: issue.projectId,
            issueId: issue.id,
            kind: "handoff",
            summary: "Work handed off for review",
            actorAgentId: session.agentId,
          });
        }
        return toSession(updated);
      });
    },

    async logActivity(actor, input) {
      return withLiveSession(actor, input.issueId, input.sessionId, async (tx, session) => {
        const [row] = await tx
          .insert(workSessionActivities)
          .values({
            id: randomUUID(),
            workSessionId: session.id,
            runId: session.runId,
            kind: input.kind,
            summary: input.summary,
            detail: input.detail ?? null,
            createdAt: sql`statement_timestamp()`,
          })
          .returning(activityColumns);
        return row === undefined ? undefined : toActivity(row);
      });
    },

    async requestStop(actor, issueId, reason) {
      if (actor === null) throw new SessionsError("human_sign_in_required");
      if (actor.kind === "agent") throw new SessionsError("agents_cannot_request_stop");
      const humanId = actor.account.humanId;
      const normalized = reason?.trim() === "" ? undefined : reason?.trim();

      const outcome = await db.transaction(async (tx) => {
        const issue = await requireHumanStopAccess(
          tx,
          { projectAccessCeiling, projectAccessAtLeast },
          humanId,
          issueId,
        );
        await expireStale(tx, issue.id, notifyActivity, onActivity);

        const [session] = await tx
          .select(sessionColumns)
          .from(workSessions)
          .where(
            and(
              eq(workSessions.issueId, issue.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .limit(1);
        if (session === undefined) return { error: "session_not_active" as const };

        if (session.stopRequestedAt !== null) return { session: toSession(session) };

        const [updated] = await tx
          .update(workSessions)
          .set({
            stopRequestedAt: sql`statement_timestamp()`,
            stopRequestedByHumanId: humanId,
            stopReason: normalized ?? null,
            updatedAt: sql`statement_timestamp()`,
          })
          .where(
            and(
              eq(workSessions.id, session.id),
              eq(workSessions.status, WorkSessionStatus.enum.active),
              liveLease,
            ),
          )
          .returning(sessionColumns);
        if (updated === undefined) return { error: "session_not_active" as const };

        const activityId = randomUUID();
        await tx.insert(projectActivity).values({
          id: activityId,
          projectId: issue.projectId,
          type: ProjectActivityType.enum.issue_stop_requested,
          issueId: issue.id,
          actorHumanId: humanId,
          summary: normalized ?? "Stop requested",
          createdAt: sql`statement_timestamp()`,
        });
        await onActivity(tx, activityId);

        // Any project contributor/manager may stop an agent, even without
        // owning the Runner host. The cancel command is enqueued in this very
        // transaction, so the stop record and the command commit together.
        await onRunnerCommand?.(tx, {
          issueId: issue.id,
          kind: "cancel",
          reason: normalized ?? "stop_requested",
        });
        return { session: toSession(updated) };
      });
      if ("error" in outcome) throw new SessionsError(outcome.error);
      return outcome.session;
    },

    async activeSessions(actor, workspaceId) {
      const caller = requireActor(actor);

      return db.transaction(
        async (tx) => {
          let projectIds: string[];
          if (caller.kind === "agent") {
            if (caller.identity.workspaceId !== workspaceId) return [];
            const ceiling = await projectAccessCeiling(
              tx,
              workspaceId,
              caller.identity.humanId,
              caller.identity.projects.map((grant) => grant.projectId),
            );
            projectIds = caller.identity.projects
              .filter((grant) => projectAccessAtLeast(grant.level, ProjectAccessLevel.enum.read))
              .filter((grant) => {
                const current = ceiling.get(grant.projectId);
                return (
                  current !== null &&
                  current !== undefined &&
                  projectAccessAtLeast(current, ProjectAccessLevel.enum.read)
                );
              })
              .map((grant) => grant.projectId);
          } else {
            if (!(await humanStillHasWorkspaceAccess(tx, workspaceId, caller.account.humanId))) {
              return [];
            }
            const rows = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.workspaceId, workspaceId));
            if (rows.length === 0) return [];
            const ceiling = await projectAccessCeiling(
              tx,
              workspaceId,
              caller.account.humanId,
              rows.map((row) => row.id),
            );
            projectIds = rows
              .filter((row) => {
                const level = ceiling.get(row.id);
                return (
                  level !== null &&
                  level !== undefined &&
                  projectAccessAtLeast(level, ProjectAccessLevel.enum.read)
                );
              })
              .map((row) => row.id);
          }
          if (projectIds.length === 0) return [];
          const rows = await tx
            .select({ ...sessionColumns, projectId: issues.projectId })
            .from(workSessions)
            .innerJoin(issues, eq(workSessions.issueId, issues.id))
            .where(
              and(
                eq(workSessions.workspaceId, workspaceId),
                eq(workSessions.status, WorkSessionStatus.enum.active),
                liveLease,
                inArray(issues.projectId, projectIds),
              ),
            )
            .orderBy(desc(workSessions.createdAt));
          return rows.map((row) => Object.assign(toSession(row), { projectId: row.projectId }));
        },
        { accessMode: "read only" },
      );
    },

    async resume(actor, input) {
      const identity = requireAgent(actor);

      return db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(and(eq(issues.id, input.issueId), isNull(issues.deletedAt)))
            .limit(1);
          if (issue === undefined) throw new SessionsError("issue_not_found");
          await requireAccess(
            { kind: "agent", identity },
            issue.projectId,
            ProjectAccessLevel.enum.read,
            "issue_not_found",
          );
          await requireRun(tx, identity, input.runId);

          const row = await findLatestForRun(tx, input.issueId, identity, input.runId);
          if (row === undefined) {
            return {
              runId: input.runId,
              issueId: input.issueId,
              disposition: "none" as const satisfies ResumeDisposition,
              session: null,
            };
          }

          const effective = WorkSessionStatus.parse(row.effectiveStatus ?? row.status);
          const disposition: ResumeDisposition = resumeDispositionFor(effective);
          return {
            runId: input.runId,
            issueId: input.issueId,
            disposition,
            session: toSession(row),
          };
        },
        { accessMode: "read only" },
      );
    },

    async reacquire(actor, input) {
      const identity = requireAgent(actor);

      await deadlineCommitted(input.issueId);
      await expireCommitted(input.issueId);
      return db.transaction(async (tx) => {
        await lockAgentWorkspaceAccess(tx, identity);
        const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
        const issue = await lockIssue(tx, input.issueId);
        await expireStale(tx, issue.id, notifyActivity, onActivity);
        await checkDeadline(tx, issue.id);

        const [fresh] = await tx
          .select({ status: issues.status, needsInput: issues.needsInput })
          .from(issues)
          .where(eq(issues.id, issue.id))
          .limit(1);
        await requireAccess(
          { kind: "agent", identity },
          issue.projectId,
          ProjectAccessLevel.enum.contribute,
          "issue_not_found",
        );
        await requireRun(tx, identity, input.runId);

        assertClaimAssignee(issue.assigneeType, issue.assigneeId, identity.agentId);

        const active = await findActive(tx, issue.id);
        if (active !== undefined) {
          if (isSameRun(active, identity, input.runId)) return toSession(active);
          throw new SessionsError("issue_claimed");
        }

        const prior = await findLatestForRun(tx, issue.id, identity, input.runId);
        const decision = decideReacquire(
          prior?.status,
          fresh?.status ?? issue.status,
          fresh?.needsInput ?? issue.needsInput,
        );
        if (
          prior === undefined ||
          prior.status !== WorkSessionStatus.enum.expired ||
          decision === "session_required"
        ) {
          throw new SessionsError("session_required");
        }

        if (
          fresh?.status !== "todo" ||
          (fresh?.needsInput ?? false) ||
          decision === "issue_blocked"
        ) {
          throw new SessionsError("issue_blocked");
        }

        const created = await insertFreshSession(
          tx,
          issue.id,
          {
            id: randomUUID(),
            agentId: identity.agentId,
            runId: input.runId,
            workspaceId: identity.workspaceId,
            issueId: issue.id,
            status: WorkSessionStatus.enum.active,
            leaseExpiresAt: fiveMinutes,
            progress: prior.progress,
            progressUpdatedAt: prior.progressUpdatedAt,

            createdAt: sql`statement_timestamp()`,
            updatedAt: sql`statement_timestamp()`,
          },
          notifyActivity,
          onActivity,
        );
        if (created !== undefined) {
          await tx
            .update(issues)
            .set({ status: "in_progress", updatedAt: sql`statement_timestamp()` })
            .where(and(eq(issues.id, issue.id), eq(issues.status, "todo")));
          return toSession(created);
        }

        throw new SessionsError("issue_claimed");
      });
    },

    async getSession(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
            .limit(1);
          if (issue === undefined) throw new SessionsError("issue_not_found");
          await requireAccess(
            actor,
            issue.projectId,
            ProjectAccessLevel.enum.read,
            "issue_not_found",
          );
          const [row] = await tx
            .select(sessionColumns)
            .from(workSessions)
            .where(eq(workSessions.issueId, issueId))
            .orderBy(desc(workSessions.createdAt))
            .limit(1);
          if (row === undefined) throw new SessionsError("session_required");
          return toSession(row);
        },
        { accessMode: "read only" },
      );
    },

    async listSessions(actorArg, issueId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          const [issue] = await tx
            .select({ projectId: issues.projectId })
            .from(issues)
            .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
            .limit(1);
          if (issue === undefined) throw new SessionsError("issue_not_found");
          await requireAccess(
            actor,
            issue.projectId,
            ProjectAccessLevel.enum.read,
            "issue_not_found",
          );
          const rows = await tx
            .select(sessionColumns)
            .from(workSessions)
            .where(eq(workSessions.issueId, issueId))
            .orderBy(desc(workSessions.createdAt));
          return rows.map(toSession);
        },
        { accessMode: "read only" },
      );
    },

    async listActivities(actorArg, issueId, sessionId) {
      const actor = requireActor(actorArg);
      return db.transaction(
        async (tx) => {
          await requireActivityReadAccess(
            tx,
            { projectAccessCeiling, projectAccessAtLeast },
            actor,
            issueId,
          );
          const [session] = await tx
            .select({ id: workSessions.id })
            .from(workSessions)
            .where(and(eq(workSessions.id, sessionId), eq(workSessions.issueId, issueId)))
            .limit(1);
          if (session === undefined) throw new SessionsError("session_not_found");

          const rows = await tx
            .select(activityColumns)
            .from(workSessionActivities)
            .where(eq(workSessionActivities.workSessionId, session.id))
            .orderBy(desc(workSessionActivities.createdAt), desc(workSessionActivities.id));
          return rows.map(toActivity);
        },
        { accessMode: "read only" },
      );
    },

    async readyWork(actorArg, projectId, filter = "all") {
      const actor = requireActor(actorArg);

      await expireCommittedForProject(projectId);

      const ownType = actor.kind === "agent" ? "agent" : "human";
      const ownId = actor.kind === "agent" ? actor.identity.agentId : actor.account.humanId;
      const assigneeFilter =
        filter === "unassigned"
          ? isNull(issues.assigneeId)
          : filter === "assignedToMe"
            ? and(eq(issues.assigneeType, ownType), eq(issues.assigneeId, ownId))
            : actor.kind === "agent"
              ? or(
                  isNull(issues.assigneeId),
                  and(eq(issues.assigneeType, "agent"), eq(issues.assigneeId, ownId)),
                )
              : undefined;

      const eligible = await db.transaction(
        async (tx) => {
          const requireAccess = requireAccessArgs(tx, projectAccessCeiling, projectAccessAtLeast);
          await requireAccess(actor, projectId, ProjectAccessLevel.enum.read, "project_not_found");

          const live = and(
            eq(workSessions.issueId, issues.id),
            eq(workSessions.status, WorkSessionStatus.enum.active),
            gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
          );

          const noOpenBlocker = notExists(
            tx
              .select({ id: issueDependencies.id })
              .from(issueDependencies)
              .innerJoin(blockerIssue, eq(issueDependencies.blockedByIssueId, blockerIssue.id))
              .where(
                and(
                  eq(issueDependencies.issueId, issues.id),
                  isNull(blockerIssue.deletedAt),
                  notInArray(blockerIssue.status, ["done", "cancelled"]),
                ),
              ),
          );

          const conditions = [
            eq(issues.projectId, projectId),
            isNull(issues.deletedAt),
            eq(issues.status, "todo"),
            eq(issues.needsInput, false),
            isNull(workSessions.id),
            noOpenBlocker,
          ];
          if (assigneeFilter !== undefined) conditions.push(assigneeFilter);
          const rows = await tx
            .select({ id: issues.id })
            .from(issues)
            .leftJoin(workSessions, live)
            .where(and(...conditions))
            .orderBy(issues.number);
          return rows.map((row) => row.id);
        },
        { accessMode: "read only" },
      );
      if (eligible.length === 0) return [];
      const ready = new Set(eligible);
      let ordered: Issue[];
      try {
        ordered = (await listIssues(actor, projectId)).filter((issue) => ready.has(issue.id));
      } catch (error) {
        // Access can be revoked after the check above and before this second read.
        // listIssues reports that as a ProjectsError; express it as a SessionsError
        // so the REST and MCP adapters turn it into a Problem instead of a 500.
        if (error instanceof ProjectsError) {
          if (error.kind === "project_not_found") throw new SessionsError("project_not_found");
          if (error.kind === "insufficient_project_access") {
            throw new SessionsError("insufficient_access");
          }
        }
        throw error;
      }

      ordered.sort((a, b) => Number(assignedToActor(b, actor)) - Number(assignedToActor(a, actor)));
      return ordered;
    },

    async sweep() {
      // Discovery is read-only and bounded; each issue is then settled in its own small
      // transaction so one bad issue cannot roll back the whole sweep. Issues are visited
      // in ascending id order, matching the global projects->issues lock order, and the
      // issue row is locked before either transition runs.
      const stale = await db.transaction(
        async (tx) => {
          const rows = await tx
            .select({ issueId: workSessions.issueId })
            .from(workSessions)
            .innerJoin(issues, eq(workSessions.issueId, issues.id))
            .where(
              and(
                eq(workSessions.status, WorkSessionStatus.enum.active),
                lte(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
                isNull(issues.deletedAt),
              ),
            )
            .orderBy(workSessions.issueId)
            .limit(100);
          return [...new Set(rows.map((row) => row.issueId))];
        },
        { accessMode: "read only" },
      );
      const due = await dueQuestionIssueIds();
      const issueIds = [...new Set([...stale, ...due])].toSorted();
      for (const issueId of issueIds) {
        try {
          await db.transaction(async (tx) => {
            await lockIssue(tx, issueId);
            // A 1-hour require_human question pause releases the claim itself; running the
            // deadline first avoids a spurious issue_session_expired for that clean pause.
            await checkDeadline(tx, issueId);
            await expireStale(tx, issueId, notifyActivity, onActivity);
          });
        } catch (error) {
          log?.warn("expiry sweep skipped an issue", {
            issueId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },

    async agentHoldsSession(tx, agentId, workspaceId, issueId) {
      const [row] = await tx
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(
          and(
            eq(workSessions.issueId, issueId),
            eq(workSessions.agentId, agentId),
            eq(workSessions.workspaceId, workspaceId),
            eq(workSessions.status, WorkSessionStatus.enum.active),
            gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async issueHasLiveSession(tx, issueId) {
      await expireStale(tx, issueId, notifyActivity, onActivity);
      return (await findActive(tx, issueId)) !== undefined;
    },
  };
}

function requireActor(actor: WorkActor | null): WorkActor {
  if (actor === null) throw new SessionsError("not_signed_in");
  return actor;
}

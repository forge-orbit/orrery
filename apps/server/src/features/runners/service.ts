import { randomBytes, randomUUID } from "node:crypto";
import type {
  AckCommandsResponse,
  AgentIdentity,
  AutoClaimResponse,
  CreateDeviceCodeRequest,
  CreateDispatchRequest,
  DeviceCodeResponse,
  Dispatch,
  DispatchAcceptance,
  DispatchOptions,
  ExchangeDeviceCodeRequest,
  IssueResolveRequest,
  IssueResolveResponse,
  ReadyWorkFilter,
  FleetRunner,
  FleetRunnerHost,
  HarnessCatalog,
  HeartbeatRequest,
} from "@orrery/contract";
import { mergeHarnessCatalog } from "@orrery/contract";
import type {
  HostCredentialResponse,
  ProjectAccessLevel,
  ReconnectRequest,
  ReconnectResponse,
  RegisterRunnerRequest,
  ResolveUncertainRequest,
  Runner,
  RunnerCommandsResponse,
  RunnerHost,
  RunnerPresence,
  RunnerDispatchRequest,
  StreamBatchRequest,
  StreamBatchResponse,
  StreamResponse,
  WorkSession,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { RunnerCommand, SessionDiagnostic, StreamChunk, WorkSessionStatus } from "@orrery/contract";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  dispatchTokens,
  humans,
  issueDependencies,
  issues,
  projects,
  runnerCommands,
  runnerDeviceCodeAttempts,
  runnerDeviceCodes,
  runnerDispatches,
  runnerHosts,
  runners,
  runs,
  storedObjects,
  workSessionActivities,
  workSessionStreamChunks,
  workSessions,
  workspaces,
  workspaceMemberships,
} from "../../db/schema.ts";
import type { DbTransaction, Sql } from "../../platform/db.ts";
import type { Logger } from "../../platform/log.ts";
import { discardObject, isDeleted } from "../../platform/object-sweep.ts";
import type { ObjectStore } from "../../platform/storage.ts";
import { tokenHash } from "../../platform/tokens.ts";
import type { SessionAccount, SessionReader } from "../accounts/index.ts";
import { newDispatchToken } from "../agents/index.ts";
import { toRun } from "../runs/index.ts";
import { releaseIssueWorkSessions, SessionsError, toSession } from "../work-sessions/index.ts";
import { createCommandNotifier } from "./notifier.ts";
import { cancelDispatchesForRunners, enqueueRunnerCommand } from "./outbox.ts";
import {
  computeAckedSeq,
  DISPATCH_UNCERTAIN_AFTER_SECONDS,
  MAX_STREAM_BATCHES_PER_WINDOW,
  mergeChunks,
  milestonesFor,
  parseJsonl,
  sha256Of,
  STREAM_CONTENT_TYPE,
  STREAM_MILESTONE_COALESCE_SECONDS,
  STREAM_WINDOW_SECONDS,
  streamObjectKey,
  toJsonl,
} from "./stream.ts";

const HOST_CREDENTIAL_PREFIX = "orr_rh_";
const DEVICE_CODE_PREFIX = "orr_dc_";
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_FAILED_USER_CODE_ATTEMPTS = 5;
const MAX_FAILED_VERIFIER_ATTEMPTS = 5;

/** A runner is offline once its last heartbeat is older than this in DB time. */
export const RUNNER_ONLINE_WINDOW_SECONDS = 120;

/** Alias for the blocker side of `issue_dependencies` in readiness queries. */
const blockerIssue = alias(issues, "blocker_issue");
const blockerProject = alias(projects, "blocker_project");

export type RunnersErrorKind =
  | "not_signed_in"
  | "device_code_invalid"
  | "device_code_expired"
  | "device_code_pending"
  | "device_code_used"
  | "invalid_verifier"
  | "too_many_attempts"
  | "device_code_rate_limited"
  | "invalid_credential"
  | "runner_revoked"
  | "slot_count_invalid"
  | "workspace_not_found"
  | "project_not_found"
  | "host_not_found"
  | "runner_not_found"
  | "agent_not_found"
  | "no_default_agent"
  | "issue_not_found"
  | "issue_ambiguous"
  | "runner_forbidden"
  | "runner_unavailable"
  | "runner_not_for_issue"
  | "harness_unavailable"
  | "insufficient_dispatch_access"
  | "dispatch_not_found"
  | "dispatch_not_pending"
  | "dispatch_uncertain"
  | "dispatch_not_uncertain"
  | "issue_not_claimable"
  | "issue_not_dispatchable"
  | "stream_unavailable"
  | "stream_attempt_mismatch"
  | "stream_batch_out_of_range"
  | "stream_batch_too_large"
  | "stream_rate_limited"
  | "stream_rollup_failed";

const messages: Record<RunnersErrorKind, string> = {
  not_signed_in: "Sign in to approve a Runner host.",
  device_code_invalid: "No pending device code has that user code.",
  device_code_expired: "This device code has expired. Start a new login.",
  device_code_pending: "The device code has not been approved in the browser yet.",
  device_code_used: "This device code has already been exchanged.",
  invalid_verifier: "The device verifier does not match this enrollment.",
  too_many_attempts: "Too many failed verifier attempts. Start a new login.",
  device_code_rate_limited: "Too many incorrect user codes. Try again in ten minutes.",
  invalid_credential: "The Runner host credential is invalid or was revoked.",
  runner_revoked: "This Runner was revoked or lost workspace access. Stop local operation.",
  slot_count_invalid: "activeSlotCount must not exceed the Runner's maxConcurrency.",
  workspace_not_found: "No such workspace is accessible to you.",
  project_not_found: "No such project exists in this workspace.",
  host_not_found: "No such Runner host belongs to you.",
  runner_not_found: "No such Runner exists.",
  agent_not_found: "That Agent is not owned by the Runner host's human.",
  no_default_agent: "The host owner has no Agent to run as by default.",
  issue_not_found: "No such issue is accessible to you.",
  issue_ambiguous: "The issue key matches more than one workspace. Pass --workspace to choose one.",
  runner_forbidden: "Only the human who owns this Runner host may dispatch to it.",
  runner_unavailable: "This Runner is offline or has no free slot.",
  runner_not_for_issue: "This Runner is not registered for the issue's project.",
  harness_unavailable: "This Runner does not have the requested Harness.",
  insufficient_dispatch_access: "The Runner host owner needs Contribute access to dispatch here.",
  dispatch_not_found: "No such pending Dispatch exists for this Runner.",
  dispatch_not_pending: "This Dispatch was already accepted or ended.",
  dispatch_uncertain: "An uncertain Dispatch must be resolved by a human before re-dispatch.",
  dispatch_not_uncertain: "Only an uncertain Dispatch can be resolved this way.",
  issue_not_claimable: "This issue is not claimable by the selected Agent.",
  issue_not_dispatchable: "The claim could not be made for this Dispatch.",
  stream_unavailable: "Object storage is not configured for stream rollup.",
  stream_attempt_mismatch: "The stream batch does not belong to the active dispatch attempt.",
  stream_batch_out_of_range: "A chunk seq lies outside the declared fromSeq..toSeq window.",
  stream_batch_too_large: "The stream batch contains too many sequences.",
  stream_rate_limited: "Too many stream batches; retry after the indicated interval.",
  stream_rollup_failed: "The stream rollup expired before its blob could be activated.",
};

export class RunnersError extends Error {
  readonly kind: RunnersErrorKind;
  /** Whole seconds for a 429 Retry-After header; only set for backpressure. */
  readonly retryAfter: number | undefined;
  /** Optional human-readable detail, e.g. the workspaces matching an issue key. */
  readonly detail: string | undefined;

  constructor(kind: RunnersErrorKind, retryAfter?: number, detail?: string) {
    super(messages[kind]);
    this.name = "RunnersError";
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

export type ProjectAccessCeiling = (
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  projectIds: readonly string[],
) => Promise<Map<string, ProjectAccessLevel | null>>;

export type ProjectAccessAtLeast = (
  actual: ProjectAccessLevel,
  required: ProjectAccessLevel,
) => boolean;

export type ClaimWorkSession = (
  tx: DbTransaction,
  identity: AgentIdentity,
  input: { issueId: string; runId: string },
) => Promise<WorkSession>;

export interface RunnersDeps {
  db: PostgresJsDatabase;
  /** Raw client for the dedicated LISTEN connection; optional for thin tests. */
  sql?: Sql | undefined;
  /** Needed for ObjectStore stream rollup; optional for thin outbox/enrollment tests. */
  store?: ObjectStore | undefined;
  /** Lets the feature clear its #199 background ticks inside service.close(). */
  onClose?: (() => void) | undefined;
  log?: Logger | undefined;
  sessionReader: SessionReader;
  publicUrl: string;
  projectAccessCeiling: ProjectAccessCeiling;
  projectAccessAtLeast: ProjectAccessAtLeast;
  claimWorkSession: ClaimWorkSession;
}

const randomUserCode = () => {
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) code += "-";
    const index = randomBytes(1)[0]! % USER_CODE_ALPHABET.length;
    code += USER_CODE_ALPHABET[index];
  }
  return code;
};

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new RunnersError("not_signed_in");
  return account;
}

const hasAccess = (
  level: ProjectAccessLevel | null | undefined,
  required: ProjectAccessLevel,
  atLeast: ProjectAccessAtLeast,
) => level !== null && level !== undefined && atLeast(level, required);

/**
 * Presence is computed by Postgres, never stored as a mutable boolean. A host
 * revocation, runner revocation, or human deactivation forces `offline`; a stale
 * heartbeat in DB time also forces `offline`; live local sessions make it `busy`.
 */
export const runnerPresenceSql = sql<RunnerPresence>`case
  when ${runners.revokedAt} is not null
    or ${runnerHosts.revokedAt} is not null
    or ${humans.deactivatedAt} is not null then 'offline'
  when ${runners.lastSeenAt} < statement_timestamp() - make_interval(secs => ${RUNNER_ONLINE_WINDOW_SECONDS}) then 'offline'
  when ${runners.activeSlotCount} > 0 then 'busy'
  else 'online' end`;

const runnerFields = {
  id: runners.id,
  hostId: runners.hostId,
  workspaceId: runners.workspaceId,
  projectId: runners.projectId,
  agentId: runners.agentId,
  displayName: runners.displayName,
  repoFingerprint: runners.repoFingerprint,
  capabilities: runners.capabilities,
  harnessCatalog: runners.harnessCatalog,
  maxConcurrency: runners.maxConcurrency,
  activeSlotCount: runners.activeSlotCount,
  lastSeenAt: runners.lastSeenAt,
  disconnectedAt: runners.disconnectedAt,
  revokedAt: runners.revokedAt,
  createdAt: runners.createdAt,
  presence: runnerPresenceSql,
};

type RunnerRow = {
  id: string;
  hostId: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  displayName: string;
  repoFingerprint: string;
  capabilities: string[];
  harnessCatalog: HarnessCatalog | null;
  maxConcurrency: number;
  activeSlotCount: number;
  lastSeenAt: Date;
  disconnectedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  presence: RunnerPresence;
};

const toRunnerResponse = (row: RunnerRow): Runner => ({
  id: row.id,
  hostId: row.hostId,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  agentId: row.agentId,
  displayName: row.displayName,
  repoFingerprint: row.repoFingerprint,
  capabilities: row.capabilities,
  harnessCatalog: row.harnessCatalog,
  maxConcurrency: row.maxConcurrency,
  activeSlotCount: row.activeSlotCount,
  lastSeenAt: row.lastSeenAt.toISOString(),
  disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  presence: row.presence,
});

const toHostResponse = (row: {
  id: string;
  humanId: string;
  displayName: string;
  platform: string;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): RunnerHost => ({
  id: row.id,
  humanId: row.humanId,
  displayName: row.displayName,
  platform: row.platform,
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** An empty catalog is the merge identity for Runners without one yet. */
const EMPTY_CATALOG: HarnessCatalog = { harnesses: [], updatedAt: "1970-01-01T00:00:00.000Z" };

async function joinRunner(tx: DbTransaction, runnerId: string) {
  const [row] = await tx
    .select(runnerFields)
    .from(runners)
    .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
    .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
    .where(eq(runners.id, runnerId));
  return row;
}

async function readHostByCredential(
  tx: DbTransaction,
  credential: string | undefined,
  allowRevoked = false,
) {
  if (credential === undefined || !credential.startsWith(HOST_CREDENTIAL_PREFIX)) {
    throw new RunnersError("invalid_credential");
  }
  const [host] = await tx
    .select({ host: runnerHosts, humanId: humans.id, deactivatedAt: humans.deactivatedAt })
    .from(runnerHosts)
    .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
    .where(
      and(
        eq(runnerHosts.credentialHash, tokenHash(credential)),
        allowRevoked ? undefined : isNull(runnerHosts.revokedAt),
      ),
    );
  if (host === undefined || host.deactivatedAt !== null)
    throw new RunnersError("invalid_credential");
  return host;
}

async function canSeeWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
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
    );
  return membership !== undefined;
}

/**
 * Live host-credential authentication for runner-host endpoints: revocation,
 * human deactivation, workspace membership and the project access ceiling are
 * all checked inside the caller's transaction (DB time, never a cached grant).
 */
async function authenticateHostRunnerForDeps(
  deps: RunnersDeps,
  tx: DbTransaction,
  credential: string | undefined,
  runnerId: string,
  lock = true,
  minLevel: ProjectAccessLevel = "read",
) {
  const host = await readHostByCredential(tx, credential);
  const query = tx.select().from(runners).where(eq(runners.id, runnerId)).limit(1);
  const [runner] = lock ? await query.for("update") : await query;
  if (runner === undefined || runner.hostId !== host.host.id) {
    throw new RunnersError("runner_not_found");
  }
  if (runner.revokedAt !== null) throw new RunnersError("runner_revoked");
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, runner.projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (project === undefined) throw new RunnersError("runner_revoked");
  if (!(await canSeeWorkspace(tx, runner.workspaceId, host.humanId))) {
    throw new RunnersError("runner_revoked");
  }
  const ceiling = await deps.projectAccessCeiling(tx, runner.workspaceId, host.humanId, [
    runner.projectId,
  ]);
  const level = ceiling.get(runner.projectId);
  if (!hasAccess(level, minLevel, deps.projectAccessAtLeast)) {
    throw new RunnersError("runner_revoked");
  }
  return { host, runner, level };
}

/** DB-time expiry flag shared by every device-code read/write decision. */
const dispatchBaseFields = {
  id: runnerDispatches.id,
  runnerId: runnerDispatches.runnerId,
  workspaceId: runnerDispatches.workspaceId,
  projectId: runnerDispatches.projectId,
  issueId: runnerDispatches.issueId,
  requestedByHumanId: runnerDispatches.requestedByHumanId,
  agentId: runnerDispatches.agentId,
  dispatchAttemptId: runnerDispatches.dispatchAttemptId,
  state: runnerDispatches.state,
  prompt: runnerDispatches.prompt,
  harness: runnerDispatches.harness,
  model: runnerDispatches.model,
  effort: runnerDispatches.effort,
  runId: runnerDispatches.runId,
  workSessionId: runnerDispatches.workSessionId,
  lastUpSeq: runnerDispatches.lastUpSeq,
  lastDownSeq: runnerDispatches.lastDownSeq,
  branchName: runnerDispatches.branchName,
  dirtyWorktree: runnerDispatches.dirtyWorktree,
  createdAt: runnerDispatches.createdAt,
  acceptedAt: runnerDispatches.acceptedAt,
  endedAt: runnerDispatches.endedAt,
};

const dispatchFields = { ...dispatchBaseFields, hostId: runnerHosts.id };

type DispatchRow = {
  id: string;
  runnerId: string;
  hostId: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  requestedByHumanId: string;
  agentId: string;
  dispatchAttemptId: string;
  state: Dispatch["state"];
  prompt: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  runId: string | null;
  workSessionId: string | null;
  lastUpSeq: number;
  lastDownSeq: number;
  branchName: string | null;
  dirtyWorktree: boolean;
  createdAt: Date;
  acceptedAt: Date | null;
  endedAt: Date | null;
};

const toDispatch = (row: DispatchRow): Dispatch => ({
  id: row.id,
  runnerId: row.runnerId,
  hostId: row.hostId,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  issueId: row.issueId,
  requestedByHumanId: row.requestedByHumanId,
  agentId: row.agentId,
  dispatchAttemptId: row.dispatchAttemptId,
  state: row.state,
  prompt: row.prompt,
  harness: row.harness,
  model: row.model,
  effort: row.effort,
  runId: row.runId,
  workSessionId: row.workSessionId,
  lastUpSeq: row.lastUpSeq,
  lastDownSeq: row.lastDownSeq,
  branchName: row.branchName,
  dirtyWorktree: row.dirtyWorktree,
  createdAt: row.createdAt.toISOString(),
  acceptedAt: row.acceptedAt?.toISOString() ?? null,
  endedAt: row.endedAt?.toISOString() ?? null,
});

const readDispatch = async (tx: DbTransaction, dispatchId: string) => {
  const [row] = await tx
    .select(dispatchFields)
    .from(runnerDispatches)
    .innerJoin(runners, eq(runnerDispatches.runnerId, runners.id))
    .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
    .innerJoin(projects, eq(runnerDispatches.projectId, projects.id))
    .where(and(eq(runnerDispatches.id, dispatchId), isNull(projects.deletedAt)))
    .limit(1);
  if (row === undefined) throw new RunnersError("dispatch_not_found");
  return row;
};

/**
 * A dispatch whose work session is no longer live is no longer "Running" in
 * the UI, even if no explicit end command arrived: derive the settled state
 * from the session in database time and persist it. Also settle any pending
 * dispatch whose outbox command has expired in database time so it never
 * permanently blocks auto-claim or leaks a concurrency slot.
 */
async function endDispatchesWithoutLiveSession(
  tx: DbTransaction,
  where: SQL | undefined,
): Promise<void> {
  await tx
    .update(runnerDispatches)
    .set({ state: "ended", endedAt: sql`statement_timestamp()` })
    .where(
      and(
        where,
        // An uncertain attempt is NEVER settled by a lapsed lease: only an
        // explicit human resolution (or a live-lease reconnect) may clear it.
        or(
          and(
            eq(runnerDispatches.state, "active"),
            sql`not exists (select 1 from ${workSessions} ws where ws.id = ${runnerDispatches.workSessionId} and ws.status = 'active' and ws.lease_expires_at > statement_timestamp())`,
          ),
          and(
            eq(runnerDispatches.state, "pending"),
            sql`exists (select 1 from ${runnerCommands} rc where rc.dispatch_id = ${runnerDispatches.id} and rc.kind = 'dispatch' and rc.expires_at <= statement_timestamp())`,
          ),
        ),
      ),
    );
}

/** The existing claim rules, checked without writing the issue's assignee. */
async function assertIssueDispatchable(
  tx: DbTransaction,
  issueId: string,
  agentId: string,
): Promise<void> {
  let [issue] = await tx
    .select({
      status: issues.status,
      needsInput: issues.needsInput,
      assigneeType: issues.assigneeType,
      assigneeId: issues.assigneeId,
    })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(and(eq(issues.id, issueId), isNull(issues.deletedAt), isNull(projects.deletedAt)))
    .limit(1)
    .for("update", { of: issues });
  if (issue === undefined) throw new RunnersError("issue_not_found");
  // Retire a lease that lapsed in database time before checking claimability,
  // mirroring the work-session service's lazy expiry.
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
    .returning({ id: workSessions.id });
  if (expired.length > 0) {
    await tx
      .update(issues)
      .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
      .where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
    [issue] = await tx
      .select({
        status: issues.status,
        needsInput: issues.needsInput,
        assigneeType: issues.assigneeType,
        assigneeId: issues.assigneeId,
      })
      .from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(and(eq(issues.id, issueId), isNull(issues.deletedAt), isNull(projects.deletedAt)))
      .limit(1);
  }
  if (issue === undefined) throw new RunnersError("issue_not_found");
  if (
    issue.status !== "todo" ||
    issue.needsInput ||
    issue.assigneeType === "human" ||
    (issue.assigneeType === "agent" && issue.assigneeId !== agentId)
  ) {
    throw new RunnersError("issue_not_claimable");
  }
  const [active] = await tx
    .select({ id: workSessions.id })
    .from(workSessions)
    .where(
      and(
        eq(workSessions.issueId, issueId),
        eq(workSessions.status, "active"),
        sql`${workSessions.leaseExpiresAt} > statement_timestamp()`,
      ),
    )
    .limit(1);
  if (active !== undefined) throw new RunnersError("issue_not_claimable");
}

async function revokeDispatchTokensForRunners(
  tx: DbTransaction,
  runnerIds: readonly string[],
  reason: string,
): Promise<void> {
  if (runnerIds.length === 0) return;
  await tx
    .update(dispatchTokens)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(and(inArray(dispatchTokens.runnerId, [...runnerIds]), isNull(dispatchTokens.revokedAt)));
  // Cancel commands and dispatch settlement share this transaction with the
  // host/member/human revocation that called us.
  await cancelDispatchesForRunners(tx, runnerIds, reason);
}

/** One ack write shared by implicit cursor advance and the explicit ack route. */
async function acknowledgeCommands(tx: DbTransaction, runnerId: string, upToSeq: number) {
  await tx
    .update(runnerCommands)
    .set({ ackedAt: sql`statement_timestamp()` })
    .where(
      and(
        eq(runnerCommands.runnerId, runnerId),
        lte(runnerCommands.seq, upToSeq),
        isNull(runnerCommands.ackedAt),
      ),
    );
}

async function hasUnackedCancel(tx: DbTransaction, runnerId: string) {
  const [row] = await tx
    .select({ id: runnerCommands.id })
    .from(runnerCommands)
    .where(
      and(
        eq(runnerCommands.runnerId, runnerId),
        eq(runnerCommands.kind, "cancel"),
        isNull(runnerCommands.ackedAt),
        gt(runnerCommands.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  return row !== undefined;
}

const deviceCodeNotExpired = sql<boolean>`${runnerDeviceCodes.expiresAt} > statement_timestamp()`;
const attemptWindowExpired = sql<boolean>`${runnerDeviceCodeAttempts.windowStartedAt} <= statement_timestamp() - interval '10 minutes'`;

/**
 * #199: runner-to-server streams. All decisions live here; the REST layer only
 * validates shapes. Every write serializes on the work_sessions row after the
 * global `issues -> runners -> runner_dispatches -> work_sessions` lock order.
 */
/**
 * Claim-first JSONL rollup (#199). The blob is written under a unique key,
 * claimed as `pending` in Postgres BEFORE the put, and activated only inside
 * the committing transaction after re-checking (under the global row lock)
 * that no late chunk arrived. A lost race discards the pending blob and leaves
 * every hot chunk for the next rollup — no active blob is ever overwritten.
 */
async function rollUpSessionById(
  db: PostgresJsDatabase,
  objectStore: ObjectStore,
  sessionId: string,
): Promise<boolean> {
  // Step 1: snapshot outside the committing write lock.
  const [snapshot] = await db
    .select({
      issueId: workSessions.issueId,
      status: workSessions.status,
      streamObjectId: workSessions.streamObjectId,
    })
    .from(workSessions)
    .where(eq(workSessions.id, sessionId))
    .limit(1);
  if (snapshot === undefined || !["completed", "released", "expired"].includes(snapshot.status)) {
    return false;
  }
  const hot = await db
    .select({ seq: workSessionStreamChunks.seq, payload: workSessionStreamChunks.payload })
    .from(workSessionStreamChunks)
    .where(eq(workSessionStreamChunks.workSessionId, sessionId))
    .orderBy(asc(workSessionStreamChunks.seq));
  // Zero-chunk sessions skip rollup (stored_objects.byte_size > 0) and are not
  // re-selected forever by the sweep.
  if (hot.length === 0) return false;
  const rolledSeqs = hot.map((row) => row.seq);
  let prior: { id: string; key: string } | undefined;
  const archived: StreamChunk[] = [];
  if (snapshot.streamObjectId !== null) {
    const [object] = await db
      .select({ id: storedObjects.id, key: storedObjects.key })
      .from(storedObjects)
      .where(eq(storedObjects.id, snapshot.streamObjectId))
      .limit(1);
    if (object !== undefined) {
      prior = object;
      const stored = await objectStore.get(object.key);
      if (stored !== null) archived.push(...parseJsonl(stored.data));
    }
  }
  const merged = mergeChunks(
    archived,
    hot.map((row) => row.payload),
  );
  const bytes = toJsonl(merged);
  if (merged.length === 0 || bytes.byteLength === 0) return false;
  const sha256 = sha256Of(bytes);
  const objectId = randomUUID();
  const key = streamObjectKey(sessionId, objectId);

  // Step 2: commit the pending claim before any blob I/O.
  await db.insert(storedObjects).values({
    id: objectId,
    key,
    status: "pending",
    contentType: STREAM_CONTENT_TYPE,
    byteSize: bytes.byteLength,
    sha256,
  });

  let discard: { id: string; key: string } | undefined;
  try {
    // Step 3: blob I/O outside any transaction.
    await objectStore.put(key, bytes, STREAM_CONTENT_TYPE);

    // Step 4: committing transaction in global lock order.
    const activated = await db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, snapshot.issueId))
        .limit(1)
        .for("update");
      const [dispatch] = await tx
        .select({ id: runnerDispatches.id, runnerId: runnerDispatches.runnerId })
        .from(runnerDispatches)
        .where(eq(runnerDispatches.workSessionId, sessionId))
        .orderBy(desc(runnerDispatches.createdAt))
        .limit(1);
      if (dispatch !== undefined) {
        await tx
          .select({ id: runners.id })
          .from(runners)
          .where(eq(runners.id, dispatch.runnerId))
          .limit(1)
          .for("update");
        await tx
          .select({ id: runnerDispatches.id })
          .from(runnerDispatches)
          .where(eq(runnerDispatches.id, dispatch.id))
          .limit(1)
          .for("update");
      }
      const [fresh] = await tx
        .select({ status: workSessions.status, streamObjectId: workSessions.streamObjectId })
        .from(workSessions)
        .where(eq(workSessions.id, sessionId))
        .limit(1)
        .for("update");
      const abort = (): false => {
        discard = { id: objectId, key };
        return false;
      };
      if (
        fresh === undefined ||
        !["completed", "released", "expired"].includes(fresh.status) ||
        fresh.streamObjectId !== snapshot.streamObjectId
      ) {
        return abort();
      }
      const late = await tx
        .select({ seq: workSessionStreamChunks.seq })
        .from(workSessionStreamChunks)
        .where(
          and(
            eq(workSessionStreamChunks.workSessionId, sessionId),
            notInArray(workSessionStreamChunks.seq, rolledSeqs),
          ),
        )
        .limit(1);
      if (late.length > 0) return abort(); // a late or gap-filling batch arrived: retry later

      const [activatedRow] = await tx
        .update(storedObjects)
        .set({ status: "active", deletedAt: null })
        .where(and(eq(storedObjects.id, objectId), eq(storedObjects.status, "pending")))
        .returning({ id: storedObjects.id });
      if (activatedRow === undefined) return abort(); // the orphan sweep won the claim
      if (prior !== undefined) {
        await tx
          .update(storedObjects)
          .set({ status: "deleted", deletedAt: sql`statement_timestamp()` })
          .where(and(eq(storedObjects.id, prior.id), eq(storedObjects.status, "active")));
      }
      await tx
        .update(workSessions)
        .set({ streamObjectId: objectId })
        .where(eq(workSessions.id, sessionId));
      await tx
        .delete(workSessionStreamChunks)
        .where(
          and(
            eq(workSessionStreamChunks.workSessionId, sessionId),
            inArray(workSessionStreamChunks.seq, rolledSeqs),
          ),
        );
      return true;
    });
    return activated;
  } catch (error) {
    discard = { id: objectId, key };
    throw error;
  } finally {
    if (discard !== undefined) {
      // Claim still-pending rows before the blob delete, then let the shared
      // sweep finish the discarded row exactly once.
      await db
        .update(storedObjects)
        .set({ status: "deleted", deletedAt: sql`statement_timestamp()` })
        .where(and(eq(storedObjects.id, discard.id), eq(storedObjects.status, "pending")));
      await discardObject(db, objectStore, discard, isDeleted);
    }
  }
}

function createStreamHelpers(deps: RunnersDeps) {
  const { db, projectAccessCeiling, projectAccessAtLeast } = deps;
  const store = deps.store;

  function requireStore(): ObjectStore {
    if (store === undefined) throw new RunnersError("stream_unavailable");
    return store;
  }

  async function authenticateHostRunner(
    tx: DbTransaction,
    credential: string | undefined,
    runnerId: string,
    lock = true,
  ) {
    return authenticateHostRunnerForDeps(deps, tx, credential, runnerId, lock);
  }

  async function ingest(
    credential: string | undefined,
    runnerId: string,
    dispatchId: string,
    input: StreamBatchRequest,
  ): Promise<StreamBatchResponse> {
    return db.transaction(async (tx) => {
      // Do not lock `runners` here: ingest only mutates runner_dispatches and
      // work_session_stream_chunks, avoiding AB-BA deadlocks with stop/cancel.
      await authenticateHostRunner(tx, credential, runnerId, false);
      // Global lock order: issues -> runner_dispatches -> work_sessions. The
      // issue lock is essential: renew/rollup also lock issues before the
      // session, so skipping it here creates a 40P01 cycle with a live lease.
      const [peek] = await tx
        .select({ issueId: runnerDispatches.issueId })
        .from(runnerDispatches)
        .where(eq(runnerDispatches.id, dispatchId))
        .limit(1);
      if (peek === undefined) throw new RunnersError("dispatch_not_found");
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, peek.issueId))
        .limit(1)
        .for("update");
      await tx
        .select({ id: runnerDispatches.id })
        .from(runnerDispatches)
        .where(eq(runnerDispatches.id, dispatchId))
        .limit(1)
        .for("update");
      const dispatch = await readDispatch(tx, dispatchId);
      if (dispatch.runnerId !== runnerId) throw new RunnersError("dispatch_not_found");
      if (dispatch.dispatchAttemptId !== input.dispatchAttemptId) {
        throw new RunnersError("stream_attempt_mismatch");
      }
      if (
        (dispatch.state !== "active" && dispatch.state !== "uncertain") ||
        dispatch.workSessionId === null
      ) {
        throw new RunnersError("dispatch_not_pending");
      }
      const sessionId = dispatch.workSessionId;
      const [session] = await tx
        .select({ id: workSessions.id, runId: workSessions.runId })
        .from(workSessions)
        .where(eq(workSessions.id, sessionId))
        .limit(1)
        .for("update");
      if (session === undefined) throw new RunnersError("dispatch_not_pending");

      if (input.toSeq - input.fromSeq + 1 > 1000) {
        throw new RunnersError("stream_batch_too_large");
      }
      const [window] = await tx
        .select({
          expired: sql<boolean>`${runnerDispatches.streamWindowStartedAt} is null
            or ${runnerDispatches.streamWindowStartedAt} <= statement_timestamp() - make_interval(secs => ${STREAM_WINDOW_SECONDS})`,
        })
        .from(runnerDispatches)
        .where(eq(runnerDispatches.id, dispatchId));
      if (window?.expired === true) {
        await tx
          .update(runnerDispatches)
          .set({ streamWindowStartedAt: sql`statement_timestamp()`, streamBatchCount: 1 })
          .where(eq(runnerDispatches.id, dispatchId));
      } else {
        const [updated] = await tx
          .update(runnerDispatches)
          .set({
            streamBatchCount: sql`least(${runnerDispatches.streamBatchCount} + 1, ${MAX_STREAM_BATCHES_PER_WINDOW + 1})`,
          })
          .where(eq(runnerDispatches.id, dispatchId))
          .returning({ count: runnerDispatches.streamBatchCount });
        if ((updated?.count ?? 0) > MAX_STREAM_BATCHES_PER_WINDOW) {
          const [wait] = await tx
            .select({
              seconds: sql<number>`greatest(1, ceil(extract(epoch from (
                ${runnerDispatches.streamWindowStartedAt} + make_interval(secs => ${STREAM_WINDOW_SECONDS})
                - statement_timestamp()))))::int`,
            })
            .from(runnerDispatches)
            .where(eq(runnerDispatches.id, dispatchId));
          throw new RunnersError("stream_rate_limited", wait?.seconds ?? STREAM_WINDOW_SECONDS);
        }
      }

      const chunkRows = input.chunks.map((chunk) => {
        if (chunk.seq < input.fromSeq || chunk.seq > input.toSeq) {
          throw new RunnersError("stream_batch_out_of_range");
        }
        // Raw stdout is always owner_only, whatever the client declared.
        const stored: StreamChunk =
          chunk.kind === "raw_output" ? { ...chunk, visibility: "owner_only" } : chunk;
        return {
          workSessionId: sessionId,
          seq: stored.seq,
          kind: stored.kind,
          visibility: stored.visibility,
          payload: stored,
          createdAt: sql`statement_timestamp()`,
        };
      });
      if (chunkRows.length > 0) {
        await tx.insert(workSessionStreamChunks).values(chunkRows).onConflictDoNothing();
      }

      // Curated milestones are coalesced by summary within a DB-time window:
      // raw stdout never reaches work_session_activities.
      for (const milestone of milestonesFor(input.chunks)) {
        const [recent] = await tx
          .select({ id: workSessionActivities.id })
          .from(workSessionActivities)
          .where(
            and(
              eq(workSessionActivities.workSessionId, sessionId),
              eq(workSessionActivities.summary, milestone.summary),
              gt(
                workSessionActivities.createdAt,
                sql`statement_timestamp() - make_interval(secs => ${STREAM_MILESTONE_COALESCE_SECONDS})`,
              ),
            ),
          )
          .limit(1);
        if (recent !== undefined) continue;
        await tx.insert(workSessionActivities).values({
          id: randomUUID(),
          workSessionId: sessionId,
          runId: session.runId,
          kind: milestone.kind,
          summary: milestone.summary,
          detail: milestone.detail,
          createdAt: sql`statement_timestamp()`,
        });
      }

      const rows = await tx
        .select({ seq: workSessionStreamChunks.seq })
        .from(workSessionStreamChunks)
        .where(
          and(
            eq(workSessionStreamChunks.workSessionId, sessionId),
            gt(workSessionStreamChunks.seq, dispatch.lastUpSeq),
            lte(workSessionStreamChunks.seq, input.toSeq),
          ),
        )
        .orderBy(asc(workSessionStreamChunks.seq));
      const ackedSeq = computeAckedSeq(
        dispatch.lastUpSeq,
        input.toSeq,
        rows.map((row) => row.seq),
      );
      if (ackedSeq > dispatch.lastUpSeq) {
        await tx
          .update(runnerDispatches)
          .set({ lastUpSeq: ackedSeq })
          .where(eq(runnerDispatches.id, dispatchId));
      }
      return { ackedSeq };
    });
  }

  async function read(
    credential: string | undefined,
    account: SessionAccount | null,
    runnerId: string,
    dispatchId: string,
    afterSeq: number,
  ): Promise<StreamResponse> {
    const objectStore = requireStore();
    // Authenticate FIRST: an anonymous caller gets 401, never a 404/401 oracle
    // that depends on whether the dispatch id exists.
    if (account === null) {
      await db.transaction((tx) => authenticateHostRunner(tx, credential, runnerId, false));
    }

    const snapshot = await db.transaction(async (tx) => {
      const dispatch = await readDispatch(tx, dispatchId);
      if (dispatch.runnerId !== runnerId) throw new RunnersError("dispatch_not_found");
      let viewerHumanId: string;
      if (account !== null) {
        viewerHumanId = account.humanId;
        if (!(await canSeeWorkspace(tx, dispatch.workspaceId, viewerHumanId))) {
          throw new RunnersError("dispatch_not_found");
        }
        const ceiling = await projectAccessCeiling(tx, dispatch.workspaceId, viewerHumanId, [
          dispatch.projectId,
        ]);
        if (!hasAccess(ceiling.get(dispatch.projectId), "read", projectAccessAtLeast)) {
          throw new RunnersError("dispatch_not_found");
        }
      } else {
        const host = await readHostByCredential(tx, credential);
        if (dispatch.hostId !== host.host.id) throw new RunnersError("dispatch_not_found");
        viewerHumanId = host.humanId;
      }
      // Re-check inside the same transaction as the read (no stale grant).
      const [host] = await tx
        .select({ humanId: runnerHosts.humanId })
        .from(runnerHosts)
        .where(eq(runnerHosts.id, dispatch.hostId))
        .limit(1);
      return { dispatch, viewerHumanId, isOwner: host?.humanId === viewerHumanId };
    });

    const sessionId = snapshot.dispatch.workSessionId;
    if (sessionId === null) return { chunks: [], nextAfterSeq: afterSeq, rolledUp: false };
    const [session] = await db
      .select({ streamObjectId: workSessions.streamObjectId })
      .from(workSessions)
      .where(eq(workSessions.id, sessionId))
      .limit(1);
    if (session === undefined) throw new RunnersError("dispatch_not_found");

    // Blob I/O outside any DB transaction.
    let archived: StreamChunk[] = [];
    if (session.streamObjectId !== null) {
      const [object] = await db
        .select({ key: storedObjects.key })
        .from(storedObjects)
        .where(eq(storedObjects.id, session.streamObjectId))
        .limit(1);
      if (object !== undefined) {
        const stored = await objectStore.get(object.key);
        if (stored !== null) archived = parseJsonl(stored.data);
      }
    }

    return db.transaction(async (tx) => {
      const hot = await tx
        .select({ payload: workSessionStreamChunks.payload })
        .from(workSessionStreamChunks)
        .where(
          and(
            eq(workSessionStreamChunks.workSessionId, sessionId),
            gt(workSessionStreamChunks.seq, afterSeq),
          ),
        )
        .orderBy(asc(workSessionStreamChunks.seq));
      const all = mergeChunks(
        archived,
        hot.map((row) => row.payload),
      ).filter((chunk) => chunk.seq > afterSeq);
      const nextAfterSeq = all.reduce((max, chunk) => Math.max(max, chunk.seq), afterSeq);

      // Server diagnostics (e.g. runner_disconnected) live in the curated
      // activity trail. Surface them as virtual chunks in the reserved high
      // sequence range so they never collide with (or stall) spool seqs.
      const activityRows = await tx
        .select({ detail: workSessionActivities.detail })
        .from(workSessionActivities)
        .where(eq(workSessionActivities.workSessionId, sessionId))
        .orderBy(desc(workSessionActivities.createdAt))
        .limit(50);
      let virtualSeq = Number.MAX_SAFE_INTEGER - 10;
      const virtual: StreamChunk[] = [];
      for (const row of activityRows) {
        const parsed = SessionDiagnostic.safeParse(row.detail?.diagnostic);
        if (!parsed.success || parsed.data.kind !== "runner_disconnected") continue;
        virtual.push(
          StreamChunk.parse({
            seq: virtualSeq--,
            kind: "diagnostic",
            visibility: "project_readers",
            diagnostic: parsed.data,
          }),
        );
      }
      const merged = [...all, ...virtual];
      const chunks = snapshot.isOwner
        ? merged
        : merged.filter(
            (chunk) => chunk.visibility !== "owner_only" && chunk.kind !== "raw_output",
          );
      return { chunks, nextAfterSeq, rolledUp: session.streamObjectId !== null };
    });
  }

  async function reconnect(
    credential: string | undefined,
    runnerId: string,
    input: ReconnectRequest,
  ): Promise<ReconnectResponse> {
    return db.transaction(async (tx) => {
      const { host } = await authenticateHostRunner(tx, credential, runnerId);
      const active = new Map(
        input.activeAttempts.map((attempt) => [attempt.dispatchAttemptId, attempt.lastSeq]),
      );
      // runner is locked by authenticateHostRunner; dispatches then work
      // sessions follow the global lock order.
      const rows = await tx
        .select(dispatchFields)
        .from(runnerDispatches)
        .innerJoin(runners, eq(runnerDispatches.runnerId, runners.id))
        .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
        .where(
          and(
            eq(runnerDispatches.runnerId, runnerId),
            inArray(runnerDispatches.state, ["active", "uncertain"]),
          ),
        )
        .orderBy(asc(runnerDispatches.id))
        .for("update", { of: runnerDispatches });
      const sessionIds = [
        ...new Set(rows.map((row) => row.workSessionId).filter((id) => id !== null)),
      ].toSorted();
      if (sessionIds.length > 0) {
        await tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(inArray(workSessions.id, sessionIds))
          .orderBy(asc(workSessions.id))
          .for("update");
      }
      const resolutions: ReconnectResponse["resolutions"] = [];
      for (const row of rows) {
        const reportedSeq = active.get(row.dispatchAttemptId);
        let state = row.state;
        let resumed = false;
        // Never advance last_up_seq to a client-reported number: only ingestion
        // that persisted those chunks may move the durable cursor.
        const durableSeq = row.lastUpSeq;
        const session =
          row.workSessionId === null
            ? undefined
            : (
                await tx
                  .select({
                    status: workSessions.status,
                    live: sql<boolean>`${workSessions.leaseExpiresAt} > statement_timestamp()`,
                  })
                  .from(workSessions)
                  .where(eq(workSessions.id, row.workSessionId))
                  .limit(1)
              )[0];
        const claimLive = session?.status === "active" && session.live;

        if (reportedSeq !== undefined && claimLive) {
          if (row.state === "uncertain") {
            await tx
              .update(runnerDispatches)
              .set({
                state: "active",
                disconnectedAt: null,
                needsHumanResolution: false,
              })
              .where(eq(runnerDispatches.id, row.id));
            state = "active";
            resumed = true;
          }
          if (row.workSessionId !== null && row.runId !== null) {
            await tx.insert(workSessionActivities).values({
              id: randomUUID(),
              workSessionId: row.workSessionId,
              runId: row.runId,
              kind: "status",
              summary: "Runner reconnected; stream resumed",
              detail: {
                dispatchAttemptId: row.dispatchAttemptId,
                serverLastUpSeq: durableSeq,
                reportedLastSeq: reportedSeq,
              },
              createdAt: sql`statement_timestamp()`,
            });
          }
        } else {
          // Absent from the active list (even when still `active` because the
          // disconnect sweep has not run yet), or the claim ended/expired:
          // never assume the write did not happen, and require a human.
          await tx
            .update(runnerDispatches)
            .set({
              state: "uncertain",
              needsHumanResolution: true,
              disconnectedAt: sql`coalesce(${runnerDispatches.disconnectedAt}, statement_timestamp())`,
            })
            .where(eq(runnerDispatches.id, row.id));
          state = "uncertain";
          const message =
            reportedSeq === undefined
              ? "Reconnecting Runner did not report this active attempt."
              : "The dispatch claim expired or ended; explicit human re-dispatch is required.";
          if (row.workSessionId !== null && row.runId !== null) {
            await tx.insert(workSessionActivities).values({
              id: randomUUID(),
              workSessionId: row.workSessionId,
              runId: row.runId,
              kind: "status",
              summary: "Uncertain attempt requires human resolution",
              detail: {
                dispatchAttemptId: row.dispatchAttemptId,
                diagnostic: { kind: "runner_disconnected", version: 1, message },
              },
              createdAt: sql`statement_timestamp()`,
            });
          }
        }
        resolutions.push({
          dispatchId: row.id,
          dispatchAttemptId: row.dispatchAttemptId,
          state,
          resumed,
          // Durable server cursor: the runner replays (lastUpSeq + 1)..localLastSeq.
          lastSeq: durableSeq,
        });
      }
      // A reconnect report is also a heartbeat in database time.
      await tx
        .update(runners)
        .set({ lastSeenAt: sql`statement_timestamp()`, disconnectedAt: null })
        .where(eq(runners.id, runnerId));
      await tx
        .update(runnerHosts)
        .set({ lastSeenAt: sql`statement_timestamp()` })
        .where(eq(runnerHosts.id, host.host.id));
      return { resolutions };
    });
  }

  /** Missed heartbeats make an active attempt uncertain, never auto-stop it. */
  async function markDisconnected(windowSeconds = DISPATCH_UNCERTAIN_AFTER_SECONDS) {
    return db.transaction(async (tx) => {
      const candidates = await tx
        .select({
          dispatchId: runnerDispatches.id,
          issueId: runnerDispatches.issueId,
          runnerId: runnerDispatches.runnerId,
          workSessionId: runnerDispatches.workSessionId,
          runId: runnerDispatches.runId,
          dispatchAttemptId: runnerDispatches.dispatchAttemptId,
        })
        .from(runnerDispatches)
        .innerJoin(runners, eq(runnerDispatches.runnerId, runners.id))
        .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
        .where(
          and(
            eq(runnerDispatches.state, "active"),
            isNotNull(runnerDispatches.workSessionId),
            isNull(runnerDispatches.disconnectedAt),
            isNull(runners.revokedAt),
            isNull(runnerHosts.revokedAt),
            lt(
              runners.lastSeenAt,
              sql`statement_timestamp() - make_interval(secs => ${windowSeconds})`,
            ),
          ),
        )
        .orderBy(asc(runnerDispatches.id));
      if (candidates.length === 0) return 0;

      // One FOR UPDATE pass per table in global lock order, never inside a loop.
      const issueIds = [...new Set(candidates.map((c) => c.issueId))].toSorted();
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(inArray(issues.id, issueIds))
        .orderBy(asc(issues.id))
        .for("update");
      const runnerIds = [...new Set(candidates.map((c) => c.runnerId))].toSorted();
      await tx
        .select({ id: runners.id })
        .from(runners)
        .where(inArray(runners.id, runnerIds))
        .orderBy(asc(runners.id))
        .for("update");
      const dispatchIds = candidates.map((c) => c.dispatchId).toSorted();
      await tx
        .select({ id: runnerDispatches.id })
        .from(runnerDispatches)
        .where(inArray(runnerDispatches.id, dispatchIds))
        .orderBy(asc(runnerDispatches.id))
        .for("update");
      const sessionIds = [
        ...new Set(candidates.map((c) => c.workSessionId).filter((id) => id !== null)),
      ].toSorted();
      if (sessionIds.length > 0) {
        await tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(inArray(workSessions.id, sessionIds))
          .orderBy(asc(workSessions.id))
          .for("update");
      }

      let marked = 0;
      for (const candidate of candidates) {
        // Re-check AFTER the row locks: a heartbeat or reconnect that won the
        // race must not be clobbered into `uncertain`.
        const [fresh] = await tx
          .select({
            state: runnerDispatches.state,
            disconnectedAt: runnerDispatches.disconnectedAt,
            stillStale: sql<boolean>`${runners.lastSeenAt} < statement_timestamp() - make_interval(secs => ${windowSeconds})`,
            runnerRevoked: runners.revokedAt,
            hostRevoked: runnerHosts.revokedAt,
          })
          .from(runnerDispatches)
          .innerJoin(runners, eq(runnerDispatches.runnerId, runners.id))
          .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
          .where(eq(runnerDispatches.id, candidate.dispatchId));
        if (
          fresh === undefined ||
          fresh.state !== "active" ||
          fresh.disconnectedAt !== null ||
          fresh.runnerRevoked !== null ||
          fresh.hostRevoked !== null ||
          !fresh.stillStale
        ) {
          continue;
        }
        await tx
          .update(runnerDispatches)
          .set({ state: "uncertain", disconnectedAt: sql`statement_timestamp()` })
          .where(eq(runnerDispatches.id, candidate.dispatchId));
        if (candidate.workSessionId !== null && candidate.runId !== null) {
          const diagnostic = {
            kind: "runner_disconnected",
            version: 1,
            message: "Runner missed heartbeats during an active dispatch; state is uncertain.",
          };
          await tx.insert(workSessionActivities).values({
            id: randomUUID(),
            workSessionId: candidate.workSessionId,
            runId: candidate.runId,
            kind: "status",
            summary: "Runner disconnected during dispatch",
            detail: { dispatchAttemptId: candidate.dispatchAttemptId, diagnostic },
            createdAt: sql`statement_timestamp()`,
          });
        }
        marked += 1;
      }
      return marked;
    });
  }

  /** Explicit human settlement of an uncertain attempt before any re-dispatch. */
  async function resolveUncertain(
    account: SessionAccount | null,
    dispatchId: string,
    outcome: ResolveUncertainRequest["outcome"],
  ): Promise<Dispatch> {
    const human = requireAccount(account);
    // Visibility FIRST, read-only: an invisible dispatch is uniformly 404,
    // never a 409 state oracle or a 403 that confirms the id exists.
    await db.transaction(
      async (tx) => {
        const visibleDispatch = await readDispatch(tx, dispatchId);
        const visible =
          (await canSeeWorkspace(tx, visibleDispatch.workspaceId, human.humanId)) &&
          hasAccess(
            (
              await projectAccessCeiling(tx, visibleDispatch.workspaceId, human.humanId, [
                visibleDispatch.projectId,
              ])
            ).get(visibleDispatch.projectId),
            "read",
            projectAccessAtLeast,
          );
        if (!visible) throw new RunnersError("dispatch_not_found");
      },
      { accessMode: "read only" },
    );

    let sessionToRollUp: string | undefined;
    const resolved = await db.transaction(async (tx) => {
      const [peek] = await tx
        .select({ issueId: runnerDispatches.issueId, runnerId: runnerDispatches.runnerId })
        .from(runnerDispatches)
        .where(eq(runnerDispatches.id, dispatchId))
        .limit(1);
      if (peek === undefined) throw new RunnersError("dispatch_not_found");
      // Global lock order: issues -> runners -> runner_dispatches -> work_sessions.
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, peek.issueId))
        .limit(1)
        .for("update");
      await tx
        .select({ id: runners.id })
        .from(runners)
        .where(eq(runners.id, peek.runnerId))
        .limit(1)
        .for("update");
      await tx
        .select({ id: runnerDispatches.id })
        .from(runnerDispatches)
        .where(eq(runnerDispatches.id, dispatchId))
        .limit(1)
        .for("update");
      const dispatch = await readDispatch(tx, dispatchId);
      // Re-check visibility inside the committing transaction, before state.
      if (
        !(await canSeeWorkspace(tx, dispatch.workspaceId, human.humanId)) ||
        !hasAccess(
          (
            await projectAccessCeiling(tx, dispatch.workspaceId, human.humanId, [
              dispatch.projectId,
            ])
          ).get(dispatch.projectId),
          "read",
          projectAccessAtLeast,
        )
      ) {
        throw new RunnersError("dispatch_not_found");
      }
      if (dispatch.state !== "uncertain") throw new RunnersError("dispatch_not_uncertain");
      const ceiling = await projectAccessCeiling(tx, dispatch.workspaceId, human.humanId, [
        dispatch.projectId,
      ]);
      const [host] = await tx
        .select({ humanId: runnerHosts.humanId })
        .from(runnerHosts)
        .where(eq(runnerHosts.id, dispatch.hostId))
        .limit(1);
      const authorized =
        human.humanId === dispatch.requestedByHumanId ||
        human.humanId === host?.humanId ||
        hasAccess(ceiling.get(dispatch.projectId), "manage", projectAccessAtLeast);
      if (!authorized) throw new RunnersError("runner_forbidden");

      if (dispatch.workSessionId !== null) {
        sessionToRollUp = dispatch.workSessionId;
        await tx
          .select({ id: workSessions.id })
          .from(workSessions)
          .where(eq(workSessions.id, dispatch.workSessionId))
          .limit(1)
          .for("update");
        await releaseIssueWorkSessions(tx, dispatch.issueId, outcome);
        await tx
          .update(issues)
          .set({ status: "todo", updatedAt: sql`statement_timestamp()` })
          .where(and(eq(issues.id, dispatch.issueId), eq(issues.status, "in_progress")));
      }
      await tx
        .update(dispatchTokens)
        .set({ revokedAt: sql`statement_timestamp()` })
        .where(and(eq(dispatchTokens.dispatchId, dispatchId), isNull(dispatchTokens.revokedAt)));
      await tx
        .update(runnerDispatches)
        .set({
          state: "ended",
          endedAt: sql`statement_timestamp()`,
          needsHumanResolution: false,
        })
        .where(eq(runnerDispatches.id, dispatchId));
      return toDispatch(await readDispatch(tx, dispatchId));
    });
    // The settlement ends the claim; roll its stream up immediately (after
    // commit) instead of waiting for the background safety-net sweep.
    if (sessionToRollUp !== undefined) {
      try {
        await rollUpSessionById(db, requireStore(), sessionToRollUp);
      } catch {
        // The settlement already committed; the background sweep will retry.
      }
    }
    return resolved;
  }

  /** Called at session end and by the lease-expiry sweep; never for live rows. */
  async function rollUp(limit = 20): Promise<number> {
    const objectStore = requireStore();
    // Only sessions that still have hot chunks; otherwise the first N ended
    // sessions would be re-uploaded forever and starve the rest.
    const hasHotChunks = exists(
      db
        .select({ one: sql`1` })
        .from(workSessionStreamChunks)
        .where(eq(workSessionStreamChunks.workSessionId, workSessions.id)),
    );
    const candidates = await db
      .select({ id: workSessions.id })
      .from(workSessions)
      .where(
        and(
          inArray(workSessions.status, ["completed", "released", "expired"]),
          isNotNull(workSessions.endedAt),
          hasHotChunks,
        ),
      )
      .orderBy(asc(workSessions.id))
      .limit(limit);
    let rolled = 0;
    for (const candidate of candidates) {
      if (await rollUpSessionById(db, objectStore, candidate.id)) rolled += 1;
    }
    return rolled;
  }

  return {
    ingest,
    read,
    reconnect,
    markDisconnected,
    resolveUncertain,
    rollUp,
    rollUpSession: (sessionId: string) => rollUpSessionById(db, requireStore(), sessionId),
  };
}

interface DispatchCreationInput extends DispatchOptions {
  runnerId: string;
  issueId: string;
  workspaceId: string;
  projectId: string;
  agentId: string;
  requestedByHumanId: string;
  prompt: string | undefined;
}

/**
 * Re-check every readiness rule while the issue row is locked. This closes the
 * scan-to-lock race between concurrent `autoClaim` and `createDispatch` calls:
 * a second transaction waits for the lock, then sees the first Dispatch and
 * skips the issue instead of claiming it again. The filter is also re-evaluated
 * under the lock so a re-assignment during the scan cannot be misread.
 */
async function assertIssueStillDispatchable(
  tx: DbTransaction,
  issueId: string,
  agentId: string,
  filter: ReadyWorkFilter,
): Promise<void> {
  const [issue] = await tx
    .select({
      deletedAt: issues.deletedAt,
      status: issues.status,
      needsInput: issues.needsInput,
      assigneeType: issues.assigneeType,
      assigneeId: issues.assigneeId,
    })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(and(eq(issues.id, issueId), isNull(issues.deletedAt), isNull(projects.deletedAt)))
    .limit(1);
  if (
    issue === undefined ||
    issue.deletedAt !== null ||
    issue.status !== "todo" ||
    issue.needsInput
  ) {
    throw new RunnersError("issue_not_claimable");
  }
  const unassigned = issue.assigneeType === null && issue.assigneeId === null;
  const mine = issue.assigneeType === "agent" && issue.assigneeId === agentId;
  const matches =
    filter === "unassigned" ? unassigned : filter === "assignedToMe" ? mine : unassigned || mine;
  if (!matches) throw new RunnersError("issue_not_claimable");

  const [blocker] = await tx
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .innerJoin(blockerIssue, eq(issueDependencies.blockedByIssueId, blockerIssue.id))
    .innerJoin(blockerProject, eq(blockerIssue.projectId, blockerProject.id))
    .where(
      and(
        eq(issueDependencies.issueId, issueId),
        isNull(blockerIssue.deletedAt),
        isNull(blockerProject.deletedAt),
        notInArray(blockerIssue.status, ["done", "cancelled"]),
      ),
    )
    .limit(1);
  if (blocker !== undefined) throw new RunnersError("issue_not_claimable");

  await endDispatchesWithoutLiveSession(tx, eq(runnerDispatches.issueId, issueId));
  const [dispatch] = await tx
    .select({ id: runnerDispatches.id })
    .from(runnerDispatches)
    .where(
      and(
        eq(runnerDispatches.issueId, issueId),
        inArray(runnerDispatches.state, ["pending", "active", "uncertain"]),
      ),
    )
    .limit(1);
  if (dispatch !== undefined) throw new RunnersError("issue_not_claimable");
}

/**
 * Insert one pending Dispatch row and build its outbox payload so callers
 * enqueue the command in the same transaction without drifting fields.
 */
async function insertDispatchRow(tx: DbTransaction, input: DispatchCreationInput) {
  const [created] = await tx
    .insert(runnerDispatches)
    .values({
      id: randomUUID(),
      runnerId: input.runnerId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      issueId: input.issueId,
      requestedByHumanId: input.requestedByHumanId,
      agentId: input.agentId,
      dispatchAttemptId: randomUUID(),
      state: "pending",
      prompt: input.prompt ?? null,
      harness: input.harness ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      createdAt: sql`statement_timestamp()`,
    })
    .returning({ id: runnerDispatches.id });
  const row = await readDispatch(tx, created!.id);
  const payload = {
    dispatchId: row.id,
    dispatchAttemptId: row.dispatchAttemptId,
    issueId: input.issueId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.harness === undefined ? {} : { harness: input.harness }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  };
  return { row, payload };
}

/** Create a Dispatch when the caller already holds the project and issue FOR UPDATE locks. */
async function insertDispatchLocked(
  tx: DbTransaction,
  input: DispatchCreationInput,
): Promise<Dispatch> {
  const [uncertain] = await tx
    .select({ id: runnerDispatches.id })
    .from(runnerDispatches)
    .where(
      and(eq(runnerDispatches.issueId, input.issueId), eq(runnerDispatches.state, "uncertain")),
    )
    .limit(1);
  if (uncertain !== undefined) throw new RunnersError("dispatch_uncertain");
  await assertIssueDispatchable(tx, input.issueId, input.agentId);
  const { row, payload } = await insertDispatchRow(tx, input);
  await enqueueRunnerCommand(tx, {
    runnerId: input.runnerId,
    dispatch: { id: row.id, dispatchAttemptId: row.dispatchAttemptId },
    kind: "dispatch",
    payload,
  });
  return toDispatch(row);
}

type ParsedIssueTarget =
  | { kind: "id"; id: string }
  | { kind: "key"; prefix: string; number: number; projectKeyHint: string | undefined };

function parseIssueTarget(target: string): ParsedIssueTarget {
  let value = target.trim();
  let projectKeyHint: string | undefined;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const parts = parsed.pathname.split("/").filter((part) => part !== "");
      const issueIndex = parts.lastIndexOf("issues");
      const candidate = issueIndex >= 0 ? parts[issueIndex + 1] : parts.at(-1);
      if (candidate === undefined) throw new Error("no issue in URL");
      const projectIndex = parts.indexOf("projects");
      if (projectIndex >= 0) projectKeyHint = parts[projectIndex + 1];
      value = decodeURIComponent(candidate);
    } catch (error) {
      throw new RunnersError(
        "issue_not_found",
        undefined,
        `Could not read an issue from the URL: ${String(error)}`,
      );
    }
  }
  const key = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/i.exec(value);
  if (key !== null && key[1] !== undefined && key[2] !== undefined) {
    // `issues.number` is int4; an oversized key must be a clean 404, never a
    // Postgres 22003 overflow surfacing as a 500.
    const number = Number(key[2]);
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
      throw new RunnersError("issue_not_found");
    }
    return {
      kind: "key",
      prefix: key[1].toUpperCase(),
      number,
      projectKeyHint: projectKeyHint?.toUpperCase(),
    };
  }
  return { kind: "id", id: value };
}

const workspaceSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

/**
 * Resolve a CLI target across every workspace the Runner host owner can see,
 * requiring Contribute access. A key matching two workspaces is never guessed:
 * the error lists them so the caller can pass --workspace.
 */
async function resolveIssueForHost(
  deps: RunnersDeps,
  tx: DbTransaction,
  credential: string | undefined,
  request: IssueResolveRequest,
): Promise<IssueResolveResponse> {
  const host = await readHostByCredential(tx, credential);
  const parsed = parseIssueTarget(request.target);
  const personal = await tx
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, host.humanId));
  const shared = await tx
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, host.humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    );
  const scopes = [...new Map([...personal, ...shared].map((row) => [row.id, row])).values()];
  const candidates =
    request.workspace === undefined
      ? scopes
      : scopes.filter(
          (scope) =>
            scope.id === request.workspace ||
            scope.name.toLowerCase() === request.workspace?.toLowerCase() ||
            workspaceSlug(scope.name) === request.workspace?.toLowerCase(),
        );
  if (candidates.length === 0) throw new RunnersError("workspace_not_found");

  const matches: IssueResolveResponse[] = [];
  for (const scope of candidates) {
    const projectsInScope = await tx
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(and(eq(projects.workspaceId, scope.id), isNull(projects.deletedAt)));
    if (projectsInScope.length === 0) continue;
    const ceiling = await deps.projectAccessCeiling(
      tx,
      scope.id,
      host.humanId,
      projectsInScope.map((project) => project.id),
    );
    const actionable = projectsInScope.filter(
      (project) =>
        (parsed.kind !== "key" ||
          parsed.projectKeyHint === undefined ||
          project.key.toUpperCase() === parsed.projectKeyHint) &&
        hasAccess(ceiling.get(project.id), "contribute", deps.projectAccessAtLeast),
    );
    if (actionable.length === 0) continue;
    const projectIds = actionable.map((project) => project.id);
    const rows = await tx
      .select({
        id: issues.id,
        projectId: issues.projectId,
        number: issues.number,
        title: issues.title,
        deletedAt: issues.deletedAt,
        key: projects.key,
      })
      .from(issues)
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          inArray(issues.projectId, projectIds),
          isNull(issues.deletedAt),
          isNull(projects.deletedAt),
          parsed.kind === "id"
            ? eq(issues.id, parsed.id)
            : and(eq(projects.key, parsed.prefix), eq(issues.number, parsed.number)),
        ),
      )
      .limit(5);
    for (const row of rows) {
      matches.push({
        issueId: row.id,
        workspaceId: scope.id,
        workspaceName: scope.name,
        projectId: row.projectId,
        projectKey: row.key,
        identifier: `${row.key}-${row.number}`,
        number: row.number,
        title: row.title,
      });
    }
  }
  if (matches.length === 0) throw new RunnersError("issue_not_found");
  if (matches.length > 1) {
    const listing = matches
      .map((match) => `${match.identifier} in ${match.workspaceName} (${match.workspaceId})`)
      .join("; ");
    throw new RunnersError(
      "issue_ambiguous",
      undefined,
      `Matches ${matches.length} workspaces: ${listing}`,
    );
  }
  return matches[0]!;
}

export function createRunnersService(deps: RunnersDeps) {
  const { db, publicUrl, projectAccessCeiling, projectAccessAtLeast, claimWorkSession } = deps;
  const stream = createStreamHelpers(deps);
  // ONE listener for the whole replica, lazily started on the first long-poll.
  const notifier = deps.sql === undefined ? undefined : createCommandNotifier(deps.sql);

  /** Live host/runner/workspace/project check shared by poll and ack. */
  const readRunnerAccessForCommands = async (
    tx: DbTransaction,
    credential: string | undefined,
    runnerId: string,
  ) => {
    const host = await readHostByCredential(tx, credential, true);
    const [joined] = await tx
      .select({
        hostId: runners.hostId,
        workspaceId: runners.workspaceId,
        projectId: runners.projectId,
        runnerRevokedAt: runners.revokedAt,
        hostRevokedAt: runnerHosts.revokedAt,
        projectDeletedAt: projects.deletedAt,
      })
      .from(runners)
      .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
      .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
      .innerJoin(projects, eq(runners.projectId, projects.id))
      .where(eq(runners.id, runnerId))
      .limit(1);
    if (joined === undefined || joined.hostId !== host.host.id) {
      throw new RunnersError("runner_not_found");
    }
    let revoked =
      joined.runnerRevokedAt !== null ||
      joined.hostRevokedAt !== null ||
      joined.projectDeletedAt !== null ||
      host.deactivatedAt !== null;
    if (!revoked && !(await canSeeWorkspace(tx, joined.workspaceId, host.humanId))) {
      revoked = true;
    }
    if (!revoked) {
      const ceiling = await projectAccessCeiling(tx, joined.workspaceId, host.humanId, [
        joined.projectId,
      ]);
      if (!hasAccess(ceiling.get(joined.projectId), "read", projectAccessAtLeast)) {
        revoked = true;
      }
    }
    return { host, joined, revoked };
  };

  return {
    async createDeviceCode(input: CreateDeviceCodeRequest): Promise<DeviceCodeResponse> {
      const deviceCode = `${DEVICE_CODE_PREFIX}${randomBytes(32).toString("hex")}`;
      const userCode = randomUserCode();
      const [row] = await db
        .insert(runnerDeviceCodes)
        .values({
          id: randomUUID(),
          deviceCodeHash: tokenHash(deviceCode),
          userCode,
          verifierHash: input.verifierHash,
          hostDisplayName: input.hostDisplayName,
          platform: input.platform,
          expiresAt: sql`statement_timestamp() + interval '10 minutes'`,
        })
        .returning({ expiresAt: runnerDeviceCodes.expiresAt });
      return {
        deviceCode,
        userCode,
        verificationUri: `${publicUrl.replace(/\/$/, "")}/device?code=${encodeURIComponent(userCode)}`,
        expiresAt: row!.expiresAt.toISOString(),
      };
    },

    async previewDeviceCode(userCode: string) {
      const [row] = await db
        .select({ code: runnerDeviceCodes, notExpired: deviceCodeNotExpired })
        .from(runnerDeviceCodes)
        .where(
          and(
            eq(runnerDeviceCodes.userCode, userCode),
            isNull(runnerDeviceCodes.usedAt),
            isNull(runnerDeviceCodes.approvedAt),
          ),
        );
      if (
        row === undefined ||
        !row.notExpired ||
        row.code.failedAttempts >= MAX_FAILED_VERIFIER_ATTEMPTS
      ) {
        throw new RunnersError("device_code_invalid");
      }
      return {
        userCode: row.code.userCode,
        hostDisplayName: row.code.hostDisplayName,
        platform: row.code.platform,
        expiresAt: row.code.expiresAt.toISOString(),
      };
    },

    async approveDeviceCode(account: SessionAccount | null, userCode: string) {
      const human = requireAccount(account);
      // Failures are returned from the transaction (rather than thrown) so that
      // the rate-limit increment commits before the caller sees the error.
      const result = await db.transaction(async (tx) => {
        // Lock the human's attempt row so concurrent typos cannot bypass the cap.
        await tx
          .insert(runnerDeviceCodeAttempts)
          .values({ humanId: human.humanId, failedCount: 0 })
          .onConflictDoNothing();
        const [attempt] = await tx
          .select({
            failedCount: runnerDeviceCodeAttempts.failedCount,
            expired: attemptWindowExpired,
          })
          .from(runnerDeviceCodeAttempts)
          .where(eq(runnerDeviceCodeAttempts.humanId, human.humanId))
          .for("update");
        let failedCount = attempt?.failedCount ?? 0;
        if (attempt?.expired === true && failedCount > 0) {
          await tx
            .update(runnerDeviceCodeAttempts)
            .set({ failedCount: 0, windowStartedAt: sql`statement_timestamp()` })
            .where(eq(runnerDeviceCodeAttempts.humanId, human.humanId));
          failedCount = 0;
        }
        if (failedCount >= MAX_FAILED_USER_CODE_ATTEMPTS) {
          return { error: "device_code_rate_limited" as const };
        }

        const [row] = await tx
          .select({ code: runnerDeviceCodes, notExpired: deviceCodeNotExpired })
          .from(runnerDeviceCodes)
          .where(
            and(
              eq(runnerDeviceCodes.userCode, userCode),
              isNull(runnerDeviceCodes.usedAt),
              isNull(runnerDeviceCodes.approvedAt),
              sql`${runnerDeviceCodes.failedAttempts} < ${MAX_FAILED_VERIFIER_ATTEMPTS}`,
            ),
          )
          .for("update");
        if (row === undefined) {
          await tx
            .update(runnerDeviceCodeAttempts)
            .set({
              failedCount: sql`least(${runnerDeviceCodeAttempts.failedCount} + 1, ${MAX_FAILED_USER_CODE_ATTEMPTS})`,
            })
            .where(eq(runnerDeviceCodeAttempts.humanId, human.humanId));
          return { error: "device_code_invalid" as const };
        }
        if (!row.notExpired) return { error: "device_code_expired" as const };

        await tx
          .update(runnerDeviceCodes)
          .set({ humanId: human.humanId, approvedAt: sql`statement_timestamp()` })
          .where(eq(runnerDeviceCodes.id, row.code.id));
        // A successful approval clears the human's failed-attempt window.
        await tx
          .delete(runnerDeviceCodeAttempts)
          .where(eq(runnerDeviceCodeAttempts.humanId, human.humanId));
        return { hostDisplayName: row.code.hostDisplayName, platform: row.code.platform };
      });
      if ("error" in result) throw new RunnersError(result.error);
      return result;
    },

    async exchangeDeviceCode(input: ExchangeDeviceCodeRequest): Promise<HostCredentialResponse> {
      // As above, verifier failures must commit their capped increment.
      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ code: runnerDeviceCodes, notExpired: deviceCodeNotExpired })
          .from(runnerDeviceCodes)
          .where(eq(runnerDeviceCodes.deviceCodeHash, tokenHash(input.deviceCode)))
          .for("update");
        if (row === undefined) return { error: "device_code_invalid" as const };
        if (row.code.usedAt !== null) return { error: "device_code_used" as const };
        if (!row.notExpired) return { error: "device_code_expired" as const };
        if (row.code.approvedAt === null || row.code.humanId === null)
          return { error: "device_code_pending" as const };
        if (row.code.failedAttempts >= MAX_FAILED_VERIFIER_ATTEMPTS)
          return { error: "too_many_attempts" as const };

        if (row.code.verifierHash !== tokenHash(input.verifier)) {
          await tx
            .update(runnerDeviceCodes)
            .set({
              failedAttempts: sql`least(${runnerDeviceCodes.failedAttempts} + 1, ${MAX_FAILED_VERIFIER_ATTEMPTS})`,
            })
            .where(eq(runnerDeviceCodes.id, row.code.id));
          return { error: "invalid_verifier" as const };
        }

        const humanId = row.code.humanId;
        const [human] = await tx
          .select({ deactivatedAt: humans.deactivatedAt })
          .from(humans)
          .where(eq(humans.id, humanId));
        if (human === undefined || human.deactivatedAt !== null)
          return { error: "invalid_credential" as const };

        const credential = `${HOST_CREDENTIAL_PREFIX}${randomBytes(32).toString("hex")}`;
        const [host] = await tx
          .insert(runnerHosts)
          .values({
            id: randomUUID(),
            humanId,
            displayName: row.code.hostDisplayName,
            platform: row.code.platform,
            credentialHash: tokenHash(credential),
            lastSeenAt: sql`statement_timestamp()`,
          })
          .returning();
        await tx
          .update(runnerDeviceCodes)
          .set({ usedAt: sql`statement_timestamp()` })
          .where(eq(runnerDeviceCodes.id, row.code.id));
        return {
          credential: {
            hostId: host!.id,
            credential,
            displayName: host!.displayName,
            platform: host!.platform,
          },
        };
      });
      if ("error" in result) throw new RunnersError(result.error);
      return result.credential;
    },

    async registerRunner(
      credential: string | undefined,
      input: RegisterRunnerRequest,
    ): Promise<Runner> {
      return db.transaction(async (tx) => {
        const host = await readHostByCredential(tx, credential);
        // Workspace first: never reveal whether a project id exists in a workspace
        // the host owner cannot see.
        if (!(await canSeeWorkspace(tx, input.workspaceId, host.humanId))) {
          throw new RunnersError("workspace_not_found");
        }
        const [project] = await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.workspaceId, input.workspaceId),
              isNull(projects.deletedAt),
            ),
          );
        if (project === undefined) throw new RunnersError("project_not_found");
        const ceiling = await projectAccessCeiling(tx, input.workspaceId, host.humanId, [
          input.projectId,
        ]);
        if (!hasAccess(ceiling.get(input.projectId), "contribute", projectAccessAtLeast)) {
          throw new RunnersError("project_not_found");
        }

        let agentId: string;
        if (input.agentId === undefined) {
          const [defaultAgent] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.humanId, host.humanId))
            .orderBy(agents.createdAt)
            .limit(1);
          if (defaultAgent === undefined) throw new RunnersError("no_default_agent");
          agentId = defaultAgent.id;
        } else {
          const [ownedAgent] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, input.agentId), eq(agents.humanId, host.humanId)));
          if (ownedAgent === undefined) throw new RunnersError("agent_not_found");
          agentId = ownedAgent.id;
        }

        // The runner sends an opaque digest of its checkout, never a local path.
        const fingerprint = input.repoFingerprint;
        // Ephemeral one-shot runners are single-use: never reuse or clobber a
        // persistent Runner row (and never inherit its presence or commands).
        const [existing] = input.ephemeral
          ? []
          : await tx
              .select({ id: runners.id, harnessCatalog: runners.harnessCatalog })
              .from(runners)
              .where(
                and(
                  eq(runners.hostId, host.host.id),
                  eq(runners.workspaceId, input.workspaceId),
                  eq(runners.projectId, input.projectId),
                  eq(runners.repoFingerprint, fingerprint),
                  isNull(runners.revokedAt),
                ),
              );
        if (existing !== undefined) {
          await tx
            .update(runners)
            .set({
              agentId,
              displayName: input.displayName ?? host.host.displayName,
              capabilities: input.capabilities,
              maxConcurrency: input.maxConcurrency,
              activeSlotCount: 0,
              lastSeenAt: sql`statement_timestamp()`,
              disconnectedAt: null,
              ...(input.harnessCatalog === undefined
                ? {}
                : {
                    // Re-registration with a catalog merges, never regresses.
                    harnessCatalog: mergeHarnessCatalog(
                      existing.harnessCatalog ?? EMPTY_CATALOG,
                      input.harnessCatalog,
                    ),
                  }),
            })
            .where(eq(runners.id, existing.id));
          const row = await joinRunner(tx, existing.id);
          if (row === undefined) throw new RunnersError("runner_not_found");
          return toRunnerResponse(row);
        }

        const [created] = await tx
          .insert(runners)
          .values({
            id: randomUUID(),
            hostId: host.host.id,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            agentId,
            displayName: input.displayName ?? host.host.displayName,
            repoFingerprint: fingerprint,
            capabilities: input.capabilities,
            maxConcurrency: input.maxConcurrency,
            activeSlotCount: 0,
            ...(input.harnessCatalog === undefined ? {} : { harnessCatalog: input.harnessCatalog }),
          })
          .returning({ id: runners.id });
        const row = await joinRunner(tx, created!.id);
        if (row === undefined) throw new RunnersError("runner_not_found");
        return toRunnerResponse(row);
      });
    },

    /**
     * Publishes a Runner's live Harness catalog. The submitted catalog is
     * merged with the stored one so a slower startup probe or later refresh
     * never regresses a previously known model's effort levels (issue #240).
     */
    async updateRunnerCatalog(
      credential: string | undefined,
      runnerId: string,
      input: HarnessCatalog,
    ): Promise<Runner> {
      return db.transaction(async (tx) => {
        const { runner } = await authenticateHostRunnerForDeps(deps, tx, credential, runnerId);
        const merged = mergeHarnessCatalog(runner.harnessCatalog ?? EMPTY_CATALOG, input);
        await tx.update(runners).set({ harnessCatalog: merged }).where(eq(runners.id, runnerId));
        const row = await joinRunner(tx, runnerId);
        if (row === undefined) throw new RunnersError("runner_not_found");
        return toRunnerResponse(row);
      });
    },

    async heartbeat(credential: string | undefined, runnerId: string, input: HeartbeatRequest) {
      return db.transaction(async (tx) => {
        const host = await readHostByCredential(tx, credential);
        const [runner] = await tx.select().from(runners).where(eq(runners.id, runnerId));
        if (runner === undefined || runner.hostId !== host.host.id)
          throw new RunnersError("runner_not_found");
        if (runner.revokedAt !== null) throw new RunnersError("runner_revoked");
        if (!(await canSeeWorkspace(tx, runner.workspaceId, host.humanId))) {
          throw new RunnersError("runner_revoked");
        }
        const ceiling = await projectAccessCeiling(tx, runner.workspaceId, host.humanId, [
          runner.projectId,
        ]);
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, runner.projectId), isNull(projects.deletedAt)))
          .limit(1);
        if (
          project === undefined ||
          !hasAccess(ceiling.get(runner.projectId), "read", projectAccessAtLeast)
        ) {
          throw new RunnersError("runner_revoked");
        }
        if (input.activeSlotCount > runner.maxConcurrency)
          throw new RunnersError("slot_count_invalid");

        await tx
          .update(runners)
          .set({
            lastSeenAt: sql`statement_timestamp()`,
            activeSlotCount: input.activeSlotCount,
            disconnectedAt: null,
          })
          .where(eq(runners.id, runnerId));
        await tx
          .update(runnerHosts)
          .set({ lastSeenAt: sql`statement_timestamp()` })
          .where(eq(runnerHosts.id, host.host.id));
        const row = await joinRunner(tx, runnerId);
        if (row === undefined) throw new RunnersError("runner_not_found");
        return toRunnerResponse(row);
      });
    },

    async listWorkspaceRunners(
      account: SessionAccount | null,
      workspaceId: string,
    ): Promise<WorkspaceRunnersFleet> {
      const human = requireAccount(account);
      return db.transaction(async (tx) => {
        if (!(await canSeeWorkspace(tx, workspaceId, human.humanId))) {
          throw new RunnersError("workspace_not_found");
        }
        const rows = await tx
          .select({ runner: runnerFields, host: runnerHosts })
          .from(runners)
          .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
          .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
          .innerJoin(projects, eq(runners.projectId, projects.id))
          .where(
            and(
              eq(runners.workspaceId, workspaceId),
              isNull(runners.revokedAt),
              isNull(runnerHosts.revokedAt),
              isNull(humans.deactivatedAt),
              isNull(projects.deletedAt),
            ),
          );
        const projectIds = [...new Set(rows.map((row) => row.runner.projectId))];
        const ceiling = await projectAccessCeiling(tx, workspaceId, human.humanId, projectIds);
        const visible = rows.filter((row) =>
          hasAccess(ceiling.get(row.runner.projectId), "read", projectAccessAtLeast),
        );

        const byHost = new Map<string, FleetRunnerHost>();
        for (const row of visible) {
          const runner = toRunnerResponse(row.runner);
          const canRevoke = row.host.humanId === human.humanId;
          let group = byHost.get(row.host.id);
          if (group === undefined) {
            group = { host: toHostResponse(row.host), presence: "offline", canRevoke, runners: [] };
            byHost.set(row.host.id, group);
          }
          const fleetRunner: FleetRunner = {
            ...runner,
            hostDisplayName: row.host.displayName,
            hostPlatform: row.host.platform,
            canRevoke,
          };
          group.runners.push(fleetRunner);
          if (
            runner.presence === "busy" ||
            (group.presence === "offline" && runner.presence === "online")
          ) {
            group.presence = runner.presence === "busy" ? "busy" : "online";
          }
        }
        return { hosts: [...byHost.values()] };
      });
    },

    /**
     * Owner-only manual dispatch. A teammate with project access can see the
     * Runner in the Fleet but gets 403 here; a non-member gets 404 on the issue.
     */
    async createDispatch(
      account: SessionAccount | null,
      issueId: string,
      runnerId: string,
      input: CreateDispatchRequest,
    ): Promise<Dispatch> {
      const human = requireAccount(account);
      return db.transaction(async (tx) => {
        const [issue] = await tx
          .select({
            id: issues.id,
            projectId: issues.projectId,
            workspaceId: projects.workspaceId,
            deletedAt: issues.deletedAt,
          })
          .from(issues)
          .innerJoin(projects, eq(issues.projectId, projects.id))
          .where(and(eq(issues.id, issueId), isNull(projects.deletedAt)))
          .limit(1);
        if (
          issue === undefined ||
          issue.deletedAt !== null ||
          !(await canSeeWorkspace(tx, issue.workspaceId, human.humanId))
        ) {
          throw new RunnersError("issue_not_found");
        }
        const callerCeiling = await projectAccessCeiling(tx, issue.workspaceId, human.humanId, [
          issue.projectId,
        ]);
        if (!hasAccess(callerCeiling.get(issue.projectId), "read", projectAccessAtLeast)) {
          throw new RunnersError("issue_not_found");
        }

        const [joined] = await tx
          .select({
            runner: runnerFields,
            hostHumanId: runnerHosts.humanId,
            hostRevokedAt: runnerHosts.revokedAt,
            deactivatedAt: humans.deactivatedAt,
          })
          .from(runners)
          .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
          .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
          .where(eq(runners.id, runnerId))
          .limit(1);
        if (joined === undefined) throw new RunnersError("runner_not_found");
        if (joined.hostHumanId !== human.humanId) throw new RunnersError("runner_forbidden");
        if (
          joined.hostRevokedAt !== null ||
          joined.runner.revokedAt !== null ||
          joined.deactivatedAt !== null
        ) {
          throw new RunnersError("runner_unavailable");
        }
        if (
          joined.runner.workspaceId !== issue.workspaceId ||
          joined.runner.projectId !== issue.projectId
        ) {
          throw new RunnersError("runner_not_for_issue");
        }
        if (
          joined.runner.presence === "offline" ||
          (joined.runner.presence === "busy" &&
            joined.runner.activeSlotCount >= joined.runner.maxConcurrency)
        ) {
          throw new RunnersError("runner_unavailable");
        }
        // The Runner is the authority on what its Harnesses can do, but an id
        // it never published can never resolve locally: refuse it here while
        // the caller still has the modal open (issue #241).
        const publishedHarnesses = joined.runner.harnessCatalog?.harnesses ?? [];
        if (
          input.harness !== undefined &&
          publishedHarnesses.length > 0 &&
          !publishedHarnesses.some((entry) => entry.id === input.harness)
        ) {
          throw new RunnersError(
            "harness_unavailable",
            undefined,
            `This Runner reports: ${publishedHarnesses.map((entry) => entry.id).join(", ")}.`,
          );
        }

        const agentId = input.agentId ?? joined.runner.agentId;
        // A prompt that is only whitespace is the same as no prompt; a kept
        // prompt is stored trimmed so Live Studio never shows padding.
        const requestedPrompt = input.prompt ?? "";
        const prompt = requestedPrompt.trim() === "" ? undefined : requestedPrompt.trim();
        const [agent] = await tx
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.humanId, joined.hostHumanId)))
          .limit(1);
        if (agent === undefined) throw new RunnersError("agent_not_found");
        const ceiling = await projectAccessCeiling(tx, issue.workspaceId, joined.hostHumanId, [
          issue.projectId,
        ]);
        if (!hasAccess(ceiling.get(issue.projectId), "contribute", projectAccessAtLeast)) {
          throw new RunnersError("insufficient_dispatch_access");
        }
        // Lock the project row first, then the issue row (global lock order:
        // projects -> issues) before checking uncertain dispatches so
        // markDisconnected and project Trash cannot race this check.
        const [activeProject] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, issue.projectId),
              eq(projects.workspaceId, issue.workspaceId),
              isNull(projects.deletedAt),
            ),
          )
          .for("no key update")
          .limit(1);
        if (activeProject === undefined) throw new RunnersError("issue_not_found");
        const [lockedIssue] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, issueId), isNull(issues.deletedAt)))
          .limit(1)
          .for("update");
        if (lockedIssue === undefined) throw new RunnersError("issue_not_found");
        // A disconnected write may have happened but not been acknowledged.
        // Never start a second attempt on this issue until a human resolves it.
        const [uncertain] = await tx
          .select({ id: runnerDispatches.id })
          .from(runnerDispatches)
          .where(
            and(eq(runnerDispatches.issueId, issueId), eq(runnerDispatches.state, "uncertain")),
          )
          .limit(1);
        if (uncertain !== undefined) throw new RunnersError("dispatch_uncertain");
        await endDispatchesWithoutLiveSession(tx, eq(runnerDispatches.issueId, issueId));
        const [inFlight] = await tx
          .select({ id: runnerDispatches.id })
          .from(runnerDispatches)
          .where(
            and(
              eq(runnerDispatches.issueId, issueId),
              inArray(runnerDispatches.state, ["pending", "active"]),
            ),
          )
          .limit(1);
        if (inFlight !== undefined) throw new RunnersError("issue_not_claimable");
        // Validate with Orrery's claim rules, without mutating issues.assignee.
        await assertIssueDispatchable(tx, issueId, agentId);

        const { row, payload } = await insertDispatchRow(tx, {
          runnerId,
          issueId,
          workspaceId: issue.workspaceId,
          projectId: issue.projectId,
          agentId,
          requestedByHumanId: human.humanId,
          prompt,
          harness: input.harness,
          model: input.model,
          effort: input.effort,
        });
        await enqueueRunnerCommand(tx, {
          runnerId,
          dispatch: { id: row.id, dispatchAttemptId: row.dispatchAttemptId },
          kind: "dispatch",
          payload,
        });
        return toDispatch(row);
      });
    },

    /**
     * `--auto-claim`: atomically pick the next ready issue for this Runner's
     * bound project and Agent through the very same Dispatch creation path as
     * manual delegation. A null result means "nothing dispatchable right now".
     */
    async autoClaim(
      credential: string | undefined,
      runnerId: string,
      filter: ReadyWorkFilter = "assignedToMe",
    ): Promise<AutoClaimResponse> {
      return db.transaction(async (tx) => {
        // Read-only live checks first. Locking `runners` here would invert the
        // global issues -> runners -> runner_dispatches order when we later
        // lock the issue row, so the locking check happens after the scan.
        const scanned = await authenticateHostRunnerForDeps(
          deps,
          tx,
          credential,
          runnerId,
          false,
          "contribute",
        );
        const scannedAgentId = scanned.runner.agentId;

        // Mirrors work-sessions' `readyWork` readiness rules, plus dispatch
        // state: no live session, no open blocker, no pending/active/uncertain
        // Dispatch, and never a trashed, closed or input-blocked issue.
        const liveSession = and(
          eq(workSessions.issueId, issues.id),
          eq(workSessions.status, "active"),
          gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
        );
        const noOpenBlocker = notExists(
          tx
            .select({ id: issueDependencies.id })
            .from(issueDependencies)
            .innerJoin(blockerIssue, eq(issueDependencies.blockedByIssueId, blockerIssue.id))
            .innerJoin(blockerProject, eq(blockerIssue.projectId, blockerProject.id))
            .where(
              and(
                eq(issueDependencies.issueId, issues.id),
                isNull(blockerIssue.deletedAt),
                isNull(blockerProject.deletedAt),
                notInArray(blockerIssue.status, ["done", "cancelled"]),
              ),
            ),
        );
        const noActiveDispatch = notExists(
          tx
            .select({ id: runnerDispatches.id })
            .from(runnerDispatches)
            .where(
              and(
                eq(runnerDispatches.issueId, issues.id),
                inArray(runnerDispatches.state, ["pending", "active", "uncertain"]),
              ),
            ),
        );
        const assignee =
          filter === "unassigned"
            ? isNull(issues.assigneeId)
            : filter === "assignedToMe"
              ? and(eq(issues.assigneeType, "agent"), eq(issues.assigneeId, scannedAgentId))
              : or(
                  isNull(issues.assigneeId),
                  and(eq(issues.assigneeType, "agent"), eq(issues.assigneeId, scannedAgentId)),
                );
        const candidates = await tx
          .select({ id: issues.id })
          .from(issues)
          .innerJoin(projects, eq(issues.projectId, projects.id))
          .leftJoin(workSessions, liveSession)
          .where(
            and(
              eq(issues.projectId, scanned.runner.projectId),
              isNull(issues.deletedAt),
              isNull(projects.deletedAt),
              eq(issues.status, "todo"),
              eq(issues.needsInput, false),
              isNull(workSessions.id),
              noOpenBlocker,
              noActiveDispatch,
              assignee,
            ),
          )
          .orderBy(issues.number)
          .limit(10);
        if (candidates.length === 0) return { dispatch: null };

        // Lock the project first, then every candidate issue in ONE ascending
        // pass (global lock order: projects -> issues -> runners).
        const [activeProject] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, scanned.runner.projectId),
              eq(projects.workspaceId, scanned.runner.workspaceId),
              isNull(projects.deletedAt),
            ),
          )
          .for("no key update")
          .limit(1);
        if (activeProject === undefined) return { dispatch: null };

        const locked = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            inArray(
              issues.id,
              candidates.map((row) => row.id),
            ),
          )
          .orderBy(asc(issues.id))
          .for("update");
        const held = new Set(locked.map((row) => row.id));

        // Only now lock the runner and re-verify revocation, membership,
        // contribute access and the slot ceiling under that lock.
        const { host, runner } = await authenticateHostRunnerForDeps(
          deps,
          tx,
          credential,
          runnerId,
          true,
          "contribute",
        );
        if (runner.agentId !== scannedAgentId) return { dispatch: null };
        await endDispatchesWithoutLiveSession(tx, eq(runnerDispatches.runnerId, runnerId));

        const [active] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(runnerDispatches)
          .where(
            and(
              eq(runnerDispatches.runnerId, runnerId),
              inArray(runnerDispatches.state, ["active", "uncertain"]),
            ),
          );
        const [queued] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(runnerDispatches)
          .where(
            and(eq(runnerDispatches.runnerId, runnerId), eq(runnerDispatches.state, "pending")),
          );
        // `activeSlotCount` can lag between acceptDispatch and the next
        // heartbeat; the live active-dispatch count is the safer upper bound.
        if (
          Math.max(runner.activeSlotCount, active?.count ?? 0) + (queued?.count ?? 0) >=
          runner.maxConcurrency
        ) {
          return { dispatch: null };
        }

        for (const candidate of candidates) {
          if (!held.has(candidate.id)) continue;
          try {
            await assertIssueStillDispatchable(tx, candidate.id, runner.agentId, filter);
            const dispatch = await insertDispatchLocked(tx, {
              runnerId,
              issueId: candidate.id,
              workspaceId: runner.workspaceId,
              projectId: runner.projectId,
              agentId: runner.agentId,
              requestedByHumanId: host.humanId,
              prompt: undefined,
              harness: undefined,
              model: undefined,
              effort: undefined,
            });
            return { dispatch };
          } catch (error) {
            // A candidate can become unclaimable between the scan and the
            // lock; skip it and try the next one in the same transaction.
            if (
              error instanceof RunnersError &&
              (error.kind === "issue_not_claimable" ||
                error.kind === "issue_not_dispatchable" ||
                error.kind === "issue_not_found" ||
                error.kind === "dispatch_uncertain")
            ) {
              continue;
            }
            throw error;
          }
        }
        return { dispatch: null };
      });
    },

    /** One-shot `orrery-runner work`: create one Dispatch for a resolved issue. */
    async createRunnerDispatch(
      credential: string | undefined,
      runnerId: string,
      input: RunnerDispatchRequest,
    ): Promise<Dispatch> {
      const issueId = input.issueId;
      const requestedPrompt = input.prompt ?? "";
      // Same normalization as the manual path: trimmed, empty means omitted.
      const prompt = requestedPrompt.trim() === "" ? undefined : requestedPrompt.trim();
      return db.transaction(async (tx) => {
        // Read-only live check, then lock projects -> issues -> runners.
        const scanned = await authenticateHostRunnerForDeps(
          deps,
          tx,
          credential,
          runnerId,
          false,
          "contribute",
        );
        const [project] = await tx
          .select({ workspaceId: projects.workspaceId })
          .from(projects)
          .where(
            and(
              eq(projects.id, scanned.runner.projectId),
              eq(projects.workspaceId, scanned.runner.workspaceId),
              isNull(projects.deletedAt),
            ),
          )
          .for("no key update")
          .limit(1);
        if (project === undefined) throw new RunnersError("issue_not_found");
        const [issue] = await tx
          .select({
            projectId: issues.projectId,
            workspaceId: projects.workspaceId,
            deletedAt: issues.deletedAt,
          })
          .from(issues)
          .innerJoin(projects, eq(issues.projectId, projects.id))
          .where(and(eq(issues.id, issueId), isNull(issues.deletedAt), isNull(projects.deletedAt)))
          .limit(1)
          .for("update", { of: issues });
        const { host, runner } = await authenticateHostRunnerForDeps(
          deps,
          tx,
          credential,
          runnerId,
          true,
          "contribute",
        );
        if (
          issue === undefined ||
          issue.deletedAt !== null ||
          project.workspaceId !== runner.workspaceId ||
          issue.projectId !== runner.projectId
        ) {
          throw new RunnersError("issue_not_found");
        }
        await assertIssueStillDispatchable(tx, issueId, runner.agentId, "all");
        return await insertDispatchLocked(tx, {
          runnerId,
          issueId,
          workspaceId: project.workspaceId,
          projectId: issue.projectId,
          agentId: runner.agentId,
          requestedByHumanId: host.humanId,
          prompt,
          harness: input.harness,
          model: input.model,
          effort: input.effort,
        });
      });
    },

    /** Resolve a CLI target across workspaces without guessing an ambiguous key. */
    async resolveIssue(
      credential: string | undefined,
      request: IssueResolveRequest,
    ): Promise<IssueResolveResponse> {
      return db.transaction((tx) => resolveIssueForHost(deps, tx, credential, request));
    },

    /** Ephemeral one-shot teardown: revoke the Runner and its Dispatch tokens. */
    async markRunnerOffline(
      credential: string | undefined,
      runnerId: string,
    ): Promise<{ runnerId: string; revokedRunners: number }> {
      return db.transaction(async (tx) => {
        const host = await readHostByCredential(tx, credential);
        // Lock the runner first, then settle its dispatches (global order:
        // runners -> runner_dispatches); this path holds no issue lock.
        const [runner] = await tx
          .select()
          .from(runners)
          .where(eq(runners.id, runnerId))
          .limit(1)
          .for("update");
        if (runner === undefined || runner.hostId !== host.host.id) {
          throw new RunnersError("runner_not_found");
        }
        if (!(await canSeeWorkspace(tx, runner.workspaceId, host.humanId))) {
          throw new RunnersError("runner_revoked");
        }
        const ceiling = await deps.projectAccessCeiling(tx, runner.workspaceId, host.humanId, [
          runner.projectId,
        ]);
        if (!hasAccess(ceiling.get(runner.projectId), "read", deps.projectAccessAtLeast)) {
          throw new RunnersError("runner_revoked");
        }
        // Idempotent teardown: a retry (e.g. after a SIGTERM race) is a clean
        // no-op, never a 401 that would leave an orphaned Runner behind.
        if (runner.revokedAt !== null) return { runnerId, revokedRunners: 0 };

        await tx
          .update(runners)
          .set({ revokedAt: sql`statement_timestamp()`, activeSlotCount: 0 })
          .where(and(eq(runners.id, runnerId), isNull(runners.revokedAt)));
        // Revokes every token AND enqueues cancel/settles any stranded
        // pending/active/uncertain dispatch in this same transaction.
        await revokeDispatchTokensForRunners(tx, [runnerId], "runner_offline");
        return { runnerId, revokedRunners: 1 };
      });
    },

    /** List a human's dispatches for an issue (never a cross-member directory). */
    async listIssueDispatches(
      account: SessionAccount | null,
      issueId: string,
    ): Promise<Dispatch[]> {
      const human = requireAccount(account);
      return db.transaction(async (tx) => {
        const [issue] = await tx
          .select({
            id: issues.id,
            projectId: issues.projectId,
            workspaceId: projects.workspaceId,
            deletedAt: issues.deletedAt,
          })
          .from(issues)
          .innerJoin(projects, eq(issues.projectId, projects.id))
          .where(and(eq(issues.id, issueId), isNull(issues.deletedAt), isNull(projects.deletedAt)))
          .limit(1);
        if (
          issue === undefined ||
          issue.deletedAt !== null ||
          !(await canSeeWorkspace(tx, issue.workspaceId, human.humanId))
        ) {
          throw new RunnersError("issue_not_found");
        }
        const ceiling = await projectAccessCeiling(tx, issue.workspaceId, human.humanId, [
          issue.projectId,
        ]);
        if (!hasAccess(ceiling.get(issue.projectId), "read", projectAccessAtLeast)) {
          throw new RunnersError("issue_not_found");
        }
        await endDispatchesWithoutLiveSession(tx, eq(runnerDispatches.issueId, issueId));
        const rows = await tx
          .select(dispatchFields)
          .from(runnerDispatches)
          .innerJoin(runners, eq(runnerDispatches.runnerId, runners.id))
          .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
          .innerJoin(projects, eq(runnerDispatches.projectId, projects.id))
          .where(
            and(
              eq(runnerDispatches.issueId, issueId),
              eq(runnerHosts.humanId, human.humanId),
              isNull(projects.deletedAt),
            ),
          );
        return rows.map(toDispatch);
      });
    },

    /**
     * One Dispatch's metadata, including its prompt, for the Live Session
     * Studio. Project readers may view it (issue #239); workspace members
     * without project Read access keep receiving 404, never a 403 oracle.
     */
    async getDispatch(
      credential: string | undefined,
      account: SessionAccount | null,
      dispatchId: string,
    ): Promise<Dispatch> {
      if (account === null) {
        // Authenticate first: an anonymous or invalid host credential gets 401,
        // never a 404 that would leak whether the dispatch id exists.
        await db.transaction((tx) => readHostByCredential(tx, credential));
      }
      return db.transaction(async (tx) => {
        const dispatch = await readDispatch(tx, dispatchId);
        if (account !== null) {
          if (!(await canSeeWorkspace(tx, dispatch.workspaceId, account.humanId))) {
            throw new RunnersError("dispatch_not_found");
          }
          const ceiling = await projectAccessCeiling(tx, dispatch.workspaceId, account.humanId, [
            dispatch.projectId,
          ]);
          if (!hasAccess(ceiling.get(dispatch.projectId), "read", projectAccessAtLeast)) {
            throw new RunnersError("dispatch_not_found");
          }
          return toDispatch(dispatch);
        }
        // Runner host credential: the host owns every Runner it enrolled.
        const host = await readHostByCredential(tx, credential);
        if (dispatch.hostId !== host.host.id) throw new RunnersError("dispatch_not_found");
        return toDispatch(dispatch);
      });
    },

    /**
     * Runner-host acceptance. Run registration, claim and token minting share
     * one transaction, so an interrupted accept leaves no partial credential.
     */
    async acceptDispatch(
      credential: string | undefined,
      runnerId: string,
      dispatchId: string,
    ): Promise<DispatchAcceptance> {
      const outcome = await db.transaction(
        async (tx): Promise<DispatchAcceptance | { error: "issue_not_dispatchable" }> => {
          const host = await readHostByCredential(tx, credential);
          const [joined] = await tx
            .select({
              runner: runnerFields,
              hostRevokedAt: runnerHosts.revokedAt,
              projectName: projects.name,
              projectDeletedAt: projects.deletedAt,
            })
            .from(runners)
            .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
            .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
            .innerJoin(projects, eq(runners.projectId, projects.id))
            .where(eq(runners.id, runnerId))
            .limit(1);
          if (joined === undefined || joined.runner.hostId !== host.host.id) {
            throw new RunnersError("runner_not_found");
          }
          if (
            joined.runner.revokedAt !== null ||
            joined.hostRevokedAt !== null ||
            joined.projectDeletedAt !== null
          ) {
            throw new RunnersError("runner_revoked");
          }
          if (!(await canSeeWorkspace(tx, joined.runner.workspaceId, host.humanId))) {
            throw new RunnersError("runner_revoked");
          }
          const hostCeiling = await projectAccessCeiling(
            tx,
            joined.runner.workspaceId,
            host.humanId,
            [joined.runner.projectId],
          );
          const hostLevel = hostCeiling.get(joined.runner.projectId);
          if (!hasAccess(hostLevel, "contribute", projectAccessAtLeast)) {
            throw new RunnersError("runner_revoked");
          }

          // Global lock order: projects -> issues -> runners -> runner_dispatches.
          // Read the dispatch's issue without locking, then lock the project and
          // issue rows before the dispatch row so this path cannot AB-BA against
          // deleteProject/requestStop/inbox/seq.
          const [peek] = await tx
            .select({ issueId: runnerDispatches.issueId })
            .from(runnerDispatches)
            .where(
              and(eq(runnerDispatches.id, dispatchId), eq(runnerDispatches.runnerId, runnerId)),
            )
            .limit(1);
          if (peek === undefined) throw new RunnersError("dispatch_not_found");
          const [activeProject] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, joined.runner.projectId),
                eq(projects.workspaceId, joined.runner.workspaceId),
                isNull(projects.deletedAt),
              ),
            )
            .for("no key update")
            .limit(1);
          if (activeProject === undefined) throw new RunnersError("runner_revoked");
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.id, peek.issueId))
            .limit(1)
            .for("update");
          const [dispatch] = await tx
            .select()
            .from(runnerDispatches)
            .where(
              and(eq(runnerDispatches.id, dispatchId), eq(runnerDispatches.runnerId, runnerId)),
            )
            .limit(1)
            .for("update");
          if (dispatch === undefined) throw new RunnersError("dispatch_not_found");
          if (dispatch.state !== "pending") {
            // A redelivered dispatch command (the ack had not committed) must be
            // idempotent: reuse the existing Run and Work session, never claim a
            // second one. A fresh fenced token is minted for this same scope.
            if (
              dispatch.state === "active" &&
              dispatch.runId !== null &&
              dispatch.workSessionId !== null
            ) {
              const [existingSession] = await tx
                .select()
                .from(workSessions)
                .where(
                  and(
                    eq(workSessions.id, dispatch.workSessionId),
                    eq(workSessions.status, WorkSessionStatus.enum.active),
                    gt(workSessions.leaseExpiresAt, sql`statement_timestamp()`),
                  ),
                )
                .limit(1);
              const [existingRun] = await tx
                .select()
                .from(runs)
                .where(eq(runs.id, dispatch.runId))
                .limit(1);
              if (existingSession !== undefined && existingRun !== undefined) {
                const retrySecret = newDispatchToken();
                await tx.insert(dispatchTokens).values({
                  id: randomUUID(),
                  tokenHash: tokenHash(retrySecret),
                  runnerHostId: joined.runner.hostId,
                  runnerId,
                  dispatchId,
                  dispatchAttemptId: dispatch.dispatchAttemptId,
                  agentId: dispatch.agentId,
                  workspaceId: joined.runner.workspaceId,
                  projectId: joined.runner.projectId,
                  issueId: dispatch.issueId,
                  runId: dispatch.runId,
                  workSessionId: dispatch.workSessionId,
                  createdAt: sql`statement_timestamp()`,
                });
                return {
                  dispatch: toDispatch({ ...dispatch, hostId: joined.runner.hostId }),
                  run: toRun(existingRun),
                  session: toSession({
                    ...existingSession,
                    effectiveStatus: existingSession.status,
                  }),
                  dispatchToken: retrySecret,
                };
              }
              // An accepted dispatch whose Work session is no longer live (lease
              // lapsed in DB time) must never be resumed by a redelivered command.
              throw new RunnersError("issue_not_dispatchable");
            }
            throw new RunnersError("dispatch_not_pending");
          }
          const [agent] = await tx
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(eq(agents.id, dispatch.agentId), eq(agents.humanId, host.humanId)))
            .limit(1);
          if (agent === undefined) throw new RunnersError("agent_not_found");

          // The chosen Harness and model are recorded on the Run (issue #241);
          // a Dispatch that left them to the Runner keeps the previous fallback.
          const harness = dispatch.harness ?? joined.runner.capabilities[0] ?? "opencode";
          const runId = randomUUID();
          const [insertedRun] = await tx
            .insert(runs)
            .values({
              id: runId,
              agentId: agent.id,
              workspaceId: joined.runner.workspaceId,
              harness,
              model: dispatch.model,
              nativeSessionId: dispatch.dispatchAttemptId,
              createdAt: sql`statement_timestamp()`,
              updatedAt: sql`statement_timestamp()`,
            })
            .onConflictDoNothing()
            .returning();
          let runRow = insertedRun;
          if (runRow === undefined) {
            const [existing] = await tx
              .select()
              .from(runs)
              .where(
                and(
                  eq(runs.agentId, agent.id),
                  eq(runs.workspaceId, joined.runner.workspaceId),
                  eq(runs.harness, harness),
                  eq(runs.nativeSessionId, dispatch.dispatchAttemptId),
                ),
              )
              .limit(1)
              .for("update");
            if (existing === undefined) throw new RunnersError("dispatch_not_found");
            runRow = existing;
          }

          const secret = newDispatchToken();
          const tokenId = randomUUID();
          // Claim first so the scope carries the real work-session id, never a
          // placeholder. The claim uses Orrery's own rules inside this transaction.
          const claimIdentity: AgentIdentity = {
            agentId: agent.id,
            name: agent.name,
            humanId: host.humanId,
            keyId: tokenId,
            workspaceId: joined.runner.workspaceId,
            validity: "never",
            projects: [
              {
                projectId: joined.runner.projectId,
                projectName: joined.projectName,
                level: hostLevel!,
              },
            ],
          };
          let session: WorkSession;
          try {
            session = await claimWorkSession(tx, claimIdentity, {
              issueId: dispatch.issueId,
              runId: runRow.id,
            });
          } catch (error) {
            if (error instanceof SessionsError) {
              // Commit the dispatch settlement so a refused accept never leaves
              // the row stranded in `pending` (which would block auto-claim and
              // leak a concurrency slot forever). Clean up the unused Run row.
              if (insertedRun !== undefined) {
                await tx.delete(runs).where(eq(runs.id, insertedRun.id));
              }
              await tx
                .update(runnerDispatches)
                .set({ state: "ended", endedAt: sql`statement_timestamp()` })
                .where(eq(runnerDispatches.id, dispatchId));
              return { error: "issue_not_dispatchable" as const };
            }
            throw error;
          }
          const scope = {
            runnerHostId: joined.runner.hostId,
            runnerId,
            dispatchId,
            dispatchAttemptId: dispatch.dispatchAttemptId,
            agentId: agent.id,
            workspaceId: joined.runner.workspaceId,
            projectId: joined.runner.projectId,
            issueId: dispatch.issueId,
            runId: runRow.id,
            workSessionId: session.id,
          };
          await tx.insert(dispatchTokens).values({
            id: tokenId,
            tokenHash: tokenHash(secret),
            ...scope,
            createdAt: sql`statement_timestamp()`,
          });
          const [updated] = await tx
            .update(runnerDispatches)
            .set({
              state: "active",
              runId: runRow.id,
              workSessionId: session.id,
              acceptedAt: sql`statement_timestamp()`,
            })
            .where(eq(runnerDispatches.id, dispatchId))
            .returning(dispatchBaseFields);
          if (updated === undefined) throw new RunnersError("dispatch_not_found");
          return {
            dispatch: toDispatch({ ...updated, hostId: joined.runner.hostId }),
            run: toRun(runRow),
            session,
            dispatchToken: secret,
          };
        },
      );
      if ("error" in outcome) throw new RunnersError(outcome.error);
      return outcome;
    },

    async revokeRunnerHost(account: SessionAccount | null, hostId: string) {
      const human = requireAccount(account);
      const [host] = await db
        .select()
        .from(runnerHosts)
        .where(
          and(
            eq(runnerHosts.id, hostId),
            eq(runnerHosts.humanId, human.humanId),
            isNull(runnerHosts.revokedAt),
          ),
        );
      if (host === undefined) throw new RunnersError("host_not_found");
      return db.transaction(async (tx) => {
        const revoked = await tx
          .update(runners)
          .set({ revokedAt: sql`statement_timestamp()` })
          .where(and(eq(runners.hostId, hostId), isNull(runners.revokedAt)))
          .returning({ id: runners.id });
        await tx
          .update(runnerHosts)
          .set({ revokedAt: sql`statement_timestamp()` })
          .where(eq(runnerHosts.id, hostId));
        await revokeDispatchTokensForRunners(
          tx,
          revoked.map((row) => row.id),
          "host_revoked",
        );
        return { hostId, revokedRunners: revoked.length };
      });
    },

    /**
     * Query-before-wait delivery from the durable outbox. Advancing `afterSeq`
     * acknowledges everything below it; a revoked runner may drain ONLY cancel
     * commands, then every later poll is a 401 stop-all-slots signal.
     */
    async pollCommands(
      credential: string | undefined,
      runnerId: string,
      afterSeq: number,
      waitMs: number,
      signal?: AbortSignal,
    ): Promise<RunnerCommandsResponse> {
      const read = () =>
        db.transaction(async (tx) => {
          const { revoked } = await readRunnerAccessForCommands(tx, credential, runnerId);
          await acknowledgeCommands(tx, runnerId, afterSeq);
          const rows = await tx
            .select()
            .from(runnerCommands)
            .where(
              and(
                eq(runnerCommands.runnerId, runnerId),
                gt(runnerCommands.seq, afterSeq),
                isNull(runnerCommands.ackedAt),
                gt(runnerCommands.expiresAt, sql`statement_timestamp()`),
              ),
            )
            .orderBy(asc(runnerCommands.seq))
            .limit(200);

          // A revoked host/runner never receives dispatch or input_resolved.
          const visible = revoked ? rows.filter((row) => row.kind === "cancel") : rows;
          if (revoked && visible.length === 0) {
            throw new RunnersError("runner_revoked");
          }
          return visible.map((row) => {
            const base = {
              commandId: row.id,
              runnerId: row.runnerId,
              seq: row.seq,
              dispatchId: row.dispatchId,
              dispatchAttemptId: row.dispatchAttemptId,
              createdAt: row.createdAt.toISOString(),
              expiresAt: row.expiresAt.toISOString(),
            };
            // The kind/payload correlation is enforced by a Postgres CHECK and
            // re-validated here at the contract boundary.
            return RunnerCommand.parse(
              Object.assign(base, { kind: row.kind, payload: row.payload }),
            );
          });
        });

      const controller = new AbortController();
      const abortSignal =
        signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
      try {
        let commands = await read();
        const deadline = Date.now() + waitMs;
        while (commands.length === 0 && Date.now() < deadline) {
          // pg_notify is a latency doorbell; the one-second cap is the fallback
          // poll that recovers from dropped notifications or a listener restart.
          const slice = Math.min(1000, deadline - Date.now());
          if (notifier === undefined) {
            await new Promise((resolve) => setTimeout(resolve, slice));
          } else {
            await notifier.wait(runnerId, slice, abortSignal);
          }
          commands = await read();
        }
        return { commands };
      } finally {
        // Always drop this poller's waiter; the LISTEN connection is shared.
        controller.abort();
      }
    },

    async ackCommands(
      credential: string | undefined,
      runnerId: string,
      upToSeq: number,
    ): Promise<AckCommandsResponse> {
      return db.transaction(async (tx) => {
        const { revoked } = await readRunnerAccessForCommands(tx, credential, runnerId);
        // A revoked runner may only acknowledge while final cancels remain.
        if (revoked && !(await hasUnackedCancel(tx, runnerId))) {
          throw new RunnersError("runner_revoked");
        }
        await acknowledgeCommands(tx, runnerId, upToSeq);
        return { ackedSeq: upToSeq };
      });
    },

    async close(): Promise<void> {
      deps.onClose?.();
      await notifier?.close();
    },

    // Structured stream ingestion & reconciliation (#199). These sit after
    // close() so the existing command-outbox service surface stays untouched.
    async ingestStream(
      credential: string | undefined,
      runnerId: string,
      dispatchId: string,
      input: StreamBatchRequest,
    ): Promise<StreamBatchResponse> {
      return stream.ingest(credential, runnerId, dispatchId, input);
    },

    async readStream(
      credential: string | undefined,
      account: SessionAccount | null,
      runnerId: string,
      dispatchId: string,
      afterSeq: number,
    ): Promise<StreamResponse> {
      return stream.read(credential, account, runnerId, dispatchId, afterSeq);
    },

    async reconnectRunner(
      credential: string | undefined,
      runnerId: string,
      input: ReconnectRequest,
    ): Promise<ReconnectResponse> {
      return stream.reconnect(credential, runnerId, input);
    },

    async markDisconnectedDispatches(windowSeconds?: number): Promise<number> {
      return stream.markDisconnected(windowSeconds);
    },

    async resolveUncertainDispatch(
      account: SessionAccount | null,
      dispatchId: string,
      outcome: ResolveUncertainRequest["outcome"],
    ): Promise<Dispatch> {
      return stream.resolveUncertain(account, dispatchId, outcome);
    },

    async rollUpStreams(limit?: number): Promise<number> {
      return stream.rollUp(limit);
    },

    /** Immediate, single-session rollup wired into work-session end/expiry. */
    async rollUpSession(sessionId: string): Promise<boolean> {
      return stream.rollUpSession(sessionId);
    },
  };
}

export type RunnersService = ReturnType<typeof createRunnersService>;

/**
 * Deactivation cascade: revoke every installation-wide Runner host of a human
 * and all of its runners inside the caller's transaction.
 */
export async function revokeRunnerHostsForHuman(
  tx: DbTransaction,
  humanId: string,
): Promise<number> {
  const active = await tx
    .select({ id: runnerHosts.id })
    .from(runnerHosts)
    .where(and(eq(runnerHosts.humanId, humanId), isNull(runnerHosts.revokedAt)));
  if (active.length === 0) return 0;
  const ids = active.map((row) => row.id);
  const revokedAt = sql`statement_timestamp()`;
  const revoked = await tx
    .update(runners)
    .set({ revokedAt })
    .where(and(inArray(runners.hostId, ids), isNull(runners.revokedAt)))
    .returning({ id: runners.id });
  await tx.update(runnerHosts).set({ revokedAt }).where(inArray(runnerHosts.id, ids));
  await revokeDispatchTokensForRunners(
    tx,
    revoked.map((row) => row.id),
    "human_deactivated",
  );
  return ids.length;
}

/**
 * Workspace member removal cascade: revoke only the removed member's runners
 * bound to this workspace, never their installation-wide Runner host.
 */
export async function revokeWorkspaceRunnersForMember(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<number> {
  const active = await tx
    .select({ id: runners.id })
    .from(runners)
    .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
    .where(
      and(
        eq(runners.workspaceId, workspaceId),
        eq(runnerHosts.humanId, humanId),
        isNull(runners.revokedAt),
        isNull(runnerHosts.revokedAt),
      ),
    );
  if (active.length === 0) return 0;
  await tx
    .update(runners)
    .set({ revokedAt: sql`statement_timestamp()` })
    .where(
      inArray(
        runners.id,
        active.map((row) => row.id),
      ),
    );
  await revokeDispatchTokensForRunners(
    tx,
    active.map((row) => row.id),
    "member_removed",
  );
  return active.length;
}

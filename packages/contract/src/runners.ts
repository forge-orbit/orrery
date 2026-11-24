import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Run } from "./runs.ts";
import { WorkSession } from "./sessions.ts";

/** A stable, opaque identity for a runner-related resource. */
export const RunnerId = z.string().min(1).max(200).meta({ id: "RunnerId" });
export type RunnerId = z.infer<typeof RunnerId>;

/** An enrolled machine owns Runners across every workspace. */
export const RunnerHostId = z.string().min(1).max(200).meta({ id: "RunnerHostId" });
export type RunnerHostId = z.infer<typeof RunnerHostId>;

/** The operating-system family a Runner host reports at enrollment. */
export const RunnerPlatform = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Use lowercase letters, digits, dots, underscores or hyphens.")
  .meta({ id: "RunnerPlatform" });
export type RunnerPlatform = z.infer<typeof RunnerPlatform>;

/** A human-readable name for an enrolled machine. */
export const RunnerHostDisplayName = z
  .string()
  .trim()
  .min(1, "Enter a display name.")
  .max(120)
  .meta({ id: "RunnerHostDisplayName" });
export type RunnerHostDisplayName = z.infer<typeof RunnerHostDisplayName>;

/** A 64-character lowercase hex digest. Local paths are never sent as this value. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a 64-character lowercase hex digest.")
  .meta({ id: "Sha256Hex" });
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** The human-entered code shown in the browser, formatted `XXXX-XXXX`. */
export const UserCode = z
  .string()
  .regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, "Enter the 8-character code shown by the runner.")
  .meta({ id: "UserCode" });
export type UserCode = z.infer<typeof UserCode>;

/** A secret only the CLI knows, used to bind device-code enrollment. */
export const DeviceVerifier = z.string().min(32).max(256).meta({ id: "DeviceVerifier" });
export type DeviceVerifier = z.infer<typeof DeviceVerifier>;

/** A short-lived secret the CLI exchanges once for a host credential. */
export const DeviceCode = z.string().min(32).max(256).meta({ id: "DeviceCode" });
export type DeviceCode = z.infer<typeof DeviceCode>;

/** The long-lived credential stored locally by an enrolled Runner host. */
export const HostCredential = z.string().min(32).max(256).meta({ id: "HostCredential" });
export type HostCredential = z.infer<typeof HostCredential>;

/** Derived in database time from heartbeats, revocation and live sessions. */
export const RunnerPresence = z
  .enum(["online", "busy", "offline"])
  .meta({ id: "RunnerPresence" });
export type RunnerPresence = z.infer<typeof RunnerPresence>;

export const RunnerHost = z
  .object({
    id: RunnerHostId,
    humanId: z.string(),
    displayName: RunnerHostDisplayName,
    platform: RunnerPlatform,
    lastSeenAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "RunnerHost" });
export type RunnerHost = z.infer<typeof RunnerHost>;

export const Runner = z
  .object({
    id: RunnerId,
    hostId: RunnerHostId,
    workspaceId: z.string(),
    projectId: z.string(),
    agentId: z.string(),
    displayName: RunnerHostDisplayName,
    repoFingerprint: Sha256Hex,
    capabilities: z.array(z.string().min(1).max(64)).max(64),
    maxConcurrency: z.int().min(1).max(64),
    activeSlotCount: z.int().min(0).max(64),
    lastSeenAt: Timestamp,
    disconnectedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    presence: RunnerPresence,
  })
  .meta({ id: "Runner" });
export type Runner = z.infer<typeof Runner>;

/** A runner plus the host it belongs to, for the workspace Runners Fleet. */
export const FleetRunner = Runner.extend({
  hostDisplayName: RunnerHostDisplayName,
  hostPlatform: RunnerPlatform,
  canRevoke: z.boolean(),
}).meta({ id: "FleetRunner" });
export type FleetRunner = z.infer<typeof FleetRunner>;

/** Runners grouped under the installation-wide host that owns them. */
export const FleetRunnerHost = z
  .object({
    host: RunnerHost,
    presence: RunnerPresence,
    canRevoke: z.boolean(),
    runners: z.array(FleetRunner),
  })
  .meta({ id: "FleetRunnerHost" });
export type FleetRunnerHost = z.infer<typeof FleetRunnerHost>;

export const WorkspaceRunnersFleet = z
  .object({ hosts: z.array(FleetRunnerHost) })
  .meta({ id: "WorkspaceRunnersFleet" });
export type WorkspaceRunnersFleet = z.infer<typeof WorkspaceRunnersFleet>;

export const CreateDeviceCodeRequest = z
  .object({
    hostDisplayName: RunnerHostDisplayName,
    platform: RunnerPlatform,
    verifierHash: Sha256Hex,
  })
  .meta({ id: "CreateDeviceCodeRequest" });
export type CreateDeviceCodeRequest = z.infer<typeof CreateDeviceCodeRequest>;

export const DeviceCodeResponse = z
  .object({
    deviceCode: DeviceCode,
    userCode: UserCode,
    verificationUri: z.string(),
    expiresAt: Timestamp,
  })
  .meta({ id: "DeviceCodeResponse" });
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponse>;

/** Preview only: a GET can never approve a device code. */
export const DeviceCodePreview = z
  .object({
    userCode: UserCode,
    hostDisplayName: RunnerHostDisplayName,
    platform: RunnerPlatform,
    expiresAt: Timestamp,
  })
  .meta({ id: "DeviceCodePreview" });
export type DeviceCodePreview = z.infer<typeof DeviceCodePreview>;

export const ApproveDeviceCodeResponse = z
  .object({
    hostDisplayName: RunnerHostDisplayName,
    platform: RunnerPlatform,
  })
  .meta({ id: "ApproveDeviceCodeResponse" });
export type ApproveDeviceCodeResponse = z.infer<typeof ApproveDeviceCodeResponse>;

export const ExchangeDeviceCodeRequest = z
  .object({ deviceCode: DeviceCode, verifier: DeviceVerifier })
  .meta({ id: "ExchangeDeviceCodeRequest" });
export type ExchangeDeviceCodeRequest = z.infer<typeof ExchangeDeviceCodeRequest>;

export const HostCredentialResponse = z
  .object({
    hostId: RunnerId,
    credential: HostCredential,
    displayName: RunnerHostDisplayName,
    platform: RunnerPlatform,
  })
  .meta({ id: "HostCredentialResponse" });
export type HostCredentialResponse = z.infer<typeof HostCredentialResponse>;

export const RegisterRunnerRequest = z
  .object({
    workspaceId: z.string().min(1).max(200),
    projectId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200).optional(),
    displayName: RunnerHostDisplayName.optional(),
    repoFingerprint: Sha256Hex,
    capabilities: z.array(z.string().min(1).max(64)).max(64).default([]),
    maxConcurrency: z.int().min(1).max(64).default(1),
  })
  .meta({ id: "RegisterRunnerRequest" });
export type RegisterRunnerRequest = z.infer<typeof RegisterRunnerRequest>;

export const HeartbeatRequest = z
  .object({ activeSlotCount: z.int().min(0).max(64).default(0) })
  .meta({ id: "HeartbeatRequest" });
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const RevokeRunnerHostResponse = z
  .object({
    hostId: RunnerHostId,
    revokedRunners: z.int().min(0),
  })
  .meta({ id: "RevokeRunnerHostResponse" });
export type RevokeRunnerHostResponse = z.infer<typeof RevokeRunnerHostResponse>;

/** A stable, opaque identity for one delivery of work to a Runner. */
export const DispatchId = z.string().min(1).max(200).meta({ id: "DispatchId" });
export type DispatchId = z.infer<typeof DispatchId>;

/** Fences a local execution attempt: a reconnect reuses the same id. */
export const DispatchAttemptId = z.string().min(1).max(200).meta({ id: "DispatchAttemptId" });
export type DispatchAttemptId = z.infer<typeof DispatchAttemptId>;

/** Database-backed reconciliation state of a Dispatch. */
export const DispatchState = z
  .enum(["pending", "active", "uncertain", "ended"])
  .meta({ id: "DispatchState" });
export type DispatchState = z.infer<typeof DispatchState>;

/** Thin delivery bridge; it never changes the issue's assignee. */
export const Dispatch = z
  .object({
    id: DispatchId,
    runnerId: RunnerId,
    hostId: RunnerHostId,
    workspaceId: z.string(),
    projectId: z.string(),
    issueId: z.string(),
    requestedByHumanId: z.string(),
    agentId: z.string(),
    dispatchAttemptId: DispatchAttemptId,
    state: DispatchState,
    runId: z.string().nullable(),
    workSessionId: z.string().nullable(),
    lastUpSeq: z.int().min(0),
    lastDownSeq: z.int().min(0),
    branchName: z.string().nullable(),
    dirtyWorktree: z.boolean(),
    createdAt: Timestamp,
    acceptedAt: Timestamp.nullable(),
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: "Dispatch" });
export type Dispatch = z.infer<typeof Dispatch>;

export const CreateDispatchRequest = z
  .object({
    runnerId: RunnerId,
    agentId: z.string().min(1).max(200).optional(),
  })
  .meta({ id: "CreateDispatchRequest" });
export type CreateDispatchRequest = z.infer<typeof CreateDispatchRequest>;

export const IssueDispatchesResponse = z
  .object({ dispatches: z.array(Dispatch) })
  .meta({ id: "IssueDispatchesResponse" });
export type IssueDispatchesResponse = z.infer<typeof IssueDispatchesResponse>;

/**
 * The `orr_dt_...` secret is returned exactly once. Only its SHA-256 digest is
 * persisted, bound to every id in `DispatchScope`.
 */
export const DispatchAcceptance = z
  .object({
    dispatch: Dispatch,
    run: Run,
    session: WorkSession,
    dispatchToken: z.string().min(1),
  })
  .meta({ id: "DispatchAcceptance" });
export type DispatchAcceptance = z.infer<typeof DispatchAcceptance>;

/** Every id a Dispatch token is fenced to; a tool may touch only these rows. */
export const DispatchScope = z
  .object({
    runnerHostId: RunnerHostId,
    runnerId: RunnerId,
    dispatchId: DispatchId,
    dispatchAttemptId: DispatchAttemptId,
    agentId: z.string(),
    workspaceId: z.string(),
    projectId: z.string(),
    issueId: z.string(),
    runId: z.string(),
    workSessionId: z.string(),
  })
  .meta({ id: "DispatchScope" });
export type DispatchScope = z.infer<typeof DispatchScope>;

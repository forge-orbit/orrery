import { z } from "zod";
import { Timestamp } from "./common.ts";
import { Run } from "./runs.ts";
import { ReadyWorkFilter, WorkSession } from "./sessions.ts";

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

/** One model an ACP harness advertised during a discovery probe. */
export const HarnessModel = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(200).optional(),
    reasoningDiscovery: z.enum(["known", "unknown"]),
    supportedEfforts: z.array(z.string().min(1).max(64)).max(32).optional(),
    defaultEffort: z.string().min(1).max(64).optional(),
  })
  .meta({ id: "HarnessModel" });
export type HarnessModel = z.infer<typeof HarnessModel>;

/** One ACP harness discovered on a Runner host, with its probed model list. */
export const HarnessCatalogEntry = z
  .object({
    id: z.string().min(1).max(64),
    displayName: z.string().min(1).max(120),
    defaultModel: z.string().min(1).max(200),
    models: z.array(HarnessModel).max(200),
    probedAt: Timestamp,
  })
  .meta({ id: "HarnessCatalogEntry" });
export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntry>;

/** A live Runner's locally discovered harnesses, published separately from heartbeats. */
export const HarnessCatalog = z
  .object({
    harnesses: z.array(HarnessCatalogEntry).max(64),
    probedAt: Timestamp,
  })
  .meta({ id: "HarnessCatalog" });
export type HarnessCatalog = z.infer<typeof HarnessCatalog>;

/** Newly registered Runners start with an empty catalog until their first probe. */
export const EMPTY_HARNESS_CATALOG: HarnessCatalog = {
  harnesses: [],
  probedAt: "1970-01-01T00:00:00.000Z",
};

const laterTimestamp = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Fold a slower/stale catalog refresh into the last published one. A model whose
 * effort levels were discovered once must never regress to `unknown` just because
 * a later probe only saw its default model (or a delayed refresh arrives late).
 * Harnesses that are no longer advertised are dropped, so the catalog still
 * reflects what is installed now.
 */
export function mergeHarnessCatalog(
  stored: HarnessCatalog | undefined | null,
  incoming: HarnessCatalog,
): HarnessCatalog {
  if (stored === undefined || stored === null) return HarnessCatalog.parse(incoming);
  const known = new Map<string, HarnessModel>();
  for (const harness of stored.harnesses) {
    for (const model of harness.models) {
      if (model.reasoningDiscovery === "known") {
        known.set(`${harness.id}\u0000${model.id}`, model);
      }
    }
  }
  return HarnessCatalog.parse({
    probedAt: laterTimestamp(stored.probedAt, incoming.probedAt),
    harnesses: incoming.harnesses.map((harness) => {
      const previous = stored.harnesses.find((item) => item.id === harness.id);
      return {
        ...harness,
        ...(previous === undefined ? {} : { probedAt: laterTimestamp(previous.probedAt, harness.probedAt) }),
        models: harness.models.map((model) => {
          if (model.reasoningDiscovery === "known") return model;
          const prior = known.get(`${harness.id}\u0000${model.id}`);
          if (prior === undefined) return model;
          return {
            ...model,
            ...(prior.label === undefined ? {} : { label: prior.label }),
            reasoningDiscovery: "known",
            ...(prior.supportedEfforts === undefined
              ? {}
              : { supportedEfforts: [...prior.supportedEfforts] }),
            ...(prior.defaultEffort === undefined ? {} : { defaultEffort: prior.defaultEffort }),
          };
        }),
      };
    }),
  });
}

/**
 * Optional per-Dispatch execution choices. They are identifiers, never
 * executable paths or flags; the Runner resolves them through its own local
 * registry. Empty strings are treated as omitted by the server.
 */
export const DispatchHarness = z.string().trim().max(64).meta({ id: "DispatchHarness" });
export type DispatchHarness = z.infer<typeof DispatchHarness>;
export const DispatchModel = z.string().trim().max(200).meta({ id: "DispatchModel" });
export type DispatchModel = z.infer<typeof DispatchModel>;
export const DispatchEffort = z.string().trim().max(64).meta({ id: "DispatchEffort" });
export type DispatchEffort = z.infer<typeof DispatchEffort>;

/**
 * Defaults a Runner applies to dispatches that carry no explicit choice. The
 * Runner registers them with its host credential; the server records the
 * effective values on the Dispatch so the Run and readers agree with execution.
 */
export const ExecutionDefaults = z
  .object({
    harness: DispatchHarness.optional(),
    model: DispatchModel.optional(),
    effort: DispatchEffort.optional(),
  })
  .meta({ id: "ExecutionDefaults" });
export type ExecutionDefaults = z.infer<typeof ExecutionDefaults>;

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
    harnessCatalog: HarnessCatalog,
    /** Effective CLI defaults for dispatches that omit their own choices. */
    defaults: ExecutionDefaults,
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
    /** Seeded from the local cache or a fast startup probe; refined via PUT /catalog. */
    harnessCatalog: HarnessCatalog.optional(),
    /** CLI `--harness`/`--model`/`--effort` defaults applied to unchosen dispatches. */
    defaults: ExecutionDefaults.optional(),
    maxConcurrency: z.int().min(1).max(64).default(1),
    /** One-shot `orrery-runner work` runners never reuse a persistent row. */
    ephemeral: z.boolean().default(false),
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

/** The shared bound for a requester's per-Dispatch instructions. */
export const MAX_DISPATCH_PROMPT_LENGTH = 16_000;

/**
 * Optional instructions from the requester for one Dispatch. Empty strings are
 * treated as omitted by the server; the limit is also a Postgres CHECK.
 */
export const DispatchPrompt = z
  .string()
  .trim()
  .max(MAX_DISPATCH_PROMPT_LENGTH)
  .meta({ id: "DispatchPrompt" });
export type DispatchPrompt = z.infer<typeof DispatchPrompt>;

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
    prompt: DispatchPrompt.optional(),
    harness: DispatchHarness.optional(),
    model: DispatchModel.optional(),
    effort: DispatchEffort.optional(),
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
    prompt: DispatchPrompt.optional(),
    harness: DispatchHarness.optional(),
    model: DispatchModel.optional(),
    effort: DispatchEffort.optional(),
  })
  .meta({ id: "CreateDispatchRequest" });
export type CreateDispatchRequest = z.infer<typeof CreateDispatchRequest>;

/** On-demand discovery requested by the Runner's owner (ADR-0011, #242). */
export const CatalogProbeRequest = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("model"),
      harness: DispatchHarness,
      model: DispatchModel,
    }),
    z.object({ kind: z.literal("catalog") }),
  ])
  .meta({ id: "CatalogProbeRequest" });
export type CatalogProbeRequest = z.infer<typeof CatalogProbeRequest>;

export const CatalogProbeResponse = z
  .object({
    commandId: z.string(),
    kind: z.enum(["probe_model", "probe_catalog"]),
    cooldownSeconds: z.int().nonnegative(),
  })
  .meta({ id: "CatalogProbeResponse" });
export type CatalogProbeResponse = z.infer<typeof CatalogProbeResponse>;

export const IssueDispatchesResponse = z
  .object({ dispatches: z.array(Dispatch) })
  .meta({ id: "IssueDispatchesResponse" });
export type IssueDispatchesResponse = z.infer<typeof IssueDispatchesResponse>;

/**
 * `--auto-claim` asks the server to select the next ready issue atomically.
 * `assignedToMe` never picks up an unassigned (potentially human) issue.
 */
export const AutoClaimRequest = z
  .object({ filter: ReadyWorkFilter.default("assignedToMe") })
  .meta({ id: "AutoClaimRequest" });
export type AutoClaimRequest = z.infer<typeof AutoClaimRequest>;

export const AutoClaimResponse = z
  .object({ dispatch: Dispatch.nullable() })
  .meta({ id: "AutoClaimResponse" });
export type AutoClaimResponse = z.infer<typeof AutoClaimResponse>;

/** A one-shot `orrery-runner work` dispatch targets one explicitly resolved issue. */
export const RunnerDispatchRequest = z
  .object({
    issueId: z.string().min(1).max(200),
    prompt: DispatchPrompt.optional(),
    harness: DispatchHarness.optional(),
    model: DispatchModel.optional(),
    effort: DispatchEffort.optional(),
  })
  .meta({ id: "RunnerDispatchRequest" });
export type RunnerDispatchRequest = z.infer<typeof RunnerDispatchRequest>;

/** An issue target may be a UUID, a full URL, or a `KEY-42` issue key. */
export const IssueResolveRequest = z
  .object({
    target: z.string().trim().min(1).max(2000),
    workspace: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: "IssueResolveRequest" });
export type IssueResolveRequest = z.infer<typeof IssueResolveRequest>;

/** The unambiguous scope an ephemeral one-shot Runner is registered against. */
export const IssueResolveResponse = z
  .object({
    issueId: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    projectId: z.string(),
    projectKey: z.string(),
    identifier: z.string(),
    number: z.int(),
    title: z.string(),
  })
  .meta({ id: "IssueResolveResponse" });
export type IssueResolveResponse = z.infer<typeof IssueResolveResponse>;

/** A one-shot Runner reports itself offline (revoked) during teardown. */
export const RunnerOfflineResponse = z
  .object({
    runnerId: RunnerId,
    revokedRunners: z.int().min(0),
  })
  .meta({ id: "RunnerOfflineResponse" });
export type RunnerOfflineResponse = z.infer<typeof RunnerOfflineResponse>;

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

/** Server-to-runner control commands carried by the transactional outbox. */
export const RunnerCommandKind = z
  .enum(["dispatch", "cancel", "input_resolved", "probe_model", "probe_catalog"])
  .meta({ id: "RunnerCommandKind" });
export type RunnerCommandKind = z.infer<typeof RunnerCommandKind>;

export const DispatchCommandPayload = z
  .object({
    dispatchId: DispatchId,
    dispatchAttemptId: DispatchAttemptId,
    issueId: z.string(),
    projectId: z.string(),
    workspaceId: z.string(),
    agentId: z.string(),
    prompt: DispatchPrompt.optional(),
    harness: DispatchHarness.optional(),
    model: DispatchModel.optional(),
    effort: DispatchEffort.optional(),
  })
  .meta({ id: "DispatchCommandPayload" });
export type DispatchCommandPayload = z.infer<typeof DispatchCommandPayload>;

export const CancelCommandPayload = z
  .object({
    dispatchId: DispatchId,
    dispatchAttemptId: DispatchAttemptId,
    issueId: z.string(),
    reason: z.string(),
  })
  .meta({ id: "CancelCommandPayload" });
export type CancelCommandPayload = z.infer<typeof CancelCommandPayload>;

export const InputResolvedCommandPayload = z
  .object({
    dispatchId: DispatchId,
    dispatchAttemptId: DispatchAttemptId,
    issueId: z.string(),
    questionId: z.string(),
    resolution: z.enum(["answered", "fallback_used"]),
    answer: z.string(),
  })
  .meta({ id: "InputResolvedCommandPayload" });
export type InputResolvedCommandPayload = z.infer<typeof InputResolvedCommandPayload>;

/**
 * Runner-level probes carry only opaque local identifiers. No path, command or
 * flag from the control plane is ever executed by the Runner (ADR-0011).
 */
export const ProbeModelCommandPayload = z
  .object({
    harness: DispatchHarness,
    model: DispatchModel,
  })
  .meta({ id: "ProbeModelCommandPayload" });
export type ProbeModelCommandPayload = z.infer<typeof ProbeModelCommandPayload>;

export const ProbeCatalogCommandPayload = z
  .object({})
  .meta({ id: "ProbeCatalogCommandPayload" });
export type ProbeCatalogCommandPayload = z.infer<typeof ProbeCatalogCommandPayload>;

export const RunnerCommandPayload = z
  .union([
    DispatchCommandPayload,
    CancelCommandPayload,
    InputResolvedCommandPayload,
    ProbeModelCommandPayload,
    ProbeCatalogCommandPayload,
  ])
  .meta({ id: "RunnerCommandPayload" });
export type RunnerCommandPayload = z.infer<typeof RunnerCommandPayload>;

const runnerCommandBase = {
  commandId: z.string().min(1),
  runnerId: RunnerId,
  seq: z.int().positive(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
};

const dispatchCommandBase = {
  ...runnerCommandBase,
  dispatchId: DispatchId,
  dispatchAttemptId: DispatchAttemptId,
};

/** Probe commands are runner-level: they belong to no Dispatch attempt. */
const probeCommandBase = {
  ...runnerCommandBase,
  dispatchId: z.null(),
  dispatchAttemptId: z.null(),
};

export const DispatchRunnerCommand = z
  .object({ ...dispatchCommandBase, kind: z.literal("dispatch"), payload: DispatchCommandPayload })
  .meta({ id: "DispatchRunnerCommand" });
export const CancelRunnerCommand = z
  .object({ ...dispatchCommandBase, kind: z.literal("cancel"), payload: CancelCommandPayload })
  .meta({ id: "CancelRunnerCommand" });
export const InputResolvedRunnerCommand = z
  .object({
    ...dispatchCommandBase,
    kind: z.literal("input_resolved"),
    payload: InputResolvedCommandPayload,
  })
  .meta({ id: "InputResolvedRunnerCommand" });
export const ProbeModelRunnerCommand = z
  .object({
    ...probeCommandBase,
    kind: z.literal("probe_model"),
    payload: ProbeModelCommandPayload,
  })
  .meta({ id: "ProbeModelRunnerCommand" });
export const ProbeCatalogRunnerCommand = z
  .object({
    ...probeCommandBase,
    kind: z.literal("probe_catalog"),
    payload: ProbeCatalogCommandPayload,
  })
  .meta({ id: "ProbeCatalogRunnerCommand" });

/** One durable, ordered command from a Runner's outbox. */
export const RunnerCommand = z
  .discriminatedUnion("kind", [
    DispatchRunnerCommand,
    CancelRunnerCommand,
    InputResolvedRunnerCommand,
    ProbeModelRunnerCommand,
    ProbeCatalogRunnerCommand,
  ])
  .meta({ id: "RunnerCommand" });
export type RunnerCommand = z.infer<typeof RunnerCommand>;

export const RunnerCommandsResponse = z
  .object({ commands: z.array(RunnerCommand) })
  .meta({ id: "RunnerCommandsResponse" });
export type RunnerCommandsResponse = z.infer<typeof RunnerCommandsResponse>;

export const CommandsQuery = z
  .object({
    afterSeq: z.coerce.number().int().nonnegative().default(0),
    waitMs: z.coerce.number().int().min(0).max(25000).default(0),
  })
  .meta({ id: "CommandsQuery" });
export type CommandsQuery = z.infer<typeof CommandsQuery>;

export const AckCommandsRequest = z
  .object({ upToSeq: z.int().nonnegative() })
  .meta({ id: "AckCommandsRequest" });
export type AckCommandsRequest = z.infer<typeof AckCommandsRequest>;

export const AckCommandsResponse = z
  .object({ ackedSeq: z.int().nonnegative() })
  .meta({ id: "AckCommandsResponse" });
export type AckCommandsResponse = z.infer<typeof AckCommandsResponse>;

/**
 * Typed, versioned ACP/Runner diagnostics. Every variant carries `version` so a
 * future shape can be added without misreading an older streamed event.
 */
const diagnosticVersion = z.literal(1);

export const AcpNotInstalledDiagnostic = z
  .object({
    kind: z.literal("acp_not_installed"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    harness: z.string().min(1).max(64).optional(),
  })
  .meta({ id: "AcpNotInstalledDiagnostic" });

export const AcpSpawnFailedDiagnostic = z
  .object({
    kind: z.literal("acp_spawn_failed"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    exitCode: z.int().optional(),
  })
  .meta({ id: "AcpSpawnFailedDiagnostic" });

export const AcpCrashedDiagnostic = z
  .object({
    kind: z.literal("acp_crashed"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    exitCode: z.int().optional(),
    signal: z.string().max(64).optional(),
  })
  .meta({ id: "AcpCrashedDiagnostic" });

export const AuthExpiredDiagnostic = z
  .object({
    kind: z.literal("auth_expired"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    /** A concrete step the human can take, e.g. "Run `opencode auth login`". */
    remediation: z.string().min(1).max(2000),
  })
  .meta({ id: "AuthExpiredDiagnostic" });

export const UsageLimitDiagnostic = z
  .object({
    kind: z.literal("usage_limit"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    resetsAt: Timestamp.optional(),
  })
  .meta({ id: "UsageLimitDiagnostic" });

export const ProviderOverloadDiagnostic = z
  .object({
    kind: z.literal("provider_overload"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    attempt: z.int().positive(),
    nextRetryAt: Timestamp.optional(),
    countdownSeconds: z.int().nonnegative().optional(),
  })
  .meta({ id: "ProviderOverloadDiagnostic" });

export const PermissionDeniedDiagnostic = z
  .object({
    kind: z.literal("permission_denied"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    tool: z.string().max(64).optional(),
    path: z.string().max(2000).optional(),
  })
  .meta({ id: "PermissionDeniedDiagnostic" });

export const RunnerDisconnectedDiagnostic = z
  .object({
    kind: z.literal("runner_disconnected"),
    version: diagnosticVersion,
    message: z.string().min(1).max(2000),
    lastSeq: z.int().nonnegative().optional(),
  })
  .meta({ id: "RunnerDisconnectedDiagnostic" });

export const SessionDiagnostic = z
  .discriminatedUnion("kind", [
    AcpNotInstalledDiagnostic,
    AcpSpawnFailedDiagnostic,
    AcpCrashedDiagnostic,
    AuthExpiredDiagnostic,
    UsageLimitDiagnostic,
    ProviderOverloadDiagnostic,
    PermissionDeniedDiagnostic,
    RunnerDisconnectedDiagnostic,
  ])
  .meta({ id: "SessionDiagnostic" });
export type SessionDiagnostic = z.infer<typeof SessionDiagnostic>;

/** `owner_only` raw stdout is only ever served to the Runner host owner. */
export const StreamChunkVisibility = z
  .enum(["project_readers", "owner_only"])
  .meta({ id: "StreamChunkVisibility" });
export type StreamChunkVisibility = z.infer<typeof StreamChunkVisibility>;

export const StreamChunkKind = z
  .enum(["event", "diagnostic", "raw_output"])
  .meta({ id: "StreamChunkKind" });
export type StreamChunkKind = z.infer<typeof StreamChunkKind>;

/** One spooled, ordered line of a session stream (tool call, diff, plan, etc.). */
export const StreamChunk = z
  .object({
    seq: z.int().positive(),
    kind: StreamChunkKind,
    visibility: StreamChunkVisibility.default("project_readers"),
    eventType: z.string().min(1).max(64).optional(),
    summary: z.string().max(2000).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    diagnostic: SessionDiagnostic.optional(),
  })
  .meta({ id: "StreamChunk" });
export type StreamChunk = z.infer<typeof StreamChunk>;

/** An idempotent `fromSeq..toSeq` window replayed by the local spool. */
export const StreamBatchRequest = z
  .object({
    dispatchAttemptId: DispatchAttemptId,
    fromSeq: z.int().positive(),
    toSeq: z.int().positive(),
    chunks: z.array(StreamChunk).max(1000),
  })
  .refine((value) => value.toSeq >= value.fromSeq, {
    message: "toSeq must not be smaller than fromSeq.",
  })
  .meta({ id: "StreamBatchRequest" });
export type StreamBatchRequest = z.infer<typeof StreamBatchRequest>;

export const StreamBatchResponse = z
  .object({ ackedSeq: z.int().nonnegative() })
  .meta({ id: "StreamBatchResponse" });
export type StreamBatchResponse = z.infer<typeof StreamBatchResponse>;

export const StreamQuery = z
  .object({ afterSeq: z.coerce.number().int().nonnegative().default(0) })
  .meta({ id: "StreamQuery" });
export type StreamQuery = z.infer<typeof StreamQuery>;

export const StreamResponse = z
  .object({
    chunks: z.array(StreamChunk),
    nextAfterSeq: z.int().nonnegative(),
    rolledUp: z.boolean(),
  })
  .meta({ id: "StreamResponse" });
export type StreamResponse = z.infer<typeof StreamResponse>;

/** A reconnect reports the attempts still running locally and their last seq. */
export const ReconnectAttempt = z
  .object({
    dispatchAttemptId: DispatchAttemptId,
    lastSeq: z.int().nonnegative(),
  })
  .meta({ id: "ReconnectAttempt" });
export type ReconnectAttempt = z.infer<typeof ReconnectAttempt>;

export const ReconnectRequest = z
  .object({ activeAttempts: z.array(ReconnectAttempt).max(64) })
  .meta({ id: "ReconnectRequest" });
export type ReconnectRequest = z.infer<typeof ReconnectRequest>;

export const ReconnectResolution = z
  .object({
    dispatchId: DispatchId,
    dispatchAttemptId: DispatchAttemptId,
    state: DispatchState,
    resumed: z.boolean(),
    lastSeq: z.int().nonnegative(),
  })
  .meta({ id: "ReconnectResolution" });
export type ReconnectResolution = z.infer<typeof ReconnectResolution>;

export const ReconnectResponse = z
  .object({ resolutions: z.array(ReconnectResolution) })
  .meta({ id: "ReconnectResponse" });
export type ReconnectResponse = z.infer<typeof ReconnectResponse>;

/** Explicit human settlement of an uncertain attempt before any re-dispatch. */
export const ResolveUncertainRequest = z
  .object({ outcome: z.enum(["released", "completed"]) })
  .meta({ id: "ResolveUncertainRequest" });
export type ResolveUncertainRequest = z.infer<typeof ResolveUncertainRequest>;

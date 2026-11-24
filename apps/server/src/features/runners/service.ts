import { randomBytes, randomUUID } from "node:crypto";
import type {
  CreateDeviceCodeRequest,
  DeviceCodeResponse,
  ExchangeDeviceCodeRequest,
  FleetRunner,
  FleetRunnerHost,
  HeartbeatRequest,
  HostCredentialResponse,
  ProjectAccessLevel,
  RegisterRunnerRequest,
  Runner,
  RunnerHost,
  RunnerPresence,
  WorkspaceRunnersFleet,
} from "@orrery/contract";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  agents,
  humans,
  projects,
  runnerDeviceCodeAttempts,
  runnerDeviceCodes,
  runnerHosts,
  runners,
  workspaces,
  workspaceMemberships,
} from "../../db/schema.ts";
import type { DbTransaction } from "../../platform/db.ts";
import { tokenHash } from "../../platform/tokens.ts";
import type { SessionAccount, SessionReader } from "../accounts/index.ts";

const HOST_CREDENTIAL_PREFIX = "orr_rh_";
const DEVICE_CODE_PREFIX = "orr_dc_";
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_FAILED_USER_CODE_ATTEMPTS = 5;
const MAX_FAILED_VERIFIER_ATTEMPTS = 5;

/** A runner is offline once its last heartbeat is older than this in DB time. */
export const RUNNER_ONLINE_WINDOW_SECONDS = 120;

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
  | "no_default_agent";

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
};

export class RunnersError extends Error {
  readonly kind: RunnersErrorKind;

  constructor(kind: RunnersErrorKind) {
    super(messages[kind]);
    this.name = "RunnersError";
    this.kind = kind;
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

export interface RunnersDeps {
  db: PostgresJsDatabase;
  sessionReader: SessionReader;
  publicUrl: string;
  projectAccessCeiling: ProjectAccessCeiling;
  projectAccessAtLeast: ProjectAccessAtLeast;
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

async function joinRunner(tx: DbTransaction, runnerId: string) {
  const [row] = await tx
    .select(runnerFields)
    .from(runners)
    .innerJoin(runnerHosts, eq(runners.hostId, runnerHosts.id))
    .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
    .where(eq(runners.id, runnerId));
  return row;
}

async function readHostByCredential(tx: DbTransaction, credential: string | undefined) {
  if (credential === undefined || !credential.startsWith(HOST_CREDENTIAL_PREFIX)) {
    throw new RunnersError("invalid_credential");
  }
  const [host] = await tx
    .select({ host: runnerHosts, humanId: humans.id, deactivatedAt: humans.deactivatedAt })
    .from(runnerHosts)
    .innerJoin(humans, eq(runnerHosts.humanId, humans.id))
    .where(
      and(eq(runnerHosts.credentialHash, tokenHash(credential)), isNull(runnerHosts.revokedAt)),
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

/** DB-time expiry flag shared by every device-code read/write decision. */
const deviceCodeNotExpired = sql<boolean>`${runnerDeviceCodes.expiresAt} > statement_timestamp()`;
const attemptWindowExpired = sql<boolean>`${runnerDeviceCodeAttempts.windowStartedAt} <= statement_timestamp() - interval '10 minutes'`;

export function createRunnersService(deps: RunnersDeps) {
  const { db, publicUrl, projectAccessCeiling, projectAccessAtLeast } = deps;

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
            and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)),
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
        const [existing] = await tx
          .select({ id: runners.id })
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
          })
          .returning({ id: runners.id });
        const row = await joinRunner(tx, created!.id);
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
        if (!hasAccess(ceiling.get(runner.projectId), "read", projectAccessAtLeast)) {
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
          .where(
            and(
              eq(runners.workspaceId, workspaceId),
              isNull(runners.revokedAt),
              isNull(runnerHosts.revokedAt),
              isNull(humans.deactivatedAt),
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
        return { hostId, revokedRunners: revoked.length };
      });
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
  await tx
    .update(runners)
    .set({ revokedAt })
    .where(and(inArray(runners.hostId, ids), isNull(runners.revokedAt)));
  await tx.update(runnerHosts).set({ revokedAt }).where(inArray(runnerHosts.id, ids));
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
  return active.length;
}

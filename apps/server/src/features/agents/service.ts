import { randomBytes, randomUUID } from "node:crypto";
import {
  AgentKeyEventType,
  AgentKeyValidity,
  ProjectAccessLevel,
  type Agent,
  type AgentIdentity,
  type AgentKey,
  type AgentKeyGrant,
  type AgentKeyProject,
  type CreateAgentKeyRequest,
  type CreateAgentKeyResponse,
  type CreateAgentRequest,
  type RotateAgentKeyRequest,
} from "@orrery/contract";
import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DbTransaction } from "../../platform/db.ts";
import { uniqueConstraintName } from "../../platform/errors.ts";
import { tokenHash } from "../../platform/tokens.ts";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agentKeyEvents,
  agents,
  humans,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import type { SessionAccount } from "../accounts/index.ts";
import { canAuthenticateKey, canRotateKey, effectiveAgentKeyState } from "./state-machine.ts";

const VALIDITY_DAYS: Record<Exclude<AgentKeyValidity, "never">, number> = {
  "7": 7,
  "14": 14,
  "30": 30,
  "60": 60,
  "90": 90,
};

const newSecret = () => `orr_ak_${randomBytes(32).toString("base64url")}`;
const keyHintFor = (secret: string) => `${secret.slice(0, 19)}...`;

function expiryFor(validity: AgentKeyValidity) {
  return validity === AgentKeyValidity.enum.never
    ? null
    : sql`now() + make_interval(days => ${VALIDITY_DAYS[validity]})`;
}

export type AgentsErrorKind =
  | "not_signed_in"
  | "agent_name_taken"
  | "agent_not_found"
  | "workspace_not_found"
  | "not_workspace_owner"
  | "key_not_found"
  | "invalid_key_grant"
  | "invalid_key"
  | "key_revoked"
  | "key_expired"
  | "key_workspace_inaccessible"
  | "key_out_of_scope"
  | "insufficient_agent_access"
  | "human_deactivated"
  | "source_key_revoked"
  | "source_key_expired";

const messages: Record<AgentsErrorKind, string> = {
  not_signed_in: "Not signed in.",
  agent_name_taken: "You already have an agent with this name.",
  agent_not_found: "No agent with this id belongs to you.",
  workspace_not_found: "This workspace does not exist or you cannot access it.",
  not_workspace_owner: "Only a workspace owner can do that.",
  key_not_found: "No such key in this scope.",
  invalid_key_grant: "A project is outside the workspace, or above your current access.",
  invalid_key: "The API key is not valid.",
  key_revoked: "The API key has been revoked.",
  key_expired: "The API key has expired.",
  key_workspace_inaccessible: "The human who owns this key can no longer use its workspace.",
  key_out_of_scope: "The API key is not scoped to this workspace.",
  insufficient_agent_access: "The agent has no access to this project.",
  human_deactivated: "The human who owns this key is deactivated.",
  source_key_revoked: "A revoked key cannot be rotated.",
  source_key_expired: "An expired key cannot be rotated.",
};

export class AgentsError extends Error {
  readonly kind: AgentsErrorKind;

  constructor(kind: AgentsErrorKind) {
    super(messages[kind]);
    this.name = "AgentsError";
    this.kind = kind;
  }
}

function requireAccount(account: SessionAccount | null): SessionAccount {
  if (account === null) throw new AgentsError("not_signed_in");
  return account;
}

function requireKey(token: string | null): string {
  if (token === null) throw new AgentsError("invalid_key");
  return token;
}

async function lockWorkspaceOwnershipWrites(tx: DbTransaction) {
  await tx.execute(sql`select lock_workspace_ownership_writes()`);
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

export interface AgentsDeps {
  db: PostgresJsDatabase;
  projectAccessCeiling: ProjectAccessCeiling;
  projectAccessAtLeast: ProjectAccessAtLeast;
}

export interface AgentKeyTarget {
  workspaceId?: string | undefined;
  projectId?: string | undefined;
}

export interface AgentsService {
  createAgent(account: SessionAccount | null, input: CreateAgentRequest): Promise<Agent>;
  listAgents(account: SessionAccount | null): Promise<Agent[]>;
  issueKey(
    account: SessionAccount | null,
    input: CreateAgentKeyRequest,
  ): Promise<CreateAgentKeyResponse>;

  rotateKey(
    account: SessionAccount | null,
    keyId: string,
    input: RotateAgentKeyRequest,
  ): Promise<CreateAgentKeyResponse>;
  listKeys(account: SessionAccount | null, workspaceId?: string): Promise<AgentKey[]>;
  revokeKey(account: SessionAccount | null, keyId: string): Promise<AgentKey>;

  workspaceKeys(account: SessionAccount | null, workspaceId: string): Promise<AgentKey[]>;
  ownerRevokeKey(
    account: SessionAccount | null,
    workspaceId: string,
    keyId: string,
  ): Promise<AgentKey>;

  authenticate(token: string | null, target?: AgentKeyTarget): Promise<AgentIdentity>;
}

async function humanCanUseWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      membershipId: workspaceMemberships.id,
      humanDeactivatedAt: humans.deactivatedAt,
    })
    .from(workspaces)

    .innerJoin(humans, eq(humans.id, humanId))
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),

        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (row === undefined || row.humanDeactivatedAt !== null) return false;
  return row.personalOwnerHumanId === humanId || row.membershipId !== null;
}

async function requireWorkspaceOwner(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
): Promise<void> {
  const [row] = await tx
    .select({
      personalOwnerHumanId: workspaces.personalOwnerHumanId,
      isOwner: workspaceMemberships.isOwner,
      humanDeactivatedAt: humans.deactivatedAt,
    })
    .from(workspaces)
    .innerJoin(humans, eq(humans.id, humanId))
    .leftJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.workspaceId, workspaces.id),
        eq(workspaceMemberships.humanId, humanId),
        isNull(workspaceMemberships.suspendedAt),
      ),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const isOwner =
    row !== undefined &&
    row.humanDeactivatedAt === null &&
    (row.personalOwnerHumanId === humanId || row.isOwner === true);
  if (!isOwner) throw new AgentsError("not_workspace_owner");
}

async function recordEvent(
  tx: DbTransaction,
  type: AgentKeyEventType,
  key: { id: string; agentId: string; workspaceId: string },
  actorHumanId: string,
): Promise<void> {
  await tx.insert(agentKeyEvents).values({
    id: randomUUID(),
    keyId: key.id,
    agentId: key.agentId,
    workspaceId: key.workspaceId,
    type,
    actorHumanId,
  });
}

type KeyRow = {
  id: string;
  agentId: string;
  agentName: string;
  workspaceId: string;
  createdByHumanId: string;
  validity: AgentKeyValidity;
  keyHint: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByHumanId: string | null;
  replacesKeyId: string | null;
};

function keyRowColumns() {
  return {
    id: agentApiKeys.id,
    agentId: agentApiKeys.agentId,
    workspaceId: agentApiKeys.workspaceId,
    createdByHumanId: agentApiKeys.createdByHumanId,
    validity: agentApiKeys.validity,
    keyHint: agentApiKeys.keyHint,
    createdAt: agentApiKeys.createdAt,
    expiresAt: agentApiKeys.expiresAt,
    revokedAt: agentApiKeys.revokedAt,
    revokedByHumanId: agentApiKeys.revokedByHumanId,
    replacesKeyId: agentApiKeys.replacesKeyId,
  };
}

function toKey(row: KeyRow, grants: AgentKeyProject[]): AgentKey {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    workspaceId: row.workspaceId,
    createdByHumanId: row.createdByHumanId,
    validity: AgentKeyValidity.parse(row.validity),
    keyHint: row.keyHint,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByHumanId: row.revokedByHumanId,
    replacesKeyId: row.replacesKeyId,
    projects: grants,
  };
}

async function loadKeyProjects(
  tx: DbTransaction,
  keyIds: readonly string[],
): Promise<Map<string, AgentKeyProject[]>> {
  const byKey = new Map<string, AgentKeyProject[]>();
  if (keyIds.length === 0) return byKey;
  const rows = await tx
    .select({
      keyId: agentApiKeyProjects.keyId,
      projectId: agentApiKeyProjects.projectId,
      projectName: projects.name,
      level: agentApiKeyProjects.level,
    })
    .from(agentApiKeyProjects)
    .innerJoin(projects, eq(projects.id, agentApiKeyProjects.projectId))
    .where(inArray(agentApiKeyProjects.keyId, [...keyIds]));
  for (const row of rows) {
    const list = byKey.get(row.keyId) ?? [];
    list.push({
      projectId: row.projectId,
      projectName: row.projectName,
      level: ProjectAccessLevel.parse(row.level),
    });
    byKey.set(row.keyId, list);
  }
  return byKey;
}

async function loadKeys(tx: DbTransaction, where: SQL | undefined): Promise<AgentKey[]> {
  const rows = await tx
    .select({ ...keyRowColumns(), agentName: agents.name })
    .from(agentApiKeys)
    .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
    .where(where);
  const projectsByKey = await loadKeyProjects(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toKey(row, projectsByKey.get(row.id) ?? []));
}

async function projectKey(tx: DbTransaction, keyId: string): Promise<AgentKey> {
  const [key] = await loadKeys(tx, eq(agentApiKeys.id, keyId));
  if (key === undefined) throw new AgentsError("key_not_found");
  return key;
}

async function revokeInTransaction(
  tx: DbTransaction,
  keyId: string,
  actorHumanId: string,
): Promise<AgentKey> {
  const updated = await tx
    .update(agentApiKeys)
    .set({ revokedAt: sql`now()`, revokedByHumanId: actorHumanId })
    .where(and(eq(agentApiKeys.id, keyId), isNull(agentApiKeys.revokedAt)))
    .returning({ id: agentApiKeys.id });
  const key = await projectKey(tx, keyId);
  if (updated.length > 0) {
    await recordEvent(
      tx,
      AgentKeyEventType.enum.agent_key_revoked,
      { id: key.id, agentId: key.agentId, workspaceId: key.workspaceId },
      actorHumanId,
    );
  }
  return key;
}

export async function revokeMemberWorkspaceKeys(
  tx: DbTransaction,
  workspaceId: string,
  humanId: string,
  actorHumanId: string,
): Promise<void> {
  const revoked = await tx
    .update(agentApiKeys)
    .set({ revokedAt: sql`now()`, revokedByHumanId: actorHumanId })
    .where(
      and(
        eq(agentApiKeys.workspaceId, workspaceId),
        isNull(agentApiKeys.revokedAt),
        inArray(
          agentApiKeys.agentId,
          tx.select({ id: agents.id }).from(agents).where(eq(agents.humanId, humanId)),
        ),
      ),
    )
    .returning({ id: agentApiKeys.id, agentId: agentApiKeys.agentId });

  if (revoked.length > 0) {
    await tx.insert(agentKeyEvents).values(
      revoked.map((key) => ({
        id: randomUUID(),
        keyId: key.id,
        agentId: key.agentId,
        workspaceId,
        type: AgentKeyEventType.enum.agent_key_revoked,
        actorHumanId,
      })),
    );
  }
}

async function resolveKeyInTransaction(
  tx: DbTransaction,
  projectAccessCeiling: ProjectAccessCeiling,
  projectAccessAtLeast: ProjectAccessAtLeast,
  credential: string | AgentIdentity,
  target?: AgentKeyTarget,
): Promise<AgentIdentity> {
  const byToken = typeof credential === "string";
  const [row] = await tx
    .select({
      key: keyRowColumns(),
      agentName: agents.name,
      humanId: agents.humanId,
      humanDeactivatedAt: humans.deactivatedAt,
    })
    .from(agentApiKeys)
    .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
    .innerJoin(humans, eq(humans.id, agents.humanId))
    .where(
      byToken
        ? eq(agentApiKeys.tokenHash, tokenHash(credential))
        : eq(agentApiKeys.id, credential.keyId),
    )
    .limit(1);
  if (row === undefined) throw new AgentsError("invalid_key");
  if (
    !byToken &&
    (row.key.agentId !== credential.agentId ||
      row.humanId !== credential.humanId ||
      row.key.workspaceId !== credential.workspaceId)
  ) {
    throw new AgentsError("invalid_key");
  }

  if (row.humanDeactivatedAt !== null) throw new AgentsError("human_deactivated");

  if (row.key.revokedAt !== null) {
    effectiveAgentKeyState({
      revokedAt: row.key.revokedAt,
      validity: AgentKeyValidity.parse(row.key.validity),
      expired: false,
    });
    throw new AgentsError("key_revoked");
  }

  if (!(await humanCanUseWorkspace(tx, row.key.workspaceId, row.humanId))) {
    throw new AgentsError("key_workspace_inaccessible");
  }

  if (AgentKeyValidity.parse(row.key.validity) !== AgentKeyValidity.enum.never) {
    const [live] = await tx
      .select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.id, row.key.id), gt(agentApiKeys.expiresAt, sql`now()`)))
      .limit(1);
    const keyState = effectiveAgentKeyState({
      revokedAt: null,
      validity: AgentKeyValidity.parse(row.key.validity),
      expired: live === undefined,
    });
    if (!canAuthenticateKey(keyState)) throw new AgentsError("key_expired");
  }

  if (target?.workspaceId !== undefined && target.workspaceId !== row.key.workspaceId) {
    throw new AgentsError("key_out_of_scope");
  }

  const grants = await loadKeyProjects(tx, [row.key.id]);
  const requested = grants.get(row.key.id) ?? [];
  const ceiling = await projectAccessCeiling(
    tx,
    row.key.workspaceId,
    row.humanId,
    requested.map((grant) => grant.projectId),
  );
  const effective: AgentKeyProject[] = [];
  for (const grant of requested) {
    const humanLevel = ceiling.get(grant.projectId);
    if (humanLevel === undefined || humanLevel === null) continue;
    effective.push({
      projectId: grant.projectId,
      projectName: grant.projectName,
      level: projectAccessAtLeast(humanLevel, grant.level) ? grant.level : humanLevel,
    });
  }

  if (
    target?.projectId !== undefined &&
    !effective.some((grant) => grant.projectId === target.projectId)
  ) {
    throw new AgentsError("insufficient_agent_access");
  }

  return {
    agentId: row.key.agentId,
    name: row.agentName,
    humanId: row.humanId,
    keyId: row.key.id,
    workspaceId: row.key.workspaceId,
    validity: AgentKeyValidity.parse(row.key.validity),
    projects: effective,
  };
}

/**
 * Re-resolve an already-authenticated agent inside a write transaction. The
 * AgentIdentity captured at request start can outlive a key revocation, owner
 * deactivation, membership suspension or project-access change; this reads the
 * live rows through the same checks as authentication and returns the key's
 * current effective level for the project (or null when it has no grant).
 */
export async function agentProjectAccessInTransaction(
  tx: DbTransaction,
  projectAccessCeiling: ProjectAccessCeiling,
  projectAccessAtLeast: ProjectAccessAtLeast,
  identity: AgentIdentity,
  workspaceId: string,
  projectId: string,
): Promise<ProjectAccessLevel | null> {
  const live = await resolveKeyInTransaction(
    tx,
    projectAccessCeiling,
    projectAccessAtLeast,
    identity,
    { workspaceId, projectId },
  );
  return live.projects.find((grant) => grant.projectId === projectId)?.level ?? null;
}

export function createAgentsService({
  db,
  projectAccessCeiling,
  projectAccessAtLeast,
}: AgentsDeps): AgentsService {
  return {
    async createAgent(account, input) {
      const actor = requireAccount(account);
      const id = randomUUID();
      const createdAt = new Date();
      try {
        await db.insert(agents).values({ id, humanId: actor.humanId, name: input.name, createdAt });
      } catch (error) {
        if (uniqueConstraintName(error) === "one_agent_name_per_human") {
          throw new AgentsError("agent_name_taken");
        }
        throw error;
      }
      const agent: Agent = {
        id,
        humanId: actor.humanId,
        name: input.name,
        createdAt: createdAt.toISOString(),
      };
      return agent;
    },

    async listAgents(account) {
      const actor = requireAccount(account);
      const rows = await db
        .select({
          id: agents.id,
          humanId: agents.humanId,
          name: agents.name,
          createdAt: agents.createdAt,
        })
        .from(agents)
        .where(eq(agents.humanId, actor.humanId));
      return rows.map((row) => ({
        id: row.id,
        humanId: row.humanId,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async issueKey(account, input) {
      const actor = requireAccount(account);
      const validity = AgentKeyValidity.parse(input.validity ?? AgentKeyValidity.enum["90"]);
      return db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);
        const [agent] = await tx
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.humanId, actor.humanId)))
          .limit(1);
        if (agent === undefined) throw new AgentsError("agent_not_found");

        if (!(await humanCanUseWorkspace(tx, input.workspaceId, actor.humanId))) {
          throw new AgentsError("workspace_not_found");
        }

        const requested = input.projects;
        const ceiling = await projectAccessCeiling(
          tx,
          input.workspaceId,
          actor.humanId,
          requested.map((grant) => grant.projectId),
        );
        for (const grant of requested) {
          const humanLevel = ceiling.get(grant.projectId);
          if (
            humanLevel === undefined ||
            humanLevel === null ||
            !projectAccessAtLeast(humanLevel, grant.level)
          ) {
            throw new AgentsError("invalid_key_grant");
          }
        }

        const secret = newSecret();
        const id = randomUUID();
        const [inserted] = await tx
          .insert(agentApiKeys)
          .values({
            id,
            agentId: agent.id,
            workspaceId: input.workspaceId,
            createdByHumanId: actor.humanId,
            validity,
            tokenHash: tokenHash(secret),
            keyHint: keyHintFor(secret),
            expiresAt: expiryFor(validity),
          })
          .returning(keyRowColumns());
        if (inserted === undefined) throw new AgentsError("invalid_key_grant");
        const row = { ...inserted, agentName: agent.name };

        if (requested.length > 0) {
          await tx.insert(agentApiKeyProjects).values(
            requested.map((grant) => ({
              id: randomUUID(),
              keyId: id,
              projectId: grant.projectId,
              level: grant.level,
            })),
          );
        }
        await recordEvent(
          tx,
          AgentKeyEventType.enum.agent_key_created,
          { id, agentId: agent.id, workspaceId: input.workspaceId },
          actor.humanId,
        );
        const stored = await loadKeyProjects(tx, [id]);
        return { key: toKey(row, stored.get(id) ?? []), secret };
      });
    },

    async rotateKey(account, keyId, input) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);

        const [source] = await tx
          .select({ key: keyRowColumns(), agentName: agents.name })
          .from(agentApiKeys)
          .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
          .where(and(eq(agentApiKeys.id, keyId), eq(agents.humanId, actor.humanId)))
          .limit(1)
          .for("update", { of: agentApiKeys });
        if (source === undefined) throw new AgentsError("key_not_found");

        const sourceValidity = AgentKeyValidity.parse(source.key.validity);
        let sourceExpired = false;
        if (source.key.revokedAt !== null) {
          effectiveAgentKeyState({
            revokedAt: source.key.revokedAt,
            validity: sourceValidity,
            expired: false,
          });
          throw new AgentsError("source_key_revoked");
        }
        if (sourceValidity !== AgentKeyValidity.enum.never) {
          const [live] = await tx
            .select({ id: agentApiKeys.id })
            .from(agentApiKeys)
            .where(and(eq(agentApiKeys.id, keyId), gt(agentApiKeys.expiresAt, sql`now()`)))
            .limit(1);
          sourceExpired = live === undefined;
        }
        const sourceState = effectiveAgentKeyState({
          revokedAt: source.key.revokedAt,
          validity: sourceValidity,
          expired: sourceExpired,
        });
        if (!canRotateKey(sourceState)) throw new AgentsError("source_key_expired");

        if (!(await humanCanUseWorkspace(tx, source.key.workspaceId, actor.humanId))) {
          throw new AgentsError("workspace_not_found");
        }

        const preserved = (await loadKeyProjects(tx, [keyId])).get(keyId) ?? [];
        const requested: AgentKeyGrant[] =
          input.projects ??
          preserved.map((grant) => ({ projectId: grant.projectId, level: grant.level }));
        const explicit = input.projects !== undefined;
        const ceiling = await projectAccessCeiling(
          tx,
          source.key.workspaceId,
          actor.humanId,
          requested.map((grant) => grant.projectId),
        );
        const grants: AgentKeyGrant[] = [];
        for (const grant of requested) {
          const humanLevel = ceiling.get(grant.projectId);
          if (humanLevel === undefined || humanLevel === null) {
            if (explicit) throw new AgentsError("invalid_key_grant");
            continue;
          }
          if (!projectAccessAtLeast(humanLevel, grant.level)) {
            if (explicit) throw new AgentsError("invalid_key_grant");
            grants.push({ projectId: grant.projectId, level: humanLevel });
          } else {
            grants.push(grant);
          }
        }

        const validity = input.validity ?? AgentKeyValidity.parse(source.key.validity);
        const secret = newSecret();
        const id = randomUUID();
        const [inserted] = await tx
          .insert(agentApiKeys)
          .values({
            id,
            agentId: source.key.agentId,
            workspaceId: source.key.workspaceId,
            createdByHumanId: actor.humanId,
            validity,
            tokenHash: tokenHash(secret),
            keyHint: keyHintFor(secret),
            expiresAt: expiryFor(validity),
            replacesKeyId: keyId,
          })
          .returning(keyRowColumns());
        if (inserted === undefined) throw new AgentsError("invalid_key_grant");
        const row = { ...inserted, agentName: source.agentName };

        if (grants.length > 0) {
          await tx.insert(agentApiKeyProjects).values(
            grants.map((grant) => ({
              id: randomUUID(),
              keyId: id,
              projectId: grant.projectId,
              level: grant.level,
            })),
          );
        }

        await recordEvent(
          tx,
          AgentKeyEventType.enum.agent_key_rotated,
          { id, agentId: source.key.agentId, workspaceId: source.key.workspaceId },
          actor.humanId,
        );
        const stored = await loadKeyProjects(tx, [id]);
        return { key: toKey(row, stored.get(id) ?? []), secret };
      });
    },

    async listKeys(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction((tx) =>
        loadKeys(
          tx,
          workspaceId === undefined
            ? eq(agents.humanId, actor.humanId)
            : and(eq(agents.humanId, actor.humanId), eq(agentApiKeys.workspaceId, workspaceId)),
        ),
      );
    },

    async revokeKey(account, keyId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);
        const [owned] = await tx
          .select({ id: agentApiKeys.id })
          .from(agentApiKeys)
          .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
          .where(and(eq(agentApiKeys.id, keyId), eq(agents.humanId, actor.humanId)))
          .limit(1);
        if (owned === undefined) throw new AgentsError("key_not_found");
        return revokeInTransaction(tx, keyId, actor.humanId);
      });
    },

    async workspaceKeys(account, workspaceId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await requireWorkspaceOwner(tx, workspaceId, actor.humanId);
        return loadKeys(tx, eq(agentApiKeys.workspaceId, workspaceId));
      });
    },

    async ownerRevokeKey(account, workspaceId, keyId) {
      const actor = requireAccount(account);
      return db.transaction(async (tx) => {
        await lockWorkspaceOwnershipWrites(tx);
        await requireWorkspaceOwner(tx, workspaceId, actor.humanId);

        const [found] = await tx
          .select({ id: agentApiKeys.id })
          .from(agentApiKeys)
          .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.workspaceId, workspaceId)))
          .limit(1);
        if (found === undefined) throw new AgentsError("key_not_found");
        return revokeInTransaction(tx, keyId, actor.humanId);
      });
    },

    async authenticate(token, target) {
      const presented = requireKey(token);

      return db.transaction(
        (tx) =>
          resolveKeyInTransaction(
            tx,
            projectAccessCeiling,
            projectAccessAtLeast,
            presented,
            target,
          ),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}

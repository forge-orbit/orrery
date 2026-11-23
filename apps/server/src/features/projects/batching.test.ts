import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { FallbackPolicy, ProjectAccessLevel, WorkspaceKind } from "@orrery/contract";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  humans,
  issueComments,
  issueDependencies,
  issueLabels,
  issueLinks,
  issues,
  projectAccessEvents,
  projectAccessGrants,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createProjectsFeature } from "./index.ts";
import { projectAccessCeilingInTransaction, type WorkActor } from "./service.ts";

let pg: StartedPostgreSqlContainer;
let database: Database;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from project_access_events`);
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from agent_api_key_projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from agent_key_events`);
    await tx.execute(sql`delete from agents`);
    await tx.execute(sql`delete from issue_dependencies`);
    await tx.execute(sql`delete from issue_labels`);
    await tx.execute(sql`delete from project_labels`);
    await tx.execute(sql`delete from issue_links`);
    await tx.execute(sql`delete from issue_comments`);
    await tx.execute(sql`delete from knowledge_entries`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from project_access_grants`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from workspace_events`);
    await tx.execute(sql`delete from workspace_invitation_grants`);
    await tx.execute(sql`delete from workspace_invitations`);
    await tx.execute(sql`delete from workspace_memberships`);
    await tx.execute(sql`delete from workspaces`);
    await tx.execute(sql`delete from browser_sessions`);
    await tx.execute(sql`delete from humans`);
  });
});

function makeService() {
  return createProjectsFeature({
    db: database.db,
    sessionReader: async () => null,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  }).service;
}

function sessionAccount(humanId: string) {
  return {
    humanId,
    email: `${humanId}@example.com`,
    isSystemAdministrator: false,
    emailVerifiedAt: null,
  };
}

function humanActor(humanId: string): WorkActor {
  return { kind: "human", account: sessionAccount(humanId) };
}

async function insertHuman(label: string) {
  const id = randomUUID();
  const [row] = await database.db
    .insert(humans)
    .values({
      id,
      email: `${label}-${id}@example.com`,
      handle: `${label}-${id.replaceAll("-", "").slice(0, 8)}`,
      passwordHash: "x",
    })
    .returning({ id: humans.id, handle: humans.handle });
  if (row === undefined) throw new Error("the human was not created");
  return row;
}

async function insertSharedWorkspace(name: string, ownerHumanId: string) {
  const id = randomUUID();
  await database.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id,
      kind: WorkspaceKind.enum.shared,
      name,
      personalOwnerHumanId: null,
    });
    await tx.insert(workspaceMemberships).values({
      id: randomUUID(),
      workspaceId: id,
      humanId: ownerHumanId,
      isOwner: true,
    });
  });
  return id;
}

async function insertPersonalWorkspace(ownerHumanId: string) {
  const id = randomUUID();
  await database.db.insert(workspaces).values({
    id,
    kind: WorkspaceKind.enum.personal,
    name: "Personal",
    personalOwnerHumanId: ownerHumanId,
  });
  return id;
}

async function insertMembership(
  workspaceId: string,
  humanId: string,
  isOwner: boolean,
  suspendedAt: Date | null = null,
) {
  await database.db.insert(workspaceMemberships).values({
    id: randomUUID(),
    workspaceId,
    humanId,
    isOwner,
    suspendedAt,
  });
}

async function insertProject(workspaceId: string, createdByHumanId: string, name: string) {
  const id = randomUUID();
  await database.db.insert(projects).values({
    id,
    workspaceId,
    name,
    key: `P${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    createdByHumanId,
  });
  return id;
}

async function grant(
  projectId: string,
  humanId: string,
  grantedByHumanId: string,
  level: ProjectAccessLevel,
) {
  await database.db.insert(projectAccessGrants).values({
    id: randomUUID(),
    projectId,
    humanId,
    level,
    grantedByHumanId,
  });
}

async function agentWithProjectKey(
  ownerHumanId: string,
  workspaceId: string,
  projectId: string,
  name: string,
) {
  const agentId = randomUUID();
  await database.db.insert(agents).values({ id: agentId, humanId: ownerHumanId, name });
  const keyId = randomUUID();
  await database.db.insert(agentApiKeys).values({
    id: keyId,
    agentId,
    workspaceId,
    createdByHumanId: ownerHumanId,
    validity: "never",
    tokenHash: tokenHash(randomUUID()),
  });
  await database.db.insert(agentApiKeyProjects).values({
    id: randomUUID(),
    keyId,
    projectId,
    level: ProjectAccessLevel.enum.read,
  });
  return agentId;
}

describe("batched project access reads and writes", () => {
  it("returns a ceiling entry for every requested project id from one query", async () => {
    const owner = await insertHuman("owner");
    const member = await insertHuman("member");
    const suspended = await insertHuman("suspended");
    const workspaceId = await insertSharedWorkspace("Access", owner.id);
    await insertMembership(workspaceId, member.id, false);
    await insertMembership(workspaceId, suspended.id, false, new Date());
    const firstProjectId = await insertProject(workspaceId, owner.id, "First");
    const secondProjectId = await insertProject(workspaceId, owner.id, "Second");
    const otherWorkspaceId = await insertSharedWorkspace("Other", owner.id);
    const otherProjectId = await insertProject(otherWorkspaceId, owner.id, "Other");
    await grant(firstProjectId, member.id, owner.id, ProjectAccessLevel.enum.contribute);
    const missingProjectId = randomUUID();

    const memberCeiling = await database.db.transaction((tx) =>
      projectAccessCeilingInTransaction(tx, workspaceId, member.id, [
        firstProjectId,
        secondProjectId,
        otherProjectId,
        missingProjectId,
        firstProjectId,
      ]),
    );
    expect([...memberCeiling.keys()].toSorted()).toEqual(
      [firstProjectId, secondProjectId, otherProjectId, missingProjectId].toSorted(),
    );
    expect(memberCeiling.get(firstProjectId)).toBe(ProjectAccessLevel.enum.contribute);
    expect(memberCeiling.get(secondProjectId)).toBeNull();
    expect(memberCeiling.get(otherProjectId)).toBeNull();
    expect(memberCeiling.get(missingProjectId)).toBeNull();

    const ownerCeiling = await database.db.transaction((tx) =>
      projectAccessCeilingInTransaction(tx, workspaceId, owner.id, [
        firstProjectId,
        secondProjectId,
        otherProjectId,
      ]),
    );
    expect(ownerCeiling.get(firstProjectId)).toBe(ProjectAccessLevel.enum.manage);
    expect(ownerCeiling.get(secondProjectId)).toBe(ProjectAccessLevel.enum.manage);
    expect(ownerCeiling.get(otherProjectId)).toBeNull();

    const suspendedCeiling = await database.db.transaction((tx) =>
      projectAccessCeilingInTransaction(tx, workspaceId, suspended.id, [firstProjectId]),
    );
    expect(suspendedCeiling.get(firstProjectId)).toBeNull();

    const personalWorkspaceId = await insertPersonalWorkspace(member.id);
    const personalProjectId = await insertProject(personalWorkspaceId, member.id, "Personal");
    const personalCeiling = await database.db.transaction((tx) =>
      projectAccessCeilingInTransaction(tx, personalWorkspaceId, member.id, [personalProjectId]),
    );
    expect(personalCeiling.get(personalProjectId)).toBe(ProjectAccessLevel.enum.manage);
    const strangerCeiling = await database.db.transaction((tx) =>
      projectAccessCeilingInTransaction(tx, personalWorkspaceId, owner.id, [personalProjectId]),
    );
    expect(strangerCeiling.get(personalProjectId)).toBeNull();
  });

  it("applies offered invitation grants and records granted versus level-changed events", async () => {
    const owner = await insertHuman("owner");
    const member = await insertHuman("member");
    const workspaceId = await insertSharedWorkspace("Invitation", owner.id);
    await insertMembership(workspaceId, member.id, false);
    const raisedProjectId = await insertProject(workspaceId, owner.id, "Raised");
    const newProjectId = await insertProject(workspaceId, owner.id, "New");
    await grant(raisedProjectId, member.id, owner.id, ProjectAccessLevel.enum.read);
    const otherWorkspaceId = await insertSharedWorkspace("Elsewhere", owner.id);
    const foreignProjectId = await insertProject(otherWorkspaceId, owner.id, "Foreign");
    const service = makeService();

    const invalid = await database.db.transaction((tx) =>
      service.applyInvitationGrants(tx, workspaceId, member.id, owner.id, [
        { projectId: raisedProjectId, level: ProjectAccessLevel.enum.manage },
        { projectId: newProjectId, level: ProjectAccessLevel.enum.read },
      ]),
    );
    expect(invalid).toEqual([]);

    const grants = await database.db
      .select({
        projectId: projectAccessGrants.projectId,
        level: projectAccessGrants.level,
        grantedByHumanId: projectAccessGrants.grantedByHumanId,
      })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.humanId, member.id))
      .orderBy(projectAccessGrants.projectId);
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        {
          projectId: raisedProjectId,
          level: ProjectAccessLevel.enum.manage,
          grantedByHumanId: owner.id,
        },
        {
          projectId: newProjectId,
          level: ProjectAccessLevel.enum.read,
          grantedByHumanId: owner.id,
        },
      ]),
    );

    const events = await database.db
      .select({
        projectId: projectAccessEvents.projectId,
        type: projectAccessEvents.type,
        level: projectAccessEvents.level,
        previousLevel: projectAccessEvents.previousLevel,
      })
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.subjectHumanId, member.id));
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          projectId: raisedProjectId,
          type: "project_access_level_changed",
          level: ProjectAccessLevel.enum.manage,
          previousLevel: ProjectAccessLevel.enum.read,
        },
        {
          projectId: newProjectId,
          type: "project_access_granted",
          level: ProjectAccessLevel.enum.read,
          previousLevel: null,
        },
      ]),
    );

    const rejected = await database.db.transaction((tx) =>
      service.applyInvitationGrants(tx, workspaceId, member.id, owner.id, [
        { projectId: foreignProjectId, level: ProjectAccessLevel.enum.read },
      ]),
    );
    expect(rejected).toEqual([foreignProjectId]);
    expect(
      await database.db
        .select()
        .from(projectAccessGrants)
        .where(eq(projectAccessGrants.projectId, foreignProjectId)),
    ).toEqual([]);
  });

  it("revokes every workspace grant and records the events in one batch", async () => {
    const owner = await insertHuman("owner");
    const member = await insertHuman("member");
    const workspaceId = await insertSharedWorkspace("Removal", owner.id);
    const otherWorkspaceId = await insertSharedWorkspace("Retained", owner.id);
    await insertMembership(workspaceId, member.id, false);
    await insertMembership(otherWorkspaceId, member.id, false);
    const readProjectId = await insertProject(workspaceId, owner.id, "Read");
    const manageProjectId = await insertProject(workspaceId, owner.id, "Manage");
    const retainedProjectId = await insertProject(otherWorkspaceId, owner.id, "Retained");
    await grant(readProjectId, member.id, owner.id, ProjectAccessLevel.enum.read);
    await grant(manageProjectId, member.id, owner.id, ProjectAccessLevel.enum.manage);
    await grant(retainedProjectId, member.id, owner.id, ProjectAccessLevel.enum.contribute);
    const service = makeService();

    await database.db.transaction((tx) =>
      service.revokeMemberProjectAccess(tx, workspaceId, member.id, owner.id),
    );

    const remaining = await database.db
      .select({ projectId: projectAccessGrants.projectId })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.humanId, member.id));
    expect(remaining).toEqual([{ projectId: retainedProjectId }]);

    const events = await database.db
      .select({
        projectId: projectAccessEvents.projectId,
        type: projectAccessEvents.type,
        level: projectAccessEvents.level,
        previousLevel: projectAccessEvents.previousLevel,
      })
      .from(projectAccessEvents)
      .where(eq(projectAccessEvents.subjectHumanId, member.id));
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          projectId: readProjectId,
          type: "project_access_revoked",
          level: null,
          previousLevel: ProjectAccessLevel.enum.read,
        },
        {
          projectId: manageProjectId,
          type: "project_access_revoked",
          level: null,
          previousLevel: ProjectAccessLevel.enum.manage,
        },
      ]),
    );
  });

  it("scrubs every expired issue and its children in one purge batch", async () => {
    const owner = await insertHuman("owner");
    const workspaceId = await insertSharedWorkspace("Purge", owner.id);
    const projectId = await insertProject(workspaceId, owner.id, "Purge");
    const service = makeService();
    const actor = humanActor(owner.id);

    const first = await service.createIssue(actor, projectId, {
      title: "First",
      body: "first secret",
    });
    const second = await service.createIssue(actor, projectId, {
      title: "Second",
      body: "second secret",
    });
    const third = await service.createIssue(actor, projectId, {
      title: "Third",
      body: "third secret",
    });
    const label = await service.createLabel(actor, projectId, {
      name: "stale",
      color: "#ff0000",
    });
    await service.createComment(actor, first.id, { body: "first comment" });
    await service.createComment(actor, first.id, { body: "second comment" });
    await service.createComment(actor, second.id, { body: "third comment" });
    await service.addIssueLink(actor, first.id, {
      url: "https://example.com/first",
      title: "First link",
      kind: "doc",
    });
    await service.addIssueLink(actor, second.id, {
      url: "https://example.com/second",
      title: "Second link",
      kind: "doc",
    });
    await service.attachLabel(actor, second.id, label.id);
    await service.attachLabel(actor, third.id, label.id);
    await service.addBlockedBy(actor, first.id, { blockedByIssueId: third.id });
    await service.addBlockedBy(actor, second.id, { blockedByIssueId: first.id });

    for (const issue of [first, second, third]) await service.deleteIssue(actor, issue.id);
    const expiredIds = [first.id, second.id, third.id];
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days' where id in (${sql.join(
        expiredIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );

    expect(await service.purgeExpiredTrash()).toBe(3);

    const tombstones = await database.db
      .select()
      .from(issues)
      .where(inArray(issues.id, expiredIds))
      .orderBy(issues.id);
    expect(tombstones).toHaveLength(3);
    for (const tombstone of tombstones) {
      expect(tombstone).toMatchObject({
        title: "[deleted]",
        body: "",
        parentIssueId: null,
        assigneeType: null,
        assigneeId: null,
      });
      expect(tombstone.purgedAt).not.toBeNull();
    }
    expect(
      await database.db
        .select()
        .from(issueComments)
        .where(inArray(issueComments.issueId, expiredIds)),
    ).toEqual([]);
    expect(
      await database.db.select().from(issueLinks).where(inArray(issueLinks.issueId, expiredIds)),
    ).toEqual([]);
    expect(
      await database.db.select().from(issueLabels).where(inArray(issueLabels.issueId, expiredIds)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(issueDependencies)
        .where(
          or(
            inArray(issueDependencies.issueId, expiredIds),
            inArray(issueDependencies.blockedByIssueId, expiredIds),
          ),
        ),
    ).toEqual([]);
  });

  it("resolves every mention candidate and agent owner from the same access map", async () => {
    const owner = await insertHuman("owner");
    const granted = await insertHuman("granted");
    const ungranted = await insertHuman("ungranted");
    const workspaceId = await insertSharedWorkspace("Mentions", owner.id);
    await insertMembership(workspaceId, granted.id, false);
    await insertMembership(workspaceId, ungranted.id, false);
    const projectId = await insertProject(workspaceId, owner.id, "Mentions");
    await grant(projectId, granted.id, owner.id, ProjectAccessLevel.enum.read);
    const grantedAgentName = "granted-agent";
    const ungrantedAgentName = "ungranted-agent";
    await agentWithProjectKey(granted.id, workspaceId, projectId, grantedAgentName);
    await agentWithProjectKey(ungranted.id, workspaceId, projectId, ungrantedAgentName);
    const service = makeService();

    const shared = await service.listMentionCandidates(humanActor(owner.id), projectId);
    expect(shared.humans.map((human) => human.id).toSorted()).toEqual(
      [owner.id, granted.id].toSorted(),
    );
    expect(shared.agents.map((agent) => agent.name)).toEqual([grantedAgentName]);

    const personalWorkspaceId = await insertPersonalWorkspace(granted.id);
    const personalProjectId = await insertProject(personalWorkspaceId, granted.id, "Personal");
    const personal = await service.listMentionCandidates(humanActor(granted.id), personalProjectId);
    expect(personal.humans.map((human) => human.id)).toEqual([granted.id]);
    expect(personal.agents).toEqual([]);
    await expect(
      service.listMentionCandidates(humanActor(owner.id), personalProjectId),
    ).rejects.toMatchObject({ kind: "project_not_found" });
  });

  it("keeps a purged issue reachable only as a tombstone", async () => {
    // Guard the batch path against leaving dependency or label rows behind for
    // a single expired issue as well as for many.
    const owner = await insertHuman("owner");
    const workspaceId = await insertSharedWorkspace("Single purge", owner.id);
    const projectId = await insertProject(workspaceId, owner.id, "Single purge");
    const service = makeService();
    const actor = humanActor(owner.id);
    const issue = await service.createIssue(actor, projectId, { title: "Only" });
    await service.createComment(actor, issue.id, { body: "comment" });
    await service.deleteIssue(actor, issue.id);
    await database.db.execute(
      sql`update issues set deleted_at = statement_timestamp() - interval '31 days' where id = ${issue.id}`,
    );
    expect(await service.purgeExpiredTrash()).toBe(1);
    expect(
      await database.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
    ).toEqual([]);
    expect(
      await database.db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issue.id), sql`${issues.purgedAt} is not null`)),
    ).toHaveLength(1);
  });
});

function holdRowLock(lock: (tx: TransactionSql) => Promise<unknown>) {
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = database.sql.begin(async (tx) => {
    await lock(tx);
    markLocked();
    await gate;
  });
  return { locked, release, holding };
}

async function waitForWaitingQuery(pattern: string) {
  await expect
    .poll(
      async () => {
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike ${pattern}
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThan(0);
}

async function waitForWaitingProjectLock(pattern: string) {
  await expect
    .poll(
      async () => {
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_locks locks
          join pg_stat_activity activity on activity.pid = locks.pid
          where activity.wait_event_type = 'Lock'
            and activity.query ilike ${pattern}
            and activity.pid <> pg_backend_pid()
            and locks.locktype = 'relation'
            and locks.relation = 'projects'::regclass
            and locks.mode = 'RowShareLock'
            and locks.granted
        `;
        return row?.count ?? 0;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThan(0);
}

describe("project-first row locking", () => {
  it("takes the project lock before waiting for the issue lock", async () => {
    const owner = await insertHuman("owner");
    const workspaceId = await insertSharedWorkspace("Locking", owner.id);
    const projectId = await insertProject(workspaceId, owner.id, "Locking");
    const service = makeService();
    const account = sessionAccount(owner.id);
    const actor = humanActor(owner.id);
    const issue = await service.createIssue(actor, projectId, { title: "Locked" });
    await service.setIssueFallbackPolicyOverride(account, issue.id, {
      override: FallbackPolicy.enum.require_human,
    });

    const holder = holdRowLock((tx) => tx`select id from issues where id = ${issue.id} for update`);
    try {
      await holder.locked;
      const changing = service.setIssueFallbackPolicyOverride(account, issue.id, {
        override: null,
      });
      await waitForWaitingQuery('%from "issues"%for update%');
      await waitForWaitingProjectLock('%from "issues"%for update%');
      holder.release();
      await holder.holding;
      await expect(changing).resolves.toMatchObject({ fallbackPolicyOverride: null });
    } finally {
      holder.release();
      await holder.holding.catch(() => {});
    }
  });

  it("waits for the parent project lock before updating knowledge and labels", async () => {
    const owner = await insertHuman("owner");
    const workspaceId = await insertSharedWorkspace("Child locks", owner.id);
    const projectId = await insertProject(workspaceId, owner.id, "Child locks");
    const service = makeService();
    const actor = humanActor(owner.id);
    const entry = await service.createKnowledge(actor, projectId, { title: "Doc" });
    const label = await service.createLabel(actor, projectId, {
      name: "bug",
      color: "#ff0000",
    });

    const withProjectLock = async (action: () => Promise<unknown>) => {
      const holder = holdRowLock(
        (tx) => tx`select id from projects where id = ${projectId} for update`,
      );
      try {
        await holder.locked;
        const pending = action();
        await waitForWaitingQuery('%from "projects"%for update%');
        holder.release();
        await holder.holding;
        return await pending;
      } finally {
        holder.release();
        await holder.holding.catch(() => {});
      }
    };

    await expect(
      withProjectLock(() => service.updateKnowledge(actor, entry.id, { title: "Doc 2" })),
    ).resolves.toMatchObject({ title: "Doc 2" });
    await expect(
      withProjectLock(() => service.updateLabel(actor, label.id, { name: "fixed" })),
    ).resolves.toMatchObject({ name: "fixed" });
    await expect(withProjectLock(() => service.deleteLabel(actor, label.id))).resolves.toBe(
      undefined,
    );
  });

  it("waits for the issue lock before removing a dependency or link", async () => {
    const owner = await insertHuman("owner");
    const workspaceId = await insertSharedWorkspace("Issue locks", owner.id);
    const projectId = await insertProject(workspaceId, owner.id, "Issue locks");
    const service = makeService();
    const actor = humanActor(owner.id);
    const target = await service.createIssue(actor, projectId, { title: "Target" });
    const blocker = await service.createIssue(actor, projectId, { title: "Blocker" });
    await service.addBlockedBy(actor, target.id, { blockedByIssueId: blocker.id });
    const link = await service.addIssueLink(actor, target.id, {
      url: "https://example.com/lock",
      title: "Lock",
      kind: "doc",
    });

    const withIssueLock = async (action: () => Promise<unknown>) => {
      const holder = holdRowLock(
        (tx) => tx`select id from issues where id = ${target.id} for update`,
      );
      try {
        await holder.locked;
        const pending = action();
        await waitForWaitingQuery('%from "issues"%for update%');
        holder.release();
        await holder.holding;
        return await pending;
      } finally {
        holder.release();
        await holder.holding.catch(() => {});
      }
    };

    await expect(
      withIssueLock(() => service.removeBlockedBy(actor, target.id, blocker.id)),
    ).resolves.toBeUndefined();
    await expect(
      withIssueLock(() => service.removeIssueLink(actor, target.id, link.id)),
    ).resolves.toBeUndefined();
  });

  it("checks an agent assignee under a share lock on the key", async () => {
    const owner = await insertHuman("owner");
    const agentOwner = await insertHuman("agent-owner");
    const workspaceId = await insertSharedWorkspace("Assignee locks", owner.id);
    await insertMembership(workspaceId, agentOwner.id, false);
    const projectId = await insertProject(workspaceId, owner.id, "Assignee locks");
    const agentId = await agentWithProjectKey(
      agentOwner.id,
      workspaceId,
      projectId,
      "assignee-agent",
    );
    const service = makeService();
    const actor = humanActor(owner.id);

    const holder = holdRowLock(
      (tx) => tx`select id from agent_api_keys where agent_id = ${agentId} for update`,
    );
    try {
      await holder.locked;
      const creating = service.createIssue(actor, projectId, {
        title: "Assigned",
        assignee: { type: "agent", id: agentId },
      });
      await waitForWaitingQuery('%from "agent_api_keys"%for share%');
      holder.release();
      await holder.holding;
      const issue = await creating;
      expect(issue.assignee).toMatchObject({ agentId });
    } finally {
      holder.release();
      await holder.holding.catch(() => {});
    }
  });
});

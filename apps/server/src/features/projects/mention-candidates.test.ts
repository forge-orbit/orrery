import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MentionCandidatesResponse, Problem } from "@orrery/contract";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  browserSessions,
  humans,
  projectAccessGrants,
  projects,
  workspaceMemberships,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature } from "./index.ts";

const PUBLIC_URL = "http://orrery.test";

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let projectId: string;
let ownerCookie: string;
let outsiderCookie: string;
let activeAgentName: string;
let deactivatedOwnerAgentName: string;

async function humanWithSession(email: string, deactivated = false) {
  const [row] = await database.db
    .insert(humans)
    .values({
      id: randomUUID(),
      email,
      passwordHash: "hash",
      ...(deactivated ? { deactivatedAt: new Date() } : {}),
    })
    .returning({ id: humans.id, handle: humans.handle });
  if (row === undefined) throw new Error("failed to seed human");
  const token = randomUUID();
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId: row.id,
    tokenHash: tokenHash(token),
    expiresAt: sql`now() + interval '1 day'`,
  });
  return { ...row, cookie: `orrery_session=${token}` };
}

async function agentWithLiveKey(ownerHumanId: string, workspaceId: string, name: string) {
  const [agent] = await database.db
    .insert(agents)
    .values({ id: randomUUID(), humanId: ownerHumanId, name })
    .returning({ id: agents.id });
  if (agent === undefined) throw new Error("failed to seed agent");
  const [key] = await database.db
    .insert(agentApiKeys)
    .values({
      id: randomUUID(),
      agentId: agent.id,
      workspaceId,
      createdByHumanId: ownerHumanId,
      validity: "never",
      tokenHash: tokenHash(randomUUID()),
    })
    .returning({ id: agentApiKeys.id });
  if (key === undefined) throw new Error("failed to seed agent key");
  await database.db.insert(agentApiKeyProjects).values({
    id: randomUUID(),
    keyId: key.id,
    projectId,
    level: "read",
  });
  return name;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: "mention-candidates-test-secret",
    publicUrl: PUBLIC_URL,
  });
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  });
  app = createApp({
    features: [accounts, projectsFeature],
    publicUrl: PUBLIC_URL,
    log: createLogger("error"),
  });

  const owner = await humanWithSession("owner@example.com");
  const activeMember = await humanWithSession("active@example.com");
  const suspendedMember = await humanWithSession("suspended@example.com");
  const deactivatedMember = await humanWithSession("deactivated@example.com", true);
  const outsider = await humanWithSession("outsider@example.com");
  const activeAgentOwner = await humanWithSession("active-agent-owner@example.com");
  const deactivatedAgentOwner = await humanWithSession("deactivated-agent-owner@example.com", true);
  ownerCookie = owner.cookie;
  outsiderCookie = outsider.cookie;

  const workspaceId = randomUUID();
  await database.db.transaction(async (tx) => {
    await tx.insert(workspaces).values({ id: workspaceId, kind: "shared", name: "Candidates" });
    for (const member of [
      owner,
      activeMember,
      suspendedMember,
      deactivatedMember,
      activeAgentOwner,
      deactivatedAgentOwner,
    ]) {
      await tx.insert(workspaceMemberships).values({
        id: randomUUID(),
        workspaceId,
        humanId: member.id,
        isOwner: member.id === owner.id,
        suspendedAt: member.id === suspendedMember.id ? new Date() : null,
      });
    }
  });
  const [created] = await database.db
    .insert(projects)
    .values({
      id: randomUUID(),
      workspaceId,
      name: "Candidates project",
      key: `P${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`,
      createdByHumanId: owner.id,
      fallbackPolicy: "require_human",
    })
    .returning({ id: projects.id });
  if (created === undefined) throw new Error("failed to seed project");
  projectId = created.id;
  await database.db.insert(projectAccessGrants).values(
    // A suspended membership cannot hold a project grant; the suspended Human is
    // already excluded from candidates by the active-membership filter. Both agent
    // owners get Read access so their agents are otherwise eligible as candidates.
    [activeMember, deactivatedMember, activeAgentOwner, deactivatedAgentOwner].map((member) => ({
      id: randomUUID(),
      projectId,
      humanId: member.id,
      grantedByHumanId: owner.id,
      level: "read" as const,
    })),
  );

  activeAgentName = "live-agent";
  deactivatedOwnerAgentName = "deactivated-owner-agent";
  await agentWithLiveKey(activeAgentOwner.id, workspaceId, activeAgentName);
  await agentWithLiveKey(deactivatedAgentOwner.id, workspaceId, deactivatedOwnerAgentName);
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

const candidates = (cookie?: string) =>
  app.request(`/api/projects/${projectId}/mention-candidates`, {
    headers: cookie ? { cookie } : {},
  });

describe("GET /api/projects/{projectId}/mention-candidates", () => {
  it("returns 401 for an unauthenticated caller", async () => {
    const res = await candidates();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(Problem.parse(await res.json())).toMatchObject({ status: 401, code: "not_signed_in" });
  });

  it("returns 404 for a Human who is not a project member", async () => {
    const res = await candidates(outsiderCookie);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(Problem.parse(await res.json())).toMatchObject({
      status: 404,
      code: "project_not_found",
    });
  });

  it("excludes suspended and deactivated Humans and agents owned by deactivated Humans", async () => {
    const res = await candidates(ownerCookie);
    expect(res.status).toBe(200);
    const body = MentionCandidatesResponse.parse(await res.json());
    const handles = body.humans.map((human) => human.handle);
    expect(handles).toContain("owner");
    expect(handles).toContain("active");
    expect(handles).not.toContain("suspended");
    expect(handles).not.toContain("deactivated");
    const agentNames = body.agents.map((agent) => agent.name);
    expect(agentNames).toContain(activeAgentName);
    expect(agentNames).not.toContain(deactivatedOwnerAgentName);
  });
});

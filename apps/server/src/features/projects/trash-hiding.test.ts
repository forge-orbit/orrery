import { randomBytes, randomUUID } from "node:crypto";
import { Issue, KnowledgeEntry, Problem } from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeyProjects,
  agentApiKeys,
  agents,
  attachmentReferences,
  attachments,
  browserSessions,
  humans,
  issueDependencies,
  issues,
  notifications,
  projectActivity,
  projectAccessGrants,
  projectTransferAuthorizations,
  projects,
  questions,
  runnerDispatches,
  runnerHosts,
  runners,
  runs,
  storedObjects,
  workSessions,
  workspaceInvitationGrants,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
  webhookProjects,
} from "../../db/schema.ts";
import { loadConfig } from "../../platform/config.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { tokenHash } from "../../platform/tokens.ts";
import { createFeatures } from "../index.ts";

const PUBLIC_URL = "http://orrery.test";
const SECRET = "project-trash-hiding-bootstrap-secret";
const ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: ReturnType<typeof createApp>;

type RequestOptions = {
  method?: string;
  cookie?: string;
  bearer?: string;
  body?: unknown;
  form?: FormData;
};

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers();
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return await app.request(path, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined
      ? options.form === undefined
        ? {}
        : { body: options.form }
      : { body: JSON.stringify(options.body) }),
  });
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(Problem.parse(await response.json())).toMatchObject({ status, code });
}

async function waitForLockWait(queryPattern: string, minimum = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count
          from pg_stat_activity
          where wait_event_type = 'Lock'
            and query ilike ${queryPattern}
            and pid <> pg_backend_pid()
        `;
        return row?.count ?? 0;
      },
      { timeout: 10_000, interval: 25 },
    )
    .toBeGreaterThanOrEqual(minimum);
}

async function createHuman(email: string): Promise<{ id: string; cookie: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await database.db.insert(humans).values({
    id,
    email,
    passwordHash: "test-only",
    emailVerifiedAt: sql`statement_timestamp()`,
  });
  await database.db.insert(browserSessions).values({
    id: randomUUID(),
    humanId: id,
    tokenHash: tokenHash(token),
    expiresAt: sql`statement_timestamp() + interval '1 hour'`,
  });
  return { id, cookie: `orrery_session=${token}` };
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  const config = loadConfig({
    DATABASE_URL: pg.getConnectionUri(),
    PUBLIC_URL,
    BOOTSTRAP_SECRET: SECRET,
    ORRERY_ENCRYPTION_KEY: ENCRYPTION_KEY,
    LOG_LEVEL: "error",
  });
  database = createDb(config.DATABASE_URL);
  await migrate(database.sql, new URL("../../../../../db/migrations", import.meta.url).pathname);
  app = createApp({
    features: createFeatures(database, config, createLogger("error")),
    publicUrl: PUBLIC_URL,
    log: createLogger("error"),
  });
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

describe("Project Trash cross-feature hiding", () => {
  it("hides downstream data, skips trashed invitation grants, and restores preserved references", async () => {
    const owner = await createHuman(`owner-${randomUUID()}@example.test`);
    const inviteeEmail = `invitee-${randomUUID()}@example.test`;
    const invitee = await createHuman(inviteeEmail);
    const workspaceId = randomUUID();
    const destinationWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const activeProjectId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values([
        { id: workspaceId, kind: "shared", name: "Source", personalOwnerHumanId: null },
        {
          id: destinationWorkspaceId,
          kind: "shared",
          name: "Destination",
          personalOwnerHumanId: null,
        },
      ]);
      await tx.insert(workspaceMemberships).values([
        { id: randomUUID(), workspaceId, humanId: owner.id, isOwner: true },
        { id: randomUUID(), workspaceId: destinationWorkspaceId, humanId: owner.id, isOwner: true },
      ]);
    });
    await database.db.insert(projects).values([
      {
        id: projectId,
        workspaceId,
        name: "Hidden project",
        key: "HIDE",
        createdByHumanId: owner.id,
      },
      {
        id: activeProjectId,
        workspaceId,
        name: "Visible project",
        key: "SHOW",
        createdByHumanId: owner.id,
      },
    ]);
    await database.db.insert(agents).values({ id: agentId, humanId: owner.id, name: "Worker" });
    await database.db.insert(runs).values({ id: runId, agentId, workspaceId });

    const hiddenIssueResponse = await request(`/api/projects/${projectId}/issues`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Hidden issue", body: "private issue body" },
    });
    expect(hiddenIssueResponse.status).toBe(201);
    const hiddenIssue = Issue.parse(await hiddenIssueResponse.json());
    const visibleIssueResponse = await request(`/api/projects/${activeProjectId}/issues`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Visible issue" },
    });
    expect(visibleIssueResponse.status).toBe(201);
    const visibleIssue = Issue.parse(await visibleIssueResponse.json());
    const knowledgeResponse = await request(`/api/projects/${projectId}/knowledge`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Hidden knowledge", body: "private knowledge body" },
    });
    expect(knowledgeResponse.status).toBe(201);
    const knowledge = KnowledgeEntry.parse(await knowledgeResponse.json());

    await database.db
      .update(issues)
      .set({ assigneeType: "human", assigneeId: owner.id })
      .where(eq(issues.id, hiddenIssue.id));
    await database.db.insert(issueDependencies).values({
      id: randomUUID(),
      issueId: visibleIssue.id,
      blockedByIssueId: hiddenIssue.id,
      createdByHumanId: owner.id,
    });

    const keySecret = `orr_ak_${randomBytes(32).toString("base64url")}`;
    await database.db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId,
      workspaceId,
      createdByHumanId: owner.id,
      validity: "never",
      tokenHash: tokenHash(keySecret),
    });
    const key = (
      await database.db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId))
    )[0];
    if (key === undefined) throw new Error("the API key was not inserted");
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: key.id,
      projectId,
      level: "contribute",
    });

    const sessionId = randomUUID();
    await database.db.insert(workSessions).values({
      id: sessionId,
      agentId,
      runId,
      workspaceId,
      issueId: hiddenIssue.id,
      status: "released",
      leaseExpiresAt: sql`statement_timestamp() - interval '1 second'`,
      endedAt: sql`statement_timestamp()`,
    });
    const questionId = randomUUID();
    await database.db.insert(questions).values({
      id: questionId,
      issueId: hiddenIssue.id,
      projectId,
      workspaceId,
      agentId,
      runId,
      sessionId,
      question: "Should this remain hidden?",
      proposedFallback: "Keep it private",
      responseDeadlineAt: sql`statement_timestamp() + interval '1 hour'`,
    });
    const [activity] = await database.db
      .select({ id: projectActivity.id })
      .from(projectActivity)
      .where(eq(projectActivity.issueId, hiddenIssue.id))
      .limit(1);
    if (activity === undefined) throw new Error("the issue activity was not recorded");
    const notificationId = randomUUID();
    await database.db.insert(notifications).values({
      id: notificationId,
      humanId: owner.id,
      projectId,
      issueId: hiddenIssue.id,
      activityId: activity.id,
      kind: "needs_input",
      summary: "Hidden notification",
    });

    const objectId = randomUUID();
    const attachmentId = randomUUID();
    await database.db.insert(storedObjects).values({
      id: objectId,
      key: `attachments/${projectId}/${objectId}.png`,
      status: "active",
      contentType: "image/png",
      byteSize: 1,
      sha256: "0".repeat(64),
    });
    await database.db.insert(attachments).values({
      id: attachmentId,
      projectId,
      objectId,
      filename: "private.png",
      contentType: "image/png",
      byteSize: 1,
      uploadedByHumanId: owner.id,
      unreferencedAt: null,
    });
    await database.db.insert(attachmentReferences).values({
      id: randomUUID(),
      attachmentId,
      holderType: "issue",
      holderId: hiddenIssue.id,
    });

    const runnerCredential = `orr_rh_${randomBytes(32).toString("hex")}`;
    const hostId = randomUUID();
    const runnerId = randomUUID();
    await database.db.insert(runnerHosts).values({
      id: hostId,
      humanId: owner.id,
      displayName: "Project runner",
      platform: "linux-x64",
      credentialHash: tokenHash(runnerCredential),
    });
    await database.db.insert(runners).values({
      id: runnerId,
      hostId,
      workspaceId,
      projectId,
      agentId,
      displayName: "Project runner",
      repoFingerprint: tokenHash("private-checkout"),
    });
    await database.db.insert(runnerDispatches).values({
      id: randomUUID(),
      runnerId,
      workspaceId,
      projectId,
      issueId: hiddenIssue.id,
      requestedByHumanId: owner.id,
      agentId,
      dispatchAttemptId: randomUUID(),
      state: "ended",
      endedAt: sql`statement_timestamp()`,
    });

    const transferToken = randomBytes(32).toString("base64url");
    await database.db.insert(projectTransferAuthorizations).values({
      id: randomUUID(),
      projectId,
      sourceWorkspaceId: workspaceId,
      destinationWorkspaceId,
      authorizedByHumanId: owner.id,
      tokenHash: tokenHash(transferToken),
      status: "pending",
      expiresAt: sql`statement_timestamp() + interval '1 day'`,
    });

    const webhookResponse = await request(`/api/workspaces/${workspaceId}/webhooks`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        url: "https://example.com/project-events",
        allProjects: false,
        projectIds: [projectId],
        allEvents: true,
        events: [],
      },
    });
    expect(webhookResponse.status).toBe(201);
    const webhookBody: unknown = await webhookResponse.json();
    const webhookWithSecret =
      typeof webhookBody === "object" && webhookBody !== null
        ? (Reflect.get(webhookBody, "webhook") ?? webhookBody)
        : webhookBody;
    const webhookId =
      typeof webhookWithSecret === "object" && webhookWithSecret !== null
        ? Reflect.get(webhookWithSecret, "id")
        : undefined;
    if (typeof webhookId !== "string") throw new Error("the webhook id was not returned");

    const commentBeforeTrash = await request(`/api/issues/${hiddenIssue.id}/comments`, {
      method: "POST",
      cookie: owner.cookie,
      body: { body: "pre-trash comment for webhook delivery" },
    });
    expect(commentBeforeTrash.status).toBe(201);

    const invitationToken = randomBytes(32).toString("base64url");
    const invitationId = randomUUID();
    await database.db.insert(workspaceInvitations).values({
      id: invitationId,
      workspaceId,
      email: inviteeEmail,
      status: "pending",
      tokenHash: tokenHash(invitationToken),
      invitedByHumanId: owner.id,
      expiresAt: sql`statement_timestamp() + interval '1 day'`,
      deliveryStatus: "sent",
    });
    await database.db.insert(workspaceInvitationGrants).values([
      { id: randomUUID(), invitationId, projectId, level: "contribute" },
      { id: randomUUID(), invitationId, projectId: activeProjectId, level: "read" },
    ]);

    const myWorkBefore = await request("/api/my-work", { cookie: owner.cookie });
    expect(myWorkBefore.status).toBe(200);
    expect(JSON.stringify(await myWorkBefore.json())).toContain(hiddenIssue.id);
    const inboxBefore = await request("/api/inbox", { cookie: owner.cookie });
    expect(inboxBefore.status).toBe(200);
    expect(JSON.stringify(await inboxBefore.json())).toContain(questionId);
    const notificationsBefore = await request("/api/notifications", { cookie: owner.cookie });
    expect(JSON.stringify(await notificationsBefore.json())).toContain(notificationId);
    const readyWorkBefore = await request(`/api/projects/${activeProjectId}/ready-work`, {
      cookie: owner.cookie,
    });
    expect(readyWorkBefore.status).toBe(200);
    expect(JSON.stringify(await readyWorkBefore.json())).not.toContain(visibleIssue.id);

    const trashed = await request(`/api/projects/${projectId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(trashed.status).toBe(204);

    await expectProblem(
      await request(`/api/projects/${projectId}`, { cookie: owner.cookie }),
      404,
      "project_not_found",
    );
    await expectProblem(
      await request(`/api/issues/${hiddenIssue.id}`, { cookie: owner.cookie }),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await request(`/api/issues/${hiddenIssue.id}/comments`, {
        method: "POST",
        cookie: owner.cookie,
        body: { body: "should be hidden" },
      }),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await request(`/api/knowledge/${knowledge.id}`, { cookie: owner.cookie }),
      404,
      "knowledge_entry_not_found",
    );
    await expectProblem(
      await request(`/api/projects/${projectId}/attachments/${attachmentId}`, {
        cookie: owner.cookie,
      }),
      404,
      "project_not_found",
    );
    const upload = new FormData();
    upload.set("file", new File([new Uint8Array([1, 2, 3])], "private.png", { type: "image/png" }));
    await expectProblem(
      await request(`/api/projects/${projectId}/attachments`, {
        method: "POST",
        cookie: owner.cookie,
        form: upload,
      }),
      404,
      "project_not_found",
    );
    await expectProblem(
      await request(`/api/issues/${hiddenIssue.id}/dispatches`, { cookie: owner.cookie }),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await request(`/api/issues/${hiddenIssue.id}/dispatches`, {
        method: "POST",
        cookie: owner.cookie,
        body: { runnerId },
      }),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await request(`/api/projects/${projectId}/transfer/preview`, {
        method: "POST",
        cookie: owner.cookie,
        body: { destinationWorkspaceId },
      }),
      404,
      "project_not_found",
    );
    await expectProblem(
      await request("/api/transfers/accept", {
        method: "POST",
        cookie: owner.cookie,
        body: { token: transferToken },
      }),
      404,
      "transfer_invalid",
    );
    const readyWorkAfter = await request(`/api/projects/${activeProjectId}/ready-work`, {
      cookie: owner.cookie,
    });
    expect(readyWorkAfter.status).toBe(200);
    expect(JSON.stringify(await readyWorkAfter.json())).toContain(visibleIssue.id);
    await expectProblem(
      await request(`/api/issues/${hiddenIssue.id}/work-sessions`, {
        method: "POST",
        bearer: keySecret,
        body: { runId },
      }),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await request(`/api/projects/${projectId}/ready-work`, { cookie: owner.cookie }),
      404,
      "project_not_found",
    );
    await expectProblem(
      await request(`/api/projects/${projectId}/history`, { cookie: owner.cookie }),
      404,
      "project_not_found",
    );

    const myWorkAfter = await request("/api/my-work", { cookie: owner.cookie });
    expect(JSON.stringify(await myWorkAfter.json())).not.toContain(hiddenIssue.id);
    const inboxAfter = await request("/api/inbox", { cookie: owner.cookie });
    expect(JSON.stringify(await inboxAfter.json())).not.toContain(questionId);
    const notificationsAfter = await request("/api/notifications", { cookie: owner.cookie });
    expect(JSON.stringify(await notificationsAfter.json())).not.toContain(notificationId);
    await expectProblem(
      await request(`/api/notifications/${notificationId}/read`, {
        method: "POST",
        cookie: owner.cookie,
      }),
      404,
      "notification_not_found",
    );

    const blockedBy = await request(`/api/issues/${visibleIssue.id}/blocked-by`, {
      cookie: owner.cookie,
    });
    expect(blockedBy.status).toBe(200);
    expect(JSON.stringify(await blockedBy.json())).not.toContain(hiddenIssue.id);
    const runnerFleet = await request(`/api/workspaces/${workspaceId}/runners`, {
      cookie: owner.cookie,
    });
    expect(JSON.stringify(await runnerFleet.json())).not.toContain(runnerId);
    await expectProblem(
      await request(`/api/runners/${runnerId}/commands`, { bearer: runnerCredential }),
      401,
      "runner_revoked",
    );
    await expectProblem(
      await request("/api/runners/issue-resolve", {
        method: "POST",
        bearer: runnerCredential,
        body: { target: hiddenIssue.id },
      }),
      404,
      "issue_not_found",
    );
    await expectProblem(
      await request("/api/runners/issue-resolve", {
        method: "POST",
        bearer: runnerCredential,
        body: { target: hiddenIssue.identifier },
      }),
      404,
      "issue_not_found",
    );
    const autoClaimTrashed = await request(`/api/runners/${runnerId}/auto-claim`, {
      method: "POST",
      bearer: runnerCredential,
      body: { filter: "all" },
    });
    expect(autoClaimTrashed.status).toBe(401);

    const keyList = await request("/api/agents/keys", { cookie: owner.cookie });
    expect(JSON.stringify(await keyList.json())).not.toContain(projectId);
    const identity = await request("/api/agents/me", { bearer: keySecret });
    expect(identity.status).toBe(200);
    expect(JSON.stringify(await identity.json())).not.toContain(projectId);
    const createKeyTrashed = await request("/api/agents/keys", {
      method: "POST",
      cookie: owner.cookie,
      body: {
        agentId,
        workspaceId,
        validity: "never",
        projects: [{ projectId, level: "contribute" }],
      },
    });
    await expectProblem(createKeyTrashed, 400, "invalid_key_grant");
    const rotateKeyTrashed = await request(`/api/agents/keys/${key.id}/rotate`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        validity: "never",
        projects: [{ projectId, level: "contribute" }],
      },
    });
    await expectProblem(rotateKeyTrashed, 400, "invalid_key_grant");

    const webhookList = await request(`/api/workspaces/${workspaceId}/webhooks`, {
      cookie: owner.cookie,
    });
    expect(webhookList.status).toBe(200);
    expect(JSON.stringify(await webhookList.json())).not.toContain(projectId);
    const deliveries = await request(
      `/api/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries`,
      { cookie: owner.cookie },
    );
    const deliveriesBody = JSON.stringify(await deliveries.json());
    expect(deliveriesBody).toContain("project_deleted");
    expect(deliveriesBody).not.toContain("issue_commented");

    const workspaceHistory = await request(`/api/workspaces/${workspaceId}/history`, {
      cookie: owner.cookie,
    });
    expect(workspaceHistory.status).toBe(200);
    expect(JSON.stringify(await workspaceHistory.json())).toContain("project_deleted");

    const invitationList = await request(`/api/workspaces/${workspaceId}/invitations`, {
      cookie: owner.cookie,
    });
    expect(invitationList.status).toBe(200);
    expect(JSON.stringify(await invitationList.json())).not.toContain(projectId);
    const invitationPreview = await request(
      `/api/workspace-invitations/preview?token=${encodeURIComponent(invitationToken)}`,
    );
    expect(invitationPreview.status).toBe(200);
    expect(JSON.stringify(await invitationPreview.json())).not.toContain(projectId);
    await expectProblem(
      await request(`/api/workspaces/${workspaceId}/invitations`, {
        method: "POST",
        cookie: owner.cookie,
        body: {
          email: `another-${randomUUID()}@example.test`,
          projectGrants: [{ projectId, level: "read" }],
        },
      }),
      409,
      "invitation_scope_invalid",
    );

    const invitationAccepted = await request("/api/workspace-invitations/acceptance", {
      method: "POST",
      cookie: invitee.cookie,
      body: { token: invitationToken },
    });
    expect(invitationAccepted.status).toBe(200);
    const invitationGrantRows = await database.db
      .select({ projectId: workspaceInvitationGrants.projectId })
      .from(workspaceInvitationGrants)
      .where(eq(workspaceInvitationGrants.invitationId, invitationId));
    expect(invitationGrantRows.map((row) => row.projectId)).toEqual([projectId, activeProjectId]);
    const inviteeAccess = await database.db
      .select({ projectId: projectAccessGrants.projectId })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.humanId, invitee.id));
    expect(inviteeAccess.map((grant) => grant.projectId)).toEqual([activeProjectId]);

    await request(`/api/projects/${projectId}/restore`, {
      method: "POST",
      cookie: owner.cookie,
    }).then((response) => expect(response.status).toBe(200));
    const deliveriesAfterRestore = await request(
      `/api/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries`,
      { cookie: owner.cookie },
    );
    expect(JSON.stringify(await deliveriesAfterRestore.json())).toContain("issue_commented");
    expect(
      await database.db
        .select()
        .from(projectTransferAuthorizations)
        .where(eq(projectTransferAuthorizations.projectId, projectId)),
    ).toMatchObject([{ status: "revoked" }]);
    expect(
      await database.db.select().from(attachments).where(eq(attachments.id, attachmentId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(attachmentReferences)
        .where(eq(attachmentReferences.attachmentId, attachmentId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(issueDependencies)
        .where(eq(issueDependencies.blockedByIssueId, hiddenIssue.id)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(agentApiKeyProjects)
        .where(eq(agentApiKeyProjects.projectId, projectId)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(webhookProjects)
        .where(eq(webhookProjects.projectId, projectId)),
    ).toHaveLength(1);
  });

  it("serializes project trash before concurrent claims and dispatches", async () => {
    const owner = await createHuman(`race-owner-${randomUUID()}@example.test`);
    const workspaceId = randomUUID();
    const destinationWorkspaceId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.insert(workspaces).values([
        { id: workspaceId, kind: "shared", name: "Race source", personalOwnerHumanId: null },
        {
          id: destinationWorkspaceId,
          kind: "shared",
          name: "Race destination",
          personalOwnerHumanId: null,
        },
      ]);
      await tx.insert(workspaceMemberships).values([
        { id: randomUUID(), workspaceId, humanId: owner.id, isOwner: true },
        {
          id: randomUUID(),
          workspaceId: destinationWorkspaceId,
          humanId: owner.id,
          isOwner: true,
        },
      ]);
    });
    await database.db.insert(projects).values({
      id: projectId,
      workspaceId,
      name: "Racing project",
      key: "RACE",
      createdByHumanId: owner.id,
    });
    await database.db.insert(agents).values({ id: agentId, humanId: owner.id, name: "Racer" });
    await database.db.insert(runs).values({ id: runId, agentId, workspaceId });
    const issueResponse = await request(`/api/projects/${projectId}/issues`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "Race issue" },
    });
    expect(issueResponse.status).toBe(201);
    const issue = Issue.parse(await issueResponse.json());

    const keySecret = `orr_ak_${randomBytes(32).toString("base64url")}`;
    await database.db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId,
      workspaceId,
      createdByHumanId: owner.id,
      validity: "never",
      tokenHash: tokenHash(keySecret),
    });
    const [key] = await database.db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, agentId));
    if (key === undefined) throw new Error("the race API key was not inserted");
    await database.db.insert(agentApiKeyProjects).values({
      id: randomUUID(),
      keyId: key.id,
      projectId,
      level: "contribute",
    });

    const runnerCredential = `orr_rh_${randomBytes(32).toString("hex")}`;
    const hostId = randomUUID();
    const runnerId = randomUUID();
    await database.db.insert(runnerHosts).values({
      id: hostId,
      humanId: owner.id,
      displayName: "Race runner",
      platform: "linux-x64",
      credentialHash: tokenHash(runnerCredential),
    });
    await database.db.insert(runners).values({
      id: runnerId,
      hostId,
      workspaceId,
      projectId,
      agentId,
      displayName: "Race runner",
      repoFingerprint: tokenHash("race-checkout"),
    });
    const transferToken = randomBytes(32).toString("base64url");
    await database.db.insert(projectTransferAuthorizations).values({
      id: randomUUID(),
      projectId,
      sourceWorkspaceId: workspaceId,
      destinationWorkspaceId,
      authorizedByHumanId: owner.id,
      tokenHash: tokenHash(transferToken),
      status: "pending",
      expiresAt: sql`statement_timestamp() + interval '1 day'`,
    });

    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holder = database.db.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      markLocked();
      await releaseLock;
    });
    await locked;

    let deleteResponse: Promise<Response> | undefined;
    let claimResponse: Promise<Response> | undefined;
    let dispatchResponse: Promise<Response> | undefined;
    let transferResponse: Promise<Response> | undefined;
    try {
      deleteResponse = request(`/api/projects/${projectId}`, {
        method: "DELETE",
        cookie: owner.cookie,
      });
      await waitForLockWait('%from "projects"%for update%');
      claimResponse = request(`/api/issues/${issue.id}/work-sessions`, {
        method: "POST",
        bearer: keySecret,
        body: { runId },
      });
      await waitForLockWait('%from "projects"%for %update%', 2);
      dispatchResponse = request(`/api/issues/${issue.id}/dispatches`, {
        method: "POST",
        cookie: owner.cookie,
        body: { runnerId, agentId },
      });
      await waitForLockWait('%from "projects"%for %update%', 3);
      transferResponse = request("/api/transfers/accept", {
        method: "POST",
        cookie: owner.cookie,
        body: { token: transferToken },
      });
      await waitForLockWait('%from "project_transfer_authorizations"%for update%');

      release();
      const [deleted, claimed, dispatched, transferred] = await Promise.all([
        deleteResponse,
        claimResponse,
        dispatchResponse,
        transferResponse,
      ]);
      await holder;
      expect(deleted.status).toBe(204);
      await expectProblem(claimed, 404, "issue_not_found");
      await expectProblem(dispatched, 404, "issue_not_found");
      await expectProblem(transferred, 404, "transfer_invalid");
      expect(
        await database.db.select().from(workSessions).where(eq(workSessions.issueId, issue.id)),
      ).toHaveLength(0);
      expect(
        await database.db
          .select()
          .from(runnerDispatches)
          .where(eq(runnerDispatches.issueId, issue.id)),
      ).toHaveLength(0);
    } finally {
      release();
      await holder.catch(() => {});
      await Promise.allSettled(
        [deleteResponse, claimResponse, dispatchResponse, transferResponse].filter(
          (response): response is Promise<Response> => response !== undefined,
        ),
      );
    }
  });
});

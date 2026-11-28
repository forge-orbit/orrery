import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

const SMTP_SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none" as const,
  username: null,
  password: null,
  from: "orrery@orrery.test",
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const hasId = (items: readonly unknown[], id: string): boolean =>
  items.some((item) => field(item, "id") === id || field(item, "sessionId") === id);

async function matchingTokens(
  client: APIRequestContext,
  to: string,
  workspaceName: string,
): Promise<string[]> {
  const list = await client.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const found: string[] = [];
  for (const message of asArray(field(body, "messages"))) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await client.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    const addresses = asArray(field(caught, "To")).flatMap((entry) => {
      const address = field(entry, "Address");
      return typeof address === "string" ? [address] : [];
    });
    if (!addresses.includes(to)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) found.push(token);
  }
  return found;
}

async function liveInvitationToken(
  client: APIRequestContext,
  to: string,
  workspaceName: string,
): Promise<string> {
  let live: string | undefined;
  await expect
    .poll(
      async () => {
        for (const token of await matchingTokens(client, to, workspaceName)) {
          if (
            (await client.get(`/api/workspace-invitations/preview?token=${token}`)).status() === 200
          ) {
            live = token;
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return requiredText(live, "a live invitation token");
}

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const list = await client.get("/api/workspaces");
  expect(list.status()).toBe(200);
  const workspaces: unknown = await list.json();
  const personal = asArray(workspaces).find((w) => field(w, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function createProject(client: APIRequestContext, workspaceId: string, label: string) {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `${label} ${randomUUID()}` },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  return {
    id: idOf(body, "project"),
    key: requiredText(field(body, "key"), "the project key"),
  };
}

async function createIssue(
  client: APIRequestContext,
  projectId: string,
  title: string,
  assigneeHumanId?: string,
) {
  const created = await client.post(`/api/projects/${projectId}/issues`, { data: { title } });
  expect(created.status()).toBe(201);
  const body: unknown = await created.json();
  const issue = {
    id: idOf(body, "issue"),
    identifier: requiredText(field(body, "identifier"), "the issue identifier"),
  };
  if (assigneeHumanId !== undefined) {
    const assigned = await client.patch(`/api/issues/${issue.id}`, {
      data: { assigneeHumanId },
    });
    expect(assigned.status()).toBe(200);
  }
  return issue;
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name: `${name}-${randomUUID()}` } });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  const res = await client.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(res.status()).toBe(201);
  const secret = requiredText(field(await res.json(), "secret"), "the key secret");
  await recordSecret(secret);
  return secret;
}

async function newRun(client: APIRequestContext, secret: string): Promise<string> {
  const res = await client.post("/api/runs/hook", {
    headers: { Authorization: `Bearer ${secret}` },
    data: {
      schema: "orrery.run.hook.v1",
      event: "run_started",
      runKey: { harness: "my-work-e2e", nativeSessionId: randomUUID() },
    },
  });
  expect(res.status()).toBe(200);
  return requiredText(field(await res.json(), "runId"), "the run id");
}

let api: APIRequestContext;
let agentApi: APIRequestContext;
let memberApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect((await api.put("/api/settings/smtp", { data: SMTP_SETTINGS })).status()).toBe(200);

  agentApi = await request.newContext({ baseURL: baseUrl });
  memberApi = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await api?.dispose();
  await agentApi?.dispose();
  await memberApi?.dispose();
});

test("aggregates personal and shared work, filters terminal and trashed issues, and refuses agent keys", async () => {
  const personalWorkspaceId = await personalWorkspaceOf(api);
  const personalProject = await createProject(api, personalWorkspaceId, "My work personal");
  const shared = await api.post("/api/workspaces", {
    data: { name: `My work shared ${randomUUID()}` },
  });
  expect(shared.status()).toBe(201);
  const sharedWorkspaceId = idOf(await shared.json(), "shared workspace");
  const sharedProject = await createProject(api, sharedWorkspaceId, "My work shared");

  const projectView = await api.get(`/api/projects/${personalProject.id}`);
  expect(projectView.status()).toBe(200);
  const humanId = requiredText(
    field(field(await projectView.json(), "createdBy"), "humanId"),
    "the signed-in human id",
  );

  const personalIssue = await createIssue(api, personalProject.id, "Personal assignment", humanId);
  const sharedIssue = await createIssue(api, sharedProject.id, "Shared assignment", humanId);
  const doneIssue = await createIssue(api, personalProject.id, "Finished assignment", humanId);
  expect(
    (await api.patch(`/api/issues/${doneIssue.id}`, { data: { status: "done" } })).status(),
  ).toBe(200);
  const trashedIssue = await createIssue(api, personalProject.id, "Trashed assignment", humanId);
  expect((await api.delete(`/api/issues/${trashedIssue.id}`)).status()).toBe(204);

  const agentId = await createAgent(api, "my-work-agent");
  const personalKey = await issueKey(api, agentId, personalWorkspaceId, personalProject.id);
  const sessionIssue = await createIssue(api, personalProject.id, "Agent is working here");
  const runId = await newRun(agentApi, personalKey);
  const claim = await agentApi.post(`/api/issues/${sessionIssue.id}/work-sessions`, {
    headers: { Authorization: `Bearer ${personalKey}` },
    data: { runId },
  });
  expect(claim.status()).toBe(201);
  const sessionId = idOf(await claim.json(), "work session");

  const sharedKey = await issueKey(api, agentId, sharedWorkspaceId, sharedProject.id);
  const questionIssue = await createIssue(api, sharedProject.id, "Needs a human decision");
  const questionRunId = await newRun(agentApi, sharedKey);
  expect(
    (
      await agentApi.post(`/api/issues/${questionIssue.id}/work-sessions`, {
        headers: { Authorization: `Bearer ${sharedKey}` },
        data: { runId: questionRunId },
      })
    ).status(),
  ).toBe(201);
  const asked = await agentApi.post("/api/questions", {
    headers: { Authorization: `Bearer ${sharedKey}` },
    data: {
      issueId: questionIssue.id,
      runId: questionRunId,
      question: `Which option for ${randomUUID()}?`,
      proposedFallback: "Use the safe default",
    },
  });
  expect(asked.status()).toBe(201);
  const questionId = idOf(await asked.json(), "question");

  const response = await api.get("/api/my-work");
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const assigned = asArray(field(body, "assignedIssues"));
  expect(hasId(assigned, personalIssue.id)).toBe(true);
  expect(hasId(assigned, sharedIssue.id)).toBe(true);
  expect(hasId(assigned, doneIssue.id)).toBe(false);
  expect(hasId(assigned, trashedIssue.id)).toBe(false);
  const personalItem = assigned.find((item) => field(item, "id") === personalIssue.id);
  expect(personalItem).toMatchObject({
    identifier: personalIssue.identifier,
    projectKey: personalProject.key,
    workspaceId: personalWorkspaceId,
  });
  const sharedItem = assigned.find((item) => field(item, "id") === sharedIssue.id);
  expect(sharedItem).toMatchObject({
    identifier: sharedIssue.identifier,
    projectKey: sharedProject.key,
    workspaceId: sharedWorkspaceId,
  });

  const sessions = asArray(field(body, "activeAgentSessions"));
  expect(hasId(sessions, sessionId)).toBe(true);
  expect(sessions.find((s) => field(s, "sessionId") === sessionId)).toMatchObject({
    agentId,
    issueIdentifier: sessionIssue.identifier,
    harness: "my-work-e2e",
  });

  const questions = asArray(field(body, "needsInputQuestions"));
  expect(hasId(questions, questionId)).toBe(true);
  expect(questions.find((q) => field(q, "id") === questionId)).toMatchObject({
    issueIdentifier: questionIssue.identifier,
    workspaceId: sharedWorkspaceId,
    status: "open",
  });

  const anonymous = await request.newContext({ baseURL: baseUrl });
  try {
    const denied = await anonymous.get("/api/my-work");
    expect(denied.status()).toBe(401);
    expect(denied.headers()["content-type"]).toContain("application/problem+json");
    expect(field(await denied.json(), "code")).toBe("not_signed_in");
  } finally {
    await anonymous.dispose();
  }

  const withKey = await agentApi.get("/api/my-work", {
    headers: { Authorization: `Bearer ${personalKey}` },
  });
  expect(withKey.status()).toBe(401);
  expect(withKey.headers()["content-type"]).toContain("application/problem+json");
  expect(field(await withKey.json(), "code")).toBe("not_signed_in");
});

test("revoking a project grant or removing a member drops all shared work immediately", async () => {
  const name = `My work revoke team ${randomUUID()}`;
  const created = await api.post("/api/workspaces", { data: { name } });
  expect(created.status()).toBe(201);
  const workspaceId = idOf(await created.json(), "shared workspace");
  const sharedProject = await createProject(api, workspaceId, "Shared revoke project");

  const memberEmail = `my-work-revoke.${randomUUID()}@orrery.test`;
  const memberPassword = "my-work-member-password";
  await recordSecret(memberPassword);
  const invitation = await api.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: {
      email: memberEmail,
      projectGrants: [{ projectId: sharedProject.id, level: "contribute" }],
    },
  });
  expect(invitation.status()).toBe(201);
  const token = await liveInvitationToken(api, memberEmail, name);
  await recordSecret(token);
  const registration = await memberApi.post("/api/workspace-invitations/registration", {
    data: { token, password: memberPassword },
  });
  expect(registration.status()).toBe(200);
  const login = await memberApi.post("/api/auth/login", {
    data: { email: memberEmail, password: memberPassword },
  });
  expect(login.status()).toBe(200);

  const directory = await api.get(`/api/workspaces/${workspaceId}/members`);
  expect(directory.status()).toBe(200);
  const memberRow = asArray(await directory.json()).find(
    (row) => field(row, "email") === memberEmail,
  );
  const memberHumanId = requiredText(field(memberRow, "humanId"), "the member id");

  const personalWorkspaceId = await personalWorkspaceOf(memberApi);
  const personalProject = await createProject(memberApi, personalWorkspaceId, "Personal revoke");
  const personalIssue = await createIssue(
    memberApi,
    personalProject.id,
    "Personal assignment",
    memberHumanId,
  );
  const sharedIssue = await createIssue(api, sharedProject.id, "Shared assignment", memberHumanId);
  const sessionIssue = await createIssue(api, sharedProject.id, "Agent working here");
  const questionIssue = await createIssue(api, sharedProject.id, "A human decision");

  const agentId = await createAgent(memberApi, "my-work-member-agent");
  const secret = await issueKey(memberApi, agentId, workspaceId, sharedProject.id);
  const runId = await newRun(agentApi, secret);
  const claim = await agentApi.post(`/api/issues/${sessionIssue.id}/work-sessions`, {
    headers: { Authorization: `Bearer ${secret}` },
    data: { runId },
  });
  expect(claim.status()).toBe(201);
  const sessionId = idOf(await claim.json(), "work session");

  const questionRunId = await newRun(agentApi, secret);
  expect(
    (
      await agentApi.post(`/api/issues/${questionIssue.id}/work-sessions`, {
        headers: { Authorization: `Bearer ${secret}` },
        data: { runId: questionRunId },
      })
    ).status(),
  ).toBe(201);
  const asked = await agentApi.post("/api/questions", {
    headers: { Authorization: `Bearer ${secret}` },
    data: {
      issueId: questionIssue.id,
      runId: questionRunId,
      question: `Should we proceed with ${randomUUID()}?`,
      proposedFallback: "Use the safe default",
    },
  });
  expect(asked.status()).toBe(201);
  const questionId = idOf(await asked.json(), "question");

  const read = async () => {
    const res = await memberApi.get("/api/my-work");
    expect(res.status()).toBe(200);
    const body: unknown = await res.json();
    return {
      assigned: asArray(field(body, "assignedIssues")),
      sessions: asArray(field(body, "activeAgentSessions")),
      questions: asArray(field(body, "needsInputQuestions")),
    };
  };

  const before = await read();
  expect(hasId(before.assigned, sharedIssue.id)).toBe(true);
  expect(hasId(before.assigned, personalIssue.id)).toBe(true);
  expect(hasId(before.sessions, sessionId)).toBe(true);
  expect(hasId(before.questions, questionId)).toBe(true);

  const revoked = await api.delete(`/api/projects/${sharedProject.id}/access/${memberHumanId}`);
  expect(revoked.status()).toBe(204);
  const afterRevoke = await read();
  expect(hasId(afterRevoke.assigned, sharedIssue.id)).toBe(false);
  expect(afterRevoke.sessions).toEqual([]);
  expect(afterRevoke.questions).toEqual([]);
  expect(hasId(afterRevoke.assigned, personalIssue.id)).toBe(true);

  const restored = await api.patch(`/api/projects/${sharedProject.id}/access`, {
    data: { email: memberEmail, level: "contribute" },
  });
  expect(restored.status()).toBe(200);
  const afterRestore = await read();
  expect(hasId(afterRestore.assigned, sharedIssue.id)).toBe(true);
  expect(hasId(afterRestore.sessions, sessionId)).toBe(true);
  expect(hasId(afterRestore.questions, questionId)).toBe(true);

  const removed = await api.delete(`/api/workspaces/${workspaceId}/members/${memberHumanId}`);
  expect(removed.status()).toBe(204);
  const afterRemoval = await read();
  expect(hasId(afterRemoval.assigned, sharedIssue.id)).toBe(false);
  expect(afterRemoval.sessions).toEqual([]);
  expect(afterRemoval.questions).toEqual([]);
  expect(hasId(afterRemoval.assigned, personalIssue.id)).toBe(true);
});

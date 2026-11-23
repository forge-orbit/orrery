import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
const baseUrl: string = configuredUrl;
const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";

const SETTINGS = {
  host: "mailpit",
  port: 1025,
  security: "none",
  username: null,
  password: null,
  from: "orrery@orrery.test",
} as const;

const delegateEmail = `history.delegate.${randomUUID()}@orrery.test`;
const memberEmail = `history.member.${randomUUID()}@orrery.test`;
const outsiderEmail = `history.outsider.${randomUUID()}@orrery.test`;
const delegatePassword = "history-delegate-password";
const memberPassword = "history-member-password";
const outsiderPassword = "history-outsider-password";

let admin: APIRequestContext;
let delegate: APIRequestContext;
let member: APIRequestContext;
let outsider: APIRequestContext;
let workspaceId = "";
let privateWorkspaceId = "";
let projectId = "";
let privateProjectId = "";
let delegateHumanId = "";
let keySecret = "";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
}
function idOf(value: unknown, what: string): string {
  return requiredText(field(value, "id"), `the ${what} id`);
}
async function bodyOf(res: APIResponse): Promise<unknown> {
  return (await res.json()) as unknown;
}

async function newContext(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: baseUrl });
}

async function signIn(client: APIRequestContext, email: string, password: string) {
  const res = await client.post("/api/auth/login", { data: { email, password } });
  expect(res.status()).toBe(200);
}

async function ensureAdminVerified() {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await bodyOf(session), "emailVerified") === true) return;
  const sent = await admin.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
  await expect.poll(async () => verificationText(), { timeout: 15_000 }).toBeTruthy();
  const text = await verificationText();
  if (text === undefined) throw new Error("the catcher never received the verification email");
  const token = text.match(/\/settings\/smtp\?token=([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("the verification email carried no token");
  await recordSecret(token);
  const verified = await admin.post("/api/settings/email-verification", { data: { token } });
  expect(verified.status()).toBe(200);
}

async function verificationText(): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body = await bodyOf(list);
  const messages = field(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Verify your Orrery email") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught = await bodyOf(detail);
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    if (!recipients(caught).includes(ADMIN_EMAIL)) continue;
    return text;
  }
  return undefined;
}

function recipients(detail: unknown): string[] {
  const to = field(detail, "To");
  if (!Array.isArray(to)) return [];
  return to.flatMap((entry) => {
    const address = field(entry, "Address");
    return typeof address === "string" ? [address] : [];
  });
}

async function invitationToken(email: string, workspaceName: string): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body = await bodyOf(list);
  const messages = field(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught = await bodyOf(detail);
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    if (!recipients(caught).includes(email)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

async function registeredMember(
  email: string,
  password: string,
  workspaceName: string,
): Promise<APIRequestContext> {
  const invited = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => invitationToken(email, workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await invitationToken(email, workspaceName);
  if (token === undefined) throw new Error(`the catcher never received ${email}'s invitation`);
  await recordSecret(token);
  await recordSecret(password);
  const registration = await newContext();
  const accepted = await registration.post("/api/workspace-invitations/registration", {
    data: { token, password },
  });
  expect(accepted.status()).toBe(200);
  await registration.dispose();
  const client = await newContext();
  await signIn(client, email, password);
  return client;
}

async function installedOutsider(): Promise<APIRequestContext> {
  const invited = await admin.post("/api/invitations/installation", {
    data: { email: outsiderEmail },
  });
  expect(invited.status()).toBe(201);
  await expect.poll(async () => installationToken(outsiderEmail), { timeout: 15_000 }).toBeTruthy();
  const token = await installationToken(outsiderEmail);
  if (token === undefined)
    throw new Error("the catcher never received the installation invitation");
  await recordSecret(token);
  await recordSecret(outsiderPassword);
  const registration = await newContext();
  const accepted = await registration.post("/api/invitations/installation/registration", {
    data: { token, password: outsiderPassword },
  });
  expect(accepted.status()).toBe(200);
  await registration.dispose();
  const client = await newContext();
  await signIn(client, outsiderEmail, outsiderPassword);
  return client;
}

async function installationToken(email: string): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const body = await bodyOf(list);
  const messages = field(body, "messages");
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught = await bodyOf(detail);
    const text = field(caught, "Text");
    if (typeof text !== "string" || !recipients(caught).includes(email)) continue;
    const token = text.match(/\/register\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

async function createProject(client: APIRequestContext, targetWorkspaceId: string, name: string) {
  const res = await client.post(`/api/workspaces/${targetWorkspaceId}/projects`, {
    data: { name },
  });
  expect(res.status()).toBe(201);
  return idOf(await bodyOf(res), "project");
}

async function memberId(email: string): Promise<string> {
  const res = await admin.get(`/api/workspaces/${workspaceId}/members`);
  expect(res.status()).toBe(200);
  const members = await bodyOf(res);
  if (!Array.isArray(members)) throw new Error("the members listing is not a list");
  for (const entry of members) {
    if (field(entry, "email") !== email) continue;
    return requiredText(field(entry, "humanId"), "the member id");
  }
  throw new Error(`the workspace has no member ${email}`);
}

async function history(client: APIRequestContext, path: string, headers?: Record<string, string>) {
  return client.get(path, headers === undefined ? {} : { headers });
}

async function events(client: APIRequestContext, path: string): Promise<unknown[]> {
  const res = await history(client, path);
  expect(res.status()).toBe(200);
  const value = await bodyOf(res);
  if (!Array.isArray(value)) throw new Error("history is not a list");
  return value;
}

function typesOf(value: unknown[]): string[] {
  return value.flatMap((event) => {
    const type = field(event, "type");
    return typeof type === "string" ? [type] : [];
  });
}

test.beforeAll(async () => {
  admin = await newContext();
  await signIn(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect((await admin.put("/api/settings/smtp", { data: SETTINGS })).status()).toBe(200);
  await ensureAdminVerified();

  const workspaceName = `History Team ${randomUUID()}`;
  const created = await admin.post("/api/workspaces", { data: { name: workspaceName } });
  expect(created.status()).toBe(201);
  workspaceId = idOf(await bodyOf(created), "workspace");

  delegate = await registeredMember(delegateEmail, delegatePassword, workspaceName);
  member = await registeredMember(memberEmail, memberPassword, workspaceName);
  delegateHumanId = await memberId(delegateEmail);

  const capability = await admin.patch(
    `/api/workspaces/${workspaceId}/members/${delegateHumanId}`,
    { data: { canManageMemberPermissions: true } },
  );
  expect(capability.status()).toBe(200);

  projectId = await createProject(admin, workspaceId, "History Project");
  expect(
    (await admin.post(`/api/projects/${projectId}/issues`, { data: { title: "Why?" } })).status(),
  ).toBe(201);
  const grant = await admin.patch(`/api/projects/${projectId}/access`, {
    data: { email: memberEmail, level: "read" },
  });
  expect(grant.status()).toBe(200);
  const delegateGrant = await admin.patch(`/api/projects/${projectId}/access`, {
    data: { email: delegateEmail, level: "manage" },
  });
  expect(delegateGrant.status()).toBe(200);

  const agent = await admin.post("/api/agents", { data: { name: `history-bot-${randomUUID()}` } });
  expect(agent.status()).toBe(201);
  const agentId = idOf(await bodyOf(agent), "agent");
  const issued = await admin.post("/api/agents/keys", {
    data: {
      agentId,
      workspaceId,
      validity: "30",
      projects: [{ projectId, level: "read" }],
    },
  });
  expect(issued.status()).toBe(201);
  const issuedBody = await bodyOf(issued);
  keySecret = requiredText(field(issuedBody, "secret"), "the key secret");
  await recordSecret(keySecret);
  const keyId = idOf(field(issuedBody, "key"), "key");
  expect((await admin.delete(`/api/agents/keys/${keyId}`)).status()).toBe(204);

  outsider = await installedOutsider();
  const privateName = `Private Team ${randomUUID()}`;
  const privateCreated = await outsider.post("/api/workspaces", { data: { name: privateName } });
  expect(privateCreated.status()).toBe(201);
  privateWorkspaceId = idOf(await bodyOf(privateCreated), "private workspace");
  privateProjectId = await createProject(outsider, privateWorkspaceId, "Private Project");
});

test.afterAll(async () => {
  for (const client of [admin, delegate, member, outsider]) await client?.dispose();
});

test("a workspace owner reads every access event recorded by earlier slices", async () => {
  const workspace = await events(admin, `/api/workspaces/${workspaceId}/history`);
  expect(typesOf(workspace)).toEqual(
    expect.arrayContaining([
      "workspace_created",
      "member_joined",
      "manage_member_permissions_granted",
      "project_access_granted",
      "agent_key_created",
      "agent_key_revoked",
    ]),
  );
  const project = await events(admin, `/api/projects/${projectId}/history`);
  expect(typesOf(project)).toEqual(
    expect.arrayContaining(["project_created", "issue_created", "project_access_granted"]),
  );

  for (const list of [workspace, project, await events(admin, "/api/installation/history")]) {
    expect(JSON.stringify(list)).not.toContain(keySecret);
  }
});

test("a delegated manager stays inside their workspace and project authority", async () => {
  const workspace = await events(delegate, `/api/workspaces/${workspaceId}/history`);
  expect(workspace.some((event) => field(event, "kind") === "workspace_access")).toBe(true);
  expect(workspace.every((event) => field(event, "kind") !== "agent_key")).toBe(true);
  expect(
    workspace.every((event) => {
      const scope = field(event, "scope");
      return field(scope, "id") === workspaceId || field(scope, "id") === projectId;
    }),
  ).toBe(true);
  const denied = await history(delegate, `/api/workspaces/${privateWorkspaceId}/history`);
  expect(denied.status()).toBe(404);
  expect(await bodyOf(denied)).toMatchObject({ status: 404, code: "workspace_not_found" });
});

test("an ordinary member sees only granted-project activity and no access history", async () => {
  const denied = await history(member, `/api/workspaces/${workspaceId}/history`);
  expect(denied.status()).toBe(403);
  expect(await bodyOf(denied)).toMatchObject({ status: 403, code: "workspace_history_forbidden" });

  const project = await events(member, `/api/projects/${projectId}/history`);
  expect(project.length).toBeGreaterThan(0);
  expect(project.every((event) => field(event, "kind") === "project_activity")).toBe(true);

  for (const path of [
    `/api/projects/${privateProjectId}/history`,
    `/api/workspaces/${privateWorkspaceId}/history`,
  ]) {
    const refused = await history(member, path);
    expect(refused.status()).toBe(404);
  }
});

test("a system administrator sees installation events but no private project or workspace", async () => {
  const installation = await events(admin, "/api/installation/history");
  expect(typesOf(installation)).toEqual(
    expect.arrayContaining([
      "installation_bootstrap",
      "installation_invitation_created",
      "installation_invitation_accepted",
    ]),
  );
  expect(
    installation.every((event) => field(field(event, "scope"), "kind") === "installation"),
  ).toBe(true);
  for (const path of [
    `/api/workspaces/${privateWorkspaceId}/history`,
    `/api/projects/${privateProjectId}/history`,
  ]) {
    const refused = await history(admin, path);
    expect(refused.status()).toBe(404);
    expect(await bodyOf(refused)).toMatchObject({ status: 404 });
  }
  const ordinary = await history(member, "/api/installation/history");
  expect(ordinary.status()).toBe(403);
  expect(await bodyOf(ordinary)).toMatchObject({ status: 403, code: "not_system_administrator" });
});

test("an agent bearer key is refused on every history route", async () => {
  const anonymous = await newContext();
  try {
    for (const path of [
      `/api/workspaces/${workspaceId}/history`,
      `/api/projects/${projectId}/history`,
      "/api/installation/history",
    ]) {
      const refused = await history(anonymous, path, { Authorization: `Bearer ${keySecret}` });
      expect(refused.status(), path).toBe(401);
    }
  } finally {
    await anonymous.dispose();
  }
});

import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_PASSWORD = "shared-transfer-member-password";
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

let admin: APIRequestContext;
let member: APIRequestContext;

async function verificationText(): Promise<string | undefined> {
  const list = await admin.get(`${mailpit}/api/v1/messages`);
  const messages = asArray(field(await list.json(), "messages"));
  for (const message of messages) {
    if (field(message, "Subject") !== "Verify your Orrery email") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const text = field(caught, "Text");
    if (typeof text !== "string") continue;
    const recipients = asArray(field(caught, "To")).flatMap((entry) => {
      const address = field(entry, "Address");
      return typeof address === "string" ? [address] : [];
    });
    if (recipients.includes(ADMIN_EMAIL)) return text;
  }
  return undefined;
}

async function ensureAdminVerified() {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await session.json(), "emailVerified") === true) return;
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

async function liveInvitationToken(to: string, workspaceName: string): Promise<string> {
  let live: string | undefined;
  await expect
    .poll(
      async () => {
        const list = await admin.get(`${mailpit}/api/v1/messages`);
        const messages = asArray(field(await list.json(), "messages"));
        for (const message of messages) {
          if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
          const id = field(message, "ID");
          if (typeof id !== "string") continue;
          const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
          const caught: unknown = await detail.json();
          const text = field(caught, "Text");
          if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
          const recipients = asArray(field(caught, "To")).flatMap((entry) => {
            const address = field(entry, "Address");
            return typeof address === "string" ? [address] : [];
          });
          if (!recipients.includes(to)) continue;
          const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
          if (
            token !== undefined &&
            (await admin.get(`/api/workspace-invitations/preview?token=${token}`)).status() === 200
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

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect((await admin.put("/api/settings/smtp", { data: SMTP_SETTINGS })).status()).toBe(200);
  await ensureAdminVerified();
  member = await request.newContext({ baseURL: baseUrl });
});

test.afterAll(async () => {
  await admin?.dispose();
  await member?.dispose();
});

test("moves a shared project between workspaces without carrying source keys or access history", async () => {
  const suffix = randomUUID().slice(0, 8);
  const w1Name = `Shared W1 ${suffix}`;
  const w2Name = `Shared W2 ${suffix}`;

  const sourceRes = await admin.post("/api/workspaces", { data: { name: w1Name } });
  expect(sourceRes.status()).toBe(201);
  const sourceId = idOf(await sourceRes.json(), "source workspace");
  const destRes = await admin.post("/api/workspaces", { data: { name: w2Name } });
  expect(destRes.status()).toBe(201);
  const destId = idOf(await destRes.json(), "destination workspace");

  const projectRes = await admin.post(`/api/workspaces/${sourceId}/projects`, {
    data: { name: `Shared transfer project ${suffix}` },
  });
  expect(projectRes.status()).toBe(201);
  const projectId = idOf(await projectRes.json(), "project");
  const issueRes = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: `Preserved issue ${suffix}` },
  });
  expect(issueRes.status()).toBe(201);
  const issueId = idOf(await issueRes.json(), "issue");

  const agentRes = await admin.post("/api/agents", {
    data: { name: `shared-transfer-agent-${suffix}` },
  });
  expect(agentRes.status()).toBe(201);
  const keyRes = await admin.post("/api/agents/keys", {
    data: {
      agentId: idOf(await agentRes.json(), "agent"),
      workspaceId: sourceId,
      validity: "90",
      projects: [{ projectId, level: "contribute" }],
    },
  });
  expect(keyRes.status()).toBe(201);
  const secret = requiredText(field(await keyRes.json(), "secret"), "the key secret");
  await recordSecret(secret);

  const memberEmail = `shared-transfer.member.${suffix}@orrery.test`;
  const invite = await admin.post(`/api/workspaces/${sourceId}/invitations`, {
    data: { email: memberEmail, projectGrants: [{ projectId, level: "read" }] },
  });
  expect(invite.status()).toBe(201);
  const token = await liveInvitationToken(memberEmail, w1Name);
  await recordSecret(token);
  const registration = await member.post("/api/workspace-invitations/registration", {
    data: { token, password: MEMBER_PASSWORD },
  });
  expect(registration.status()).toBe(200);
  const signIn = await member.post("/api/auth/login", {
    data: { email: memberEmail, password: MEMBER_PASSWORD },
  });
  expect(signIn.status()).toBe(200);

  const beforeHistory = await admin.get(`/api/projects/${projectId}/history`);
  expect(beforeHistory.status()).toBe(200);
  const beforeEvents = asArray(await beforeHistory.json());
  const sourceAccessIds = beforeEvents
    .filter(
      (event) =>
        field(event, "kind") === "project_access" &&
        field(field(event, "subject"), "email") === memberEmail,
    )
    .map((event) => requiredText(field(event, "id"), "the source access event id"));
  expect(sourceAccessIds.length).toBeGreaterThan(0);

  const previewRes = await admin.post(`/api/projects/${projectId}/transfer/preview`, {
    data: { destinationWorkspaceId: destId },
  });
  expect(previewRes.status()).toBe(200);
  expect(await previewRes.json()).toMatchObject({
    projectId,
    visibilityChange: "shared_to_shared",
    source: { workspaceId: sourceId, kind: "shared" },
    destination: { workspaceId: destId, kind: "shared" },
  });
  const completeRes = await admin.post(`/api/projects/${projectId}/transfer/complete`, {
    data: { destinationWorkspaceId: destId },
  });
  expect(completeRes.status()).toBe(200);
  expect(await completeRes.json()).toMatchObject({
    id: projectId,
    workspaceId: destId,
    accessLevel: "manage",
  });

  const keyOnly = await fetch(new URL(`/api/projects/${projectId}`, baseUrl), {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(keyOnly.status).toBeGreaterThanOrEqual(400);

  const after = await admin.get(`/api/projects/${projectId}`);
  expect(after.status()).toBe(200);
  expect(await after.json()).toMatchObject({ id: projectId, accessLevel: "manage" });
  const issues = await admin.get(`/api/projects/${projectId}/issues`);
  expect(asArray(await issues.json()).map((issue) => field(issue, "id"))).toContain(issueId);
  const activity = await admin.get(`/api/projects/${projectId}/activity`);
  expect(asArray(await activity.json()).map((event) => field(event, "type"))).toContain(
    "issue_created",
  );

  const afterHistory = await admin.get(`/api/projects/${projectId}/history`);
  expect(afterHistory.status()).toBe(200);
  const afterEvents = asArray(await afterHistory.json());
  expect(afterEvents.map((event) => field(event, "id"))).not.toEqual(
    expect.arrayContaining(sourceAccessIds),
  );
  expect(afterEvents.map((event) => field(event, "type"))).toContain("project_access_granted");
  expect(afterEvents.some((event) => field(field(event, "subject"), "email") === memberEmail)).toBe(
    false,
  );

  const w1History = await admin.get(`/api/workspaces/${sourceId}/history`);
  expect(asArray(await w1History.json()).map((event) => field(event, "id"))).toEqual(
    expect.arrayContaining(sourceAccessIds),
  );
  const w2History = await admin.get(`/api/workspaces/${destId}/history`);
  const w2Events = asArray(await w2History.json());
  expect(w2Events.map((event) => field(event, "id"))).not.toEqual(
    expect.arrayContaining(sourceAccessIds),
  );
  expect(w2Events.map((event) => field(event, "type"))).toContain("project_transfer_received");

  const memberView = await member.get(`/api/projects/${projectId}`);
  expect(memberView.status()).toBeGreaterThanOrEqual(400);
});

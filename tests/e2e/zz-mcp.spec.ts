import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) throw new Error("Set ORRERY_URL to a running Orrery");

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_EMAIL = "workspace.existing@orrery.test";
const MEMBER_PASSWORD = "existing-workspace-password";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const requiredText = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const idOf = (value: unknown, what: string): string =>
  requiredText(field(value, "id"), `the ${what} id`);
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const bearerRequest = (secret: string) => ({
  get: (path: string) =>
    fetch(new URL(path, baseUrl), { headers: { Authorization: `Bearer ${secret}` } }),
  post: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  patch: (path: string, body: unknown) =>
    fetch(new URL(path, baseUrl), {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  delete: (path: string) =>
    fetch(new URL(path, baseUrl), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${secret}` },
    }),
});

async function personalWorkspaceOf(client: APIRequestContext): Promise<string> {
  const res = await client.get("/api/workspaces");
  expect(res.status()).toBe(200);
  const list: unknown = await res.json();
  if (!Array.isArray(list)) throw new Error("the workspaces listing is not a list");
  const personal = list.find((workspace) => field(workspace, "kind") === "personal");
  return idOf(personal, "personal workspace");
}

async function createAgent(client: APIRequestContext, name: string): Promise<string> {
  const res = await client.post("/api/agents", { data: { name } });
  expect(res.status()).toBe(201);
  return idOf(await res.json(), "agent");
}

async function issueKey(
  client: APIRequestContext,
  agentId: string,
  workspaceId: string,
  grants: { projectId: string; level: string }[],
): Promise<{ id: string; secret: string }> {
  const res = await client.post("/api/agents/keys", {
    data: { agentId, workspaceId, validity: "90", projects: grants },
  });
  expect(res.status()).toBe(201);
  const body: unknown = await res.json();
  const secret = requiredText(field(body, "secret"), "the key secret");
  await recordSecret(secret);
  return { id: idOf(field(body, "key"), "key"), secret };
}

type CallResult = { isError: boolean; data: Record<string, unknown> };

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "orrery-e2e-mcp", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      authProvider: { token: async () => secret },
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, data: asRecord(result.structuredContent) };
}

async function claimIssue(client: Client, issueId: string): Promise<void> {
  const checkin = await call(client, "orrery_run_checkin", {
    event: "run_started",
    runKey: { harness: "codex", nativeSessionId: randomUUID() },
  });
  expect(checkin.isError).toBe(false);
  const runId = requiredText(field(checkin.data, "runId"), "the run id");
  const claim = await call(client, "claim_issue", { issueId, runId });
  expect(claim.isError).toBe(false);
}

async function caughtWorkspaceToken(workspaceName: string): Promise<string | undefined> {
  const list = await api.get(`${mailpit}/api/v1/messages`);
  const body: unknown = await list.json();
  const messages: unknown =
    typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (field(message, "Subject") !== "Your Orrery workspace invitation") continue;
    const id = field(message, "ID");
    if (typeof id !== "string") continue;
    const detail = await api.get(`${mailpit}/api/v1/message/${id}`);
    const caught: unknown = await detail.json();
    const toAddresses = field(caught, "To");
    const addresses = Array.isArray(toAddresses)
      ? toAddresses.flatMap((entry) => {
          const address = field(entry, "Address");
          return typeof address === "string" ? [address] : [];
        })
      : [];
    if (!addresses.includes(MEMBER_EMAIL)) continue;
    const text = field(caught, "Text");
    if (typeof text !== "string" || !text.includes(`"${workspaceName}"`)) continue;
    const token = text.match(/\/workspace-invitation\?token=([A-Za-z0-9_-]+)/)?.[1];
    if (token !== undefined) return token;
  }
  return undefined;
}

let api: APIRequestContext;
let memberApi: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  memberApi = await request.newContext({ baseURL: baseUrl });
  const memberLogin = await memberApi.post("/api/auth/login", {
    data: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
  });
  expect(memberLogin.status()).toBe(200);
});
test.afterAll(async () => {
  await api?.dispose();
  await memberApi?.dispose();
});

test("offers project work only: no membership, access, or administration tools", async () => {
  const agentId = await createAgent(api, `mcp-tools-bot-${randomUUID()}`);
  const key = await issueKey(api, agentId, await personalWorkspaceOf(api), []);
  const client = await connect(key.secret);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_projects",
        "get_project",
        "list_issues",
        "get_issue",
        "create_issue",
        "update_issue",
        "list_comments",
        "create_comment",
        "add_issue_link",
        "remove_issue_link",
        "list_activity",
        "list_knowledge",
        "get_knowledge",
        "create_knowledge",
        "update_knowledge",
      ]),
    );
    for (const name of names) {
      expect(name).not.toMatch(/member|invit|workspace|access|setting|key|admin|grant/);
    }
  } finally {
    await client.close();
  }
});

test("a Contribute key runs the full issue and knowledge cycle over MCP and REST", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP project ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentName = `mcp-writer-${randomUUID()}`;
  const agentId = await createAgent(api, agentName);
  const key = await issueKey(api, agentId, workspaceId, [{ projectId, level: "contribute" }]);
  const client = await connect(key.secret);
  const rest = bearerRequest(key.secret);
  try {
    const createdIssue = await call(client, "create_issue", {
      projectId,
      title: "An MCP issue",
      body: "Created by an agent key.",
    });
    expect(createdIssue.isError).toBe(false);
    const issue = asRecord(createdIssue.data.issue);
    expect(field(issue, "createdBy")).toMatchObject({ agentId, displayName: agentName });
    const issueId = requiredText(field(issue, "id"), "the issue id");

    const unfenced = await call(client, "update_issue", { issueId, title: "No session" });
    expect(unfenced.isError).toBe(true);
    expect(unfenced.data).toMatchObject({ code: "session_required" });
    await claimIssue(client, issueId);

    const edited = await call(client, "update_issue", {
      issueId,
      title: "Edited over MCP",
      body: "A new body.",
    });
    expect(edited.isError).toBe(false);
    expect(field(edited.data.issue, "title")).toBe("Edited over MCP");
    expect(field(edited.data.issue, "updatedBy")).toMatchObject({ agentId });

    const commented = await call(client, "create_comment", { issueId, body: "Agent comment" });
    expect(commented.isError).toBe(false);
    expect(field(field(commented.data.comment, "author"), "agentId")).toBe(agentId);

    const closed = await call(client, "update_issue", { issueId, status: "done" });
    expect(field(closed.data.issue, "status")).toBe("done");
    expect(field(closed.data.issue, "updatedBy")).toMatchObject({ agentId });
    const afterClose = await call(client, "update_issue", { issueId, status: "todo" });
    expect(afterClose.isError).toBe(true);
    expect(afterClose.data).toMatchObject({ code: "session_required" });

    const reopenedRes = await api.patch(`/api/issues/${issueId}`, { data: { status: "todo" } });
    expect(reopenedRes.status()).toBe(200);
    const reopenedIssue = asRecord(await reopenedRes.json());
    expect(field(reopenedIssue, "status")).toBe("todo");
    expect(field(reopenedIssue, "closedAt")).toBeNull();

    const entry = await call(client, "create_knowledge", { projectId, title: "Agent note" });
    const entryId = requiredText(field(entry.data.entry, "id"), "the knowledge id");
    const editedEntry = await call(client, "update_knowledge", { entryId, body: "More detail" });
    expect(editedEntry.isError).toBe(false);
    expect(field(field(editedEntry.data.entry, "updatedBy"), "agentId")).toBe(agentId);

    const activity = await call(client, "list_activity", { projectId });
    const types = asArray(field(activity.data, "activity")).map((event) => field(event, "type"));
    expect(types).toEqual(
      expect.arrayContaining([
        "issue_created",
        "issue_edited",
        "issue_closed",
        "issue_reopened",
        "issue_commented",
        "knowledge_created",
        "knowledge_edited",
      ]),
    );

    const restIssues = await rest.get(`/api/projects/${projectId}/issues`);
    expect(restIssues.status).toBe(200);
    const listed = asArray(await restIssues.json());
    expect(listed.some((item) => field(item, "id") === issueId)).toBe(true);

    const restCreated = await rest.post(`/api/projects/${projectId}/issues`, {
      title: "A REST issue",
      body: "Created by the same key.",
    });
    expect(restCreated.status).toBe(201);
    const restIssue = asRecord(await restCreated.json());
    const restIssueId = idOf(restIssue, "issue");
    expect(field(restIssue, "createdBy")).toMatchObject({ agentId });
    await claimIssue(client, restIssueId);

    const restEdited = await rest.patch(`/api/issues/${restIssueId}`, {
      title: "Edited over REST",
      body: "REST body.",
    });
    expect(restEdited.status).toBe(200);
    expect(field(await restEdited.json(), "title")).toBe("Edited over REST");
    const restClosed = await rest.patch(`/api/issues/${restIssueId}`, { status: "done" });
    expect(restClosed.status).toBe(200);
    const restReopened = await rest.patch(`/api/issues/${restIssueId}`, { status: "todo" });
    expect(restReopened.status).toBe(200);
    expect(field(await restReopened.json(), "closedAt")).toBeNull();
    const restComment = await rest.post(`/api/issues/${restIssueId}/comments`, {
      body: "REST comment",
    });
    expect(restComment.status).toBe(201);
    expect(field(field(await restComment.json(), "author"), "agentId")).toBe(agentId);

    const restEntry = await rest.post(`/api/projects/${projectId}/knowledge`, {
      title: "REST note",
    });
    expect(restEntry.status).toBe(201);
    const restEntryId = idOf(asRecord(await restEntry.json()), "knowledge");
    const restEntryEdit = await rest.patch(`/api/knowledge/${restEntryId}`, {
      body: "REST detail",
    });
    expect(restEntryEdit.status).toBe(200);
    expect(field(field(await restEntryEdit.json(), "updatedBy"), "agentId")).toBe(agentId);

    const afterRest = await call(client, "get_issue", { issueId: restIssueId });
    expect(field(afterRest.data.issue, "title")).toBe("Edited over REST");
  } finally {
    await client.close();
  }
});

test("an agent attaches a PR link over MCP and REST issue detail shows it", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP links ${randomUUID()}` },
  });
  expect(created.status()).toBe(201);
  const projectId = idOf(await created.json(), "project");
  const agentId = await createAgent(api, `mcp-links-${randomUUID()}`);
  const key = await issueKey(api, agentId, workspaceId, [{ projectId, level: "contribute" }]);
  const client = await connect(key.secret);
  const rest = bearerRequest(key.secret);
  try {
    const createdIssue = await call(client, "create_issue", {
      projectId,
      title: "Issue with a PR",
    });
    expect(createdIssue.isError).toBe(false);
    const issueId = requiredText(field(createdIssue.data.issue, "id"), "the issue id");

    const prUrl = "https://github.com/forge-orbit/orrery/pull/87";
    const added = await call(client, "add_issue_link", {
      issueId,
      url: prUrl,
      title: "Structured links PR",
      kind: "pr",
    });
    expect(added.isError).toBe(false);
    const link = asRecord(added.data.link);
    const linkId = requiredText(field(link, "id"), "the link id");
    expect(field(link, "kind")).toBe("pr");
    expect(field(field(link, "createdBy"), "agentId")).toBe(agentId);

    const duplicate = await call(client, "add_issue_link", {
      issueId,
      url: prUrl,
      title: "Again",
      kind: "pr",
    });
    expect(duplicate.isError).toBe(true);
    expect(field(duplicate.data, "code")).toBe("issue_link_exists");

    const unsafe = await call(client, "add_issue_link", {
      issueId,
      url: "javascript:alert(1)",
      title: "Unsafe",
      kind: "link",
    });
    expect(unsafe.isError).toBe(true);

    const mcpDetail = await call(client, "get_issue", { issueId });
    const mcpLinks = asArray(field(mcpDetail.data.issue, "links"));
    expect(mcpLinks).toHaveLength(1);
    expect(field(mcpLinks[0], "url")).toBe(prUrl);

    const restDetail = await rest.get(`/api/issues/${issueId}`);
    expect(restDetail.status).toBe(200);
    const restLinks = asArray(field(asRecord(await restDetail.json()), "links"));
    expect(restLinks).toHaveLength(1);
    expect(field(restLinks[0], "kind")).toBe("pr");
    expect(field(field(restLinks[0], "createdBy"), "agentId")).toBe(agentId);

    const activity = await call(client, "list_activity", { projectId });
    const types = asArray(field(activity.data, "activity")).map((event) => field(event, "type"));
    expect(types).toEqual(expect.arrayContaining(["issue_link_added"]));

    const removed = await call(client, "remove_issue_link", { issueId, linkId });
    expect(removed.isError).toBe(false);
    expect(field(removed.data, "removed")).toBe(true);
    const after = await rest.get(`/api/issues/${issueId}`);
    expect(asArray(field(asRecord(await after.json()), "links"))).toHaveLength(0);

    const activityAfter = await call(client, "list_activity", { projectId });
    const typesAfter = asArray(field(activityAfter.data, "activity")).map((event) =>
      field(event, "type"),
    );
    expect(typesAfter).toEqual(expect.arrayContaining(["issue_link_removed"]));
  } finally {
    await client.close();
  }
});

test("a Read key inspects over MCP and REST but cannot change work on either", async () => {
  const workspaceName = `MCP read team ${randomUUID()}`;
  const workspaceRes = await api.post("/api/workspaces", { data: { name: workspaceName } });
  const workspaceId = idOf(await workspaceRes.json(), "workspace");
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP read project ${randomUUID()}` },
  });
  const projectId = idOf(await created.json(), "project");
  const writer = await createAgent(api, `mcp-seed-${randomUUID()}`);
  const writerKey = await issueKey(api, writer, workspaceId, [{ projectId, level: "contribute" }]);
  const writerClient = await connect(writerKey.secret);
  let issueId = "";
  let entryId = "";
  try {
    const seeded = await call(writerClient, "create_issue", { projectId, title: "Seed issue" });
    issueId = requiredText(field(seeded.data.issue, "id"), "the issue id");
    const seededEntry = await call(writerClient, "create_knowledge", {
      projectId,
      title: "Seed note",
    });
    entryId = requiredText(field(seededEntry.data.entry, "id"), "the knowledge id");
  } finally {
    await writerClient.close();
  }

  const reader = await createAgent(api, `mcp-reader-${randomUUID()}`);
  const readerKey = await issueKey(api, reader, workspaceId, [{ projectId, level: "read" }]);
  const client = await connect(readerKey.secret);
  const rest = bearerRequest(readerKey.secret);
  try {
    expect((await call(client, "list_projects", { workspaceId })).isError).toBe(false);
    expect((await call(client, "list_issues", { projectId })).isError).toBe(false);
    expect((await call(client, "get_issue", { issueId })).isError).toBe(false);
    expect((await call(client, "list_comments", { issueId })).isError).toBe(false);
    expect((await call(client, "list_knowledge", { projectId })).isError).toBe(false);
    expect((await call(client, "list_activity", { projectId })).isError).toBe(false);

    expect((await rest.get(`/api/projects/${projectId}/issues`)).status).toBe(200);
    expect((await rest.get(`/api/issues/${issueId}`)).status).toBe(200);
    expect((await rest.get(`/api/projects/${projectId}/knowledge`)).status).toBe(200);

    const mcpDenials = await Promise.all([
      call(client, "create_issue", { projectId, title: "No" }),
      call(client, "update_issue", { issueId, status: "done" }),
      call(client, "create_comment", { issueId, body: "No" }),
      call(client, "add_issue_link", {
        issueId,
        url: "https://example.com/no",
        title: "No",
        kind: "link",
      }),
      call(client, "remove_issue_link", { issueId, linkId: "no" }),
      call(client, "create_knowledge", { projectId, title: "No" }),
      call(client, "update_knowledge", { entryId, body: "No" }),
    ]);
    for (const denial of mcpDenials) {
      expect(denial.isError).toBe(true);
      expect(field(denial.data, "code")).toBe("insufficient_project_access");
    }
    const restDenials = await Promise.all([
      rest.post(`/api/projects/${projectId}/issues`, { title: "No" }),
      rest.patch(`/api/issues/${issueId}`, { status: "done" }),
      rest.post(`/api/issues/${issueId}/comments`, { body: "No" }),
      rest.post(`/api/issues/${issueId}/links`, {
        url: "https://example.com/no",
        title: "No",
        kind: "link",
      }),
      rest.delete(`/api/issues/${issueId}/links/no`),
      rest.post(`/api/projects/${projectId}/knowledge`, { title: "No" }),
      rest.patch(`/api/knowledge/${entryId}`, { body: "No" }),
    ]);
    for (const denial of restDenials) {
      expect(denial.status).toBe(403);
      expect(await denial.json()).toMatchObject({
        status: 403,
        code: "insufficient_project_access",
      });
    }
  } finally {
    await client.close();
  }

  const invited = await api.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: MEMBER_EMAIL, projectGrants: [{ projectId, level: "read" }] },
  });
  expect(invited.status()).toBe(201);
  await expect
    .poll(async () => caughtWorkspaceToken(workspaceName), { timeout: 15_000 })
    .toBeTruthy();
  const token = await caughtWorkspaceToken(workspaceName);
  if (token === undefined) throw new Error("the catcher never received the invitation");
  await recordSecret(token);
  const accepted = await memberApi.post("/api/workspace-invitations/acceptance", {
    data: { token },
  });
  expect(accepted.status()).toBe(200);
  const humanDenied = await memberApi.patch(`/api/issues/${issueId}`, {
    data: { status: "done" },
  });
  expect(humanDenied.status()).toBe(403);
  expect(await humanDenied.json()).toMatchObject({ code: "insufficient_project_access" });
});

test("keys scoped to one workspace and project are denied on the other over MCP and REST", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const scoped = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP scoped ${randomUUID()}` },
  });
  const scopedId = idOf(await scoped.json(), "project");
  const outside = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP outside ${randomUUID()}` },
  });
  const outsideId = idOf(await outside.json(), "project");

  const other = await api.post("/api/workspaces", { data: { name: `MCP other ${randomUUID()}` } });
  const otherId = idOf(await other.json(), "workspace");

  const agentId = await createAgent(api, `mcp-scoped-${randomUUID()}`);
  const key = await issueKey(api, agentId, workspaceId, [
    { projectId: scopedId, level: "contribute" },
  ]);
  const client = await connect(key.secret);
  const rest = bearerRequest(key.secret);
  try {
    const mcpCross = await call(client, "list_projects", { workspaceId: otherId });
    expect(mcpCross.isError).toBe(true);
    expect(field(mcpCross.data, "code")).toBe("workspace_not_found");
    const restCross = await rest.get(`/api/workspaces/${otherId}/projects`);
    expect(restCross.status).toBe(404);
    expect(await restCross.json()).toMatchObject({ code: "workspace_not_found" });

    const mcpOutside = await call(client, "create_issue", { projectId: outsideId, title: "No" });
    expect(mcpOutside.isError).toBe(true);
    expect(field(mcpOutside.data, "code")).toBe("project_not_found");
    const restOutside = await rest.post(`/api/projects/${outsideId}/issues`, { title: "No" });
    expect(restOutside.status).toBe(404);
    expect(await restOutside.json()).toMatchObject({ code: "project_not_found" });
  } finally {
    await client.close();
  }
});

test("a revoked key is refused on the next MCP call and the next REST call", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP revoke ${randomUUID()}` },
  });
  const projectId = idOf(await created.json(), "project");
  const agentId = await createAgent(api, `mcp-revoked-${randomUUID()}`);
  const key = await issueKey(api, agentId, workspaceId, [{ projectId, level: "read" }]);

  const revoked = await api.delete(`/api/agents/keys/${key.id}`);
  expect(revoked.status()).toBe(204);
  const client = await connect(key.secret);
  try {
    const denied = await call(client, "list_projects", { workspaceId });
    expect(denied.isError).toBe(true);
    expect(field(denied.data, "code")).toBe("key_revoked");
  } finally {
    await client.close();
  }
  const rest = await bearerRequest(key.secret).get(`/api/projects/${projectId}/issues`);
  expect(rest.status).toBe(401);
  expect(await rest.json()).toMatchObject({ code: "key_revoked" });
});

test("agent keys cannot reach membership, project access, or installation settings over REST", async () => {
  const workspaceId = await personalWorkspaceOf(api);
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `MCP admin ${randomUUID()}` },
  });
  const projectId = idOf(await created.json(), "project");
  const agentId = await createAgent(api, `mcp-admin-${randomUUID()}`);
  const key = await issueKey(api, agentId, workspaceId, [{ projectId, level: "manage" }]);
  const rest = bearerRequest(key.secret);
  for (const path of [
    `/api/projects/${projectId}/access`,
    `/api/workspaces/${workspaceId}/members`,
    "/api/settings/smtp",
  ]) {
    const res = await rest.get(path);
    expect(res.status).toBe(401);
  }
  const write = await rest.post(`/api/workspaces/${workspaceId}/projects`, { name: "No" });
  expect(write.status).toBe(401);
  const configure = await rest.patch(`/api/projects/${projectId}`, { name: "No" });
  expect(configure.status).toBe(401);
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  Issue,
  ProjectActivityResponse,
  ProjectLabel,
  type CreateIssueRequest,
} from "@orrery/contract";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  humans,
  issueLabels,
  issues,
  projects,
  workspaces,
} from "../../db/schema.ts";
import { createDb, type Database } from "../../platform/db.ts";
import { rootCause } from "../../platform/errors.ts";
import { createApp } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { migrate } from "../../platform/migrate.ts";
import { createAccountsFeature } from "../accounts/index.ts";
import { createProjectsFeature, ProjectsError, type WorkActor } from "./index.ts";
import { createProjectsMcp } from "./mcp.ts";

const SECRET = "correct horse battery staple staple";
const EMAIL = "admin@example.com";
const PASSWORD = "first-admin-password";
const PUBLIC_URL = "http://orrery.test";
const silentLogger = createLogger("error");

let pg: StartedPostgreSqlContainer;
let database: Database;
let app: Hono;
let cookie: string;
let workspaceId: string;
let service: ReturnType<typeof createProjectsFeature>["service"];
let actor: WorkActor;

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: unknown) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const del = (path: string) => app.request(path, { method: "DELETE", headers: { cookie } });
const get = (path: string) => app.request(path, { headers: { cookie } });

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};

async function problemOf(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/problem+json");
  expect(await res.json()).toMatchObject({ status, code });
}

type ToolRegistrar = Parameters<ReturnType<typeof createProjectsMcp>>[0];

function isToolRegistrar(value: unknown): value is ToolRegistrar {
  return typeof value === "object" && value !== null && "registerTool" in value;
}

async function adminHumanId(): Promise<string> {
  const [row] = await database.db
    .select({ id: humans.id })
    .from(humans)
    .where(eq(humans.email, EMAIL));
  if (row === undefined) throw new Error("the administrator was not found");
  return row.id;
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  if (error instanceof ProjectsError) return error.kind;
  throw error;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected the write to be rejected");
    },
    (cause: unknown) => cause,
  );
  return rootCause(error)?.message ?? String(error);
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18").start();
  database = createDb(pg.getConnectionUri());
  const migrationsDir = new URL("../../../../../db/migrations", import.meta.url).pathname;
  await migrate(database.sql, migrationsDir);

  const accounts = createAccountsFeature({
    db: database.db,
    setupSecret: SECRET,
    publicUrl: PUBLIC_URL,
  });
  const projectsFeature = createProjectsFeature({
    db: database.db,
    sessionReader: accounts.sessionReader,
    agentAuthenticator: async () => null,
    sessionGate: async () => true,
  });
  service = projectsFeature.service;
  app = createApp({
    features: [accounts, projectsFeature],
    publicUrl: PUBLIC_URL,
    log: silentLogger,
  });

  const boot = await app.request("/api/setup/admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, email: EMAIL, password: PASSWORD }),
  });
  if (boot.status !== 201) throw new Error("the administrator was not bootstrapped");
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const raw = login.headers
    .getSetCookie()
    .find((entry) => entry.startsWith("orrery_session="))
    ?.split(";")[0];
  if (raw === undefined) throw new Error("the session cookie was not set");
  cookie = raw;
  const [admin] = await database.db
    .select({
      humanId: humans.id,
      email: humans.email,
      isSystemAdministrator: humans.isSystemAdministrator,
      emailVerifiedAt: humans.emailVerifiedAt,
    })
    .from(humans)
    .where(eq(humans.email, EMAIL));
  const [personal] = await database.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.personalOwnerHumanId, admin!.humanId));
  workspaceId = personal!.id;
  actor = { kind: "human", account: admin! };
}, 120_000);

afterAll(async () => {
  await database?.sql.end();
  await pg?.stop();
});

afterEach(async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`delete from project_activity`);
    await tx.execute(sql`delete from issue_labels`);
    await tx.execute(sql`delete from project_labels`);
    await tx.execute(sql`delete from issues`);
    await tx.execute(sql`delete from projects`);
    await tx.execute(sql`delete from agent_api_keys`);
    await tx.execute(sql`delete from agents`);
  });
});

async function project(name = "Labels", key = "LBL"): Promise<string> {
  const res = await post(`/api/workspaces/${workspaceId}/projects`, { name, key });
  expect(res.status).toBe(201);
  return text(field(await res.json(), "id"), "the project id");
}

async function issue(projectId: string, input: CreateIssueRequest = { title: "An issue" }) {
  const res = await post(`/api/projects/${projectId}/issues`, input);
  expect(res.status).toBe(201);
  return Issue.parse(await res.json());
}

describe("project-scoped labels (#97)", () => {
  it("creates, lists, renames and deletes labels, with case-insensitive uniqueness per project", async () => {
    const pid = await project();
    const created = await post(`/api/projects/${pid}/labels`, { name: "Bug", color: "#ff0000" });
    expect(created.status).toBe(201);
    const label = ProjectLabel.parse(await created.json());
    expect(label).toMatchObject({ projectId: pid, name: "Bug", color: "#ff0000" });

    const duplicate = await post(`/api/projects/${pid}/labels`, { name: "bug", color: "#00ff00" });
    await problemOf(duplicate, 409, "label_exists");
    expect(await kindOf(service.createLabel(actor, pid, { name: "BUG", color: "#00ff00" }))).toBe(
      "label_exists",
    );

    const other = await project("Other", "OTH2");
    const otherLabel = await post(`/api/projects/${other}/labels`, {
      name: "bug",
      color: "#00ff00",
    });
    expect(otherLabel.status).toBe(201);

    const listed = await get(`/api/projects/${pid}/labels`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject([{ id: label.id, name: "Bug" }]);

    const renamed = await patch(`/api/labels/${label.id}`, { name: "Defect", color: "#0000ff" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Defect", color: "#0000ff" });

    const removed = await del(`/api/labels/${label.id}`);
    expect(removed.status).toBe(204);

    await problemOf(await del(`/api/labels/${label.id}`), 404, "label_not_found");
    const afterDelete = await get(`/api/projects/${pid}/labels`);
    expect(await afterDelete.json()).toEqual([]);
    const missing = await patch(`/api/labels/${randomUUID()}`, { name: "Nope" });
    await problemOf(missing, 404, "label_not_found");

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "project_label_created",
        "project_label_edited",
        "project_label_deleted",
      ]),
    );
  });

  it("attaches and detaches labels on issues, and labels appear on issue payloads", async () => {
    const pid = await project();
    const issueA = await issue(pid);
    const issueB = await issue(pid, { title: "Second" });
    const other = await project("Other", "OTH2");
    const foreign = text(
      field(
        await (
          await post(`/api/projects/${other}/labels`, { name: "Foreign", color: "#abcdef" })
        ).json(),
        "id",
      ),
      "the foreign label id",
    );
    const label = text(
      field(
        await (await post(`/api/projects/${pid}/labels`, { name: "Bug", color: "#ff0000" })).json(),
        "id",
      ),
      "the label id",
    );

    const attached = await post(`/api/issues/${issueA.id}/labels/${label}`, {});
    expect(attached.status).toBe(201);
    expect(await attached.json()).toMatchObject({
      id: issueA.id,
      labels: [{ id: label, name: "Bug", color: "#ff0000" }],
    });

    const again = await post(`/api/issues/${issueA.id}/labels/${label}`, {});
    expect(again.status).toBe(201);
    const rows = await database.db
      .select()
      .from(issueLabels)
      .where(eq(issueLabels.issueId, issueA.id));
    expect(rows).toHaveLength(1);

    const fetched = await get(`/api/issues/${issueA.id}`);
    expect(field(await fetched.json(), "labels")).toMatchObject([{ id: label }]);
    const listed = await get(`/api/projects/${pid}/issues`);
    const listedBody = await listed.json();
    expect(field(Array.isArray(listedBody) ? listedBody[0] : undefined, "labels")).toMatchObject([
      { id: label },
    ]);

    const overridden = await patch(`/api/issues/${issueA.id}/fallback-policy`, {
      override: "require_human",
    });
    expect(overridden.status).toBe(200);
    expect(field(await overridden.json(), "labels")).toMatchObject([{ id: label }]);

    await problemOf(
      await post(`/api/issues/${issueB.id}/labels/${foreign}`, {}),
      404,
      "label_not_found",
    );

    await expect(
      rejectionMessage(
        database.db.execute(
          sql`insert into issue_labels (issue_id, label_id) values (${issueB.id}, ${foreign})`,
        ),
      ),
    ).resolves.toMatch(/same project/i);

    const detached = await del(`/api/issues/${issueA.id}/labels/${label}`);
    expect(detached.status).toBe(200);
    expect(field(await detached.json(), "labels")).toEqual([]);

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.filter((event) => event.type === "issue_label_added")).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("issue_label_removed");
  });
});

describe("one-level subtasks (#97)", () => {
  it("sets and clears a parent on create and update, enforcing all three service invariants", async () => {
    const pid = await project();
    const other = await project("Other", "OTH2");
    const parent = await issue(pid, { title: "Parent" });
    const child = await issue(pid, { title: "Child", parentIssueId: parent.id });
    expect(child.parentIssueId).toBe(parent.id);
    expect(parent.parentIssueId).toBeNull();

    expect(await kindOf(service.updateIssue(actor, child.id, { parentIssueId: child.id }))).toBe(
      "self_parent",
    );
    await problemOf(
      await patch(`/api/issues/${child.id}`, { parentIssueId: child.id }),
      400,
      "self_parent",
    );

    const foreign = await issue(other, { title: "Foreign" });
    expect(await kindOf(service.updateIssue(actor, child.id, { parentIssueId: foreign.id }))).toBe(
      "cross_project_parent",
    );
    await problemOf(
      await patch(`/api/issues/${child.id}`, { parentIssueId: foreign.id }),
      400,
      "cross_project_parent",
    );

    expect(await kindOf(service.updateIssue(actor, parent.id, { parentIssueId: child.id }))).toBe(
      "subtask_depth_exceeded",
    );
    await problemOf(
      await patch(`/api/issues/${parent.id}`, { parentIssueId: child.id }),
      409,
      "subtask_depth_exceeded",
    );
    const grandchild = await issue(pid, { title: "Grandchild" });
    expect(
      await kindOf(service.updateIssue(actor, grandchild.id, { parentIssueId: child.id })),
    ).toBe("subtask_depth_exceeded");
    await problemOf(
      await post(`/api/projects/${pid}/issues`, { title: "Bad parent", parentIssueId: child.id }),
      409,
      "subtask_depth_exceeded",
    );
    await problemOf(
      await post(`/api/projects/${pid}/issues`, {
        title: "Missing parent",
        parentIssueId: randomUUID(),
      }),
      404,
      "issue_not_found",
    );

    const cleared = await patch(`/api/issues/${child.id}`, { parentIssueId: null });
    expect(cleared.status).toBe(200);
    expect(field(await cleared.json(), "parentIssueId")).toBeNull();

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.map((event) => event.type)).toContain("issue_parent_changed");
  });

  it("enforces same-project and depth-1 in the database for bypassing writers", async () => {
    const pid = await project();
    const other = await project("Other", "OTH2");
    const author = (await database.db.select({ id: humans.id }).from(humans))[0]!.id;
    const ids = await database.db
      .insert(issues)
      .values([
        {
          id: randomUUID(),
          projectId: pid,
          number: 1,
          title: "Root",
          status: "todo",
          sortOrder: 65535,
          createdByHumanId: author,
          updatedByHumanId: author,
        },
        {
          id: randomUUID(),
          projectId: pid,
          number: 2,
          title: "Child",
          status: "todo",
          sortOrder: 131070,
          createdByHumanId: author,
          updatedByHumanId: author,
        },
      ])
      .returning({ id: issues.id });

    const rootId = ids[0]!.id;
    const childId = ids[1]!.id;

    await expect(
      rejectionMessage(
        database.db.execute(
          sql`update issues set parent_issue_id = ${rootId} where id = ${rootId}`,
        ),
      ),
    ).resolves.toMatch(/own parent|issues_no_self_parent/i);

    await database.db.execute(
      sql`update issues set parent_issue_id = ${rootId} where id = ${childId}`,
    );
    const grandchildId = randomUUID();
    await expect(
      rejectionMessage(
        database.db.execute(sql`
          insert into issues (id, project_id, number, title, status, sort_order,
            created_by_human_id, updated_by_human_id, parent_issue_id)
          values (${grandchildId}, ${pid}, 3, 'Grandchild', 'todo', 196605,
            ${author}, ${author}, ${childId})
        `),
      ),
    ).resolves.toMatch(/depth/i);

    await expect(
      rejectionMessage(
        database.db.execute(
          sql`update issues set parent_issue_id = ${childId} where id = ${rootId}`,
        ),
      ),
    ).resolves.toMatch(/depth|children/i);

    const foreignId = randomUUID();
    await database.db.execute(sql`
      insert into issues (id, project_id, number, title, status, sort_order,
        created_by_human_id, updated_by_human_id)
      values (${foreignId}, ${other}, 1, 'Foreign', 'todo', 65535, ${author}, ${author})
    `);
    await expect(
      rejectionMessage(
        database.db.execute(
          sql`update issues set parent_issue_id = ${foreignId} where id = ${childId}`,
        ),
      ),
    ).resolves.toMatch(/same project/i);

    await expect(
      rejectionMessage(
        database.db.execute(sql`update issues set project_id = ${other} where id = ${rootId}`),
      ),
    ).resolves.toMatch(/project|project_id/i);
  });

  it("404s a parent id in a workspace the caller cannot read (#97 review)", async () => {
    const pid = await project();
    const humanId = randomUUID();
    expect(humanId).toBeTruthy();
    await database.db.insert(humans).values({
      id: humanId,
      email: `other-${humanId}@example.com`,
      passwordHash: "not-a-real-hash",
    });
    const foreignWorkspaceId = randomUUID();
    await database.db.insert(workspaces).values({
      id: foreignWorkspaceId,
      kind: "personal",
      name: "Foreign workspace",
      personalOwnerHumanId: humanId,
    });
    const foreignProjectId = randomUUID();
    await database.db.insert(projects).values({
      id: foreignProjectId,
      workspaceId: foreignWorkspaceId,
      name: "Foreign project",
      key: "FRGN",
      createdByHumanId: humanId,
    });
    const foreignIssueId = randomUUID();
    await database.db.insert(issues).values({
      id: foreignIssueId,
      projectId: foreignProjectId,
      number: 1,
      title: "Foreign parent",
      status: "todo",
      sortOrder: 65535,
      createdByHumanId: humanId,
      updatedByHumanId: humanId,
    });

    await problemOf(
      await post(`/api/projects/${pid}/issues`, { title: "Child", parentIssueId: foreignIssueId }),
      404,
      "issue_not_found",
    );
    const own = await issue(pid);
    await problemOf(
      await patch(`/api/issues/${own.id}`, { parentIssueId: foreignIssueId }),
      404,
      "issue_not_found",
    );
  });

  it("serializes concurrent parent writes so two racers cannot create depth 2", async () => {
    const pid = await project();
    const a = await issue(pid, { title: "A" });
    const b = await issue(pid, { title: "B" });
    const c = await issue(pid, { title: "C" });

    const results = await Promise.allSettled([
      service.updateIssue(actor, b.id, { parentIssueId: a.id }),
      service.updateIssue(actor, a.id, { parentIssueId: c.id }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const rows = await database.db
      .select({ id: issues.id, parent: issues.parentIssueId })
      .from(issues)
      .where(eq(issues.projectId, pid));
    const parents = new Map(rows.map((row) => [row.id, row.parent]));

    const storedParents = [parents.get(a.id), parents.get(b.id)].filter(
      (value): value is string => value !== null && value !== undefined,
    );
    expect(storedParents.every((id) => parents.get(id) === null)).toBe(true);
  });
});

async function labelId(projectId: string, name: string, color = "#ff0000") {
  const res = await post(`/api/projects/${projectId}/labels`, { name, color });
  expect(res.status).toBe(201);
  return text(field(await res.json(), "id"), "the label id");
}

async function nextIssueNumber(projectId: string) {
  const [row] = await database.db
    .select({ nextIssueNumber: projects.nextIssueNumber })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row!.nextIssueNumber;
}

async function issueCount(projectId: string) {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  return row!.count;
}

describe("atomic issue creation (#175)", () => {
  it("creates the issue, its assignee and its labels in one REST request", async () => {
    const pid = await project();
    const bug = await labelId(pid, "Bug");
    const ui = await labelId(pid, "UI", "#0000ff");
    const humanId = await adminHumanId();

    const created = await issue(pid, {
      title: "Triage on create",
      body: "Filed with its metadata.",
      status: "in_progress",
      priority: "high",
      assignee: { type: "human", id: humanId },
      labelIds: [bug, ui, bug],
    });
    expect(created).toMatchObject({
      status: "in_progress",
      priority: "high",
      assignee: { humanId },
    });
    expect(created.labels.map((label) => label.id).toSorted()).toEqual([bug, ui].toSorted());

    const [row] = await database.db.select().from(issues).where(eq(issues.id, created.id));
    expect(row).toMatchObject({ assigneeType: "human", assigneeId: humanId });
    const attached = await database.db
      .select({ labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, created.id));
    expect(attached.map((entry) => entry.labelId).toSorted()).toEqual([bug, ui].toSorted());

    const events = ProjectActivityResponse.parse(
      await (await get(`/api/projects/${pid}/activity`)).json(),
    );
    expect(events.filter((event) => event.type === "issue_label_added")).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain("issue_created");
  });

  it("rejects a foreign label or an unknown assignee without creating a partial issue", async () => {
    const pid = await project();
    const other = await project("Other", "OTH2");
    const foreign = await labelId(other, "Foreign");
    const before = await issueCount(pid);
    const number = await nextIssueNumber(pid);

    await problemOf(
      await post(`/api/projects/${pid}/issues`, {
        title: "Foreign label",
        labelIds: [foreign],
      }),
      404,
      "label_not_found",
    );
    expect(await issueCount(pid)).toBe(before);
    expect(await nextIssueNumber(pid)).toBe(number);

    await problemOf(
      await post(`/api/projects/${pid}/issues`, {
        title: "Unknown assignee",
        assignee: { type: "human", id: randomUUID() },
      }),
      404,
      "assignee_not_found",
    );
    expect(await issueCount(pid)).toBe(before);
    expect(await nextIssueNumber(pid)).toBe(number);
    expect(
      await kindOf(service.createIssue(actor, pid, { title: "Service", labelIds: [foreign] })),
    ).toBe("label_not_found");
  });

  it("accepts an agent assignee and label ids over MCP with the same validation", async () => {
    const pid = await project();
    const label = await labelId(pid, "MCP label");
    const other = await project("Other", "OTH2");
    const foreign = await labelId(other, "Foreign");
    const agentId = randomUUID();
    await database.db.insert(agents).values({
      id: agentId,
      humanId: await adminHumanId(),
      name: `triage-${agentId}`,
    });
    await database.db.insert(agentApiKeys).values({
      id: randomUUID(),
      agentId,
      workspaceId,
      createdByHumanId: await adminHumanId(),
      validity: "90",
      tokenHash: `test-hash-${agentId}`,
    });
    const identity = {
      agentId,
      name: "triage-bot",
      humanId: await adminHumanId(),
      keyId: randomUUID(),
      workspaceId,
      validity: "90" as const,
      projects: [{ projectId: pid, projectName: "Labels", level: "contribute" as const }],
    };
    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<{
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }>
    >();
    // The tool registrar only calls registerTool; a capturing stub is enough here.
    const rawServer = {
      registerTool: (
        name: string,
        _config: unknown,
        handler: (args: Record<string, unknown>) => Promise<{
          structuredContent?: Record<string, unknown>;
          isError?: boolean;
        }>,
      ) => {
        handlers.set(name, handler);
      },
    };
    if (!isToolRegistrar(rawServer)) throw new Error("the tool registrar stub is invalid");
    createProjectsMcp(service, async () => identity)(
      rawServer,
      new Request("http://orrery.test/mcp"),
    );
    const create = handlers.get("create_issue");
    if (create === undefined) throw new Error("create_issue was not registered");

    const created = await create({
      projectId: pid,
      title: "MCP atomic issue",
      labelIds: [label],
      assignee: { type: "agent", id: agentId },
    });
    expect(created.isError).not.toBe(true);
    const createdIssue = created.structuredContent?.issue;
    expect(createdIssue).toMatchObject({ title: "MCP atomic issue", labels: [{ id: label }] });
    expect(field(createdIssue, "assignee")).toMatchObject({ agentId });

    const before = await issueCount(pid);
    const rejected = await create({
      projectId: pid,
      title: "MCP cross-project label",
      labelIds: [foreign],
    });
    expect(rejected).toMatchObject({
      isError: true,
      structuredContent: { code: "label_not_found" },
    });
    expect(await issueCount(pid)).toBe(before);
  });
});

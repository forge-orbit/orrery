import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const smtpHost = process.env.MAILPIT_SMTP_HOST ?? "mailpit";
const TEAMMATE_PASSWORD = "studio-teammate-password";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${what}`);
  return value;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface Fixture {
  workspaceId: string;
  projectId: string;
  issueId: string;
  runnerId: string;
  dispatchId: string;
  dispatchAttemptId: string;
  dispatchToken: string;
  teammateEmail: string;
}

let admin: APIRequestContext;
let fixture: Fixture;

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const smtp = await admin.put("/api/settings/smtp", {
    data: {
      host: smtpHost,
      port: 1025,
      security: "none",
      username: null,
      password: null,
      from: "orrery@orrery.test",
    },
  });
  expect(smtp.status()).toBe(200);
  await ensureAdminVerified();
  fixture = await seedFixture();
});

test.afterAll(async () => {
  await admin?.dispose();
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  for (const cookie of await page.context().cookies()) await recordSecret(cookie.value);
}

async function ensureAdminVerified() {
  const session = await admin.get("/api/auth/session");
  expect(session.status()).toBe(200);
  if (field(await session.json(), "emailVerified") === true) return;
  const sent = await admin.post("/api/settings/smtp/test");
  expect(sent.status()).toBe(200);
  const token = await mailToken(
    ADMIN_EMAIL,
    "Verify your Orrery email",
    /\/settings\/smtp\?token=([A-Za-z0-9_-]+)/,
  );
  const verified = await admin.post("/api/settings/email-verification", { data: { token } });
  expect(verified.status()).toBe(200);
}

async function mailToken(to: string, subject: string, pattern: RegExp): Promise<string> {
  const matcher = async (): Promise<string | undefined> => {
    const list = await admin.get(`${mailpit}/api/v1/messages`);
    const body: unknown = await list.json();
    const messages = field(body, "messages");
    if (!Array.isArray(messages)) return undefined;
    for (const message of messages) {
      if (field(message, "Subject") !== subject) continue;
      const id = field(message, "ID");
      if (typeof id !== "string") continue;
      const detail = await admin.get(`${mailpit}/api/v1/message/${id}`);
      const bodyDetail: unknown = await detail.json();
      const recipients = field(bodyDetail, "To");
      const hasRecipient =
        Array.isArray(recipients) && recipients.some((entry) => field(entry, "Address") === to);
      const content = field(bodyDetail, "Text");
      if (hasRecipient && typeof content === "string") {
        const token = content.match(pattern)?.[1];
        if (token !== undefined) return token;
      }
    }
    return undefined;
  };
  await expect.poll(matcher, { timeout: 15_000 }).toBeTruthy();
  const token = await matcher();
  if (token === undefined) throw new Error(`no mail token for ${to}`);
  await recordSecret(token);
  return token;
}

async function enrolledHost(): Promise<string> {
  const verifier = randomBytes(32).toString("hex");
  await recordSecret(verifier);
  const created = await admin.post("/api/runners/device-codes", {
    data: {
      hostDisplayName: `e2e-studio-laptop-${randomUUID().slice(0, 6)}`,
      platform: "linux-x64",
      verifierHash: sha256(verifier),
    },
  });
  expect(created.status()).toBe(201);
  const device = await created.json();
  const deviceCode = text(field(device, "deviceCode"), "device code");
  await recordSecret(deviceCode);
  const approved = await admin.post(
    `/api/runners/device-codes/${text(field(device, "userCode"), "user code")}/approve`,
    { data: {} },
  );
  expect(approved.status()).toBe(200);
  const exchanged = await admin.post("/api/runners/device-codes/token", {
    data: { deviceCode, verifier },
  });
  expect(exchanged.status()).toBe(200);
  const credential = text(field(await exchanged.json(), "credential"), "host credential");
  await recordSecret(credential);
  return credential;
}

async function seedFixture(): Promise<Fixture> {
  const workspace = await admin.post("/api/workspaces", {
    data: { name: `Live Studio ${randomUUID().slice(0, 6)}` },
  });
  expect(workspace.status()).toBe(201);
  const workspaceId = text(field(await workspace.json(), "id"), "workspace id");

  const projectResponse = await admin.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: "Studio project" },
  });
  expect(projectResponse.status()).toBe(201);
  const projectId = text(field(await projectResponse.json(), "id"), "project id");

  const issueResponse = await admin.post(`/api/projects/${projectId}/issues`, {
    data: { title: "Show me the live session" },
  });
  expect(issueResponse.status()).toBe(201);
  const issueId = text(field(await issueResponse.json(), "id"), "issue id");

  const agentResponse = await admin.post("/api/agents", {
    data: { name: `studio-agent-${randomUUID().slice(0, 6)}` },
  });
  expect(agentResponse.status()).toBe(201);
  const agentId = text(field(await agentResponse.json(), "id"), "agent id");

  const credential = await enrolledHost();
  const hostApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  let dispatchId = "";
  let runnerId = "";
  let dispatchAttemptId = "";
  let dispatchToken = "";
  try {
    const registered = await hostApi.post("/api/runners/register", {
      data: {
        workspaceId,
        projectId,
        agentId,
        displayName: "studio-runner",
        repoFingerprint: sha256("/private/local/studio-repo"),
        capabilities: ["opencode"],
        maxConcurrency: 2,
      },
    });
    expect(registered.status()).toBe(201);
    runnerId = text(field(await registered.json(), "id"), "runner id");

    const dispatchResponse = await admin.post(`/api/issues/${issueId}/dispatches`, {
      data: { runnerId },
    });
    expect(dispatchResponse.status()).toBe(201);
    dispatchId = text(field(await dispatchResponse.json(), "id"), "dispatch id");

    const accepted = await hostApi.post(`/api/runners/${runnerId}/dispatches/${dispatchId}/accept`);
    expect(accepted.status()).toBe(200);
    const acceptance: unknown = await accepted.json();
    const dispatch: unknown = field(acceptance, "dispatch");
    dispatchAttemptId = text(field(dispatch, "dispatchAttemptId"), "dispatch attempt id");
    dispatchToken = text(field(acceptance, "dispatchToken"), "dispatch token");
    await recordSecret(dispatchToken);
  } finally {
    await hostApi.dispose();
  }

  const future = new Date(Date.now() + 120_000).toISOString();
  const chunks = [
    {
      seq: 1,
      kind: "event",
      eventType: "plan",
      summary: "Plan updated",
      data: {
        items: [
          { label: "Inspect the repo", checked: true },
          { label: "Implement fix", checked: false },
        ],
      },
    },
    {
      seq: 2,
      kind: "event",
      eventType: "command",
      summary: "pnpm test",
      data: { status: "passed" },
    },
    {
      seq: 3,
      kind: "event",
      eventType: "file_diff",
      summary: "src/app.ts",
      data: {
        path: "src/app.ts",
        diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    },
    {
      seq: 4,
      kind: "event",
      eventType: "tool_call",
      summary: "pnpm build",
      data: { status: "running" },
    },
    { seq: 5, kind: "raw_output", visibility: "owner_only", summary: "owner-only stdout line" },
    {
      seq: 6,
      kind: "diagnostic",
      diagnostic: {
        kind: "acp_not_installed",
        version: 1,
        message: "opencode missing",
        harness: "opencode",
      },
    },
    {
      seq: 7,
      kind: "diagnostic",
      diagnostic: { kind: "acp_spawn_failed", version: 1, message: "spawn failed", exitCode: 2 },
    },
    {
      seq: 8,
      kind: "diagnostic",
      diagnostic: { kind: "acp_crashed", version: 1, message: "agent crashed", signal: "SIGSEGV" },
    },
    {
      seq: 9,
      kind: "diagnostic",
      diagnostic: {
        kind: "auth_expired",
        version: 1,
        message: "auth expired",
        remediation: "Run opencode auth login",
      },
    },
    {
      seq: 10,
      kind: "diagnostic",
      diagnostic: { kind: "usage_limit", version: 1, message: "quota reached", resetsAt: future },
    },
    {
      seq: 11,
      kind: "diagnostic",
      diagnostic: {
        kind: "provider_overload",
        version: 1,
        message: "provider busy",
        attempt: 2,
        countdownSeconds: 90,
      },
    },
    {
      seq: 12,
      kind: "diagnostic",
      diagnostic: {
        kind: "permission_denied",
        version: 1,
        message: "denied",
        tool: "bash",
        path: "/repo",
      },
    },
    {
      seq: 13,
      kind: "diagnostic",
      diagnostic: {
        kind: "runner_disconnected",
        version: 1,
        message: "runner offline",
        lastSeq: 5,
      },
    },
  ];
  const ingestApi = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { authorization: `Bearer ${credential}` },
  });
  try {
    const ingested = await ingestApi.post(
      `/api/runners/${runnerId}/dispatches/${dispatchId}/stream`,
      { data: { dispatchAttemptId, fromSeq: 1, toSeq: chunks.length, chunks } },
    );
    expect(ingested.status()).toBe(200);
  } finally {
    await ingestApi.dispose();
  }

  const teammateEmail = `studio-teammate.${randomUUID()}@orrery.test`;
  await recordSecret(TEAMMATE_PASSWORD);
  const invited = await admin.post("/api/invitations/installation", {
    data: { email: teammateEmail },
  });
  expect(invited.status()).toBe(201);
  const registrationToken = await mailToken(
    teammateEmail,
    "Your Orrery invitation",
    /\/register\?token=([A-Za-z0-9_-]+)/,
  );
  const teammateApi = await request.newContext({ baseURL: baseUrl });
  try {
    const registered = await admin.post("/api/invitations/installation/registration", {
      data: { token: registrationToken, password: TEAMMATE_PASSWORD },
    });
    expect(registered.status()).toBe(200);
    const signedIn = await teammateApi.post("/api/auth/login", {
      data: { email: teammateEmail, password: TEAMMATE_PASSWORD },
    });
    expect(signedIn.status()).toBe(200);

    const workspaceInvite = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
      data: { email: teammateEmail },
    });
    expect(workspaceInvite.status()).toBe(201);
    const workspaceToken = await mailToken(
      teammateEmail,
      "Your Orrery workspace invitation",
      /\/workspace-invitation\?token=([A-Za-z0-9_-]+)/,
    );
    const acceptedInvite = await teammateApi.post("/api/workspace-invitations/acceptance", {
      data: { token: workspaceToken },
    });
    expect(acceptedInvite.status()).toBe(200);
  } finally {
    await teammateApi.dispose();
  }

  const grant = await admin.patch(`/api/projects/${projectId}/access`, {
    data: { email: teammateEmail, level: "read" },
  });
  expect(grant.status()).toBe(200);

  return {
    workspaceId,
    projectId,
    issueId,
    runnerId,
    dispatchId,
    dispatchAttemptId,
    dispatchToken,
    teammateEmail,
  };
}

function studioUrl(): string {
  return `/live/${fixture.runnerId}/${fixture.dispatchId}?issueId=${fixture.issueId}&workspaceId=${fixture.workspaceId}`;
}

test.describe("Live Session Studio", () => {
  test.describe.configure({ mode: "serial" });

  test("opens the Studio from the Issue inspector and the Runners Fleet", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`/issues/${fixture.issueId}?inspector=true`);
      const link = page.locator("[data-open-live-studio]").first();
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(/\/live\//);
      await expect(page.locator("[data-live-studio]")).toBeVisible();
      await expect(page.locator("[data-stream-card]").first()).toBeVisible();
      await expect(page.locator("[data-context-rail]")).toBeVisible();

      await page.goto(`/workspaces/${fixture.workspaceId}`);
      await page.getByRole("tab", { name: "Runners" }).click();
      const fleetLink = page.locator("[data-fleet-live-link]").first();
      await expect(fleetLink).toBeVisible();
      await fleetLink.click();
      await expect(page).toHaveURL(/\/live\//);

      await page.goto(`/board/${fixture.projectId}`);
      const issueCard = page.locator(
        `[data-board-column="In progress"] [data-board-issue-id="${fixture.issueId}"]`,
      );
      await expect(issueCard).toBeVisible();
      await issueCard.getByRole("button", { name: "Inspect session" }).click();
      const drawer = page.getByRole("dialog", { name: "Session preview" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("link", { name: "Open Live Studio" })).toBeVisible();
      await expect(drawer.locator("[data-activity-timeline]")).toHaveCount(0);
      await expect(drawer.getByText("owner-only stdout line")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("stream cards, filters and all eight diagnostic banners render", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(studioUrl());
      await expect(page.locator("[data-stream-card]")).toHaveCount(12);
      await expect(page.locator("[data-stream-card][data-stream-category='edit']")).toHaveCount(1);

      await page.getByText("Edits", { exact: true }).click();
      await expect(page.locator("[data-stream-card]")).toHaveCount(1);
      await expect(page.locator("[data-stream-card][data-stream-category='edit']")).toBeVisible();

      await page.getByText("Commands & Tests", { exact: true }).click();
      await expect(page.locator("[data-stream-card][data-stream-category='command']")).toHaveCount(
        2,
      );

      await page.getByText("Diagnostics", { exact: true }).click();
      await expect(
        page.locator("[data-stream-card][data-stream-category='diagnostic']"),
      ).toHaveCount(8);

      await page.getByText("All", { exact: true }).click();
      await expect(page.locator('[data-stream-seq="2"]')).toHaveAttribute(
        "data-stream-open",
        "false",
      );
      await expect(page.locator('[data-stream-seq="4"]')).toHaveAttribute(
        "data-stream-open",
        "true",
      );
      await expect(page.locator('[data-stream-seq="3"]')).toHaveAttribute(
        "data-stream-open",
        "false",
      );
      await page.locator('[data-stream-seq="3"]').getByText("Edit · src/app.ts").click();
      await expect(page.locator('[data-stream-seq="3"]')).toContainText("+new");

      await page.getByText("Thoughts", { exact: true }).click();
      await expect(page.locator("[data-stream-card]")).toHaveCount(1);
      await expect(
        page.locator("[data-stream-card][data-stream-category='thought']"),
      ).toBeVisible();
      await page.getByText("All", { exact: true }).click();

      for (const kind of [
        "acp_not_installed",
        "acp_spawn_failed",
        "acp_crashed",
        "auth_expired",
        "usage_limit",
        "provider_overload",
        "permission_denied",
        "runner_disconnected",
      ]) {
        await expect(page.locator(`[data-diagnostic-kind="${kind}"]`)).toBeVisible();
      }
      await expect(page.getByText("Run opencode auth login")).toBeVisible();
      await expect(page.locator("[data-plan-checklist]")).toBeVisible();
      await expect(page.locator("[data-changed-file]")).toHaveCount(1);
      await page.locator("[data-file-jump]").first().click();
      await expect(page.locator("[data-stream-card]")).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("a bare /live/:runnerId/:dispatchId URL reads the stream without empty-id requests", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    const requested: string[] = [];
    page.on("request", (req) => requested.push(req.url()));
    try {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`/live/${fixture.runnerId}/${fixture.dispatchId}`);
      await expect(page.locator("[data-live-studio]")).toBeVisible();
      await expect(page.locator("[data-stream-card]").first()).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to workspaces" })).toBeVisible();
      expect(requested.some((url) => url.includes("/api/issues//"))).toBe(false);
      expect(requested.some((url) => url.includes("/api/workspaces//"))).toBe(false);
      expect(
        requested.some((url) =>
          url.includes(`/api/runners/${fixture.runnerId}/dispatches/${fixture.dispatchId}/stream`),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("raw output is opt-in for the owner and restricted for teammates", async ({ browser }) => {
    const ownerContext = await browser.newContext({ baseURL: baseUrl });
    const owner = await ownerContext.newPage();
    try {
      await signIn(owner, ADMIN_EMAIL, ADMIN_PASSWORD);
      await owner.goto(studioUrl());
      await expect(owner.locator("[data-raw-toggle]")).toBeVisible();
      await expect(owner.getByText("owner-only stdout line")).toHaveCount(0);
      await owner.locator("[data-raw-toggle]").click();
      await expect(owner.getByText("owner-only stdout line")).toBeVisible();
    } finally {
      await ownerContext.close();
    }

    const teammateContext = await browser.newContext({ baseURL: baseUrl });
    const teammate = await teammateContext.newPage();
    try {
      await signIn(teammate, fixture.teammateEmail, TEAMMATE_PASSWORD);
      await teammate.goto(studioUrl());
      await expect(teammate.locator("[data-raw-toggle]")).toHaveCount(0);
      await expect(
        teammate.getByText("Raw output is restricted to the Runner host owner."),
      ).toBeVisible();
      await expect(teammate.getByText("owner-only stdout line")).toHaveCount(0);
    } finally {
      await teammateContext.close();
    }

    const ownerStream = await admin.get(
      `/api/runners/${fixture.runnerId}/dispatches/${fixture.dispatchId}/stream?afterSeq=0`,
    );
    expect(ownerStream.status()).toBe(200);
    const ownerChunks = field(await ownerStream.json(), "chunks");
    expect(Array.isArray(ownerChunks)).toBe(true);
    if (Array.isArray(ownerChunks)) {
      expect(ownerChunks.some((entry) => field(entry, "kind") === "raw_output")).toBe(true);
    }

    const teammateApi = await request.newContext({ baseURL: baseUrl });
    try {
      const login = await teammateApi.post("/api/auth/login", {
        data: { email: fixture.teammateEmail, password: TEAMMATE_PASSWORD },
      });
      expect(login.status()).toBe(200);
      const stream = await teammateApi.get(
        `/api/runners/${fixture.runnerId}/dispatches/${fixture.dispatchId}/stream?afterSeq=0`,
      );
      expect(stream.status()).toBe(200);
      const chunks = field(await stream.json(), "chunks");
      expect(Array.isArray(chunks)).toBe(true);
      if (Array.isArray(chunks)) {
        expect(chunks.some((entry) => field(entry, "kind") === "raw_output")).toBe(false);
      }
    } finally {
      await teammateApi.dispose();
    }
  });

  test("Stop Agent requires an explicit confirmation with a reason", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(studioUrl());
      await page.getByLabel("Stop reason (optional)").fill("Needs a human decision");
      await page.locator("[data-studio-stop-agent]").click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Needs a human decision")).toBeVisible();
      await expect(dialog.getByText(/Leaving this Studio does not stop it/)).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await page.locator("[data-studio-stop-agent]").click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Stop Agent" }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Stop requested for the active agent session." }),
      ).toBeVisible();

      const sessions = await admin.get(`/api/issues/${fixture.issueId}/work-sessions`);
      expect(sessions.status()).toBe(200);
      expect(field(await sessions.json(), "stopReason")).toBe("Needs a human decision");
    } finally {
      await context.close();
    }
  });

  test("replays the rolled-up ObjectStore stream after the session ends", async ({ browser }) => {
    const stopped = await request.newContext({
      baseURL: baseUrl,
      extraHTTPHeaders: { authorization: `Bearer ${fixture.dispatchToken}` },
    });
    try {
      const ended = await stopped.post(`/api/issues/${fixture.issueId}/work-sessions/stop`, {
        data: { outcome: "completed" },
      });
      expect(ended.status()).toBe(200);
    } finally {
      await stopped.dispose();
    }

    await expect
      .poll(
        async () => {
          const stream = await admin.get(
            `/api/runners/${fixture.runnerId}/dispatches/${fixture.dispatchId}/stream?afterSeq=0`,
          );
          if (!stream.ok()) return false;
          return field(await stream.json(), "rolledUp") === true;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    try {
      await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(studioUrl());
      await expect(page.locator("[data-studio-replay]")).toHaveText("Archived replay");
      await expect(page.getByText("Replaying the archived session")).toBeVisible();
      await expect(page.locator("[data-stream-card]")).toHaveCount(12);
    } finally {
      await context.close();
    }
  });
});

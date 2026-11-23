import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, recordSecret } from "./admin.ts";

const baseUrl = process.env.ORRERY_URL;
if (!baseUrl) {
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");
}

const mailpit = process.env.MAILPIT_URL ?? "http://localhost:8025";
const MEMBER_PASSWORD = "webhooks-ui-member-password";
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

type Received = {
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  event: string | undefined;
};

let admin: APIRequestContext;
let receiver: Server | undefined;
let received: Received[];

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

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

test.beforeAll(async () => {
  admin = await request.newContext({ baseURL: baseUrl });
  const login = await admin.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect((await admin.put("/api/settings/smtp", { data: SMTP_SETTINGS })).status()).toBe(200);
  await ensureAdminVerified();

  received = [];
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        signature: header(req.headers["x-orrery-signature-256"]),
        timestamp: header(req.headers["x-orrery-timestamp"]),
        event: header(req.headers["x-orrery-event"]),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver?.listen(0, "0.0.0.0", resolve));
});

test.afterAll(async () => {
  if (receiver !== undefined) {
    await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  }
  await admin?.dispose();
});

test("owner manages webhooks and inspects deliveries while non-owners do not see the Webhooks tab", async ({
  browser,
}) => {
  const workspaceName = `Webhooks UI ${randomUUID().slice(0, 8)}`;
  const wsRes = await admin.post("/api/workspaces", { data: { name: workspaceName } });
  expect(wsRes.status()).toBe(201);
  const workspaceId = idOf(await wsRes.json(), "workspace");

  // Invite a regular (non-owner) member so we can verify the Webhooks tab stays hidden for them.
  const memberEmail = `webhooks-member-${randomUUID().slice(0, 8)}@orrery.test`;
  const inviteRes = await admin.post(`/api/workspaces/${workspaceId}/invitations`, {
    data: { email: memberEmail, projectGrants: [] },
  });
  expect(inviteRes.status()).toBe(201);
  const inviteToken = await liveInvitationToken(memberEmail, workspaceName);
  await recordSecret(inviteToken);
  const memberApi = await request.newContext({ baseURL: baseUrl });
  try {
    const reg = await memberApi.post("/api/workspace-invitations/registration", {
      data: {
        token: inviteToken,
        password: MEMBER_PASSWORD,
      },
    });
    expect(reg.status()).toBe(200);
  } finally {
    await memberApi.dispose();
  }

  const address = receiver?.address();
  if (address === undefined || address === null || typeof address === "string") {
    throw new Error("no receiver address");
  }
  const receiverHost = process.env.ORRERY_WEBHOOK_E2E_HOST ?? "host.docker.internal";
  const receiverUrl = `http://${receiverHost}:${address.port}/hook`;

  // 1. Owner flow: create, copy one-time secret, send test, inspect delivery log, disable/re-enable, delete.
  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  try {
    await ownerPage.goto("/signin");
    await ownerPage.getByLabel("Email").fill(ADMIN_EMAIL);
    await ownerPage.getByLabel("Password").fill(ADMIN_PASSWORD);
    await ownerPage.getByRole("button", { name: "Sign in" }).click();
    await expect(ownerPage.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

    await ownerPage.goto(`/workspaces/${workspaceId}`);
    const webhooksTab = ownerPage.getByRole("tab", { name: /Webhooks/ });
    await expect(webhooksTab).toBeVisible();
    await webhooksTab.click();

    await ownerPage.getByRole("button", { name: "Add webhook" }).first().click();
    await ownerPage.getByLabel(/Endpoint URL/).fill(receiverUrl);
    await ownerPage.getByLabel("Description").fill("E2E webhook receiver");
    await ownerPage.getByRole("button", { name: "Create webhook" }).click();

    const secretCode = ownerPage.locator("[data-webhook-secret]");
    await expect(secretCode).toBeVisible();
    const secret = (await secretCode.innerText()).trim();
    expect(secret).toMatch(/^whsec_/);
    await recordSecret(secret);
    await ownerPage
      .locator("[data-webhook-secret-banner]")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(secretCode).toHaveCount(0);

    const row = ownerPage.locator("[data-webhook-id]").first();
    await expect(row).toContainText(receiverUrl);
    await expect(row).toContainText("Active");

    // Send test -> opens deliveries drawer and verifies live signed delivery.
    await row.getByRole("button", { name: "Send test" }).click();
    const drawer = ownerPage.locator("[data-webhook-deliveries]");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("webhook.test");
    await expect(drawer.locator('[data-delivery-status="delivered"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawer).toContainText("200");

    expect(received.length).toBeGreaterThan(0);
    const delivery = received[0]!;
    expect(delivery.event).toBe("webhook.test");
    const expectedSig = createHmac("sha256", secret)
      .update(`${delivery.timestamp}.${delivery.body}`)
      .digest("hex");
    expect(delivery.signature).toBe(`sha256=${expectedSig}`);

    await ownerPage.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // Disable and re-enable.
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row).toHaveAttribute("data-webhook-enabled", "false");
    await expect(row).toContainText("Disabled");

    await row.getByRole("button", { name: "Re-enable" }).click();
    await expect(row).toHaveAttribute("data-webhook-enabled", "true");
    await expect(row).toContainText("Active");

    // Delete with confirmation dialog.
    await row.getByRole("button", { name: "Delete" }).click();
    const alertDialog = ownerPage.getByRole("alertdialog");
    await expect(alertDialog).toBeVisible();
    await alertDialog.getByRole("button", { name: "Delete webhook" }).click();
    await expect(ownerPage.locator("[data-webhook-id]")).toHaveCount(0);
    await expect(
      ownerPage.locator("#panel-webhooks").getByText("No outgoing webhooks yet"),
    ).toBeVisible();
  } finally {
    for (const cookie of await ownerCtx.cookies()) await recordSecret(cookie.value);
    await ownerCtx.close();
  }

  // 2. Non-owner member flow: Webhooks tab must not be rendered.
  const memberCtx = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  try {
    await memberPage.goto("/signin");
    await memberPage.getByLabel("Email").fill(memberEmail);
    await memberPage.getByLabel("Password").fill(MEMBER_PASSWORD);
    await memberPage.getByRole("button", { name: "Sign in" }).click();
    await expect(memberPage.getByText(`Signed in as ${memberEmail}.`)).toBeVisible();

    await memberPage.goto(`/workspaces/${workspaceId}`);
    await expect(memberPage.getByRole("tab", { name: /Projects/ })).toBeVisible();
    await expect(memberPage.getByRole("tab", { name: /Webhooks/ })).toHaveCount(0);
  } finally {
    for (const cookie of await memberCtx.cookies()) await recordSecret(cookie.value);
    await memberCtx.close();
  }
});

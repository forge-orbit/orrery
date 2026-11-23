import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./admin.ts";

const configuredUrl = process.env.ORRERY_URL;
if (!configuredUrl) throw new Error("Set ORRERY_URL to a running Orrery");
const baseUrl: string = configuredUrl;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const idOf = (value: unknown, what: string): string => {
  const id = field(value, "id");
  if (typeof id !== "string" || id === "") throw new Error(`missing ${what} id`);
  return id;
};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// A valid 1x1 PNG, small enough to paste and drop without disk fixtures.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMQCVggErCAAUIBABpOBBEmsXU3AAAAAElFTkSuQmCC",
  "base64",
);

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: baseUrl });
  const login = await api.post("/api/auth/login", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
});

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();
}

async function newProject(): Promise<string> {
  const workspaces = await api.get("/api/workspaces");
  expect(workspaces.status()).toBe(200);
  const personal = asArray(await workspaces.json()).find((w) => field(w, "kind") === "personal");
  const workspaceId = idOf(personal, "personal workspace");
  const key = `AT${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  const created = await api.post(`/api/workspaces/${workspaceId}/projects`, {
    data: { name: `Attachments ${key}`, key },
  });
  expect(created.status()).toBe(201);
  return idOf(await created.json(), "project");
}

/** Dispatch a paste or drop carrying a File, the way a browser does for clipboard/screen shots. */
async function dispatchFiles(
  page: Page,
  selector: string,
  eventName: "paste" | "drop",
  name: string,
) {
  await page.locator(selector).evaluate(
    (element, args) => {
      const bytes = Uint8Array.from(atob(args.base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], args.name, { type: args.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const init = { bubbles: true, cancelable: true };
      const event =
        args.eventName === "paste"
          ? new ClipboardEvent("paste", { ...init, clipboardData: transfer })
          : new DragEvent("drop", { ...init, dataTransfer: transfer });
      element.dispatchEvent(event);
    },
    { eventName, name, base64: PNG.toString("base64"), type: "image/png" },
  );
}

test("paste, drop, and click each upload an attachment that renders inline only in Orrery", async ({
  page,
}) => {
  const projectId = await newProject();
  await signIn(page);
  await page.goto(`/projects/${projectId}/issues/new`);
  await expect(page.locator("[data-new-issue-page]")).toBeVisible();

  // Hold uploads briefly so the temporary placeholder is observable.
  await page.route("**/api/projects/*/attachments", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  const body = page.locator("#new-issue-body");

  await dispatchFiles(page, "#new-issue-body", "paste", "pasted.png");
  await expect(body).toHaveValue(/!\[Uploading pasted\.png(?: #\d+)?\.\.\.\]/);
  await expect(body).toHaveValue(
    new RegExp(`!\\[pasted\\.png\\]\\(/api/projects/${projectId}/attachments/[0-9a-f-]+\\)`),
  );

  await dispatchFiles(page, "[data-attachment-dropzone]", "drop", "dropped.png");
  await expect(body).toHaveValue(
    new RegExp(`!\\[dropped\\.png\\]\\(/api/projects/${projectId}/attachments/[0-9a-f-]+\\)`),
  );

  await page.locator("[data-attach-bar] input[type=file]").setInputFiles({
    name: "picked.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(body).toHaveValue(
    new RegExp(`!\\[picked\\.png\\]\\(/api/projects/${projectId}/attachments/[0-9a-f-]+\\)`),
  );

  const markdown = await body.inputValue();
  const attachmentUrl = /\/api\/projects\/[^)]+\/attachments\/[0-9a-f-]+/.exec(markdown)?.[0];
  expect(attachmentUrl).toBeDefined();

  await body.fill(`${markdown}\n\n![tracker](https://example.com/pixel.png)`);
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.locator("img[data-orrery-attachment]").first()).toBeVisible();
  await expect(page.getByText("[image: tracker]")).toBeVisible();
  expect(await page.locator('img[src="https://example.com/pixel.png"]').count()).toBe(0);

  const served = await api.get(attachmentUrl!);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-disposition"]).toContain("inline");
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");
});

test("non-image attachments download with Content-Disposition attachment", async () => {
  const projectId = await newProject();
  const response = await api.post(`/api/projects/${projectId}/attachments`, {
    multipart: { file: { name: "build.log", mimeType: "text/plain", buffer: Buffer.from("ok\n") } },
  });
  expect(response.status()).toBe(201);
  const url = field(await response.json(), "downloadUrl");
  if (typeof url !== "string") throw new Error("missing downloadUrl");
  const served = await api.get(url);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-disposition"]).toContain("attachment");
  expect(served.headers()["x-content-type-options"]).toBe("nosniff");
});

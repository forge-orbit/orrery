import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_EMAIL as email, ADMIN_PASSWORD as password, recordSecret } from "./admin.ts";

const exec = promisify(execCallback);

const setupSecret = process.env.ORRERY_SETUP_SECRET ?? "";
const restartCommand = process.env.ORRERY_RESTART_CMD;

test.skip(!setupSecret, "Set ORRERY_SETUP_SECRET to the instance's BOOTSTRAP_SECRET.");

test.beforeAll(async () => {
  await recordSecret(setupSecret);
  await recordSecret(password);
  await recordSecret("definitely-not-the-secret");
});

async function fillSetupForm(page: Page, secret: string) {
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Set up Orrery" })).toBeVisible();
  await page.getByLabel("Setup secret").fill(secret);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(
    page.locator("footer[data-access-footer]").getByRole("link", { name: "Forge Orbit" }),
  ).toHaveAttribute("href", "https://github.com/forge-orbit");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  await expect(
    page
      .locator("[data-app-sidebar] footer[data-sidebar-footer]")
      .getByRole("link", { name: "Forge Orbit" }),
  ).toHaveAttribute("href", "https://github.com/forge-orbit");

  for (const cookie of await page.context().cookies()) {
    await recordSecret(cookie.value);
  }
}

test("follows the system and saves an explicit appearance choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/setup");
  const picker = page.getByRole("radiogroup", { name: "Appearance" });
  const canvas = page.locator("body");
  const darkCanvas = "rgb(17, 19, 24)";
  const lightCanvas = "rgb(255, 255, 255)";
  await expect(picker.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(canvas).toHaveCSS("background-color", darkCanvas);

  await page.emulateMedia({ colorScheme: "light" });
  await expect(canvas).toHaveCSS("background-color", lightCanvas);

  await picker.getByRole("radio", { name: "Dark" }).click();
  await expect(canvas).toHaveCSS("background-color", darkCanvas);
  await page.reload();
  await expect(picker.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(canvas).toHaveCSS("background-color", darkCanvas);

  await picker.getByRole("radio", { name: "System" }).click();
  await page.reload();
  await expect(picker.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(canvas).toHaveCSS("background-color", lightCanvas);
});

test("refuses a wrong setup secret in the browser", async ({ page }) => {
  await fillSetupForm(page, "definitely-not-the-secret");
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid setup secret.");

  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: false });
});

test("creates the first administrator and signs in", async ({ page }) => {
  await fillSetupForm(page, setupSecret);
  await page.getByRole("button", { name: "Create administrator" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: true });
  const second = await page.request.post("/api/setup/admin", {
    data: { secret: setupSecret, email: "second@example.com", password },
  });
  expect(second.status()).toBe(409);

  await signIn(page);
});

test("keeps setup closed and login working after a restart", async ({ page }) => {
  test.skip(
    !restartCommand,
    "Set ORRERY_RESTART_CMD to a command that restarts the server, for example " +
      "'docker compose -f <repo>/compose.yaml restart orrery'.",
  );

  await exec(restartCommand ?? "", { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get("/readyz")).ok();
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBeTruthy();

  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ setupComplete: true });
  const attempt = await page.request.post("/api/setup/admin", {
    data: { secret: setupSecret, email: "third@example.com", password },
  });
  expect(attempt.status()).toBe(409);

  await signIn(page);
});

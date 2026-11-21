import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./admin.ts";

test.describe.configure({ mode: "serial" });

test("updates display name from /account, switches light mode sidebar, and signs out", async ({
  page,
}) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-app-sidebar]")).toBeVisible();

  await page.locator("[data-app-sidebar] [data-sidebar-account-link]").click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  await page.getByLabel("Display name").fill("Admin Operator");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.locator("#content").getByText("Profile saved.")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText("Profile saved."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Admin Operator" })).toBeVisible();
  await expect(page.locator("[data-app-sidebar] [data-sidebar-account-name]")).toHaveText(
    "Admin Operator",
  );

  await page.getByLabel("Display name").fill("");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.locator("#content").getByText("Profile saved.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  await page.locator("[data-app-sidebar]").getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("[data-app-sidebar]")).not.toHaveCSS(
    "background-color",
    "rgb(26, 26, 28)",
  );

  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/signin/);
  const sessionAfter = await page.request.get("/api/auth/session");
  expect(sessionAfter.status()).toBe(401);
});

import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./admin.ts";

test("keeps the current password empty and locked until the user interacts", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("[data-app-sidebar]")).toBeVisible();

  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

  const current = page.locator("#account-current-password");
  const next = page.locator("#account-new-password");
  const confirm = page.locator("#account-confirm-password");

  await expect(current).toHaveValue("");
  await expect(current).toHaveAttribute("autocomplete", "one-time-code");
  await expect(current).toHaveAttribute("readonly", "");

  // Keyboard tabbing focuses the field and unlocks it for normal input.
  await page.getByRole("button", { name: "Save profile" }).focus();
  await page.keyboard.press("Tab");
  await expect(current).toBeFocused();
  await expect(current).not.toHaveAttribute("readonly", "");
  await expect(current).toBeEditable();

  // A reload starts locked and empty again, and a pointer press unlocks it.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(current).toHaveValue("");
  await expect(current).toHaveAttribute("readonly", "");
  await current.click();
  await expect(current).not.toHaveAttribute("readonly", "");
  await expect(current).toBeEditable();

  // Paste still lands in the field after it unlocks.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("not-the-current-password"));
  await page.keyboard.press("ControlOrMeta+V");
  await expect(current).toHaveValue("not-the-current-password");

  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  await page.keyboard.type("new-password-1234");

  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.type("different-password");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("New passwords do not match.")).toBeVisible();

  await confirm.fill("new-password-1234");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Current password is incorrect.")).toBeVisible();
});

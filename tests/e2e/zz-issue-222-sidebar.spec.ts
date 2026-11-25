import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./admin.ts";

test("removes the sidebar attribution and pins the mobile drawer footer", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(`Signed in as ${ADMIN_EMAIL}.`)).toBeVisible();

  const sidebarFooter = page.locator("[data-app-sidebar] footer[data-sidebar-footer]");
  await expect(sidebarFooter).toBeVisible();
  await expect(sidebarFooter.locator("[data-forge-orbit-attribution]")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();

  const drawer = page.locator("dialog[data-app-sidebar]");
  await expect(drawer).toBeVisible();
  const footer = drawer.locator("footer[data-sidebar-footer]");
  await expect(footer).toBeVisible();
  await expect(footer.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
  await expect(footer).toContainText(ADMIN_EMAIL);
  await expect(footer.getByRole("button", { name: "Sign out" })).toBeVisible();

  const content = drawer.locator("nav");
  const contentBox = await content.boundingBox();
  const footerBox = await footer.boundingBox();
  if (contentBox === null || footerBox === null)
    throw new Error("the mobile drawer did not lay out");

  // The footer sits at the drawer's bottom edge rather than under the nav items.
  expect(footerBox.y).toBeGreaterThan(contentBox.y + contentBox.height / 2);
  expect(contentBox.y + contentBox.height - (footerBox.y + footerBox.height)).toBeLessThan(24);
});

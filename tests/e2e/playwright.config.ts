import { defineConfig } from "@playwright/test";

const baseURL = process.env.ORRERY_URL;
if (!baseURL)
  throw new Error("Set ORRERY_URL to a running Orrery, for example http://localhost:8080");

export default defineConfig({
  testDir: ".",

  testMatch: "**/*.spec.ts",

  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    trace: process.env.CI ? "retain-on-failure" : "off",
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
  },
});

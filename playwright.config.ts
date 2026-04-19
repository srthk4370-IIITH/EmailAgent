import { defineConfig, devices } from "@playwright/test";

const PLAYWRIGHT_PORT = process.env.PLAYWRIGHT_PORT ?? "3100";
const PLAYWRIGHT_BASE_URL = `http://127.0.0.1:${PLAYWRIGHT_PORT}`;
const NEXT_DEV_BIN = "./node_modules/next/dist/bin/next";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: PLAYWRIGHT_BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `node ${NEXT_DEV_BIN} dev -p ${PLAYWRIGHT_PORT}`,
    url: PLAYWRIGHT_BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

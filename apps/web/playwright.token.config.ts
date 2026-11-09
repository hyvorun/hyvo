import { defineConfig } from "@playwright/test";

/**
 * The site as it is built once HYVO has launched: the same dev server as playwright.config.ts, with
 * a test address in VITE_HYVO_TOKEN_ADDRESS. It runs e2e/token-live.spec.ts alone, on a desktop and
 * a phone viewport; every other spec checks the build without a token.
 *
 *   pnpm exec playwright test -c playwright.token.config.ts
 */

/** E2E_TOKEN_PORT lets two checkouts of the repo run these tests at the same time. */
const PORT = Number(process.env.E2E_TOKEN_PORT ?? 5195);

/** A made-up address, checksummed, so the pages are seen to show it exactly as the build gives it. */
const HYVO_TOKEN = "0x4e70c0de4e70c0DE4e70c0De4E70C0de4E70c0de";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "token-live.spec.ts",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  /** What the spec reads to know it runs against this build (and skips itself under any other config). */
  metadata: { hyvoToken: HYVO_TOKEN },
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    env: { VITE_API_URL: "http://api.test", VITE_RPC_URLS: "http://rpc.test", VITE_HYVO_TOKEN_ADDRESS: HYVO_TOKEN },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

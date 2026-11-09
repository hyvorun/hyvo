import { defineConfig } from "@playwright/test";

/** Smoke tests against the golden run (fixtures/golden-run.json) on a desktop and a phone
 * viewport. The API (e2e/stub-api.ts), the chain and the wallet (e2e/stub-chain.ts) are stubbed
 * per test, so no Worker, RPC or wallet extension is needed. */

/** E2E_PORT lets two checkouts of the repo run their tests at the same time. */
const PORT = Number(process.env.E2E_PORT ?? 5174);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
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
    env: { VITE_API_URL: "http://api.test", VITE_RPC_URLS: "http://rpc.test" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

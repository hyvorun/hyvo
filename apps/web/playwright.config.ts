import { defineConfig } from "@playwright/test";

/** Smoke tests against the golden run (fixtures/golden-run.json) on a desktop and a phone
 * viewport. The API (e2e/stub-api.ts), the chain and the wallet (e2e/stub-chain.ts) are stubbed
 * per test, so no Worker, RPC or wallet extension is needed. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5174", trace: "retain-on-failure" },
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
    command: "pnpm exec vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    env: { VITE_API_URL: "http://api.test", VITE_RPC_URLS: "http://rpc.test" },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false, // the AI binding is stubbed in tests; nothing reaches Cloudflare
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          RUNNER_TOKEN: "test-runner-token",
          LLM_TOKEN: "test-llm-token",
          ARTIFACT_SIGNING_KEY: "test-artifact-signing-key",
        },
      },
    })),
  ],
  // The launch scripts' tests run in Node (`test:scripts`), not in the Workers pool.
  test: { setupFiles: ["./test/apply-migrations.ts"], exclude: [...configDefaults.exclude, "scripts/**"] },
});

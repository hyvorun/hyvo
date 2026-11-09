/**
 * The launch scripts' tests run in Node, not in the Workers runtime the API's own tests use: they write
 * temporary files and start anvil. `pnpm --filter @hyvo/api test` runs both; `test:scripts` runs these alone.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "packages/shared/src/**/*.ts",
        "packages/signal/src/**/*.ts",
        "packages/bot-sdk/src/**/*.ts",
        "packages/bots/*/src/**/*.ts",
        "apps/server/src/domain/**/*.ts"
      ],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/test-utils.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85
      }
    }
  }
});

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@coool/opencode-plugin-test": path.resolve(import.meta.dirname, "src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/types.ts"],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
      reporter: ["text", "json-summary"],
    },
    fileParallelism: false,
  },
});

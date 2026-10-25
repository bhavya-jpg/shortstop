import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "vendor/hmem/reference/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});

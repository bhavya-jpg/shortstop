import { defineConfig } from "vitest/config";

// Live tests call the real Zetaris and Nightshift services. Run: npm run test:live
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.ts"],
    environment: "node",
    testTimeout: 300_000,
    fileParallelism: false,
  },
});

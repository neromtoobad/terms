import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { SAMPLE_MODE: "true", TERMS_DATA: "data/runtime-vitest", LOG_LEVEL: "ERROR" },
    testTimeout: 60000,
    include: ["test/**/*.test.ts", "engines/*/test/**/*.test.ts"],
  },
});

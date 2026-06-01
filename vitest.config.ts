import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // Hook timeout 30s gives `cleanupTempConfig` enough headroom for
    // Node's `fs.rm({maxRetries: 10, retryDelay: 200})` (~11s ladder)
    // plus the EBUSY catch + stderr-log path in tests/helpers.ts. See
    // rmdirWithRetry doc for the Windows handle-release-race rationale.
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});

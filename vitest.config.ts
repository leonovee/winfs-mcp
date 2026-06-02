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
    // Vitest 4 removed `test.poolOptions`; pool-specific options are now
    // top-level. We only ever set `forks.singleFork: false`, which is the
    // default (isolated, multi-fork), so the block is dropped entirely.
    pool: "forks",
  },
});

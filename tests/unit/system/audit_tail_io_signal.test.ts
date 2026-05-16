import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { auditTailImpl } from "../../../src/tools/system/audit_tail.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * Kimi P2.2 — `fs.open` / `fs.realpath` / `fileHandle.read` don't honor
 * AbortSignal natively. On a roaming `%LOCALAPPDATA%` synced through
 * OneDrive (or any slow / network-backed disk) those operations can hang
 * past the runTool wrapper's deadline. The wrapper would log an
 * ETIMEDOUT, but the underlying I/O keeps the worker thread blocked.
 *
 * v0.3.2 wraps each fs op in an `abortable()` helper that races the op
 * against the wrapper's `AbortSignal`. When the signal fires before the
 * op resolves we surface ETIMEDOUT immediately; the in-flight op
 * continues but its result (if any) is discarded / cleaned up.
 *
 * Tested with a monkey-patched `fs.open` that delays 5 s before
 * delegating. With a 50 ms abort deadline, the impl must return a
 * structured ETIMEDOUT in well under 5 s.
 */
describe("tools/system/audit_tail — I/O honors AbortSignal (kimi P2.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("fast-firing abort surfaces ETIMEDOUT without waiting for slow fs.open", async () => {
    // Set up a real log so realpath / fstat would normally succeed quickly.
    await fs.mkdir(path.dirname(config.resolvedAuditLogPath), { recursive: true });
    await fs.writeFile(
      config.resolvedAuditLogPath,
      JSON.stringify({
        ts: "2026-05-16T00:00:00.000Z",
        tool: "read",
        args_summary: {},
        result_status: "ok",
        duration_ms: 1,
      }) + "\n",
      "utf8",
    );

    const origOpen = fs.open;
    (fs as unknown as { open: typeof origOpen }).open = (async (
      ...args: Parameters<typeof origOpen>
    ) => {
      // Sleep 5 s before delegating. The abortable wrapper around fs.open
      // should reject long before this resolves.
      await new Promise((r) => setTimeout(r, 5000));
      return origOpen.apply(fs, args);
    }) as typeof origOpen;

    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      const res = await auditTailImpl({ n: 5 }, config, controller.signal);
      const elapsed = Date.now() - started;

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected error");
      expect(res.error.code).toBe("ETIMEDOUT");
      // We must NOT have waited the full 5 s. Allow generous slack to
      // dampen CI jitter, but still well under the slow-fs.open delay.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      (fs as unknown as { open: typeof origOpen }).open = origOpen;
    }
  });
});

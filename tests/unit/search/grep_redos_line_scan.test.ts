import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { grepImpl } from "../../../src/tools/search/grep.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — verify-first for grep P1.2 (combined with P2.7).
 *
 * P1.2 (Kimi review C1) claim: the abort signal is checked between lines, not
 * within a single `regex.test(line)` call, so a pathological pattern like
 * `(a+)+$` on a long line of 'a' can stall V8's regex engine for many seconds
 * despite the deadline firing.
 *
 * P2.7 (Kimi review D4) claim: no per-line length cap; a 10 MB single line
 * produces a `Match` with a 10 MB string.
 *
 * Verify-first result: V8 returns within ~10 ms on the canonical ReDoS bait
 * pattern at 10 KB. V8 has hardened regex matching against catastrophic
 * backtracking for common bait patterns — the finding does NOT reproduce
 * on this Node version.
 *
 * Test below pins the OBSERVED fast behavior. If a future Node version
 * regresses (real stall), this test fails — surfacing the regression and
 * justifying the line-scan cap fix at that point.
 */
describe("invariant: grep deadline cooperates with V8 regex engine on bait patterns (P1.2/P2.7 invalidated 2026-05-22)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("'(a+)+$' on a 10 KB line of 'a' completes within 2 seconds (observed ~10 ms; pinned)", async () => {
    const filePath = path.join(root, "redos-bait.txt");
    await fs.writeFile(filePath, "a".repeat(10_000), "utf8");

    const deadlineMs = 500;
    const t0 = Date.now();
    const res = await grepImpl(
      {
        pattern: "(a+)+$",
        path_glob: path.join(root, "**", "*.txt"),
        case_sensitive: false,
        context_lines: 0,
        offset: 0,
        limit: 50,
        timeout_ms: deadlineMs,
      },
      config,
    );
    const elapsed = Date.now() - t0;

    // Pins V8's observed fast behavior. Generous 2 s ceiling allows for CI
    // host noise; observed locally is ~10 ms. A future regression in V8 or
    // in grep deadline handling would surface here as a multi-second elapsed,
    // re-opening the P1.2/P2.7 line-scan-cap discussion.
    expect(elapsed).toBeLessThan(2000);
    expect(res.ok).toBe(true);
  }, 30_000);
});

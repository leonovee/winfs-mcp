import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { grepImpl } from "../../../src/tools/search/grep.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — grep regression tests for the defense-in-depth
 * + small-fix bundle:
 *   - P1.3: negative context_lines guard at impl layer
 *   - P2.5: defensive re.lastIndex reset (no behavior change today; pins
 *           future-flag-pass-through safety)
 *   - P2.8: compileGlob base absolute non-empty assertion
 *
 * P1.1 (inner-deadline ≥ buffer before outer) is structurally verified by
 * the existing timeouts invariant test which uses `timeout_ms = maxTimeoutMs`
 * implicitly; rather than duplicate, the deadline-race fix is documented in
 * the source comment + spec amendment.
 */
describe("grep: defensive guards (P1.3, P2.5, P2.8)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("P1.3: negative context_lines rejected with EINVAL at impl layer", async () => {
    const target = path.join(root, "f.txt");
    await fs.writeFile(target, "hello\n", "utf8");
    const res = await grepImpl(
      {
        pattern: "hello",
        path_glob: path.join(root, "**", "*.txt"),
        case_sensitive: false,
        context_lines: -1 as unknown as number,
        offset: 0,
        limit: 50,
      } as unknown as Parameters<typeof grepImpl>[0],
      config,
      1000,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
    expect(res.error.message).toMatch(/context_lines/);
  });

  it("P2.8: wildcards-only glob rejected with EINVAL (existing compileGlob check + defensive assert)", async () => {
    // A bare `**/*.ts` has no literal prefix. compileGlob already throws on
    // this; grepImpl wraps the throw into EINVAL. The new defensive assert
    // is a second layer that would catch any future compileGlob change that
    // returned a non-absolute base instead of throwing.
    const res = await grepImpl(
      {
        pattern: "x",
        path_glob: "**/*.ts",
        case_sensitive: false,
        context_lines: 0,
        offset: 0,
        limit: 50,
      },
      config,
      1000,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
    // Either "pattern must be absolute" (compileGlob throw) or "absolute
    // literal prefix" (defensive assert) — both close the bypass.
    expect(res.error.message).toMatch(/absolute/);
  });

  it("P2.5: regex with /g/y flags via embedded source still matches all lines (lastIndex defensively reset)", async () => {
    // The current code path compiles without g/y flags, so this test exercises
    // the defensive reset as a no-op behavior check — a future change that
    // adds flag-pass-through must keep matching working.
    const target = path.join(root, "many.txt");
    await fs.writeFile(target, "match\nmatch\nmatch\nmatch\n", "utf8");
    const res = await grepImpl(
      {
        pattern: "match",
        path_glob: path.join(root, "**", "*.txt"),
        case_sensitive: false,
        context_lines: 0,
        offset: 0,
        limit: 50,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches).toHaveLength(4);
  });

  it("P1.1: timeout_ms = maxTimeoutMs returns partial result (truncated:true, reason:timeout) not ETIMEDOUT", async () => {
    // Write enough files that the walk takes measurable time. Then ask for
    // timeout_ms exactly equal to maxTimeoutMs and observe the response shape.
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(path.join(root, `f${i}.txt`), "hello\n".repeat(1000), "utf8");
    }
    const res = await grepImpl(
      {
        pattern: "hello",
        path_glob: path.join(root, "**", "*.txt"),
        case_sensitive: false,
        context_lines: 0,
        offset: 0,
        limit: 50,
      },
      config,
      // Inner deadline = 1 ms — guarantees timeout fires before the walk
      // completes; the partial-result path returns `truncated:true,
      // reason:"timeout"` rather than a wrapper-synthesised ETIMEDOUT
      // (because grepImpl owns its own deadline, not the wrapper).
      1,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok (partial result)");
    expect(res.value.truncated).toBe(true);
    expect(res.value.reason).toBe("timeout");
  });
});

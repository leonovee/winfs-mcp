import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkExecBlocklist } from "../../../src/core/exec_safety.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — verify-first for execute_command P1.2.
 *
 * P1.2 (Gemini-substituted Q3b): the `rm` blocklist pattern is `rm\s.*-rf`,
 * which requires the literal combined flag `-rf`. PowerShell aliases `rm`
 * for `Remove-Item`, and PowerShell accepts unambiguous prefixes of long
 * parameter names. So `rm -r C:\foo`, `rm -R C:\foo`, and `rm -Recurse C:\foo`
 * are all valid recursive-delete commands that the current pattern does NOT
 * catch.
 *
 * Gemini-only finding. Verify-first: prove the bypass before patching.
 */
describe("verify-first: execute_command blocklist rm short-flag bypass (P1.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("sanity: 'rm -rf C:\\foo' IS blocked (combined flag matches existing pattern)", () => {
    const blocked = checkExecBlocklist("rm -rf C:\\foo", config);
    expect(blocked).toBeDefined();
    expect(blocked?.error.code).toBe("EBLOCKED");
  });

  // Assertions below state POST-FIX behavior — these MUST be blocked.
  // Currently they fail; that's the verify-first signal. After Phase 2 fix
  // they become regression cover.

  it("'rm -r C:\\foo' (short recursive flag) MUST be blocked (P1.2 — currently fails)", () => {
    const blocked = checkExecBlocklist("rm -r C:\\foo", config);
    expect(blocked).toBeDefined();
    expect(blocked?.error.code).toBe("EBLOCKED");
  });

  it("'rm -R C:\\foo' (capital R) MUST be blocked (P1.2 — currently fails)", () => {
    const blocked = checkExecBlocklist("rm -R C:\\foo", config);
    expect(blocked).toBeDefined();
  });

  it("'rm -Recurse C:\\foo' (full PowerShell long flag) MUST be blocked (P1.2 — currently fails)", () => {
    const blocked = checkExecBlocklist("rm -Recurse C:\\foo", config);
    expect(blocked).toBeDefined();
  });

  it("sanity: 'rm C:\\foo' (no recursive flag) stays unblocked — single-file delete is OK", () => {
    const blocked = checkExecBlocklist("rm C:\\foo", config);
    expect(blocked).toBeUndefined();
  });
});

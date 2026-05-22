import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkExecBlocklist } from "../../../src/core/exec_safety.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — verify-first for execute_command P1.1.
 *
 * P1.1 (Gemini-substituted Q3a): `powershell -EncodedCommand <base64>` lets
 * the caller smuggle a base64-encoded payload past the blocklist. Even if
 * the decoded payload would be `Remove-Item -Recurse C:\`, the composed
 * string seen by the blocklist contains only the base64 — none of the
 * destructive-verb patterns match.
 *
 * Gemini's finding is single-source (substituted), so the wave's verify-first
 * rule requires we PROVE the bypass before patching. If checkExecBlocklist
 * returns undefined for the encoded-command payload, the bypass is real.
 */
describe("verify-first: execute_command blocklist -EncodedCommand bypass (P1.1)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("sanity: literal 'Remove-Item -Recurse C:\\foo' IS blocked", () => {
    const composed = "Remove-Item -Recurse C:\\foo";
    const blocked = checkExecBlocklist(composed, config);
    expect(blocked).toBeDefined();
    expect(blocked?.error.code).toBe("EBLOCKED");
  });

  // Assertions below state POST-FIX behavior (the blocklist SHOULD catch
  // these). Currently they fail — that's the verify-first signal. After the
  // Phase 2 fix lands the tests pass as regression cover.

  it("powershell -EncodedCommand <b64> MUST be blocked (P1.1 — currently fails)", () => {
    const payload = "Remove-Item -Recurse C:\\Windows\\nonexistent";
    const b64 = Buffer.from(payload, "utf16le").toString("base64");
    const composed = `powershell -EncodedCommand ${b64}`;
    const blocked = checkExecBlocklist(composed, config);
    expect(blocked).toBeDefined();
    expect(blocked?.error.code).toBe("EBLOCKED");
  });

  it("powershell -e <b64> short form MUST be blocked (P1.1 — currently fails)", () => {
    const payload = "Remove-Item -Recurse C:\\foo";
    const b64 = Buffer.from(payload, "utf16le").toString("base64");
    const composed = `powershell -e ${b64}`;
    const blocked = checkExecBlocklist(composed, config);
    expect(blocked).toBeDefined();
    expect(blocked?.error.code).toBe("EBLOCKED");
  });

  it("powershell -EncodedC <b64> medium-prefix form MUST be blocked (P1.1)", () => {
    const payload = "Remove-Item -Recurse C:\\foo";
    const b64 = Buffer.from(payload, "utf16le").toString("base64");
    const composed = `powershell -EncodedC ${b64}`;
    const blocked = checkExecBlocklist(composed, config);
    expect(blocked).toBeDefined();
  });

  it("powershell -Command 'Get-Date' stays unblocked (sanity — only encoded forms blocked)", () => {
    const blocked = checkExecBlocklist("powershell -Command 'Get-Date'", config);
    expect(blocked).toBeUndefined();
  });
});

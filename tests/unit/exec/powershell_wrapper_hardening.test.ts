import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeCommandImpl } from "../../../src/tools/exec/execute_command.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7.2 — PowerShell wrapper hardening (H2 from the v0.7.1 hotfix prompt).
 *
 * Pins the wrapper contract:
 *  - UTF-8 stdout: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;`
 *    is injected at the start of the composed command so non-ASCII output is
 *    not mangled by the system OEM code page.
 *  - Exit-code propagation: `; exit $LASTEXITCODE` is appended so external
 *    command exit codes survive even when other PowerShell statements
 *    follow them in the same composed command (today the composed command
 *    has just one statement, but future composed shapes might not).
 *  - -OutputFormat Text + -InputFormat None: belt-and-suspenders against
 *    CLIXML leakage on stdout and stdin-deadlock waiting for input.
 *
 * The wrapper additions are defensive — bug #2 from handoff #1 (the
 * "execute_command silent-output" operational note) does not reproduce at
 * the server source-code layer (see stdout_capture.regression.test.ts).
 * These tests pin the H2 hardening contracts so any future change that
 * breaks them is caught immediately.
 */
describe("v0.7.2: PowerShell wrapper hardening", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("UTF-8 stdout: Write-Output with non-ASCII characters captures correctly", async () => {
    // Write-Output a string with Cyrillic + emoji-adjacent BMP characters.
    // Without [Console]::OutputEncoding = UTF8 these get encoded via the
    // system OEM code page (often 1252 or 437) and decode garbled when
    // tryDecodeUtf8Strict runs — surfacing as either mojibake or EENCODING.
    const res = await executeCommandImpl(
      { command: "Write-Output 'привет мир ✓'", args: [], cwd: root, timeout_ms: 10000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toContain("привет мир");
    expect(res.value.stdout).toContain("✓");
  }, 30_000);

  it("exit-code propagation: `exit 7` preserved through the wrapper suffix", async () => {
    const res = await executeCommandImpl(
      { command: "exit 7", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(7);
  }, 30_000);

  it("exit-code propagation: external command failure surfaces non-zero exit code", async () => {
    // node exits non-zero on syntax error inside -e script
    const res = await executeCommandImpl(
      { command: "node -e \"process.exit(42)\"", args: [], cwd: root, timeout_ms: 10000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(42);
  }, 30_000);

  it("cmdlet-only path: Get-Date exits 0 even with exit $LASTEXITCODE suffix", async () => {
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout.length).toBeGreaterThan(0);
  }, 30_000);

  it("multi-statement composed command: last external exit code propagates", async () => {
    // Two statements: first an external exe that succeeds, then a cmdlet.
    // Without `exit $LASTEXITCODE`, PowerShell's process exit code would
    // be 0 (last statement is a cmdlet that succeeded). With the suffix,
    // exit code = $LASTEXITCODE = 0 (set by the prior successful external).
    // We're pinning that the exit code IS 0 in the happy case — not the
    // far-edge case where a cmdlet runs after a failing external (PowerShell
    // semantics would still surface 0 in that combination, which is a
    // separate concern from this wrap).
    const res = await executeCommandImpl(
      { command: "node --version; Get-Date", args: [], cwd: root, timeout_ms: 10000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toMatch(/v\d+\.\d+\.\d+/);
  }, 30_000);

  it("no stdin-deadlock: `& 'node' -e ...` completes without waiting for input", async () => {
    // Pre-fix the prompt's H2 cited stdin-deadlock as one of the suspected
    // root causes. With -InputFormat None set, PowerShell does not try to
    // read stdin even if a child does — so this should complete in well
    // under the deadline. If the test times out, the deadlock is back.
    const t0 = Date.now();
    const res = await executeCommandImpl(
      {
        command: "& 'node' -e \"console.log('alive')\"",
        args: [],
        cwd: root,
        timeout_ms: 5000,
      },
      config,
    );
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toContain("alive");
    expect(elapsed).toBeLessThan(3000);
  }, 30_000);
});

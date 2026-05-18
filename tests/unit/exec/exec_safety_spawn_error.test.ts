import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSubprocess } from "../../../src/core/exec_safety.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.5.x latent regression surfaced by v0.6 smoke (probe §2 #25 run_python).
 *
 * `spawnSubprocess` previously had `child.on("error", () => onSettle(null))`
 * which swallowed async spawn failures (typical case on Windows: executable
 * not on the sanitized PATH — Node emits an `error` event asynchronously
 * with `.code === "ENOENT"` rather than throwing synchronously from
 * `spawn()`). The result resolved with `spawnFailed: false`, `exitCode:
 * null`, empty stdout/stderr — the caller (run_python / execute_command /
 * find_command) couldn't distinguish "process started + exited cleanly with
 * no output" from "process never started".
 *
 * Fix: capture the async error in a local var and pass it through to
 * onSettle so `spawnFailed: true` + `spawnErrorCode` + `spawnErrorMessage`
 * are surfaced consistently with the synchronous-throw path.
 */
describe("invariant: spawnSubprocess surfaces async spawn errors (v0.6 smoke regression)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("non-existent binary → spawnFailed:true with ENOENT (not vacuous exit_code:null)", async () => {
    const result = await spawnSubprocess({
      bin: "definitely-not-a-real-binary-987654321.exe",
      args: ["--whatever"],
      cwd: root,
      deadlineMs: 5000,
      maxOutputBytes: 16 * 1024,
      config,
    });
    expect(result.spawnFailed).toBe(true);
    expect(result.spawnErrorCode).toBe("ENOENT");
    expect(typeof result.spawnErrorMessage).toBe("string");
    expect(result.spawnErrorMessage).toMatch(/ENOENT|spawn/i);
    // The vacuous-success contract gap: pre-fix this would resolve with
    // exitCode: null + spawnFailed: false. Now exitCode is null but
    // spawnFailed: true so callers (run_python) correctly map to
    // EPYTHONNOTFOUND / EIO instead of returning empty success.
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("successful spawn still resolves with spawnFailed:false (no false positive)", async () => {
    // Use a binary guaranteed present on the sanitized PATH: cmd.exe (Windows)
    // or `true` (POSIX). On Windows, cmd.exe is in System32 which is in the
    // sanitized PATH.
    const bin =
      process.platform === "win32"
        ? "cmd.exe"
        : "true";
    const args = process.platform === "win32" ? ["/c", "exit 0"] : [];
    const result = await spawnSubprocess({
      bin,
      args,
      cwd: root,
      deadlineMs: 5000,
      maxOutputBytes: 16 * 1024,
      config,
    });
    expect(result.spawnFailed).toBe(false);
    expect(result.spawnErrorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

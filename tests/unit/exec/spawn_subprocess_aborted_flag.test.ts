import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSubprocess } from "../../../src/core/exec_safety.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — execute_command P1.3 regression test.
 *
 * Gemini-substituted finding: SpawnSubprocessResult had no `aborted` field.
 * A caller-initiated abort produced exit_code: null indistinguishable from
 * a clean no-output exit. Fix adds `aborted: boolean` field set by the
 * onAbort handler (and false otherwise).
 *
 * The narrow pid-undefined race fix (kill in the `spawn` event when abort
 * arrived first) is structural — not deterministically testable without
 * heavy timing mocks. Spec amendment §AA documents it.
 */
describe("core/exec_safety: spawnSubprocess aborted flag (P1.3)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("aborted: false on a clean exit", async () => {
    const res = await spawnSubprocess({
      bin: process.platform === "win32" ? "powershell.exe" : "echo",
      args: process.platform === "win32" ? ["-NoProfile", "-Command", "exit 0"] : ["hello"],
      cwd: root,
      deadlineMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      config,
    });
    expect(res.aborted).toBe(false);
  });

  it("aborted: true when caller-supplied signal fires mid-execution", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const res = await spawnSubprocess({
      bin: process.platform === "win32" ? "powershell.exe" : "sleep",
      args:
        process.platform === "win32"
          ? ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
          : ["5"],
      cwd: root,
      deadlineMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      config,
      signal: controller.signal,
    });
    expect(res.aborted).toBe(true);
    // exit_code from a SIGTERM-then-SIGKILL kill on Windows is typically
    // null (killed before normal exit). On POSIX it may be the signal
    // exit code. Either way the aborted flag distinguishes the path.
  }, 30_000);

  it("aborted: false on a deadline-timeout (timed_out flag covers that case)", async () => {
    const res = await spawnSubprocess({
      bin: process.platform === "win32" ? "powershell.exe" : "sleep",
      args:
        process.platform === "win32"
          ? ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
          : ["5"],
      cwd: root,
      deadlineMs: 200,
      maxOutputBytes: 1024 * 1024,
      config,
    });
    expect(res.timedOut).toBe(true);
    expect(res.aborted).toBe(false);
  }, 30_000);
});

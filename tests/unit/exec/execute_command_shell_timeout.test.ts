import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeCommandImpl } from "../../../src/tools/exec/execute_command.js";
import * as execSafety from "../../../src/core/exec_safety.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

// Phase B: execute_command's one-shot deadline must come from the SHELL
// timeout pair (shellTimeoutMs / shellMaxTimeoutMs), not the general
// defaultTimeoutMs / maxTimeoutMs pair. We assert the deadlineMs handed to
// spawnSubprocess (spied via the namespace object, which is exactly why
// execute_command dispatches through `execSafety.spawnSubprocess`).

function fakeSpawnResult(): execSafety.SpawnSubprocessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: 1,
    spawnFailed: false,
    aborted: false,
  };
}

describe("tools/exec/execute_command shell-timeout wiring (Phase B)", { timeout: 30_000 }, () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempConfig(root);
  });

  it("default deadline uses shellTimeoutMs, not defaultTimeoutMs", async () => {
    config.defaultTimeoutMs = 10_000;
    config.maxTimeoutMs = 60_000;
    config.shellTimeoutMs = 30_000;
    config.shellMaxTimeoutMs = 300_000;
    const spy = vi
      .spyOn(execSafety, "spawnSubprocess")
      .mockResolvedValue(fakeSpawnResult());
    await executeCommandImpl({ command: "echo hi", args: [], cwd: root }, config);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 30_000 }),
    );
  });

  it("honors a timeout_ms above maxTimeoutMs when below shellMaxTimeoutMs", async () => {
    config.maxTimeoutMs = 60_000; // general ceiling (must NOT clamp here)
    config.shellTimeoutMs = 30_000;
    config.shellMaxTimeoutMs = 120_000; // shell ceiling
    const spy = vi
      .spyOn(execSafety, "spawnSubprocess")
      .mockResolvedValue(fakeSpawnResult());
    await executeCommandImpl(
      { command: "echo hi", args: [], cwd: root, timeout_ms: 90_000 },
      config,
    );
    // 90s is under the 120s shell ceiling → honored. Under the old general
    // pair it would have been clamped to maxTimeoutMs=60s.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 90_000 }),
    );
  });

  it("clamps a timeout_ms above shellMaxTimeoutMs to shellMaxTimeoutMs", async () => {
    config.shellTimeoutMs = 30_000;
    config.shellMaxTimeoutMs = 120_000;
    const spy = vi
      .spyOn(execSafety, "spawnSubprocess")
      .mockResolvedValue(fakeSpawnResult());
    await executeCommandImpl(
      { command: "echo hi", args: [], cwd: root, timeout_ms: 999_999 },
      config,
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 120_000 }),
    );
  });
});

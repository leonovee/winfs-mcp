import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeCommandImpl } from "../../../src/tools/exec/execute_command.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";
import * as execSafety from "../../../src/core/exec_safety.js";

/**
 * v0.7 wave 2a: execute_command attaches diagnostic hints when stderr
 * matches a known cryptic-failure pattern. First entry in the registry:
 * PowerShell's "Cannot run a document in the middle of a pipeline" error
 * (raw output is technically accurate but unhelpful to agents).
 *
 * Tests mock spawnSubprocess so we can drive stderr directly without
 * needing PowerShell to actually fail this way.
 */
describe("tools/exec/execute_command — hints registry (v0.7 wave 2a)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
    vi.restoreAllMocks();
  });

  function mockSpawn(stderr: string, stdout = ""): void {
    vi.spyOn(execSafety, "spawnSubprocess").mockResolvedValue({
      stdout,
      stderr,
      exitCode: 1,
      timedOut: false,
      truncatedStdout: false,
      truncatedStderr: false,
      durationMs: 5,
      spawnFailed: false,
    });
  }

  it("attaches the PowerShell-document-in-pipeline hint when stderr matches", async () => {
    mockSpawn(
      "ssh.exe : Cannot run a document in the middle of a pipeline\nAt line:1 char:1",
    );
    const res = await executeCommandImpl(
      { command: "ssh user@host whoami", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.hints).toBeDefined();
    expect(res.value.hints).toHaveLength(1);
    expect(res.value.hints![0]).toMatch(/PowerShell/i);
    expect(res.value.hints![0]).toMatch(/PATHEXT|cmd|full path/i);
    // Raw stderr is preserved verbatim — hints do not mutate it.
    expect(res.value.stderr).toMatch(/Cannot run a document in the middle of a pipeline/);
  });

  it("match is case-insensitive and substring-anchored", async () => {
    mockSpawn(
      "  garbage prefix CANNOT RUN A DOCUMENT IN THE MIDDLE OF A PIPELINE more garbage",
    );
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.hints).toHaveLength(1);
  });

  it("no hint when stderr does not match the registry", async () => {
    mockSpawn("some other error\n");
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Absent is the chosen convention (cleaner than empty array).
    expect(res.value.hints).toBeUndefined();
  });

  it("no hint when stderr is empty", async () => {
    mockSpawn("", "some stdout");
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.hints).toBeUndefined();
  });
});

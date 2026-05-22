import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { executeCommandImpl } from "../../../src/tools/exec/execute_command.js";
import { readImpl } from "../../../src/tools/fs/read.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — bug #1 reproducer.
 *
 * Empirical observation (this session + parallel ai-judge session): after
 * execute_command returns EPERM_ROOT for an outside-roots cwd, subsequent
 * winfs tool calls hang for ~4 minutes before Claude Desktop times the
 * MCP transport out.
 *
 * Hypothesis A (prompt): resource leak in execute_command error path
 * (orphan child_process, leaked AbortSignal listener, etc.).
 *
 * Hypothesis B (alternative): the hang is in the MCP transport layer
 * itself, NOT in winfs server code. EPERM_ROOT correlates because of
 * timing, not causation.
 *
 * This test exercises the in-process impls directly — no MCP transport.
 * If it passes (second call returns fast), bug is NOT in winfs server
 * code and hypothesis B is supported. If it fails (second call hangs
 * or times out), bug IS in winfs code and hypothesis A is supported.
 *
 * Wall-clock budget: 5 seconds. EPERM_ROOT should return in ms; read of
 * a small file should return in ms; total well under 1s. Anything ≥ 1s
 * is the bug.
 */
describe("invariant: EPERM_ROOT on execute_command must not stall subsequent tool calls (bug #1)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("EPERM_ROOT on execute_command then read returns within 1 second", async () => {
    const target = path.join(root, "after.txt");
    await fs.writeFile(target, "hello after", "utf8");

    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const err = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: outside, timeout_ms: 5000 },
      config,
    );
    expect(err.ok).toBe(false);
    if (err.ok) throw new Error("expected EPERM_ROOT");
    expect(err.error.code).toBe("EPERM_ROOT");

    const t0 = Date.now();
    const r = await readImpl({ path: target }, config);
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok read");
    expect(r.value.content).toBe("hello after");

    // The bug, if real, would manifest as elapsed >> 1000 ms (the prompt
    // describes a 4-minute hang). 1000 ms gives a comfortable margin for
    // CI noise on slow Windows hosts while still catching a real hang.
    expect(elapsed).toBeLessThan(1000);
  });

  it("EPERM_ROOT on execute_command then another execute_command returns within 2 seconds", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const err = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: outside, timeout_ms: 5000 },
      config,
    );
    expect(err.ok).toBe(false);

    const t0 = Date.now();
    const ok = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    const elapsed = Date.now() - t0;

    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok execute_command");
    // Second execute_command (real spawn) needs more headroom for PowerShell
    // startup on Windows. Anything > 2s is the bug.
    expect(elapsed).toBeLessThan(2000);
  });
});

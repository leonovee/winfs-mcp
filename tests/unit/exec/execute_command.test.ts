import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { executeCommandImpl } from "../../../src/tools/exec/execute_command.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/exec/execute_command", { timeout: 60_000 }, () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("happy: runs `Get-Date` and returns non-empty stdout, exit_code 0", async () => {
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 10000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout.length).toBeGreaterThan(0);
    expect(res.value.truncated_stdout).toBe(false);
    expect(res.value.timed_out).toBe(false);
  });

  it("EBLOCKED on a blocklist hit (Remove-Item -Recurse)", async () => {
    const res = await executeCommandImpl(
      { command: "Remove-Item -Recurse C:\\important", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EBLOCKED");
    expect(res.error.details?.pattern).toMatch(/Remove-Item/);
  });

  it("EPERM_ROOT when cwd is outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: outside, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("non-zero exit_code preserved (returns exit 7)", async () => {
    const res = await executeCommandImpl(
      { command: "exit 7", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(7);
  });

  it("timed_out:true surfaced with truncated output, no error", async () => {
    const res = await executeCommandImpl(
      { command: "Start-Sleep -Seconds 30", args: [], cwd: root, timeout_ms: 500 },
      config,
    );
    // execute_command surfaces timeout as a flag, not an error, so caller
    // receives partial diagnostics (per design).
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.timed_out).toBe(true);
  });

  it("cwd resolves under realpath then validates against allowedRoots", async () => {
    // Pass a subdirectory of root explicitly.
    const sub = path.join(root, "subdir");
    const { promises: fs } = await import("node:fs");
    await fs.mkdir(sub);
    const res = await executeCommandImpl(
      { command: "Get-Location", args: [], cwd: sub, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
  });
});

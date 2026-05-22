import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeCommandImpl } from "../../../src/tools/exec/execute_command.js";
import { startProcessImpl } from "../../../src/tools/system/start_process.js";
import { interactImpl } from "../../../src/tools/system/interact.js";
import { ProcessRegistry } from "../../../src/core/process_registry.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7.1 hotfix — bug #2 since project start (operational note in CLAUDE.md
 * across v0.5.1 → v0.6 → v0.7 without a fix until now).
 *
 * Symptom: execute_command runs an external .exe via the PowerShell wrapper
 * (`powershell.exe -NoProfile -NonInteractive -Command <composed>`) and the
 * .exe runs (exit code 0, normal duration) but stdout/stderr arrive empty
 * in the response envelope.
 *
 * start_process (wave 2b) uses a different code path — direct child_process.spawn
 * against argv[0] with shell:false — and captures stdout correctly. The
 * comparison test below proves the divergence.
 *
 * If A1's tests fail (empty stdout) AND A2's start_process test passes, the
 * bug is isolated to exec_safety::spawnSubprocess called from execute_command.
 */
describe("v0.7.1 regression: execute_command stdout capture (bug #2 since project start)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  // ── A1: reproducer tests against execute_command ─────────────────────────

  it("A1.1: execute_command captures stdout from `node --version`", async () => {
    const res = await executeCommandImpl(
      { command: "node", args: ["--version"], cwd: root, timeout_ms: 10000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toMatch(/^v\d+\.\d+\.\d+/);
  }, 30_000);

  it("A1.2: execute_command captures stdout from direct git path", async () => {
    const res = await executeCommandImpl(
      {
        command: "& 'C:\\Program Files\\Git\\cmd\\git.exe' --version",
        args: [],
        cwd: root,
        timeout_ms: 10000,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toMatch(/^git version /);
  }, 30_000);

  it("A1.3: execute_command captures stdout from a PowerShell cmdlet (Get-Date)", async () => {
    // Pre-existing test asserts this works. Pin it here too as part of the
    // regression suite so any fix that breaks cmdlet output capture is
    // caught immediately.
    const res = await executeCommandImpl(
      { command: "Get-Date", args: [], cwd: root, timeout_ms: 10000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout.length).toBeGreaterThan(0);
  }, 30_000);

  // ── A2: parallel comparison via start_process ────────────────────────────

  it("A2: start_process captures `node --version` correctly (cross-pipeline comparison)", async () => {
    const reg = new ProcessRegistry(config);
    const spawn = await startProcessImpl(
      { command: ["node", "--version"], cwd: root, timeout_seconds: 10 },
      config,
      reg,
    );
    expect(spawn.ok).toBe(true);
    if (!spawn.ok) throw new Error("expected ok");
    const sid = spawn.value.session_id;

    // Poll up to ~5 s for settle.
    let settled = false;
    let stdoutSeen = "";
    let off = 0;
    for (let i = 0; i < 25 && !settled; i++) {
      const r = await interactImpl(
        { session_id: sid, stdout_since: off, stderr_since: 0, max_wait_ms: 500 },
        reg,
      );
      if (!r.ok) throw new Error(`interact failed: ${r.error.code}`);
      if (r.value.stdout) stdoutSeen += r.value.stdout;
      if (typeof r.value.stdout_offset === "number") off = r.value.stdout_offset;
      if (r.value.status && r.value.status !== "running") {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    expect(stdoutSeen).toMatch(/^v\d+\.\d+\.\d+/);

    await reg.shutdown();
  }, 30_000);
});

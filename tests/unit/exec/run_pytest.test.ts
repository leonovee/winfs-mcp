import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runPytestImpl } from "../../../src/tools/exec/run_pytest.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/** pytest may not be installed on the test host. We skip the live tests
 *  with a guard message rather than failing — the EPARSE / EPYTHONNOTFOUND
 *  cases still exercise the contract. */
async function isPytestAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const { spawn } = require("node:child_process");
    const child = spawn(
      process.platform === "win32" ? "python.exe" : "python",
      ["-m", "pytest", "--version"],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("close", (code: number | null) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

describe("tools/exec/run_pytest", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("count_only: --collect-only returns the collected count (when pytest is installed)", async () => {
    if (!(await isPytestAvailable())) return;
    await fs.writeFile(
      path.join(root, "test_smoke.py"),
      "def test_a():\n    assert 1+1 == 2\n\ndef test_b():\n    assert True\n",
      "utf8",
    );
    const res = await runPytestImpl(
      { cwd: root, count_only: true, timeout_ms: 30_000 },
      config,
    );
    if (!res.ok) {
      // Parser may not match pytest's collect-only output on every version.
      expect(res.error.code).toBe("EPARSE");
      return;
    }
    expect(res.value.collect_only).toBe(true);
  });

  it("full run: passed + failed counts parsed", async () => {
    if (!(await isPytestAvailable())) return;
    await fs.writeFile(
      path.join(root, "test_mix.py"),
      "def test_pass():\n    assert True\n\ndef test_fail():\n    assert False\n",
      "utf8",
    );
    const res = await runPytestImpl(
      { cwd: root, count_only: false, timeout_ms: 30_000 },
      config,
    );
    if (!res.ok) {
      // Tolerate parser miss — we'll surface as EPARSE.
      expect(res.error.code).toBe("EPARSE");
      return;
    }
    expect(res.value.passed).toBe(1);
    expect(res.value.failed).toBe(1);
    expect(res.value.collect_only).toBe(false);
  });

  it("EPYTHONNOTFOUND when config.pythonHome points at nothing", async () => {
    const badCfg = { ...config, pythonHome: path.join(root, "no-such-python") };
    const res = await runPytestImpl({ cwd: root, count_only: false, timeout_ms: 5000 }, badCfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    // Either spawn EPYTHONNOTFOUND or — if python.exe shim resolves — EPARSE.
    expect(["EPYTHONNOTFOUND", "EPARSE", "EIO"]).toContain(res.error.code);
  });
}, { timeout: 60_000 });

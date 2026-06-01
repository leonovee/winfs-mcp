import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolvePowershellBin,
  resetPowershellResolverCache,
} from "../../../src/core/powershell_resolver.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.9.1 Phase B — PowerShell binary resolution.
 *
 * Priority order (per resolver):
 *   1. config.powershellExePath if set and exists
 *   2. pwsh.exe (PS 7+) via `where pwsh` (skip WindowsApps shim)
 *   3. powershell.exe (PS 5.1) as Windows fallback
 *   4. "pwsh" string on POSIX
 *
 * Cache must be reset between tests to re-probe.
 */
describe("core/powershell_resolver", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    resetPowershellResolverCache();
  });

  afterEach(async () => {
    resetPowershellResolverCache();
    await cleanupTempConfig(root);
  });

  it("honors explicit config.powershellExePath when the file exists", async () => {
    const fakeBin = path.join(root, "fake-ps.exe");
    await fs.writeFile(fakeBin, "");
    const cfg: ResolvedConfig = { ...config, powershellExePath: fakeBin };
    expect(resolvePowershellBin(cfg)).toBe(fakeBin);
  });

  it("falls through when config.powershellExePath is set but missing", async () => {
    const missing = path.join(root, "does-not-exist-9999.exe");
    const cfg: ResolvedConfig = { ...config, powershellExePath: missing };
    const resolved = resolvePowershellBin(cfg);
    // Should be either an absolute pwsh path or "powershell.exe" fallback.
    if (process.platform === "win32") {
      expect(resolved.endsWith("pwsh.exe") || resolved === "powershell.exe").toBe(true);
    } else {
      expect(resolved).toBe("pwsh");
    }
  });

  it("auto-detects without explicit override (returns pwsh.exe path or powershell.exe fallback on Windows)", () => {
    const resolved = resolvePowershellBin(config);
    if (process.platform === "win32") {
      // Either a pwsh.exe path or the powershell.exe fallback.
      expect(resolved.endsWith("pwsh.exe") || resolved === "powershell.exe").toBe(true);
    } else {
      expect(resolved).toBe("pwsh");
    }
  });

  it("caches resolution between calls (second call doesn't re-probe)", () => {
    const first = resolvePowershellBin(config);
    const second = resolvePowershellBin(config);
    expect(second).toBe(first);
  });

  it("never returns the Microsoft Store WindowsApps shim", () => {
    const resolved = resolvePowershellBin(config);
    expect(/\\WindowsApps\\/i.test(resolved)).toBe(false);
  });
});

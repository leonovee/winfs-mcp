import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ResolvedConfig } from "./config.js";
import { STANDARD_WINDOWS_PATHEXT } from "./exec_safety.js";

/**
 * v0.9.1 Phase B — central PowerShell binary resolution.
 *
 * Priority order:
 *   1. `config.powershellExePath` — explicit override; if set and exists,
 *      use it. If set but missing, warn to stderr and fall through.
 *   2. `pwsh.exe` (PowerShell 7+) — probed via `where pwsh` on Windows.
 *      The first hit that exists and is NOT the Microsoft Store shim
 *      (`WindowsApps\pwsh.exe`) wins.
 *   3. `powershell.exe` (Windows PowerShell 5.1) — final Windows fallback;
 *      always present on Windows 10/11.
 *   4. `pwsh` — POSIX hosts; resolved via PATH at spawn time.
 *
 * Result is cached for the lifetime of the process (resolution involves
 * a spawn + filesystem stat, neither of which we want per-call).
 *
 * Compatibility: all v0.7.2 H2 hardening flags
 * (-NoProfile / -NonInteractive / -OutputFormat Text / -InputFormat None /
 * -Command) are accepted by BOTH `pwsh.exe` and `powershell.exe`. The
 * binary swap is fully transparent to call sites; only the resolved
 * binary path changes.
 */
let _cached: string | null = null;

export function resolvePowershellBin(config: ResolvedConfig): string {
  if (_cached !== null) return _cached;

  // 1. Explicit config override.
  if (config.powershellExePath) {
    if (existsSync(config.powershellExePath)) {
      _cached = config.powershellExePath;
      return _cached;
    }
    process.stderr.write(
      `winfs: config.powershellExePath '${config.powershellExePath}' does not exist; falling back to auto-detect\n`,
    );
  }

  if (process.platform !== "win32") {
    // POSIX: rely on PATH; spawn will fail loudly if pwsh is missing.
    _cached = "pwsh";
    return _cached;
  }

  // 2. Probe for pwsh.exe via `where`. Pin PATHEXT (Phase C) so the bare-name
  //    `where` resolves even under a mangled inherited PATHEXT (.CPL).
  const probe = spawnSync("where", ["pwsh"], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, PATHEXT: STANDARD_WINDOWS_PATHEXT },
  });
  if (probe.status === 0 && probe.stdout) {
    const candidates = probe.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const cand of candidates) {
      // Skip the Microsoft Store shim — same pattern as detectPythonHome in
      // tests/helpers.ts. The shim resolves but prompts to install when run.
      if (/\\WindowsApps\\/i.test(cand)) continue;
      if (existsSync(cand)) {
        _cached = cand;
        return _cached;
      }
    }
  }

  // 3. Final fallback — PowerShell 5.1 ships with Windows.
  _cached = "powershell.exe";
  return _cached;
}

/** Reset the cache. Tests only — production code never needs this. */
export function resetPowershellResolverCache(): void {
  _cached = null;
}

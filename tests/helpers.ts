import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import type { ResolvedConfig } from "../src/core/config.js";
import { flushAudit } from "../src/core/audit.js";

/** Find a python install for tests. Best-effort — returns undefined if no
 *  python on the test host so test suites can skip gracefully. Result is
 *  cached for the test process.
 *
 *  On Windows the first `where python` hit is often the Microsoft Store
 *  shim (`WindowsApps\python.exe`) which doesn't actually execute Python —
 *  it just prompts to install. We iterate all hits and probe each by running
 *  `--version`; first one that exits 0 with a "Python X.Y.Z" line wins. */
let _pythonHomeCache: string | undefined | null = null;
function detectPythonHome(): string | undefined {
  if (_pythonHomeCache !== null) return _pythonHomeCache;
  const cmd = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(cmd, ["python"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout) {
    _pythonHomeCache = undefined;
    return undefined;
  }
  const candidates = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const cand of candidates) {
    if (process.platform === "win32" && /\\WindowsApps\\/i.test(cand)) continue;
    const verify = spawnSync(cand, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (verify.status === 0 && /Python\s/.test(verify.stdout + verify.stderr)) {
      _pythonHomeCache = path.dirname(cand);
      return _pythonHomeCache;
    }
  }
  _pythonHomeCache = undefined;
  return undefined;
}

/**
 * Create a temp directory and return it as a single-root canonical config.
 * Each test gets its own root so parallel runs don't collide. Caller is
 * responsible for cleanup via `cleanupTempConfig`.
 */
export async function makeTempConfig(): Promise<{ config: ResolvedConfig; root: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-winfs-test-"));
  const real = await fs.realpath(base);
  // audit_tail enforces the `mcp-winfs/*.jsonl` shape on the resolved audit
  // log path. Tests use the same convention so the default helper works
  // end-to-end without a separate fixture.
  const auditPath = path.join(real, "mcp-winfs", "audit.jsonl");

  const config: ResolvedConfig = {
    allowedRoots: [real],
    allowedUrlHosts: [],
    deniedUrlPatterns: [],
    shellBlocklist: [],
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10000,
    shellTimeoutMs: 5000,
    shellMaxTimeoutMs: 30000,
    fetchUrlMaxBytes: 1024 * 1024,
    fetchUrlTimeoutMs: 5000,
    readMaxBytes: 1024 * 1024,
    maxDiffBytes: 256 * 1024,
    execMaxOutputBytes: 1 * 1024 * 1024,
    execExtraBlocklist: [],
    execSanitizeEnv: false,
    pythonHome: detectPythonHome(),
    unrestrictedFilesystem: false,
    unrestrictedFilesystemConfirm: undefined,
    sshExePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    processMaxConcurrent: 16,
    processBufferCap: 1024 * 1024,
    processSessionTtlMs: 60_000,
    processGcIntervalMs: 10_000,
    auditLogMaxBytes: 1024 * 1024,
    configPath: "<test>",
    resolvedAllowedRoots: [path.normalize(real)],
    resolvedAuditLogPath: auditPath,
    version: "0.1.0-test",
    serverMode: "strict",
  };

  return { config, root: real };
}

export async function cleanupTempConfig(root: string): Promise<void> {
  // The audit module serializes writes through a module-level queue. If a
  // test leaves writes in flight, they may try to create files inside `root`
  // after rm starts — Windows then returns ENOTEMPTY. Flush before delete.
  await flushAudit();
  await rmdirWithRetry(root);
}

/**
 * v0.9.1 Phase A1 — Windows holds directory handles briefly after a
 * subprocess exits, even when `child.on("close")` has fired and the
 * session is settled. An immediate `fs.rm({recursive: true})` against
 * the tempdir that held the subprocess often hits EBUSY / ENOTEMPTY /
 * EPERM during `afterEach`. The retry loop backs off (50ms, 100ms,
 * 150ms, …) up to `attempts` tries, surfacing the original error if
 * still failing after the last attempt. Non-EBUSY errors short-circuit
 * to fail-fast since they're not the cleanup race.
 *
 * Reference: v0.7 pre-tag wave's 10 Windows-flaky failures in
 * tests/unit/process/* — all EBUSY-on-rmdir during afterEach. This
 * helper closes the entire class. Spec invariant #41
 * (settle-by-close-event) addressed the underlying ProcessRegistry
 * race; this helper closes the OS-handle-release race that's
 * downstream of it.
 */
export async function rmdirWithRetry(
  p: string,
  attempts = 5,
  delayMs = 50,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (i === attempts - 1) throw err;
      if (e?.code !== "EBUSY" && e?.code !== "ENOTEMPTY" && e?.code !== "EPERM") {
        throw err;
      }
      // Linear backoff: 50ms, 100ms, 150ms, 200ms. Total ≤ 500ms across
      // all attempts. Windows handle-release after subprocess exit
      // typically completes within 100-200ms; 5 attempts × linear
      // backoff is the empirical sweet spot from similar Node-on-Windows
      // test-cleanup patterns.
      await new Promise((res) => setTimeout(res, delayMs * (i + 1)));
    }
  }
}

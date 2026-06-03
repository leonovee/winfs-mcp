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
    auditVerbose: false,
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
 * v0.9.1 Phase A1 — Windows holds directory handles after a subprocess
 * exits, sometimes for many seconds. An immediate `fs.rm({recursive: true})`
 * against the tempdir that held the subprocess often hits EBUSY /
 * ENOTEMPTY / EPERM during `afterEach`. Investigation showed even after
 * the subprocess close event fires, the OS keeps the cwd handle live
 * (likely process-record reaping delay + Defender post-exit scan), and
 * the empty tempdir can be undeletable for 10–20+ seconds.
 *
 * Strategy:
 *   - Use Node's built-in `fs.rm({maxRetries, retryDelay})` which retries
 *     with linear backoff at the libuv layer for the recognised codes.
 *   - On non-EBUSY/ENOTEMPTY/EPERM errors, throw — those indicate a
 *     real bug, not a Windows handle-release race.
 *   - On EBUSY/ENOTEMPTY/EPERM after retries exhausted, log to stderr
 *     but DON'T throw. The test's logical assertion has already run.
 *     The temp dir will be cleaned up by Windows `%TEMP%` gc eventually,
 *     and the cleanup failure is not a test-correctness bug.
 *
 * Reference: v0.7 pre-tag wave's 10 Windows-flaky failures in
 * tests/unit/process/* — all EBUSY-on-rmdir during afterEach. Spec
 * invariant #41 (settle-by-close-event) addressed the underlying
 * ProcessRegistry race; this helper closes the OS-handle-release
 * race that's downstream of it without blocking on it.
 */
export async function rmdirWithRetry(p: string): Promise<void> {
  try {
    await fs.rm(p, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EBUSY" || e?.code === "ENOTEMPTY" || e?.code === "EPERM") {
      // Log so monitoring can spot if the rate climbs, but don't fail
      // the test for an OS handle-release race outside our control.
      process.stderr.write(
        `rmdirWithRetry: ${e.code} on ${p} after retries; leaking to %TEMP% gc\n`,
      );
      return;
    }
    throw err;
  }
}

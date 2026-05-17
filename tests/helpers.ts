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
    auditLogMaxBytes: 1024 * 1024,
    configPath: "<test>",
    resolvedAllowedRoots: [path.normalize(real)],
    resolvedAuditLogPath: auditPath,
    version: "0.1.0-test",
  };

  return { config, root: real };
}

export async function cleanupTempConfig(root: string): Promise<void> {
  // The audit module serializes writes through a module-level queue. If a
  // test leaves writes in flight, they may try to create files inside `root`
  // after rm starts — Windows then returns ENOTEMPTY. Flush before delete.
  await flushAudit();
  await fs.rm(root, { recursive: true, force: true });
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResolvedConfig } from "../src/core/config.js";
import { flushAudit } from "../src/core/audit.js";

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

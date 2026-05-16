import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tailLines } from "../../../src/tools/system/audit_tail.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * Codex review P2 (a): the old `fs.readFile` loaded the entire log on
 * every call, so a multi-GB audit log + `n: 1` still paid the full
 * I/O cost. The fix is a reverse-read in 256 KB chunks with a 64 MB
 * total ceiling.
 *
 * This test asserts the read footprint, not just wall-clock — a fast
 * SSD could mask the bug behind sub-200 ms times on a 50 MB file.
 */
describe("tools/system/audit_tail — bounded read (codex P2a)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("reads under 1 MB and completes in under 200 ms on a ≥ 50 MB log with n=5", async () => {
    // Build a ~50 MB audit log. One entry per line; ~120 bytes/entry.
    await fs.mkdir(path.dirname(config.resolvedAuditLogPath), { recursive: true });
    const logPath = config.resolvedAuditLogPath;
    const sampleEntry =
      JSON.stringify({
        ts: "2026-05-16T00:00:00.000Z",
        tool: "read",
        args_summary: { path: "C:\\users\\x\\proj\\fixture.txt" },
        result_status: "ok",
        duration_ms: 5,
      }) + "\n";
    // Generate in 1 MB batches via appendFile so the test doesn't allocate
    // 50 MB of JS string at once.
    const PER_BATCH = Math.ceil((1024 * 1024) / sampleEntry.length);
    const TARGET_BYTES = 50 * 1024 * 1024;
    const batch = sampleEntry.repeat(PER_BATCH);
    const batchBytes = Buffer.byteLength(batch, "utf8");
    const fullBatches = Math.ceil(TARGET_BYTES / batchBytes);
    for (let i = 0; i < fullBatches; i++) {
      await fs.appendFile(logPath, batch, "utf8");
    }
    const stat = await fs.stat(logPath);
    expect(stat.size).toBeGreaterThanOrEqual(50 * 1024 * 1024);

    // Probe with the test hook that records every disk read.
    let totalBytesRead = 0;
    const started = Date.now();
    const entries = await tailLines(logPath, 5, {
      onRead: (bytes) => {
        totalBytesRead += bytes;
      },
    });
    const elapsedMs = Date.now() - started;

    expect(entries.length).toBe(5);
    expect(totalBytesRead).toBeLessThan(1024 * 1024); // < 1 MB read for n=5
    expect(elapsedMs).toBeLessThan(200);
  }, 60_000);

  it("honors the 64 MB ceiling without throwing when no \\n is ever found", async () => {
    // Pathological case: a single line longer than the ceiling. The tail
    // should return [] (no complete record found before the cap) rather than
    // OOM or hang.
    await fs.mkdir(path.dirname(config.resolvedAuditLogPath), { recursive: true });
    const logPath = config.resolvedAuditLogPath;
    // Write 2 MB of garbage with no newlines (well under the 64 MB ceiling
    // but above the 256 KB chunk size — exercises the partial-line carryover).
    const bigBlob = "x".repeat(2 * 1024 * 1024);
    await fs.writeFile(logPath, bigBlob, "utf8");

    let totalBytesRead = 0;
    const entries = await tailLines(logPath, 5, {
      onRead: (bytes) => {
        totalBytesRead += bytes;
      },
    });
    expect(entries).toEqual([]);
    // We will have read the whole 2 MB file (no \n means we keep extending
    // partialEnd) but never more than the ceiling.
    expect(totalBytesRead).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(totalBytesRead).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  });
});

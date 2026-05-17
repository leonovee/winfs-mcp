import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { auditTailImpl } from "../../../src/tools/system/audit_tail.js";
import { appendAudit, flushAudit } from "../../../src/core/audit.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * Codex review P2 (b): the v0.3.0 self-dedup was a *post-filter* pop
 * loop. If the last N entries are all `audit_tail` (trivially achievable
 * by repeatedly invoking audit_tail), the loop drained them all and
 * returned an empty array — the legitimate entries that preceded the
 * audit_tail flood were never surfaced.
 *
 * The fix integrates the filter into the backward scan: we keep
 * scanning past audit_tail records until we accumulate `n` *other*
 * records (or hit the start of the file / the read ceiling). This test
 * exercises a flood-of-`audit_tail` log and asserts that the 5
 * legitimate records buried under 100 audit_tail entries surface.
 */
describe("tools/system/audit_tail — scan-time self-dedup (codex P2b)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("§M (v0.5): entries_seen_total counts ALL scanned records, including filtered audit_tail ones", async () => {
    // Layout: [audit_tail × 50][read × 3]
    // Scan order (backward): 3 reads collected + 50 audit_tail filtered.
    // entries.length = 3, entries_seen_total = 53.
    for (let i = 0; i < 50; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 17, 9, 0, 0, i).toISOString(),
        tool: "audit_tail",
        args_summary: { n: 10 },
        result_status: "ok",
        duration_ms: 1,
      });
    }
    for (let i = 0; i < 3; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 17, 9, 5, 0, i).toISOString(),
        tool: "read",
        args_summary: { idx: i },
        result_status: "ok",
        duration_ms: 1,
      });
    }
    await flushAudit();
    const res = await auditTailImpl({ n: 10 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(3);
    expect(res.value.entries_seen_total).toBe(53);
    // Gap is exactly the filtered audit_tail records.
    expect(res.value.entries_seen_total - res.value.total).toBe(50);
  });

  it("§M (v0.5): missing audit log returns entries_seen_total:0", async () => {
    const res = await auditTailImpl({ n: 10 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries_seen_total).toBe(0);
    expect(res.value.total).toBe(0);
  });

  it("with 100×audit_tail then 5×non-audit_tail at the tail, n=10 returns the 5 non-audit_tail entries", async () => {
    // Layout in file order: [audit_tail × 100][read × 5]
    // Newest 10 entries = [audit_tail × 5][read × 5] (raw tail).
    // v0.3.0 post-drain would have popped only the trailing run of
    // audit_tail (none, since the tail is `read`), returning all 10.
    // The codex attack is when the tail is all audit_tail — then v0.3.0
    // returns []. With scan-time dedup we never collect audit_tail in
    // the first place, so we keep scanning past them until we either
    // hit `n` non-audit_tail records or the start of the file.
    for (let i = 0; i < 100; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 16, 12, 0, 0, i).toISOString(),
        tool: "audit_tail",
        args_summary: { n: 10 },
        result_status: "ok",
        duration_ms: 1,
      });
    }
    for (let i = 0; i < 5; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 16, 12, 5, 0, i).toISOString(),
        tool: "read",
        args_summary: { idx: i },
        result_status: "ok",
        duration_ms: 3,
      });
    }
    await flushAudit();

    const res = await auditTailImpl({ n: 10 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.length).toBe(5);
    expect(res.value.entries.every((e) => e.tool === "read")).toBe(true);
    // File-order preserved within the returned slice.
    expect(res.value.entries.map((e) => (e.args_summary as { idx: number }).idx)).toEqual([0, 1, 2, 3, 4]);
  });

  it("with ALL recent entries being audit_tail, returns the older non-audit_tail entries instead of empty", async () => {
    // Inverse layout: [read × 3][audit_tail × 50]
    // v0.3.0 post-drain pops all 50 trailing audit_tail and stops — but it
    // only requested n=10 entries, so it would have read entries[40..49]
    // (all audit_tail), drained all → empty. The codex bug.
    for (let i = 0; i < 3; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 16, 11, 0, 0, i).toISOString(),
        tool: "stat",
        args_summary: { idx: i },
        result_status: "ok",
        duration_ms: 2,
      });
    }
    for (let i = 0; i < 50; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 16, 13, 0, 0, i).toISOString(),
        tool: "audit_tail",
        args_summary: { n: 10 },
        result_status: "ok",
        duration_ms: 1,
      });
    }
    await flushAudit();

    const res = await auditTailImpl({ n: 10 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Three legitimate older entries surface (not empty).
    expect(res.value.entries.length).toBe(3);
    expect(res.value.entries.every((e) => e.tool === "stat")).toBe(true);
  });
});

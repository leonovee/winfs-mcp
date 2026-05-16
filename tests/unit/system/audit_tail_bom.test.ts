import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { auditTailImpl } from "../../../src/tools/system/audit_tail.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * Kimi P3 / codex deferred — a UTF-8 BOM at the start of the audit log
 * (it can only legitimately appear at byte 0) causes JSON.parse on the
 * first line to throw on the leading `﻿`, silently dropping the
 * first record. v0.3.2 strips a leading `﻿` from every decoded line
 * before parsing.
 */
describe("tools/system/audit_tail — strips leading UTF-8 BOM (kimi P3)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns all 3 entries from a BOM-prefixed audit log (was dropping the first)", async () => {
    const e = (idx: number, tool = "read"): string =>
      JSON.stringify({
        ts: new Date(2026, 4, 16, 12, 0, idx).toISOString(),
        tool,
        args_summary: { idx },
        result_status: "ok",
        duration_ms: 1,
      });
    const content = "﻿" + e(1) + "\n" + e(2) + "\n" + e(3) + "\n";

    await fs.mkdir(path.dirname(config.resolvedAuditLogPath), { recursive: true });
    await fs.writeFile(config.resolvedAuditLogPath, content, "utf8");

    const res = await auditTailImpl({ n: 50 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.length).toBe(3);
    // File-order preserved; the originally-BOM-prefixed entry is first.
    expect(
      res.value.entries.map((entry) => (entry.args_summary as { idx: number }).idx),
    ).toEqual([1, 2, 3]);
  });
});

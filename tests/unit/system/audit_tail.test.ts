import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  auditTailImpl,
  isAuditLogPathLegitimate,
} from "../../../src/tools/system/audit_tail.js";
import { appendAudit, flushAudit } from "../../../src/core/audit.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/system/audit_tail", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  async function writeAuditEntries(n: number, tool = "test"): Promise<void> {
    for (let i = 0; i < n; i++) {
      appendAudit(config, {
        ts: new Date(2026, 4, 16, 12, 0, i).toISOString(),
        tool,
        args_summary: { idx: i },
        result_status: "ok",
        duration_ms: 5,
      });
    }
    await flushAudit();
  }

  it("returns the last N entries", async () => {
    await writeAuditEntries(20, "read");
    const res = await auditTailImpl({ n: 5 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.length).toBe(5);
    expect(res.value.total).toBe(5);
    expect(res.value.entries.map((e) => (e.args_summary as { idx: number }).idx)).toEqual([15, 16, 17, 18, 19]);
  });

  it("returns all entries when n exceeds total", async () => {
    await writeAuditEntries(3, "read");
    const res = await auditTailImpl({ n: 100 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(3);
  });

  it("returns empty array when n=0", async () => {
    await writeAuditEntries(5, "read");
    const res = await auditTailImpl({ n: 0 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries).toEqual([]);
    expect(res.value.total).toBe(0);
  });

  it("returns empty when audit file does not exist yet", async () => {
    const res = await auditTailImpl({}, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries).toEqual([]);
  });

  it("drops trailing audit_tail self-entries (self-deduplication)", async () => {
    await writeAuditEntries(3, "read");
    // Simulate a previous audit_tail call's audit record landing on disk.
    appendAudit(config, {
      ts: new Date().toISOString(),
      tool: "audit_tail",
      args_summary: { n: 10 },
      result_status: "ok",
      duration_ms: 2,
    });
    await flushAudit();
    const res = await auditTailImpl({ n: 50 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.entries.every((e) => e.tool !== "audit_tail")).toBe(true);
    expect(res.value.total).toBe(3);
  });

  it("EPERM_ROOT when configured auditLogPath does not end in .jsonl", async () => {
    const badConfig: ResolvedConfig = {
      ...config,
      resolvedAuditLogPath: path.join(root, "definitely-not-audit.txt"),
    };
    const res = await auditTailImpl({ n: 50 }, badConfig);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("EPERM_ROOT when configured auditLogPath is not absolute (v0.3.3 deepseek P3)", async () => {
    const badConfig: ResolvedConfig = {
      ...config,
      resolvedAuditLogPath: "audit.jsonl", // relative — would resolve against cwd
    };
    const res = await auditTailImpl({ n: 50 }, badConfig);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    expect(res.error.message.toLowerCase()).toContain("absolute");
    expect(res.error.details).toMatchObject({ configured: "audit.jsonl" });
  });

  it("isAuditLogPathLegitimate enforces .jsonl extension only (kimi P1.3)", () => {
    // v0.3.0/v0.3.1 also required parent-dir === "mcp-winfs" — removed in
    // v0.3.2 per kimi P1.3 (parent layer was defense-in-depth and brittle
    // to future repo renames). Only the extension gates acceptance now.
    expect(
      isAuditLogPathLegitimate(
        process.platform === "win32"
          ? "C:\\Users\\x\\AppData\\Local\\mcp-winfs\\audit.jsonl"
          : "/home/x/.local/share/mcp-winfs/audit.jsonl",
      ),
    ).toBe(true);
    // Any folder is accepted now, as long as the file ends in .jsonl.
    expect(
      isAuditLogPathLegitimate(
        process.platform === "win32"
          ? "C:\\Users\\x\\AppData\\Local\\some-other\\audit.jsonl"
          : "/home/x/some-other/audit.jsonl",
      ),
    ).toBe(true);
    // Non-.jsonl extensions are rejected.
    expect(
      isAuditLogPathLegitimate(
        process.platform === "win32"
          ? "C:\\Users\\x\\mcp-winfs\\notes.txt"
          : "/home/x/mcp-winfs/notes.txt",
      ),
    ).toBe(false);
    expect(
      isAuditLogPathLegitimate(
        process.platform === "win32"
          ? "C:\\Users\\x\\mcp-winfs\\audit.log"
          : "/home/x/mcp-winfs/audit.log",
      ),
    ).toBe(false);
  });
});

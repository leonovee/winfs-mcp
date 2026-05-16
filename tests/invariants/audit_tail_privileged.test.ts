import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { auditTailImpl } from "../../src/tools/system/audit_tail.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * audit_tail reads from a path OUTSIDE allowedRoots by design — the audit log
 * lives in %LOCALAPPDATA%\mcp-winfs\ which is a legitimate exception to spec
 * §2.2. The shape check is what stops the tool from becoming a universal
 * "read any file you can name" backdoor.
 *
 * These invariants pin that boundary: every probe that points the configured
 * audit path at something that is NOT shaped like an mcp-winfs audit log
 * MUST return EPERM_ROOT regardless of how plausibly the path is named.
 */
describe("invariant: audit_tail refuses non-audit paths (v0.3 §4.8)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("rejects path whose parent dir is NOT 'mcp-winfs'", async () => {
    const sneaky: ResolvedConfig = {
      ...config,
      resolvedAuditLogPath: path.join(root, "other-app", "audit.jsonl"),
    };
    const res = await auditTailImpl({ n: 50 }, sneaky);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("rejects path that does NOT end in .jsonl", async () => {
    const sneaky: ResolvedConfig = {
      ...config,
      resolvedAuditLogPath: path.join(root, "mcp-winfs", "audit.log"),
    };
    const res = await auditTailImpl({ n: 50 }, sneaky);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("rejects a Windows-sensitive path even when given a plausible filename", async () => {
    const winLike =
      process.platform === "win32"
        ? "C:\\Windows\\System32\\drivers\\etc\\hosts.jsonl"
        : "/etc/passwd.jsonl";
    const sneaky: ResolvedConfig = {
      ...config,
      resolvedAuditLogPath: winLike,
    };
    const res = await auditTailImpl({ n: 50 }, sneaky);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("accepts a legitimate mcp-winfs path even when outside allowedRoots", async () => {
    // The whole point: the legitimate path IS outside allowedRoots. Build a
    // fixture in os.tmpdir() under an explicit `mcp-winfs/` directory and
    // point the config at it. Note: makeTempConfig already uses this shape.
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "audit-priv-"));
    try {
      const legitDir = path.join(tmpBase, "mcp-winfs");
      await fs.mkdir(legitDir, { recursive: true });
      const legitPath = path.join(legitDir, "audit.jsonl");
      await fs.writeFile(legitPath, "", "utf8");
      const legit: ResolvedConfig = {
        ...config,
        resolvedAuditLogPath: legitPath,
      };
      const res = await auditTailImpl({ n: 10 }, legit);
      expect(res.ok).toBe(true);
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });
});

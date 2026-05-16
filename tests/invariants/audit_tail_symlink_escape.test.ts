import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { auditTailImpl } from "../../src/tools/system/audit_tail.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * Codex review P1: the lexical shape check (parent dir == "mcp-winfs",
 * suffix == ".jsonl") is necessary but not sufficient — a symlink or NTFS
 * junction placed at a legitimate-shape path can resolve to an arbitrary
 * file, and `fs.readFile` follows the link at OS level. The fix is a
 * post-realpath re-validation of the same shape.
 *
 * These probes pin that defense end-to-end: a symlink at
 * `<root>/mcp-winfs/audit.jsonl` pointing to a file OUTSIDE the
 * mcp-winfs convention must return EPERM_ROOT with both the configured
 * and resolved paths surfaced in details.
 *
 * Skipped cleanly on hosts where the process lacks symlink-creation
 * rights (Win10 without SeCreateSymbolicLinkPrivilege) — same platform-
 * aware fallback as the copy.ts symlink-escape test.
 */
describe("invariant: audit_tail rejects symlink/junction escape (codex P1)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("symlink at legit-shape path → real target outside the convention → EPERM_ROOT", async () => {
    const escapeBase = await fs.mkdtemp(path.join(os.tmpdir(), "audit-escape-"));
    try {
      // Target: a file the symlink will point to. NOT inside an mcp-winfs/ dir.
      const secret = path.join(escapeBase, "secret.txt");
      await fs.writeFile(secret, "TOPSECRET", "utf8");

      // Symlink: legit-shape path (parent is mcp-winfs/, ends .jsonl).
      const legitDir = path.join(root, "mcp-winfs");
      await fs.mkdir(legitDir, { recursive: true });
      const symPath = path.join(legitDir, "audit.jsonl");
      try {
        await fs.symlink(secret, symPath, "file");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code === "EPERM" || e?.code === "EACCES") return; // host lacks symlink rights
        throw err;
      }

      const attacker: ResolvedConfig = {
        ...config,
        resolvedAuditLogPath: symPath,
      };
      const res = await auditTailImpl({ n: 50 }, attacker);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected error");
      expect(res.error.code).toBe("EPERM_ROOT");
      // Both paths surfaced for forensic traceability.
      const details = res.error.details ?? {};
      expect(typeof details.configured).toBe("string");
      expect(typeof details.resolved).toBe("string");
      expect(details.configured).not.toBe(details.resolved);

      // The secret was never read.
      // (Nothing to assert positively beyond the EPERM — fs.readFile was never
      //  called because we short-circuit before tailLines. This is implicit in
      //  the EPERM contract: a successful EPERM means we didn't reach I/O.)
    } finally {
      await fs.rm(escapeBase, { recursive: true, force: true });
    }
  });

  it("non-symlink legitimate path still works (positive control)", async () => {
    // Sanity check: the realpath round-trip doesn't break the normal case.
    const legitDir = path.join(root, "mcp-winfs");
    await fs.mkdir(legitDir, { recursive: true });
    const legitPath = path.join(legitDir, "audit.jsonl");
    await fs.writeFile(legitPath, "", "utf8");
    const legit: ResolvedConfig = {
      ...config,
      resolvedAuditLogPath: legitPath,
    };
    const res = await auditTailImpl({ n: 10 }, legit);
    expect(res.ok).toBe(true);
  });
});

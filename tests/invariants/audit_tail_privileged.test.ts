import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { auditTailImpl } from "../../src/tools/system/audit_tail.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * audit_tail reads from a path OUTSIDE allowedRoots by design. After kimi
 * P1.3 (v0.3.2) the gating check is a `.jsonl` extension on both the
 * configured and `fs.realpath`-resolved paths — the parent-directory name
 * layer was removed (see audit_tail.ts header for the threat-model
 * justification).
 *
 * These invariants pin the post-P1.3 boundary:
 *   1. Non-`.jsonl` configured path → EPERM_ROOT.
 *   2. Legitimate `.jsonl` path outside allowedRoots → accepted.
 *
 * The parent-name "wrong folder" probes from v0.3.0/v0.3.1 were removed:
 * after P1.3 those paths are accepted lexically, so the old assertions
 * (expecting EPERM_ROOT) no longer match the contract. The TOCTOU /
 * symlink-escape probes that ARE still in scope live in
 * `audit_tail_symlink_escape.test.ts` and `audit_tail_toctou.test.ts`.
 */
describe("invariant: audit_tail enforces .jsonl extension (v0.3.2 §4.8)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
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

  it("accepts a legitimate .jsonl path outside allowedRoots", async () => {
    // The whole point: the legitimate path IS outside allowedRoots and the
    // parent directory name no longer matters after P1.3 — only the .jsonl
    // suffix gates acceptance.
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "audit-priv-"));
    try {
      const legitDir = path.join(tmpBase, "some-arbitrary-folder");
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

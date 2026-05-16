import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { auditTailImpl } from "../../src/tools/system/audit_tail.js";
import { appendAudit, flushAudit } from "../../src/core/audit.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * Kimi P1.2 — TOCTOU race between path validation and file open.
 *
 * v0.3.1 closed the lexical / realpath gap but left a window between
 * `fs.realpath(configured)` returning a path X and `fs.open(configured)`
 * being called — on Windows, junction points can be swapped atomically,
 * so an attacker could redirect the read after the realpath snapshot
 * approved the target.
 *
 * v0.3.2's fix: open the RESOLVED path X directly (not the configured
 * path). Once `fs.open` returns, the file descriptor is bound to an
 * inode and any subsequent junction swap of the configured path is
 * irrelevant. Plus an `fstat` on the handle to confirm a regular file.
 *
 * Two cases:
 *   1. Pre-resolve swap — junction redirected BEFORE `fs.realpath` runs.
 *      Caught by realpath's view of the new target + the `.jsonl`
 *      extension re-check on the resolved path.
 *   2. Post-resolve swap — junction redirected AFTER `fs.realpath`
 *      returns but BEFORE `fs.open`. Caught by `fs.open` operating on
 *      the resolved path (X) directly, which never re-traverses the
 *      mutated symlink. We deterministically simulate this race by
 *      monkey-patching `fs.realpath` to swap the symlink target after
 *      it returns.
 *
 * Either outcome is acceptable per the review:
 *   - EPERM_ROOT (extension re-check fired) — pre-resolve case.
 *   - Original content read (resolved path opened directly) — post-
 *     resolve case.
 * The forbidden outcome: content of the SWAPPED target.
 */
describe("invariant: audit_tail closes TOCTOU window (kimi P1.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("pre-resolve swap to a non-.jsonl target → EPERM_ROOT (caught by realpath re-check)", async () => {
    // Set up: legit jsonl + a non-.jsonl secret + a symlink at the
    // configured path that currently points at a non-.jsonl file.
    const legitDir = path.join(root, "mcp-winfs");
    await fs.mkdir(legitDir, { recursive: true });
    const secret = path.join(root, "secret.txt");
    await fs.writeFile(secret, "SECRET", "utf8");

    const symPath = path.join(legitDir, "audit.jsonl");
    try {
      await fs.symlink(secret, symPath, "file");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EPERM" || e?.code === "EACCES") return; // host lacks symlink rights
      throw err;
    }

    const cfg: ResolvedConfig = { ...config, resolvedAuditLogPath: symPath };
    const res = await auditTailImpl({ n: 50 }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    // Both paths surfaced so a defender can audit the attempted swap.
    const details = res.error.details ?? {};
    expect(typeof details.configured).toBe("string");
    expect(typeof details.resolved).toBe("string");
    expect(details.configured).not.toBe(details.resolved);
  });

  it("post-resolve swap → reads ORIGINAL resolved target, never the swapped one", async () => {
    // Set up two valid `.jsonl` files. The symlink initially points at the
    // legitimate one. We monkey-patch `fs.realpath` so that AFTER it
    // returns the original target path it swaps the symlink to point at
    // an attacker-controlled file — deterministically simulating the
    // post-realpath / pre-fs.open race window.
    const legitDir = path.join(root, "mcp-winfs");
    await fs.mkdir(legitDir, { recursive: true });

    const originalTarget = path.join(legitDir, "audit-original.jsonl");
    const attackerTarget = path.join(legitDir, "audit-attacker.jsonl");
    // Write valid audit entries differing only in tool name so the test can
    // tell which file was actually read.
    appendAudit(
      { ...config, resolvedAuditLogPath: originalTarget },
      {
        ts: "2026-05-16T00:00:00.000Z",
        tool: "ORIGINAL_MARKER",
        args_summary: {},
        result_status: "ok",
        duration_ms: 1,
      },
    );
    appendAudit(
      { ...config, resolvedAuditLogPath: attackerTarget },
      {
        ts: "2026-05-16T00:00:00.000Z",
        tool: "ATTACKER_PLANT",
        args_summary: {},
        result_status: "ok",
        duration_ms: 1,
      },
    );
    await flushAudit();

    const symPath = path.join(legitDir, "audit.jsonl");
    try {
      await fs.symlink(originalTarget, symPath, "file");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EPERM" || e?.code === "EACCES") return;
      throw err;
    }

    const origRealpath = fs.realpath;
    let swapHappened = false;
    (fs as unknown as { realpath: typeof origRealpath }).realpath = (async (
      p: string,
    ) => {
      const resolved = await origRealpath.call(fs, p);
      if (path.normalize(p) === path.normalize(symPath) && !swapHappened) {
        swapHappened = true;
        // Race window simulated: between realpath returning the original
        // target and the impl calling fs.open, repoint the junction.
        await fs.unlink(symPath);
        await fs.symlink(attackerTarget, symPath, "file");
      }
      return resolved;
    }) as typeof origRealpath;

    try {
      const cfg: ResolvedConfig = { ...config, resolvedAuditLogPath: symPath };
      const res = await auditTailImpl({ n: 50 }, cfg);
      expect(swapHappened).toBe(true); // the race window WAS triggered
      // The impl must have opened the resolved (original) target by its
      // physical path, ignoring the post-realpath swap.
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.value.entries.length).toBeGreaterThan(0);
      // Every entry returned came from the original file. The attacker's
      // plant must never appear.
      expect(
        res.value.entries.every((e) => e.tool === "ORIGINAL_MARKER"),
      ).toBe(true);
      expect(
        res.value.entries.some((e) => e.tool === "ATTACKER_PLANT"),
      ).toBe(false);
    } finally {
      (fs as unknown as { realpath: typeof origRealpath }).realpath = origRealpath;
    }
  });
});

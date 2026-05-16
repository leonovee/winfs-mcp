import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { editFileImpl } from "../../src/tools/editor/edit_file.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * Spec amendment §I (v0.4): `edit_file` writes go through the same atomic
 * path as `write` (temp + fsync + rename). Pin two properties:
 *
 *   1. `dry_run: true` must not produce a `.tmp` artifact in the parent
 *      directory — the implementation forks before atomic-write begins.
 *   2. A `fs.rename` failure (simulated by monkey-patching) must leave the
 *      original file intact AND must not leak a `.tmp` orphan past the
 *      caller's exit (atomic_write.ts unlinks the temp on rename failure).
 */
describe("invariant: edit_file dry_run + atomic semantics (v0.4 §I)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("dry_run does NOT create any temp file in the parent directory", async () => {
    const p = path.join(root, "target.txt");
    await fs.writeFile(p, "alpha\n", "utf8");

    const before = await fs.readdir(root);
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "alpha", new_str: "OMEGA" }], dry_run: true },
      config,
    );
    expect(res.ok).toBe(true);
    const after = await fs.readdir(root);

    // Same directory contents → no .tmp file was ever created.
    expect(after.sort()).toEqual(before.sort());
    // File contents unchanged.
    expect(await fs.readFile(p, "utf8")).toBe("alpha\n");
  });

  it("rename failure leaves the original file intact and cleans up the temp", async () => {
    const p = path.join(root, "target.txt");
    await fs.writeFile(p, "ORIGINAL\n", "utf8");

    const origRename = fs.rename;
    let renameAttempted = false;
    (fs as unknown as { rename: typeof origRename }).rename = (async () => {
      renameAttempted = true;
      const err = new Error("simulated rename failure") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    }) as typeof origRename;

    try {
      const res = await editFileImpl(
        { path: p, edits: [{ old_str: "ORIGINAL", new_str: "REPLACED" }], dry_run: false },
        config,
      );
      expect(renameAttempted).toBe(true);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected error");
      expect(res.error.code).toBe("EBUSY");
      // Original content preserved — atomicity invariant.
      expect(await fs.readFile(p, "utf8")).toBe("ORIGINAL\n");
      // No orphan .tmp left behind. atomicWriteFile unlinks on rename fail.
      const entries = await fs.readdir(root);
      const orphan = entries.find((n) => n.includes(".tmp"));
      expect(orphan).toBeUndefined();
    } finally {
      (fs as unknown as { rename: typeof origRename }).rename = origRename;
    }
  });
});

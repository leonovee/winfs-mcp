import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { editFileImpl } from "../../../src/tools/editor/edit_file.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 wave 2a: opt-out of diff body for response-size control on large edits.
 *
 *   - `with_diff` defaults to true (preserves v0.4 §I "diff field always populated").
 *   - `with_diff: false` → `diff` is the empty string, `truncated_diff` is absent.
 *   - When the unified diff would exceed 16 KB, it is truncated with a trailing
 *     marker and the response carries `truncated_diff: true`.
 */
describe("tools/editor/edit_file — with_diff opt-out and truncation (v0.7 wave 2a)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("with_diff: true (default) returns the unified diff body", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "beta", new_str: "BETA" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.diff).toMatch(/-beta/);
    expect(res.value.diff).toMatch(/\+BETA/);
    expect(res.value.truncated_diff).toBeUndefined();
  });

  it("with_diff: false suppresses the diff body (empty string)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "beta", new_str: "BETA" }],
        dry_run: false,
        with_diff: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.diff).toBe("");
    expect(res.value.truncated_diff).toBeUndefined();
    // File still mutated.
    expect(await fs.readFile(p, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("with_diff: false on dry_run also suppresses the diff", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "original\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "original", new_str: "MODIFIED" }],
        dry_run: true,
        with_diff: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.diff).toBe("");
    expect(res.value.dry_run).toBe(true);
    // File untouched (dry_run).
    expect(await fs.readFile(p, "utf8")).toBe("original\n");
  });

  it("with_diff: true on multi-edit returns a single combined diff", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "one\ntwo\nthree\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [
          { old_str: "one", new_str: "ONE" },
          { old_str: "three", new_str: "THREE" },
        ],
        dry_run: false,
        with_diff: true,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Single unified-diff string with both hunks (or one combined hunk).
    expect(res.value.diff).toMatch(/-one/);
    expect(res.value.diff).toMatch(/\+ONE/);
    expect(res.value.diff).toMatch(/-three/);
    expect(res.value.diff).toMatch(/\+THREE/);
  });

  it("oversized diff is truncated at 16 KB with marker + truncated_diff: true", async () => {
    const p = path.join(root, "big.txt");
    // Build a file where a single replacement produces a diff well above 16 KB.
    // 800 distinct lines, each ~50 chars, each line gets a deletion + addition
    // in the diff → ~80 KB of diff body.
    const lines: string[] = [];
    for (let i = 0; i < 800; i++) {
      lines.push(`line-${i.toString().padStart(4, "0")}-${"x".repeat(40)}`);
    }
    await fs.writeFile(p, lines.join("\n") + "\n", "utf8");

    // Single edit that replaces every "x" run with "y" run on every line.
    // We do this by chaining one edit that has expected_count=800 on the "x"*40
    // substring → multi-occurrence replace.
    const res = await editFileImpl(
      {
        path: p,
        edits: [
          {
            old_str: "x".repeat(40),
            new_str: "y".repeat(40),
            expected_count: 800,
          },
        ],
        dry_run: false,
        with_diff: true,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.truncated_diff).toBe(true);
    // Cap is 16 KB; truncated body must be at or under the cap + a small marker.
    expect(res.value.diff.length).toBeLessThanOrEqual(16 * 1024 + 128);
    expect(res.value.diff).toMatch(/truncated/i);
  });

  it("under-cap diff does not set truncated_diff", async () => {
    const p = path.join(root, "small.txt");
    await fs.writeFile(p, "hello\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "hello", new_str: "world" }],
        dry_run: false,
        with_diff: true,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.truncated_diff).toBeUndefined();
  });
});

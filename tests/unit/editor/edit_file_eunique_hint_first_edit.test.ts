import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { editFileImpl } from "../../../src/tools/editor/edit_file.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — edit_file P2.1 regression test.
 *
 * Pre-fix, the EUNIQUE error hint for an absent old_str always said
 * "An earlier edit may have removed the target". For edit[0] this is
 * factually misleading — no prior edit ran. Fix: hint conditional on
 * i > 0.
 */
describe("edit_file: EUNIQUE absence hint is conditional on i > 0 (P2.1)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("edit[0] absent: hint mentions spelling / whitespace, NOT earlier edit", async () => {
    const target = path.join(root, "first.txt");
    await fs.writeFile(target, "hello", "utf8");
    const res = await editFileImpl(
      { path: target, edits: [{ old_str: "missing", new_str: "x", expected_count: 1 }], dry_run: false, with_diff: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.hint).toMatch(/spelling|whitespace/i);
    expect(res.error.hint).not.toMatch(/earlier edit/i);
  });

  it("edit[1] absent after edit[0] removed text: hint references earlier-edit cascade", async () => {
    const target = path.join(root, "second.txt");
    await fs.writeFile(target, "alpha beta", "utf8");
    const res = await editFileImpl(
      {
        path: target,
        edits: [
          { old_str: "alpha", new_str: "", expected_count: 1 }, // removes "alpha"
          { old_str: "alpha", new_str: "x", expected_count: 1 }, // now absent
        ],
        dry_run: false,
        with_diff: true,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.hint).toMatch(/earlier edit/i);
  });
});

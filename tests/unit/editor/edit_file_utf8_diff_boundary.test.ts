import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { editFileImpl } from "../../../src/tools/editor/edit_file.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.9.1 P2.2 — diff body truncation must cut on a UTF-8 codepoint
 * boundary, not a byte boundary. Pre-fix the cap-hit path could leave
 * a partial multi-byte sequence at the tail, which `toString("utf8")`
 * then rendered as U+FFFD replacement character(s). The
 * 16-KB DIFF_BODY_CAP_BYTES is chosen to make this likely whenever the
 * file contains non-ASCII content within striking distance of the cap.
 */
describe("tools/editor/edit_file — UTF-8 codepoint-boundary diff truncation (P2.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("truncated diff does NOT end in U+FFFD replacement char when the cut lands inside a multi-byte sequence", async () => {
    // Build a file that's > 16 KB after the edit, with lots of
    // 4-byte UTF-8 codepoints (math 𝕩 = U+1D569 encoded as F0 9D 95 A9)
    // so any byte-boundary cut has high probability of partial sequence.
    const filler = "𝕩".repeat(5000); // ~20 KB of pure 4-byte sequences
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, `before\n${filler}\nafter\n`, "utf8");

    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "before", new_str: "BEFORE" }],
        dry_run: true, // dry_run so we get the diff without disturbing the file
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    if (res.value.truncated_diff) {
      // Decoded diff string MUST NOT contain U+FFFD before the truncation
      // marker (the marker itself is pure ASCII, so any U+FFFD before it
      // is from a mid-sequence byte cut).
      const markerIdx = res.value.diff.indexOf("... [");
      const head = markerIdx >= 0 ? res.value.diff.slice(0, markerIdx) : res.value.diff;
      expect(head).not.toMatch(/�/);
    }
  });
});

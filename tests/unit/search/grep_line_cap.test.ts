import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { grepImpl } from "../../../src/tools/search/grep.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

// grep P2.7: a single very long line (no newline) was stored verbatim in
// match.match — an attacker-controlled 10 MB line meant 10 MB per match held in
// memory and serialized to the response. Cap the stored line (and context
// lines) with a truncation marker.

describe("tools/search/grep long-line cap (P2.7)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("caps a match line far longer than the cap and appends a truncation marker", async () => {
    const longLine = "x".repeat(200_000) + "NEEDLE" + "y".repeat(200_000);
    await fs.writeFile(path.join(root, "long.txt"), longLine, "utf8");
    const res = await grepImpl(
      { path_glob: path.join(root, "**", "*.txt"), pattern: "NEEDLE", case_sensitive: true, context_lines: 0 },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(1);
    const m = res.value.matches[0]!.match;
    // Far below the original 400k; capped with a marker.
    expect(m.length).toBeLessThan(10_000);
    expect(m).toMatch(/truncated\]$/);
  });

  it("leaves a normal short line unchanged (no marker)", async () => {
    await fs.writeFile(path.join(root, "short.txt"), "alpha NEEDLE gamma\n", "utf8");
    const res = await grepImpl(
      { path_glob: path.join(root, "**", "*.txt"), pattern: "NEEDLE", case_sensitive: true, context_lines: 0 },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches[0]!.match).toBe("alpha NEEDLE gamma");
    expect(res.value.matches[0]!.match).not.toContain("truncated");
  });
});

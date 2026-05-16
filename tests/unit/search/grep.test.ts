import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { grepImpl } from "../../../src/tools/search/grep.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/search/grep", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("finds matches and reports line numbers", async () => {
    const f1 = path.join(root, "a.txt");
    const f2 = path.join(root, "b.txt");
    await fs.writeFile(f1, "alpha\nBETA\ngamma\n", "utf8");
    await fs.writeFile(f2, "delta\nepsilon\nbeta-prime\n", "utf8");

    const res = await grepImpl(
      {
        path_glob: path.join(root, "**", "*.txt"),
        pattern: "beta",
        case_sensitive: false,
        context_lines: 0,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(2);
    const byFile = res.value.matches.map((m) => path.basename(m.file)).sort();
    expect(byFile).toEqual(["a.txt", "b.txt"]);
    expect(res.value.truncated).toBe(false);
  });

  it("returns empty match list, not an error, when nothing matches", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "alpha\nbeta\n", "utf8");
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "nothing-like-that",
        case_sensitive: false,
        context_lines: 0,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches).toEqual([]);
    expect(res.value.total).toBe(0);
  });

  it("returns EINVAL on malformed regex", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "x", "utf8");
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "[unterminated",
        case_sensitive: false,
        context_lines: 0,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("caps at max_matches and surfaces reason='max_matches'", async () => {
    await fs.writeFile(path.join(root, "many.txt"), "hit\nhit\nhit\nhit\nhit\n", "utf8");
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit",
        case_sensitive: false,
        context_lines: 0,
        max_matches: 2,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(2);
    expect(res.value.truncated).toBe(true);
    expect(res.value.reason).toBe("max_matches");
  });

  it("returns context_before / context_after when context_lines > 0", async () => {
    await fs.writeFile(
      path.join(root, "ctx.txt"),
      "line1\nline2\nMATCH\nline4\nline5\n",
      "utf8",
    );
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "MATCH",
        case_sensitive: true,
        context_lines: 2,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(1);
    const m = res.value.matches[0]!;
    expect(m.context_before).toEqual(["line1", "line2"]);
    expect(m.context_after).toEqual(["line4", "line5"]);
  });

  it("returns EPERM_ROOT when the glob base is outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\**\\*.dll" : "/etc/**/*";
    const res = await grepImpl(
      {
        path_glob: outside,
        pattern: "x",
        case_sensitive: false,
        context_lines: 0,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("returns partial results with truncated:true / reason:timeout on deadline expiry", async () => {
    // Create enough files that even a fast walk takes longer than 1ms.
    for (let i = 0; i < 50; i++) {
      const content = "needle\n".repeat(20);
      await fs.writeFile(path.join(root, `f${i}.txt`), content, "utf8");
    }
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "needle",
        case_sensitive: false,
        context_lines: 0,
      },
      config,
      1, // 1ms deadline — guaranteed to expire mid-walk.
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // We may have managed zero or some matches — either way truncated must be set.
    expect(res.value.truncated).toBe(true);
    expect(res.value.reason).toBe("timeout");
  });
});

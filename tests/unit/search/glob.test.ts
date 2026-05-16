import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { globImpl } from "../../../src/tools/search/glob.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/search/glob", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("finds files matching `**` glob", async () => {
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "one.ts"), "x", "utf8");
    await fs.writeFile(path.join(root, "a", "b", "two.ts"), "y", "utf8");
    await fs.writeFile(path.join(root, "a", "skip.md"), "z", "utf8");

    const res = await globImpl(
      { pattern: path.join(root, "**", "*.ts") },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(2);
    expect(res.value.matches.map((m) => path.basename(m)).sort()).toEqual(["one.ts", "two.ts"]);
    expect(res.value.truncated).toBe(false);
  });

  it("returns empty array on no match (not an error)", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "x", "utf8");
    const res = await globImpl(
      { pattern: path.join(root, "**", "*.bogus") },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches).toEqual([]);
    expect(res.value.total).toBe(0);
    expect(res.value.truncated).toBe(false);
  });

  it("caps results at max_results and sets truncated=true", async () => {
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(path.join(root, `f${i}.txt`), "x", "utf8");
    }
    const res = await globImpl(
      { pattern: path.join(root, "*.txt"), max_results: 5 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(5);
    expect(res.value.truncated).toBe(true);
  });

  it("returns EPERM_ROOT when the literal prefix is outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\**\\*.dll" : "/etc/**/*";
    const res = await globImpl({ pattern: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("returns EINVAL for a non-absolute pattern", async () => {
    const res = await globImpl({ pattern: "**/*.ts" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });
});

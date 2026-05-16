import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { listImpl } from "../../../src/tools/fs/list.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/list", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    await fs.writeFile(path.join(root, "a.md"), "a", "utf8");
    await fs.writeFile(path.join(root, "b.txt"), "b", "utf8");
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "c.md"), "c", "utf8");
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("lists immediate children by default (max_depth=1)", async () => {
    const res = await listImpl({ path: root, max_depth: 1 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.md", "b.txt", "sub"]);
  });

  it("recurses up to max_depth", async () => {
    const res = await listImpl({ path: root, max_depth: 2 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name);
    expect(names).toContain("c.md");
    const deep = res.value.entries.find((e) => e.name === "c.md");
    expect(deep?.depth).toBe(2);
  });

  it("filters by glob (basename only)", async () => {
    const res = await listImpl({ path: root, max_depth: 2, glob: "*.md" }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.md", "c.md"]);
  });

  it("returns ENOTDIR for a file path", async () => {
    const res = await listImpl(
      { path: path.join(root, "a.md"), max_depth: 1 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOTDIR");
  });

  it("returns ENOENT for missing dir", async () => {
    const res = await listImpl(
      { path: path.join(root, "missing"), max_depth: 1 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EPERM_ROOT outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const res = await listImpl({ path: outside, max_depth: 1 }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });
});

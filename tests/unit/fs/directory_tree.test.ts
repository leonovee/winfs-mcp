import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { directoryTreeImpl } from "../../../src/tools/fs/directory_tree.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("v0.8 P4.2: directory_tree", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    // Create a small layout:
    //   root/
    //     a.txt
    //     subdir/
    //       b.txt
    //       node_modules/
    //         hide_me.txt
    //     .git/
    //       config
    await fs.writeFile(path.join(root, "a.txt"), "a", "utf8");
    await fs.mkdir(path.join(root, "subdir"));
    await fs.writeFile(path.join(root, "subdir", "b.txt"), "b", "utf8");
    await fs.mkdir(path.join(root, "subdir", "node_modules"));
    await fs.writeFile(path.join(root, "subdir", "node_modules", "hide_me.txt"), "h", "utf8");
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "[]", "utf8");
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns recursive tree with root.children", async () => {
    const res = await directoryTreeImpl({ path: root, max_depth: 3 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.root.type).toBe("directory");
    expect(Array.isArray(res.value.root.children)).toBe(true);
    const childNames = res.value.root.children!.map((c) => c.name).sort();
    expect(childNames).toEqual([".git", "a.txt", "subdir"]);
  });

  it("nested directory has its own children", async () => {
    const res = await directoryTreeImpl({ path: root, max_depth: 3 }, config);
    if (!res.ok) throw new Error("expected ok");
    const subdir = res.value.root.children!.find((c) => c.name === "subdir")!;
    expect(subdir.type).toBe("directory");
    const subChildren = subdir.children!.map((c) => c.name).sort();
    expect(subChildren).toEqual(["b.txt", "node_modules"]);
  });

  it("exclude_patterns hides matching entries (basename only)", async () => {
    const res = await directoryTreeImpl(
      { path: root, max_depth: 3, exclude_patterns: ["node_modules", ".git"] },
      config,
    );
    if (!res.ok) throw new Error("expected ok");
    const topChildren = res.value.root.children!.map((c) => c.name).sort();
    expect(topChildren).toEqual(["a.txt", "subdir"]); // .git filtered out
    const subdir = res.value.root.children!.find((c) => c.name === "subdir")!;
    const subChildren = subdir.children!.map((c) => c.name);
    expect(subChildren).toEqual(["b.txt"]); // node_modules filtered out
  });

  it("exclude_patterns supports basic glob (*.txt)", async () => {
    const res = await directoryTreeImpl(
      { path: root, max_depth: 1, exclude_patterns: ["*.txt"] },
      config,
    );
    if (!res.ok) throw new Error("expected ok");
    const topChildren = res.value.root.children!.map((c) => c.name).sort();
    expect(topChildren).toEqual([".git", "subdir"]); // a.txt filtered
  });

  it("max_depth=1 returns only top-level (subdir.children empty)", async () => {
    const res = await directoryTreeImpl({ path: root, max_depth: 1 }, config);
    if (!res.ok) throw new Error("expected ok");
    const subdir = res.value.root.children!.find((c) => c.name === "subdir")!;
    expect(subdir.children).toEqual([]);
    expect(res.value.truncated).toBe(true);
    expect(res.value.truncated_reason).toBe("max_depth");
  });

  it("EPERM_ROOT on path outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const res = await directoryTreeImpl({ path: outside, max_depth: 1 }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("ENOTDIR when path is a file", async () => {
    const res = await directoryTreeImpl(
      { path: path.join(root, "a.txt"), max_depth: 1 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOTDIR");
  });
});

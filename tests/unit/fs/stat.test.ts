import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { statImpl } from "../../../src/tools/fs/stat.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/stat", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns exists=false (not ENOENT) for a missing path inside allowedRoots", async () => {
    const res = await statImpl({ path: path.join(root, "nope.txt") }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exists).toBe(false);
  });

  it("returns size and is_dir for an existing file", async () => {
    const target = path.join(root, "hello.txt");
    await fs.writeFile(target, "hello", "utf8");
    const res = await statImpl({ path: target }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exists).toBe(true);
    expect(res.value.is_dir).toBe(false);
    expect(res.value.size).toBe(5);
    expect(res.value.mtime).toMatch(/T.*Z$/);
  });

  it("returns is_dir=true for a directory", async () => {
    const res = await statImpl({ path: root }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exists).toBe(true);
    expect(res.value.is_dir).toBe(true);
  });

  it("returns EPERM_ROOT outside allowedRoots even for a non-existent path", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\some-missing-file.tmp" : "/some-missing-file.tmp";
    const res = await statImpl({ path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });
});

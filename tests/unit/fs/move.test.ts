import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { moveImpl } from "../../../src/tools/fs/move.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/move", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("renames a file within the same allowed root", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "hello", "utf8");
    const res = await moveImpl({ src, dst, overwrite: false }, config);
    expect(res.ok).toBe(true);
    expect(await fs.readFile(dst, "utf8")).toBe("hello");
    await expect(fs.stat(src)).rejects.toThrow();
  });

  it("returns ENOENT for a missing source", async () => {
    const res = await moveImpl(
      { src: path.join(root, "missing"), dst: path.join(root, "x"), overwrite: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EPERM_ROOT when src is outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\test.outside" : "/etc/hosts";
    const res = await moveImpl(
      { src: outside, dst: path.join(root, "x"), overwrite: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("returns EPERM_ROOT when dst is outside allowedRoots (and details name dst)", async () => {
    const src = path.join(root, "a.txt");
    await fs.writeFile(src, "x", "utf8");
    const outside = process.platform === "win32" ? "C:\\Windows\\moved.tmp" : "/etc/moved.tmp";
    const res = await moveImpl({ src, dst: outside, overwrite: false }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    expect(res.error.details).toMatchObject({ dst: outside });
  });

  it("returns EEXIST when dst exists and overwrite=false", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "src", "utf8");
    await fs.writeFile(dst, "dst", "utf8");
    const res = await moveImpl({ src, dst, overwrite: false }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
  });

  it("overwrites when overwrite=true", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "src", "utf8");
    await fs.writeFile(dst, "dst", "utf8");
    const res = await moveImpl({ src, dst, overwrite: true }, config);
    expect(res.ok).toBe(true);
    expect(await fs.readFile(dst, "utf8")).toBe("src");
  });
});

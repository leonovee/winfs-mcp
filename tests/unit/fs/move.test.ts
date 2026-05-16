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

  it("renames a file within the same allowed root and flags atomic:true", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "hello", "utf8");
    const res = await moveImpl(
      { src, dst, overwrite: false, allow_cross_volume: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.atomic).toBe(true);
    expect(await fs.readFile(dst, "utf8")).toBe("hello");
    await expect(fs.stat(src)).rejects.toThrow();
  });

  it("returns ENOENT for a missing source", async () => {
    const res = await moveImpl(
      {
        src: path.join(root, "missing"),
        dst: path.join(root, "x"),
        overwrite: false,
        allow_cross_volume: false,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EPERM_ROOT when src is outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\test.outside" : "/etc/hosts";
    const res = await moveImpl(
      { src: outside, dst: path.join(root, "x"), overwrite: false, allow_cross_volume: false },
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
    const res = await moveImpl(
      { src, dst: outside, overwrite: false, allow_cross_volume: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    expect(res.error.details).toMatchObject({ dst: outside });
  });

  it("EXDEV without allow_cross_volume returns EIO with errno:EXDEV (mocked rename)", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "hello", "utf8");
    const origRename = fs.rename;
    let called = false;
    // Mock rename to simulate EXDEV unconditionally.
    (fs as unknown as { rename: typeof origRename }).rename = (async () => {
      called = true;
      const err = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    }) as typeof origRename;
    try {
      const res = await moveImpl(
        { src, dst, overwrite: false, allow_cross_volume: false },
        config,
      );
      expect(called).toBe(true);
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected error");
      expect(res.error.code).toBe("EIO");
      expect(res.error.details).toMatchObject({ errno: "EXDEV" });
      // Source preserved.
      expect(await fs.readFile(src, "utf8")).toBe("hello");
    } finally {
      (fs as unknown as { rename: typeof origRename }).rename = origRename;
    }
  });

  it("EXDEV with allow_cross_volume:true falls back to copy+delete, flags atomic:false", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "hello-xdev", "utf8");
    const origRename = fs.rename;
    (fs as unknown as { rename: typeof origRename }).rename = (async () => {
      const err = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    }) as typeof origRename;
    try {
      const res = await moveImpl(
        { src, dst, overwrite: false, allow_cross_volume: true },
        config,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.value.atomic).toBe(false);
      expect(res.value.moved).toBe(true);
      expect(await fs.readFile(dst, "utf8")).toBe("hello-xdev");
      // Source removed after copy succeeded.
      await expect(fs.stat(src)).rejects.toThrow();
    } finally {
      (fs as unknown as { rename: typeof origRename }).rename = origRename;
    }
  });

  it("returns EEXIST when dst exists and overwrite=false", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "src", "utf8");
    await fs.writeFile(dst, "dst", "utf8");
    const res = await moveImpl({ src, dst, overwrite: false, allow_cross_volume: false }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
  });

  it("overwrites when overwrite=true", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "src", "utf8");
    await fs.writeFile(dst, "dst", "utf8");
    const res = await moveImpl({ src, dst, overwrite: true, allow_cross_volume: false }, config);
    expect(res.ok).toBe(true);
    expect(await fs.readFile(dst, "utf8")).toBe("src");
  });
});

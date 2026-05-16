import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  copyImpl,
  getFullSkipCountForAudit,
} from "../../../src/tools/fs/copy.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/copy", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("copies a single file and reports byte+file counts", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "hello", "utf8");
    const res = await copyImpl({ src, dst, overwrite: false, recursive: true }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.files_copied).toBe(1);
    expect(res.value.bytes_copied).toBe(5);
    expect(res.value.files_skipped).toBe(0);
    expect(await fs.readFile(dst, "utf8")).toBe("hello");
    // src is preserved.
    expect(await fs.readFile(src, "utf8")).toBe("hello");
  });

  it("recursively copies a directory tree", async () => {
    const srcDir = path.join(root, "tree");
    await fs.mkdir(path.join(srcDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "a.txt"), "aaa", "utf8");
    await fs.writeFile(path.join(srcDir, "sub", "b.txt"), "bbbb", "utf8");
    const dstDir = path.join(root, "copy");
    const res = await copyImpl({ src: srcDir, dst: dstDir, overwrite: false, recursive: true }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.files_copied).toBe(2);
    expect(res.value.bytes_copied).toBe(7);
    expect(await fs.readFile(path.join(dstDir, "a.txt"), "utf8")).toBe("aaa");
    expect(await fs.readFile(path.join(dstDir, "sub", "b.txt"), "utf8")).toBe("bbbb");
  });

  it("returns EISDIR when copying a directory with recursive=false", async () => {
    const srcDir = path.join(root, "tree");
    await fs.mkdir(srcDir);
    const dstDir = path.join(root, "copy");
    const res = await copyImpl(
      { src: srcDir, dst: dstDir, overwrite: false, recursive: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });

  it("returns EEXIST when dst exists and overwrite=false", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "x", "utf8");
    await fs.writeFile(dst, "y", "utf8");
    const res = await copyImpl({ src, dst, overwrite: false, recursive: true }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
  });

  it("returns ENOENT for a missing source", async () => {
    const res = await copyImpl(
      {
        src: path.join(root, "nope"),
        dst: path.join(root, "x"),
        overwrite: false,
        recursive: true,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EPERM_ROOT for a destination outside allowedRoots", async () => {
    const src = path.join(root, "a.txt");
    await fs.writeFile(src, "x", "utf8");
    const outside = process.platform === "win32" ? "C:\\Windows\\copy-out.tmp" : "/etc/copy-out.tmp";
    const res = await copyImpl(
      { src, dst: outside, overwrite: false, recursive: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("records full files_skipped_total for audit when skipped_paths is capped at 10", async () => {
    // Build a synthetic tree of 15 symlinks that all escape the sandbox.
    // We skip if the host can't create symlinks (Win10 non-elevated user).
    const { config: cfgOutside, root: outsideRoot } = await makeTempConfig();
    try {
      await fs.writeFile(path.join(outsideRoot, "leak.txt"), "leak", "utf8");
      const srcDir = path.join(root, "tree");
      await fs.mkdir(srcDir);
      for (let i = 0; i < 15; i++) {
        try {
          await fs.symlink(outsideRoot, path.join(srcDir, `escape-${i}`), "dir");
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e?.code === "EPERM" || e?.code === "EACCES") return; // skip on locked-down hosts
          throw err;
        }
      }
      const dstDir = path.join(root, "copy");
      const res = await copyImpl(
        { src: srcDir, dst: dstDir, overwrite: false, recursive: true },
        config,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      // Response array is capped at 10 even though full count is 15.
      expect(res.value.skipped_paths.length).toBe(10);
      expect(res.value.files_skipped).toBe(15);
      // Audit-only sidechannel reflects the full count for telemetry.
      expect(getFullSkipCountForAudit(res.value)).toBe(15);
    } finally {
      await cleanupTempConfig(outsideRoot);
      void cfgOutside;
    }
  });

  it("skips symlink-escape entries inside a recursive tree (spec amendment §B)", async () => {
    // Place a symlink that points OUTSIDE the allowed root. We expect copy
    // to skip it silently and count it in files_skipped. Skip the test if
    // the host lacks symlink-creation rights (Win10 non-elevated).
    const { config: cfgOutside, root: outsideRoot } = await makeTempConfig();
    try {
      await fs.writeFile(path.join(outsideRoot, "leak.txt"), "leak", "utf8");
      const srcDir = path.join(root, "tree");
      await fs.mkdir(srcDir);
      await fs.writeFile(path.join(srcDir, "ok.txt"), "ok", "utf8");
      const escapingLink = path.join(srcDir, "escape");
      try {
        await fs.symlink(outsideRoot, escapingLink, "dir");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code === "EPERM" || e?.code === "EACCES") return; // skip on locked-down hosts
        throw err;
      }

      const dstDir = path.join(root, "copy");
      const res = await copyImpl(
        { src: srcDir, dst: dstDir, overwrite: false, recursive: true },
        config,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.value.files_copied).toBe(1);
      expect(res.value.files_skipped).toBeGreaterThanOrEqual(1);
      // The escaping link should NOT have been followed — leak.txt must not appear in dst.
      await expect(fs.stat(path.join(dstDir, "escape", "leak.txt"))).rejects.toThrow();
    } finally {
      await cleanupTempConfig(outsideRoot);
      void cfgOutside;
    }
  });
});

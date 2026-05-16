import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeImpl } from "../../../src/tools/fs/write.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/write", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("creates a new UTF-8 file without BOM and reports created=true", async () => {
    const target = path.join(root, "hello.txt");
    const res = await writeImpl(
      { path: target, content: "Привет, мир", overwrite: true, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.created).toBe(true);

    const buf = await fs.readFile(target);
    expect(buf[0]).not.toBe(0xef); // no BOM
    expect(buf.toString("utf8")).toBe("Привет, мир");
  });

  it("returns EEXIST when overwrite=false and file exists", async () => {
    const target = path.join(root, "exists.txt");
    await fs.writeFile(target, "old", "utf8");
    const res = await writeImpl(
      { path: target, content: "new", overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
  });

  it("creates parents when mkdirParents=true", async () => {
    const target = path.join(root, "a", "b", "c", "deep.txt");
    const res = await writeImpl(
      { path: target, content: "hi", overwrite: true, mkdirParents: true },
      config,
    );
    expect(res.ok).toBe(true);
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("hi");
  });

  it("returns ENOENT when parent missing and mkdirParents=false", async () => {
    const target = path.join(root, "missing-dir", "file.txt");
    const res = await writeImpl(
      { path: target, content: "x", overwrite: true, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EPERM_ROOT for a target outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\test.txt" : "/tmp_outside.txt";
    const res = await writeImpl(
      { path: outside, content: "x", overwrite: true, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });
});

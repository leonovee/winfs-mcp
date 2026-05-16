import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { mkdirImpl } from "../../../src/tools/fs/mkdir.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/mkdir", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("creates a single directory and reports created=true", async () => {
    const target = path.join(root, "single");
    const res = await mkdirImpl({ path: target, recursive: true }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.created).toBe(true);
    const st = await fs.stat(target);
    expect(st.isDirectory()).toBe(true);
  });

  it("creates nested directories with recursive=true", async () => {
    const target = path.join(root, "a", "b", "c");
    const res = await mkdirImpl({ path: target, recursive: true }, config);
    expect(res.ok).toBe(true);
    const st = await fs.stat(target);
    expect(st.isDirectory()).toBe(true);
  });

  it("is idempotent on an existing directory when recursive=true (created=false, no error)", async () => {
    const target = path.join(root, "idem");
    await fs.mkdir(target);
    const res = await mkdirImpl({ path: target, recursive: true }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.created).toBe(false);
  });

  it("returns EEXIST when recursive=false and the directory exists", async () => {
    const target = path.join(root, "exists");
    await fs.mkdir(target);
    const res = await mkdirImpl({ path: target, recursive: false }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
  });

  it("returns EEXIST when target is a regular file", async () => {
    const target = path.join(root, "file.txt");
    await fs.writeFile(target, "data", "utf8");
    const res = await mkdirImpl({ path: target, recursive: true }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
  });

  it("returns EPERM_ROOT for a target outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\test-mkdir-v02" : "/tmp/mcp-outside-v02";
    const res = await mkdirImpl({ path: outside, recursive: true }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { moveImpl } from "../../src/tools/fs/move.js";
import { copyImpl } from "../../src/tools/fs/copy.js";
import { mkdirImpl } from "../../src/tools/fs/mkdir.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * Spec amendment 2026-05-16 §B + v0.2 hard invariant: both src AND dst must
 * be inside allowedRoots after realpath. It is not enough to check just one.
 */
describe("invariant: both-roots check for mutation tools (v0.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("move: rejects when only src is inside allowed (dst outside) → EPERM_ROOT", async () => {
    const src = path.join(root, "a.txt");
    await fs.writeFile(src, "x", "utf8");
    const outside =
      process.platform === "win32" ? "C:\\Windows\\moved.tmp" : "/etc/moved.tmp";
    const res = await moveImpl({ src, dst: outside, overwrite: false }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    // src didn't move.
    expect(await fs.readFile(src, "utf8")).toBe("x");
  });

  it("move: rejects when only dst is inside allowed (src outside) → EPERM_ROOT", async () => {
    const dst = path.join(root, "moved.txt");
    const outside =
      process.platform === "win32" ? "C:\\Windows\\System32\\notepad.exe" : "/etc/hostname";
    const res = await moveImpl({ src: outside, dst, overwrite: false }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("copy: rejects dst outside even when src is fine → EPERM_ROOT", async () => {
    const src = path.join(root, "a.txt");
    await fs.writeFile(src, "x", "utf8");
    const outside =
      process.platform === "win32" ? "C:\\Windows\\copy-out.tmp" : "/etc/copy-out.tmp";
    const res = await copyImpl(
      { src, dst: outside, overwrite: false, recursive: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("copy: rejects src outside even when dst is fine → EPERM_ROOT", async () => {
    const outside =
      process.platform === "win32" ? "C:\\Windows\\System32\\notepad.exe" : "/etc/hostname";
    const dst = path.join(root, "imported");
    const res = await copyImpl(
      { src: outside, dst, overwrite: false, recursive: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("mkdir: target outside allowed root → EPERM_ROOT, no silent create", async () => {
    const outside =
      process.platform === "win32" ? "C:\\Windows\\test-mkdir-bothroots" : "/tmp/mcp-outside";
    const res = await mkdirImpl({ path: outside, recursive: true }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    // Sanity: directory was NOT created.
    let created = false;
    try {
      await fs.stat(outside);
      created = true;
    } catch {
      created = false;
    }
    expect(created).toBe(false);
  });
});

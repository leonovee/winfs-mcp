import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeChunkImpl } from "../../src/tools/file/write_chunk.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * v0.6 §V invariant #31: write_chunk is deliberately NON-ATOMIC.
 *
 * The contract guarantee is the inverse of `write`: no temp file, no
 * fsync ceremony, no atomic rename — just `fs.open(r+)` + `fileHandle.write`
 * at the requested offset. This file pins that contract so future
 * refactoring can't silently slip an atomic-write path back in.
 *
 * Properties verified:
 *   1. Response includes `atomic: false`.
 *   2. No `.tmp` artifact created during or after the call (in contrast to
 *      `write`'s temp+fsync+rename strategy).
 *   3. The mutation is observable on the original inode immediately
 *      (no intermediate phantom file).
 */
describe("invariant: write_chunk is non-atomic by design (v0.6 §V #31)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("response carries atomic: false (literal, not a generic boolean)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "ABCDE", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 1, content: "X", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.atomic).toBe(false);
  });

  it("does NOT create a .tmp artifact in the parent directory", async () => {
    const p = path.join(root, "no_temp.txt");
    await fs.writeFile(p, "ABCDE", "utf8");
    const before = await fs.readdir(root);
    const res = await writeChunkImpl(
      { path: p, offset: 1, content: "X", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    const after = await fs.readdir(root);
    // Same directory contents → no .tmp / atomic-write artifact was ever
    // created. Contrast with write, which leaves a `.<base>.<rand>.tmp` file
    // briefly during its atomic ceremony.
    expect(after.sort()).toEqual(before.sort());
    expect(after.find((n) => /\.tmp$/i.test(n))).toBeUndefined();
  });

  it("mutation is on the original inode (not a renamed replacement)", async () => {
    const p = path.join(root, "inode.txt");
    await fs.writeFile(p, "ABCDE", "utf8");
    const inoBefore = (await fs.stat(p)).ino;
    const res = await writeChunkImpl(
      { path: p, offset: 0, content: "Z", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    const inoAfter = (await fs.stat(p)).ino;
    // Same inode confirms in-place write. write() (atomic) would rename a new
    // file over the original → different inode on POSIX. Windows often
    // reports ino=0 for both — assert "not changed" rather than "non-zero".
    expect(inoAfter).toBe(inoBefore);
    expect(await fs.readFile(p, "utf8")).toBe("ZBCDE");
  });
});

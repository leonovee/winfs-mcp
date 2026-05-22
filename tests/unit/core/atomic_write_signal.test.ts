import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as nodefs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../src/core/atomic_write.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";

/**
 * v0.7 pre-tag bug-fix wave — Phase 1 precursor for edit_file P1.1.
 *
 * atomicWriteFile and atomicAppend now accept an optional AbortSignal.
 * When abort fires before rename, the temp file is unlinked and an
 * abort error thrown. Existing callers pass no signal and see no behavior
 * change.
 */
describe("core/atomic_write — AbortSignal support (v0.7 bug-fix wave)", () => {
  let root: string;

  beforeEach(async () => {
    ({ root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("backward-compat: no signal argument, behavior unchanged", async () => {
    const target = path.join(root, "no-signal.txt");
    await atomicWriteFile(target, "hello");
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("hello");
  });

  it("pre-aborted signal throws abort error without creating destination file", async () => {
    const target = path.join(root, "pre-aborted.txt");
    const controller = new AbortController();
    controller.abort();
    await expect(atomicWriteFile(target, "should not land", { signal: controller.signal }))
      .rejects.toThrow();
    await expect(fs.access(target)).rejects.toThrow(/ENOENT/);
  });

  it("not-aborted signal allows write to complete normally", async () => {
    const target = path.join(root, "not-aborted.txt");
    const controller = new AbortController();
    await atomicWriteFile(target, "ok", { signal: controller.signal });
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("ok");
  });

  it("abort fired between fsync and rename leaves no .tmp orphan in destination dir", async () => {
    const target = path.join(root, "mid-abort.txt");
    const controller = new AbortController();

    // Hook fs.rename so we can trigger the abort after the temp file is
    // synced but before rename completes.
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (src: nodefs.PathLike, dst: nodefs.PathLike) => {
      controller.abort();
      // After abort fires, the atomic write should observe the aborted
      // state and bail without renaming. We never actually call realRename.
      void realRename;
      void src;
      void dst;
      throw Object.assign(new Error("test: forced rename failure"), { code: "EIO" });
    });

    await expect(atomicWriteFile(target, "data", { signal: controller.signal }))
      .rejects.toThrow();

    // No destination file (the mocked rename failed) and the temp got
    // cleaned up (no leftover .*.tmp file in the destination dir).
    await expect(fs.access(target)).rejects.toThrow(/ENOENT/);
    const entries = await fs.readdir(root);
    const tmpLeft = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpLeft).toEqual([]);

    vi.restoreAllMocks();
  });
});

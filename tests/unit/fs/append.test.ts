import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { appendImpl } from "../../../src/tools/fs/append.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/append", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("appends UTF-8 text to an existing file", async () => {
    const target = path.join(root, "log.txt");
    await fs.writeFile(target, "first\n", "utf8");
    const res = await appendImpl({ path: target, content: "second\n" }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.bytes_added).toBe(Buffer.byteLength("second\n", "utf8"));
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("first\nsecond\n");
  });

  it("returns ENOENT when target is missing", async () => {
    const res = await appendImpl(
      { path: path.join(root, "missing.txt"), content: "x" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EISDIR when target is a directory", async () => {
    const res = await appendImpl({ path: root, content: "x" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });

  it("returns EPERM_ROOT outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\test.log" : "/tmp_outside.log";
    const res = await appendImpl({ path: outside, content: "x" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });
});

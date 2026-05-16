import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readImpl } from "../../../src/tools/fs/read.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/read", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("reads a UTF-8 file with Russian text round-trip", async () => {
    const target = path.join(root, "session_log.md");
    const original = "Привет, мир\nstrings co-exist\n";
    await fs.writeFile(target, original, "utf8");

    const res = await readImpl({ path: target }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe(original);
    expect(res.value.bytes_returned).toBe(Buffer.byteLength(original, "utf8"));
    expect(res.value.truncated).toBe(false);
  });

  it("strips a leading UTF-8 BOM", async () => {
    const target = path.join(root, "with-bom.txt");
    await fs.writeFile(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]));

    const res = await readImpl({ path: target }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("hello");
  });

  it("returns EISDIR for a directory", async () => {
    const res = await readImpl({ path: root }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });

  it("returns ENOENT for missing path", async () => {
    const res = await readImpl({ path: path.join(root, "nope.txt") }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("returns EPERM_ROOT for a path outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\notepad.exe" : "/etc/hostname";
    const res = await readImpl({ path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    expect(res.error.hint).toMatch(/allowedRoots/);
  });

  it("returns EENCODING for binary content", async () => {
    const target = path.join(root, "binary.bin");
    await fs.writeFile(target, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const res = await readImpl({ path: target }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EENCODING");
  });

  it("returns ETOOLARGE when file size exceeds max_bytes", async () => {
    const target = path.join(root, "big.txt");
    await fs.writeFile(target, "a".repeat(2048), "utf8");
    const res = await readImpl({ path: target, max_bytes: 1024 }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ETOOLARGE");
  });

  it("honors a 1-based inclusive line range", async () => {
    const target = path.join(root, "lines.txt");
    await fs.writeFile(target, "a\nb\nc\nd\ne\n", "utf8");
    const res = await readImpl({ path: target, range: [2, 4] }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("b\nc\nd");
    expect(res.value.lines_returned).toBe(3);
  });
});

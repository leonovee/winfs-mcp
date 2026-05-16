import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readSectionImpl } from "../../../src/tools/slicing/read_section.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/slicing/read_section", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("line_range slice returns the requested lines", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "L1\nL2\nL3\nL4\nL5\n", "utf8");
    const res = await readSectionImpl(
      { path: p, line_range: [2, 4], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("L2\nL3\nL4");
    expect(res.value.range).toEqual({ kind: "line", start: 2, end: 4 });
    expect(res.value.total_lines).toBe(5);
    expect(res.value.encoding).toBe("utf8");
  });

  it("byte_range slice returns the requested bytes (utf8 ASCII clean)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "0123456789", "utf8");
    const res = await readSectionImpl(
      { path: p, byte_range: [2, 5], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("2345");
    expect(res.value.range).toEqual({ kind: "byte", start: 2, end: 5 });
    expect(res.value.total_bytes).toBe(10);
    expect(res.value.adjusted).toBeUndefined();
  });

  it("both selectors → EINVAL", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "x\ny\n", "utf8");
    const res = await readSectionImpl(
      { path: p, line_range: [1, 1], byte_range: [0, 0], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("neither selector → EINVAL", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "x\ny\n", "utf8");
    const res = await readSectionImpl({ path: p, encoding: "utf8" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("line_range end > total_lines → EINVAL", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "L1\nL2\n", "utf8");
    const res = await readSectionImpl(
      { path: p, line_range: [1, 10], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("byte_range straddling a UTF-8 multi-byte sequence sets adjusted:true", async () => {
    const p = path.join(root, "f.txt");
    // "Π" is 2-byte UTF-8 (CE A0); "Z" is ASCII. Layout:
    //   bytes: [0xCE, 0xA0, 0xCE, 0xA0, 0x5A]
    //   chars:  Π Π Z
    // byte_range [1, 3] cuts mid-Π on both ends → trim should leave just
    // the middle complete Π (bytes 2..3 = CE A0).
    await fs.writeFile(p, "ΠΠZ", "utf8");
    const res = await readSectionImpl(
      { path: p, byte_range: [1, 3], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.adjusted).toBe(true);
    expect(res.value.content).toBe("Π");
  });

  it("encoding: 'raw' returns base64 of the exact byte slice", async () => {
    const p = path.join(root, "f.bin");
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    await fs.writeFile(p, bytes);
    const res = await readSectionImpl(
      { path: p, byte_range: [0, 4], encoding: "raw" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.encoding).toBe("raw");
    expect(Buffer.from(res.value.content, "base64").equals(bytes)).toBe(true);
  });

  it("ETOOLARGE when slice exceeds readMaxBytes", async () => {
    const tight = { ...config, readMaxBytes: 4 };
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "0123456789", "utf8");
    const res = await readSectionImpl(
      { path: p, byte_range: [0, 9], encoding: "utf8" },
      tight,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ETOOLARGE");
  });

  it("EPERM_ROOT when path is outside allowedRoots", async () => {
    const outside =
      process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
    const res = await readSectionImpl(
      { path: outside, line_range: [1, 1], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("ENOENT for missing file", async () => {
    const res = await readSectionImpl(
      { path: path.join(root, "no.txt"), line_range: [1, 1], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("EISDIR when path is a directory", async () => {
    const d = path.join(root, "d");
    await fs.mkdir(d);
    const res = await readSectionImpl(
      { path: d, line_range: [1, 1], encoding: "utf8" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readMediaFileImpl } from "../../../src/tools/file/read_media_file.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("v0.8 P4.4: read_media_file", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("reads a PNG file and returns base64 + correct content_type", async () => {
    // Minimal 1×1 transparent PNG.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const file = path.join(root, "pixel.png");
    await fs.writeFile(file, pngBytes);

    const res = await readMediaFileImpl({ path: file }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content_type).toBe("image/png");
    expect(res.value.bytes_read).toBe(pngBytes.length);
    expect(res.value.truncated).toBe(false);
    // Round-trip the base64 back to bytes and confirm equality.
    const roundTrip = Buffer.from(res.value.base64, "base64");
    expect(roundTrip.equals(pngBytes)).toBe(true);
  });

  it("maps common extensions to content-types", async () => {
    const cases: Array<[string, string]> = [
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.webp", "image/webp"],
      ["a.svg", "image/svg+xml"],
      ["a.pdf", "application/pdf"],
      ["a.mp3", "audio/mpeg"],
      ["a.wav", "audio/wav"],
      ["a.mp4", "video/mp4"],
    ];
    for (const [name, expected] of cases) {
      const p = path.join(root, name);
      await fs.writeFile(p, Buffer.from([0]));
      const res = await readMediaFileImpl({ path: p }, config);
      if (!res.ok) throw new Error(`expected ok for ${name}: ${res.error.code}`);
      expect(res.value.content_type).toBe(expected);
    }
  });

  it("unknown extension → application/octet-stream", async () => {
    const file = path.join(root, "weird.xyz");
    await fs.writeFile(file, Buffer.from([1, 2, 3]));
    const res = await readMediaFileImpl({ path: file }, config);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content_type).toBe("application/octet-stream");
  });

  it("ETOOLARGE when file > 16 MB default and max_bytes not specified", async () => {
    // Write a file just over the default 16 MB cap (17 MB).
    const big = path.join(root, "big.bin");
    const seventeenMb = Buffer.alloc(17 * 1024 * 1024);
    await fs.writeFile(big, seventeenMb);
    const res = await readMediaFileImpl({ path: big }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ETOOLARGE");
  }, 30_000);

  it("max_bytes:N opts into truncation; returns truncated:true with N bytes", async () => {
    const file = path.join(root, "med.bin");
    const oneKb = Buffer.alloc(1024).fill(0x41); // 'A' * 1024
    await fs.writeFile(file, oneKb);
    const res = await readMediaFileImpl({ path: file, max_bytes: 100 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.truncated).toBe(true);
    expect(res.value.bytes_read).toBe(100);
    const roundTrip = Buffer.from(res.value.base64, "base64");
    expect(roundTrip.length).toBe(100);
    expect(roundTrip.every((b) => b === 0x41)).toBe(true);
  });

  it("EPERM_ROOT on path outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\notepad.exe" : "/bin/ls";
    const res = await readMediaFileImpl({ path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("EISDIR when path is a directory", async () => {
    const res = await readMediaFileImpl({ path: root }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });
});

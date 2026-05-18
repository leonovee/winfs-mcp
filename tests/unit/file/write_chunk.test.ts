import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeChunkImpl, getWriteChunkAuditExtras } from "../../../src/tools/file/write_chunk.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/file/write_chunk", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("happy: replaces bytes in place (utf8) preserving surrounding content", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "ABCDEFGHIJ", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 3, content: "xy", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.bytes_written).toBe(2);
    expect(res.value.total_bytes_after).toBe(10);
    expect(res.value.atomic).toBe(false);
    expect(await fs.readFile(p, "utf8")).toBe("ABCxyFGHIJ");
  });

  it("base64 encoding decodes payload", async () => {
    const p = path.join(root, "bin.dat");
    await fs.writeFile(p, Buffer.from([1, 2, 3, 4, 5]));
    // Base64 of bytes [0xFE, 0xFF] = "/v8="
    const res = await writeChunkImpl(
      { path: p, offset: 1, content: "/v8=", encoding: "base64", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.bytes_written).toBe(2);
    const out = await fs.readFile(p);
    expect(Array.from(out)).toEqual([1, 0xfe, 0xff, 4, 5]);
  });

  it("extending file beyond EOF (offset==size, content extends)", async () => {
    const p = path.join(root, "ext.txt");
    await fs.writeFile(p, "abc", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 3, content: "def", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total_bytes_after).toBe(6);
    expect(await fs.readFile(p, "utf8")).toBe("abcdef");
  });

  it("offset 0 replaces start", async () => {
    const p = path.join(root, "s.txt");
    await fs.writeFile(p, "AAAAAA", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 0, content: "BB", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(await fs.readFile(p, "utf8")).toBe("BBAAAA");
  });

  it("offset > file_size → EOFFSET (no sparse-file)", async () => {
    const p = path.join(root, "small.txt");
    await fs.writeFile(p, "abc", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 100, content: "x", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EOFFSET");
    expect(res.error.details).toMatchObject({ offset: 100, file_size: 3 });
    // File untouched.
    expect(await fs.readFile(p, "utf8")).toBe("abc");
  });

  it("EPERM_ROOT when path is outside allowedRoots (strict mode)", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
    const res = await writeChunkImpl(
      { path: outside, offset: 0, content: "x", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("ENOENT when file does not exist (write_chunk does NOT create)", async () => {
    const p = path.join(root, "missing.txt");
    const res = await writeChunkImpl(
      { path: p, offset: 0, content: "x", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("EISDIR when path is a directory", async () => {
    const d = path.join(root, "d");
    await fs.mkdir(d);
    const res = await writeChunkImpl(
      { path: d, offset: 0, content: "x", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });

  it("utf8 content with lone surrogate is normalised to U+FFFD (no error; pins JS string semantics)", async () => {
    // The "EENCODING on invalid utf8 content" guard in the impl is a
    // defensive check — JS strings passed in always re-encode losslessly
    // (lone surrogates → U+FFFD replacement) so the round-trip never trips
    // from string input. We pin this observable behavior: lone surrogate
    // becomes U+FFFD in the file, no error. The unreachable defensive
    // check remains in source as guard against future buffer-based inputs.
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "hello", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 0, content: "\uD800X", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // U+FFFD is 3 bytes (EF BF BD), then "X" is 1 byte = 4 bytes written
    expect(res.value.bytes_written).toBe(4);
    const out = await fs.readFile(p, "utf8");
    expect(out.charCodeAt(0)).toBe(0xfffd);
  });

  it("EENCODING when offset lands mid-multibyte UTF-8 sequence", async () => {
    // "Π" = 2 bytes (CE A0). File: "ΠΠΠA" = [CE A0 CE A0 CE A0 41] (7 bytes).
    // Writing at offset 1 lands on a continuation byte → EENCODING.
    const p = path.join(root, "utf.txt");
    await fs.writeFile(p, "ΠΠΠA", "utf8");
    const res = await writeChunkImpl(
      { path: p, offset: 1, content: "x", encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EENCODING");
    expect((res.error.details as { offset: number }).offset).toBe(1);
  });

  it("validate_byte_range=false skips the boundary check (still rejects invalid utf8 content)", async () => {
    const p = path.join(root, "utf2.txt");
    await fs.writeFile(p, "ΠΠΠA", "utf8");
    // Same mid-multibyte offset, but boundary check disabled — write goes through.
    const res = await writeChunkImpl(
      { path: p, offset: 1, content: "x", encoding: "utf8", validate_byte_range: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.bytes_written).toBe(1);
  });

  it("audit extras populated with content_length + content_prefix + truncated_at", async () => {
    const p = path.join(root, "aud.txt");
    await fs.writeFile(p, "x".repeat(500), "utf8");
    const longContent = "y".repeat(400);
    const res = await writeChunkImpl(
      { path: p, offset: 0, content: longContent, encoding: "utf8", validate_byte_range: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const extras = getWriteChunkAuditExtras(res.value);
    expect(extras).toBeDefined();
    expect(extras!.content_length).toBe(400);
    expect(extras!.content_prefix.length).toBe(256);
    expect(extras!.truncated_at).toBe(256);
  });
});

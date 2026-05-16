import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readSinceImpl } from "../../../src/tools/slicing/read_since.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/slicing/read_since", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("steady-state: since_offset === total_bytes returns empty content", async () => {
    const p = path.join(root, "log.txt");
    await fs.writeFile(p, "hello\n", "utf8");
    const size = (await fs.stat(p)).size;
    const res = await readSinceImpl({ path: p, since_offset: size }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("");
    expect(res.value.new_offset).toBe(size);
    expect(res.value.truncated).toBe(false);
    expect(res.value.file_rotated).toBe(false);
  });

  it("append: returns the delta from since_offset to EOF", async () => {
    const p = path.join(root, "log.txt");
    await fs.writeFile(p, "AAA", "utf8");
    const offset1 = 3;
    await fs.appendFile(p, "BBB", "utf8");
    const res = await readSinceImpl({ path: p, since_offset: offset1 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("BBB");
    expect(res.value.new_offset).toBe(6);
    expect(res.value.file_rotated).toBe(false);
  });

  it("truncated:true when delta > max_bytes", async () => {
    const p = path.join(root, "log.txt");
    const big = "x".repeat(2048);
    await fs.writeFile(p, big, "utf8");
    const res = await readSinceImpl(
      { path: p, since_offset: 0, max_bytes: 256 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.truncated).toBe(true);
    expect(res.value.content.length).toBeLessThanOrEqual(256);
    expect(res.value.new_offset).toBeLessThan(2048);
  });

  it("rotation: total_bytes < since_offset returns whole file with file_rotated:true", async () => {
    const p = path.join(root, "log.txt");
    await fs.writeFile(p, "ORIGINAL_LARGE_LOG", "utf8");
    const oldOffset = 100; // beyond current EOF
    const res = await readSinceImpl({ path: p, since_offset: oldOffset }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.file_rotated).toBe(true);
    expect(res.value.content).toBe("ORIGINAL_LARGE_LOG");
    expect(res.value.new_offset).toBe(res.value.total_bytes);
  });

  it("UTF-8 boundary: since_offset mid-multibyte advances forward silently (≤3 bytes)", async () => {
    // "Π" = 2 bytes (CE A0). Place 3 Π's then ASCII to ensure offset lands mid-multibyte.
    // File: ΠΠΠA = [CE A0 CE A0 CE A0 41] (7 bytes total).
    // since_offset = 1 falls on the continuation byte of the first Π. Advance to byte 2.
    const p = path.join(root, "log.txt");
    await fs.writeFile(p, "ΠΠΠA", "utf8");
    const res = await readSinceImpl({ path: p, since_offset: 1 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Skipped 1 byte from since_offset=1 → start at byte 2.
    // Content should be the 2 remaining Π's + A = "ΠΠA".
    expect(res.value.content).toBe("ΠΠA");
    expect(res.value.new_offset).toBe(7);
  });

  it("EPERM_ROOT for path outside allowedRoots", async () => {
    const outside =
      process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
    const res = await readSinceImpl({ path: outside, since_offset: 0 }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("ENOENT for missing file", async () => {
    const res = await readSinceImpl(
      { path: path.join(root, "missing.log"), since_offset: 0 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("mtime field surfaced as ISO string", async () => {
    const p = path.join(root, "log.txt");
    await fs.writeFile(p, "hello", "utf8");
    const res = await readSinceImpl({ path: p, since_offset: 0 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

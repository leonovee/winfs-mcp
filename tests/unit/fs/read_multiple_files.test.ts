import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readMultipleFilesImpl } from "../../../src/tools/fs/read_multiple_files.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/read_multiple_files", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns all-good with content blocks for each path", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "AAA", "utf8");
    await fs.writeFile(b, "BB", "utf8");

    const res = await readMultipleFilesImpl({ paths: [a, b] }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(2);
    expect(res.value.ok_count).toBe(2);
    expect(res.value.error_count).toBe(0);
    const contents = res.value.files
      .map((f) => ("content" in f ? f.content : null))
      .filter(Boolean)
      .sort();
    expect(contents).toEqual(["AAA", "BB"].sort());
  });

  it("returns mixed results: one ok + one ENOENT + one EPERM_ROOT (top-level still ok=true)", async () => {
    const good = path.join(root, "good.txt");
    await fs.writeFile(good, "yes", "utf8");
    const missing = path.join(root, "missing.txt");
    const outside =
      process.platform === "win32" ? "C:\\Windows\\bad.txt" : "/etc/bad.txt";

    const res = await readMultipleFilesImpl(
      { paths: [good, missing, outside] },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(3);
    expect(res.value.ok_count).toBe(1);
    expect(res.value.error_count).toBe(2);

    const byPath = Object.fromEntries(res.value.files.map((f) => [f.path, f]));
    expect("content" in byPath[good]!).toBe(true);
    expect("error" in byPath[missing]!).toBe(true);
    if (!("error" in byPath[missing]!)) throw new Error("expected error");
    expect(byPath[missing]!.error.code).toBe("ENOENT");
    if (!("error" in byPath[outside]!)) throw new Error("expected error");
    expect(byPath[outside]!.error.code).toBe("EPERM_ROOT");
  });

  it("returns all-bad when every path fails (top-level still ok=true)", async () => {
    const a = path.join(root, "missing-a.txt");
    const b = path.join(root, "missing-b.txt");
    const res = await readMultipleFilesImpl({ paths: [a, b] }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.ok_count).toBe(0);
    expect(res.value.error_count).toBe(2);
    expect(res.value.files.every((f) => "error" in f)).toBe(true);
  });

  it("applies a uniform line range to every successful file", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "L1a\nL2a\nL3a\nL4a\n", "utf8");
    await fs.writeFile(b, "L1b\nL2b\nL3b\n", "utf8");

    const res = await readMultipleFilesImpl({ paths: [a, b], range: [2, 3] }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const byPath = Object.fromEntries(res.value.files.map((f) => [f.path, f]));
    expect("content" in byPath[a]!).toBe(true);
    if (!("content" in byPath[a]!)) throw new Error("expected content");
    expect(byPath[a]!.content).toBe("L2a\nL3a");
    if (!("content" in byPath[b]!)) throw new Error("expected content");
    expect(byPath[b]!.content).toBe("L2b\nL3b");
  });
});

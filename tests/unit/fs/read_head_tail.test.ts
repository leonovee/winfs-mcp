import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readImpl } from "../../../src/tools/fs/read.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.8 P4.1 — read tool gains head:N and tail:N convenience params.
 * Both compose to the existing range path; mutually exclusive with each
 * other and with range.
 */
describe("v0.8 P4.1: read head/tail params", () => {
  let config: ResolvedConfig;
  let root: string;
  let file: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    file = path.join(root, "lines.txt");
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    await fs.writeFile(file, lines, "utf8");
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("head:3 returns lines 1-3", async () => {
    const res = await readImpl({ path: file, head: 3 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("line 1\nline 2\nline 3");
    expect(res.value.lines_returned).toBe(3);
  });

  it("tail:4 returns the last 4 lines (17-20)", async () => {
    const res = await readImpl({ path: file, tail: 4 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("line 17\nline 18\nline 19\nline 20");
    expect(res.value.lines_returned).toBe(4);
  });

  it("tail:N where N > total lines returns the whole file", async () => {
    const res = await readImpl({ path: file, tail: 9999 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.lines_returned).toBe(20);
  });

  it("head + tail together → EINVAL (mutex)", async () => {
    const res = await readImpl({ path: file, head: 3, tail: 3 }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
    expect(res.error.message).toMatch(/at most one of/i);
  });

  it("head + range together → EINVAL (mutex)", async () => {
    const res = await readImpl({ path: file, head: 3, range: [1, 5] }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("tail + range together → EINVAL (mutex)", async () => {
    const res = await readImpl({ path: file, tail: 3, range: [1, 5] }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("head + tail + range all → EINVAL (mutex)", async () => {
    const res = await readImpl({ path: file, head: 1, tail: 1, range: [1, 5] }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });
});

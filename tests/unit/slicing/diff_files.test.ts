import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { diffFilesImpl } from "../../../src/tools/slicing/diff_files.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/slicing/diff_files", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("identical files → identical:true, empty diff, counts 0", async () => {
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");
    await fs.writeFile(a, "L1\nL2\nL3\n", "utf8");
    await fs.writeFile(b, "L1\nL2\nL3\n", "utf8");
    const res = await diffFilesImpl(
      { a, b, context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.identical).toBe(true);
    expect(res.value.diff).toBe("");
    expect(res.value.lines_added).toBe(0);
    expect(res.value.lines_removed).toBe(0);
  });

  it("file vs inline produces a unified diff with non-zero counts", async () => {
    const a = path.join(root, "a.txt");
    await fs.writeFile(a, "alpha\nbeta\ngamma\n", "utf8");
    const res = await diffFilesImpl(
      { a, b_inline: "alpha\nBETA\ngamma\n", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.identical).toBe(false);
    expect(res.value.lines_added).toBeGreaterThan(0);
    expect(res.value.lines_removed).toBeGreaterThan(0);
    expect(res.value.a_label).toBe("a.txt");
    expect(res.value.b_label).toBe("<inline>");
  });

  it("inline vs inline works", async () => {
    const res = await diffFilesImpl(
      { a_inline: "one\n", b_inline: "two\n", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.identical).toBe(false);
    expect(res.value.a_label).toBe("<inline>");
    expect(res.value.b_label).toBe("<inline>");
  });

  it("EINVAL when both a and a_inline supplied", async () => {
    const a = path.join(root, "a.txt");
    await fs.writeFile(a, "x", "utf8");
    const res = await diffFilesImpl(
      { a, a_inline: "y", b_inline: "z", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("EINVAL when neither a nor a_inline supplied", async () => {
    const res = await diffFilesImpl(
      { b_inline: "z", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("both empty inline → identical", async () => {
    const res = await diffFilesImpl(
      { a_inline: "", b_inline: "", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.identical).toBe(true);
  });

  it("one side empty, other non-empty → diff non-empty, not identical", async () => {
    const res = await diffFilesImpl(
      { a_inline: "", b_inline: "x\ny\n", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.identical).toBe(false);
    expect(res.value.lines_added).toBeGreaterThan(0);
  });

  it("UTF-8 BOM on file is stripped before diff", async () => {
    const a = path.join(root, "a.txt");
    // BOM + same content as inline
    await fs.writeFile(a, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n", "utf8")]));
    const res = await diffFilesImpl(
      { a, b_inline: "hello\n", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.identical).toBe(true);
  });

  it("binary file → EENCODING", async () => {
    const a = path.join(root, "a.bin");
    await fs.writeFile(a, Buffer.from([0x00, 0x01, 0x02]));
    const res = await diffFilesImpl(
      { a, b_inline: "text\n", context_lines: 3, format: "unified" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EENCODING");
  });

  it("format:'minimal' returns the summary header + capped changed lines", async () => {
    const res = await diffFilesImpl(
      {
        a_inline: "L1\nL2\nL3\nL4\nL5\n",
        b_inline: "L1\nL2_changed\nL3\nL4_changed\nL5\n",
        context_lines: 3,
        format: "minimal",
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.format).toBe("minimal");
    expect(res.value.diff.startsWith("--- summary:")).toBe(true);
  });

  it("truncated:true when diff > maxDiffBytes", async () => {
    const tight = { ...config, maxDiffBytes: 32 };
    const res = await diffFilesImpl(
      {
        a_inline: "alpha\nbeta\ngamma\ndelta\nepsilon\n",
        b_inline: "ALPHA\nBETA\nGAMMA\nDELTA\nEPSILON\n",
        context_lines: 3,
        format: "unified",
      },
      tight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.truncated).toBe(true);
  });
});

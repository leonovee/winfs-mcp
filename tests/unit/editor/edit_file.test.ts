import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { editFileImpl, getEditFileAuditExtras } from "../../../src/tools/editor/edit_file.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/editor/edit_file", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("applies a single edit and writes the file atomically", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "beta", new_str: "BETA" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(1);
    expect(res.value.atomic).toBe(true);
    expect(res.value.dry_run).toBe(false);
    expect(res.value.diff).toMatch(/-beta/);
    expect(res.value.diff).toMatch(/\+BETA/);
    expect(await fs.readFile(p, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("applies multiple edits sequentially", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "one\ntwo\nthree\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [
          { old_str: "one", new_str: "ONE" },
          { old_str: "three", new_str: "THREE" },
        ],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(2);
    expect(await fs.readFile(p, "utf8")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("dry_run=true does not write to disk but returns the diff", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "original\n", "utf8");
    const mtimeBefore = (await fs.stat(p)).mtimeMs;
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "original", new_str: "MODIFIED" }], dry_run: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.dry_run).toBe(true);
    expect(res.value.diff).toMatch(/-original/);
    expect(res.value.diff).toMatch(/\+MODIFIED/);
    expect(await fs.readFile(p, "utf8")).toBe("original\n");
    // mtime should be unchanged (no write)
    expect((await fs.stat(p)).mtimeMs).toBe(mtimeBefore);
  });

  it("EUNIQUE when old_str does not match (0 occurrences)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\nbeta\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "MISSING", new_str: "X" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.details).toMatchObject({ edit_index: 0, occurrences: 0 });
    // File untouched.
    expect(await fs.readFile(p, "utf8")).toBe("alpha\nbeta\n");
  });

  it("EUNIQUE when old_str appears 2+ times", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "foo\nfoo\nfoo\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "foo", new_str: "BAR" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.details).toMatchObject({ edit_index: 0, occurrences: 3 });
    // File untouched.
    expect(await fs.readFile(p, "utf8")).toBe("foo\nfoo\nfoo\n");
  });

  it("sequential application: edit[0] makes edit[1] no-longer-unique → EUNIQUE on edit[1]", async () => {
    const p = path.join(root, "f.txt");
    // After edit[0] removes the leading "X", the buffer has only one "Y" left;
    // but edit[1] targets "X" which is already gone → occurrences=0.
    await fs.writeFile(p, "X-Y-Z\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [
          { old_str: "X-", new_str: "" },
          { old_str: "X-", new_str: "anything" },
        ],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.details).toMatchObject({ edit_index: 1, occurrences: 0 });
  });

  it("EPERM_ROOT for path outside allowedRoots", async () => {
    const outside =
      process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
    const res = await editFileImpl(
      { path: outside, edits: [{ old_str: "x", new_str: "y" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("ENOENT when file does not exist (edit_file never creates files)", async () => {
    const res = await editFileImpl(
      {
        path: path.join(root, "missing.txt"),
        edits: [{ old_str: "x", new_str: "y" }],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });

  it("EISDIR when path is a directory", async () => {
    const d = path.join(root, "d");
    await fs.mkdir(d);
    const res = await editFileImpl(
      { path: d, edits: [{ old_str: "x", new_str: "y" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EISDIR");
  });

  it("EENCODING on binary file", async () => {
    const p = path.join(root, "bin");
    await fs.writeFile(p, Buffer.from([0x00, 0x01, 0x02]));
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "x", new_str: "y" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EENCODING");
  });

  it("BOM round-trip: file in had BOM, file out has no BOM", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(
      p,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n", "utf8")]),
    );
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "hello", new_str: "world" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const after = await fs.readFile(p);
    // No BOM on output.
    expect(after[0] !== 0xef || after[1] !== 0xbb || after[2] !== 0xbf).toBe(true);
    expect(after.toString("utf8")).toBe("world\n");
  });

  it("identity edit (old_str === new_str) is a no-op that counts toward replacements_made", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "foo bar baz\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "bar", new_str: "bar" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(1);
    // Diff is effectively a no-op.
    expect(res.value.diff.includes("-bar") && res.value.diff.includes("+bar")).toBe(false);
    expect(await fs.readFile(p, "utf8")).toBe("foo bar baz\n");
  });

  it("audit extras include bytes_before / bytes_after", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "alpha", new_str: "delta-and-some-more" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const extras = getEditFileAuditExtras(res.value);
    expect(extras).toBeDefined();
    expect(extras!.bytes_before).toBe(6); // "alpha\n"
    expect(extras!.bytes_after).toBeGreaterThan(extras!.bytes_before);
  });
});

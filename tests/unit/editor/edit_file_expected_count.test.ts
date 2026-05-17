import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { editFileImpl } from "../../../src/tools/editor/edit_file.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.6 §W invariant #34: optional `expected_count` per edit.
 *
 *   - undefined / 1 → v0.5 contract (single occurrence required, replaced once).
 *   - 0           → assertion-only mode (verify absent, no replacement performed).
 *   - N >= 2      → multi-occurrence replace (count must equal N exactly).
 *
 *   Count match is exact, not minimum. Mismatch → EUNIQUE with details
 *   { edit_index, occurrences_found, expected_count }.
 */
describe("tools/editor/edit_file — expected_count extension (v0.6 §W)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("default 1: omitted expected_count behaves like v0.5 (single replace)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf8");
    const res = await editFileImpl(
      { path: p, edits: [{ old_str: "beta", new_str: "BETA" }], dry_run: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(1);
    expect(await fs.readFile(p, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("expected_count: 3 with exactly 3 occurrences → all replaced, replacements_made = 3", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "foo\nfoo\nfoo\nbar\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "foo", new_str: "BAZ", expected_count: 3 }],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(3);
    expect(await fs.readFile(p, "utf8")).toBe("BAZ\nBAZ\nBAZ\nbar\n");
  });

  it("expected_count: 3 with only 2 occurrences → EUNIQUE, file untouched", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "foo\nfoo\nbar\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "foo", new_str: "BAZ", expected_count: 3 }],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.details).toMatchObject({
      edit_index: 0,
      occurrences_found: 2,
      expected_count: 3,
    });
    // File untouched.
    expect(await fs.readFile(p, "utf8")).toBe("foo\nfoo\nbar\n");
  });

  it("expected_count: 0 (assertion-only): substring absent → OK, no replacement performed", async () => {
    const p = path.join(root, "f.txt");
    const original = "alpha\nbeta\n";
    await fs.writeFile(p, original, "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "deprecated_token", new_str: "<ignored>", expected_count: 0 }],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // No replacement performed → replacements_made does NOT increment.
    expect(res.value.replacements_made).toBe(0);
    // File untouched.
    expect(await fs.readFile(p, "utf8")).toBe(original);
  });

  it("expected_count: 0 with 1+ occurrence → EUNIQUE (assertion fails)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "still has deprecated_token here\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "deprecated_token", new_str: "<ignored>", expected_count: 0 }],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EUNIQUE");
    expect(res.error.details).toMatchObject({
      edit_index: 0,
      occurrences_found: 1,
      expected_count: 0,
    });
  });

  it("expected_count: 5 with 5 occurrences replaced atomically (split+join multi-replace)", async () => {
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "X-X-X-X-X", "utf8"); // 5 X's
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "X", new_str: "YY", expected_count: 5 }],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(5);
    expect(await fs.readFile(p, "utf8")).toBe("YY-YY-YY-YY-YY");
  });

  it("mixed batch: expected_count varies per edit — sum counted in replacements_made", async () => {
    const p = path.join(root, "f.txt");
    // foo appears 2x, bar 1x, baz 0x
    await fs.writeFile(p, "foo and foo and bar\n", "utf8");
    const res = await editFileImpl(
      {
        path: p,
        edits: [
          { old_str: "foo", new_str: "FOO", expected_count: 2 }, // 2 replacements
          { old_str: "bar", new_str: "BAR", expected_count: 1 }, // 1 replacement
          { old_str: "baz_absent", new_str: "<ignored>", expected_count: 0 }, // assertion, 0
        ],
        dry_run: false,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.replacements_made).toBe(3); // 2 + 1 + 0
    expect(await fs.readFile(p, "utf8")).toBe("FOO and FOO and BAR\n");
  });

  it("dry_run with expected_count: 0 still reports diff (no-op) and does not touch disk", async () => {
    const p = path.join(root, "f.txt");
    const original = "alpha\nbeta\n";
    await fs.writeFile(p, original, "utf8");
    const mtimeBefore = (await fs.stat(p)).mtimeMs;
    const res = await editFileImpl(
      {
        path: p,
        edits: [{ old_str: "absent_token", new_str: "ignored", expected_count: 0 }],
        dry_run: true,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.dry_run).toBe(true);
    expect(res.value.replacements_made).toBe(0);
    // File mtime unchanged (dry_run + no actual replacement).
    expect((await fs.stat(p)).mtimeMs).toBe(mtimeBefore);
  });
});

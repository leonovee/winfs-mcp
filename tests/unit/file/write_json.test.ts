import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeJsonImpl } from "../../../src/tools/file/write_json.js";
import { readJsonImpl } from "../../../src/tools/search/read_json.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/file/write_json", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("creates a new .json file (overwrite=false default)", async () => {
    const p = path.join(root, "out.json");
    const res = await writeJsonImpl(
      { path: p, value: { hello: "world", n: 42 }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.created).toBe(true);
    expect(res.value.bytes_written).toBeGreaterThan(0);

    const text = await fs.readFile(p, "utf8");
    // Indent 2, trailing newline.
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ hello: "world", n: 42 });
  });

  it("EEXIST when file already exists and overwrite=false", async () => {
    const p = path.join(root, "exists.json");
    await fs.writeFile(p, "{}\n", "utf8");
    const res = await writeJsonImpl(
      { path: p, value: { a: 1 }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXIST");
    // File unchanged.
    expect(await fs.readFile(p, "utf8")).toBe("{}\n");
  });

  it("overwrite=true replaces existing file", async () => {
    const p = path.join(root, "replace.json");
    await fs.writeFile(p, '{"old":true}\n', "utf8");
    const res = await writeJsonImpl(
      { path: p, value: { new: true }, indent: 2, overwrite: true, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.created).toBe(false);
    expect(JSON.parse(await fs.readFile(p, "utf8"))).toEqual({ new: true });
  });

  it("EEXT_NOT_JSON for non-.json suffix (caller path)", async () => {
    const p = path.join(root, "out.txt");
    const res = await writeJsonImpl(
      { path: p, value: { x: 1 }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EEXT_NOT_JSON");
    // Sanity: no file created.
    await expect(fs.stat(p)).rejects.toThrow();
  });

  it(".JSON (uppercase) is accepted — case-insensitive", async () => {
    const p = path.join(root, "MIXED.JSON");
    const res = await writeJsonImpl(
      { path: p, value: [1, 2, 3], indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(JSON.parse(await fs.readFile(p, "utf8"))).toEqual([1, 2, 3]);
  });

  it("round-trips with read_json (default indent 2)", async () => {
    const p = path.join(root, "rt.json");
    const original = { nested: { a: [1, 2, { deep: true }], b: null }, s: "hello" };
    const w = await writeJsonImpl(
      { path: p, value: original, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(w.ok).toBe(true);
    const r = await readJsonImpl({ path: p }, config);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected read ok");
    expect(r.value.data).toEqual(original);
  });

  it("indent 0 produces compact serialisation (no newlines inside body)", async () => {
    const p = path.join(root, "compact.json");
    const res = await writeJsonImpl(
      { path: p, value: { a: 1, b: 2 }, indent: 0, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const text = await fs.readFile(p, "utf8");
    expect(text).toBe('{"a":1,"b":2}\n');
  });

  it("indent 2 (default) produces multi-line output", async () => {
    const p = path.join(root, "pretty.json");
    const res = await writeJsonImpl(
      { path: p, value: { a: 1, b: 2 }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const text = await fs.readFile(p, "utf8");
    expect(text.split("\n").length).toBeGreaterThan(2);
    expect(text).toContain('  "a": 1');
  });

  it("EPERM_ROOT when path is outside allowedRoots (strict mode)", async () => {
    const outside =
      process.platform === "win32"
        ? "C:\\Windows\\Temp\\winfs-test.json"
        : "/tmp/winfs-test.json";
    const res = await writeJsonImpl(
      { path: outside, value: { x: 1 }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("EINVAL for circular reference", async () => {
    const p = path.join(root, "cycle.json");
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const res = await writeJsonImpl(
      { path: p, value: obj, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
    expect(res.error.message.toLowerCase()).toMatch(/json|circular|cyclic/);
  });

  it("EINVAL for BigInt", async () => {
    const p = path.join(root, "bigint.json");
    const res = await writeJsonImpl(
      { path: p, value: { n: BigInt(1) }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("EINVAL for top-level function (serialises to undefined)", async () => {
    const p = path.join(root, "fn.json");
    const res = await writeJsonImpl(
      { path: p, value: () => 1, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("mkdirParents=true creates missing parent dirs", async () => {
    const p = path.join(root, "nested", "deep", "out.json");
    const res = await writeJsonImpl(
      { path: p, value: { ok: true }, indent: 2, overwrite: false, mkdirParents: true },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(JSON.parse(await fs.readFile(p, "utf8"))).toEqual({ ok: true });
  });

  it("ENOENT when parent missing and mkdirParents=false", async () => {
    const p = path.join(root, "missing", "out.json");
    const res = await writeJsonImpl(
      { path: p, value: { ok: true }, indent: 2, overwrite: false, mkdirParents: false },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });
});

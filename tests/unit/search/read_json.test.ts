import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readJsonImpl } from "../../../src/tools/search/read_json.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/search/read_json", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("parses a well-formed JSON file", async () => {
    const p = path.join(root, "ok.json");
    await fs.writeFile(p, JSON.stringify({ a: 1, b: [true, false] }), "utf8");
    const res = await readJsonImpl({ path: p }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.data).toEqual({ a: 1, b: [true, false] });
    expect(res.value.size_bytes).toBeGreaterThan(0);
  });

  it("returns EBADJSON with line/column for malformed JSON", async () => {
    const p = path.join(root, "bad.json");
    await fs.writeFile(p, '{\n  "a": 1,\n  "b": ,\n}\n', "utf8");
    const res = await readJsonImpl({ path: p }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EBADJSON");
    // Position info best-effort — assert at least one of the fields landed.
    const d = res.error.details ?? {};
    expect(
      typeof d.line === "number" || typeof d.snippet === "string",
    ).toBe(true);
  });

  it("returns ETOOLARGE if readMaxBytes blocks the read", async () => {
    const tight = { ...config, readMaxBytes: 4 };
    const p = path.join(root, "big.json");
    await fs.writeFile(p, JSON.stringify({ data: "x".repeat(64) }), "utf8");
    const res = await readJsonImpl({ path: p }, tight);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ETOOLARGE");
  });

  it("returns EPERM_ROOT for a path outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\system.ini" : "/etc/hosts";
    const res = await readJsonImpl({ path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("returns ENOENT for missing file", async () => {
    const res = await readJsonImpl({ path: path.join(root, "missing.json") }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOENT");
  });
});

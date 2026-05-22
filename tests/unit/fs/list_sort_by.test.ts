import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { listImpl } from "../../../src/tools/fs/list.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.8 P4.3 — list tool gains sort_by: 'name' | 'size' | 'mtime'.
 */
describe("v0.8 P4.3: list sort_by", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(1000), "utf8");
    await fs.writeFile(path.join(root, "medium.txt"), "x".repeat(100), "utf8");
    await fs.writeFile(path.join(root, "tiny.txt"), "x", "utf8");
    // Touch big.txt's mtime to a known earlier value (rest are now).
    const earlier = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(root, "big.txt"), earlier, earlier);
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("sort_by='name' sorts alphabetically", async () => {
    const res = await listImpl({ path: root, max_depth: 1, sort_by: "name" }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name);
    expect(names).toEqual(["big.txt", "medium.txt", "tiny.txt"]);
  });

  it("sort_by='size' sorts largest first", async () => {
    const res = await listImpl({ path: root, max_depth: 1, sort_by: "size" }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name);
    expect(names).toEqual(["big.txt", "medium.txt", "tiny.txt"]);
    expect(res.value.entries[0]!.size).toBe(1000);
    expect(res.value.entries[1]!.size).toBe(100);
    expect(res.value.entries[2]!.size).toBe(1);
  });

  it("sort_by='mtime' sorts newest first (big.txt was touched older)", async () => {
    const res = await listImpl({ path: root, max_depth: 1, sort_by: "mtime" }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name);
    // big.txt is the OLDEST → last; the other two are roughly equal-recent.
    expect(names[names.length - 1]).toBe("big.txt");
  });

  it("omitting sort_by preserves directory-walk order (legacy contract)", async () => {
    const res = await listImpl({ path: root, max_depth: 1 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // No assertion on a specific order — just confirm all 3 entries present.
    expect(res.value.entries.length).toBe(3);
  });
});

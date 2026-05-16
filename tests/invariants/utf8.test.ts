import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeImpl } from "../../src/tools/fs/write.js";
import { readImpl } from "../../src/tools/fs/read.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import { hasUtf8Bom } from "../../src/core/utf8.js";
import type { ResolvedConfig } from "../../src/core/config.js";

describe("invariant: UTF-8 round-trip (spec §2.1)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("write→read roundtrips Russian + emoji + ASCII identically", async () => {
    const target = path.join(root, "mixed.md");
    const original = "Привет, мир\n🚀 emoji line\nplain ASCII\nспецсимволы: ёщъыЁ\n";
    const wRes = await writeImpl(
      { path: target, content: original, overwrite: true, mkdirParents: false },
      config,
    );
    expect(wRes.ok).toBe(true);

    const buf = await fs.readFile(target);
    expect(hasUtf8Bom(buf)).toBe(false);

    const rRes = await readImpl({ path: target }, config);
    expect(rRes.ok).toBe(true);
    if (!rRes.ok) throw new Error("expected ok");
    expect(rRes.value.content).toBe(original);
  });

  it("read strips a leading BOM transparently even though write never adds one", async () => {
    const target = path.join(root, "with-bom.txt");
    const bomFile = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("after BOM", "utf8"),
    ]);
    await fs.writeFile(target, bomFile);

    const res = await readImpl({ path: target }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("after BOM");
  });
});

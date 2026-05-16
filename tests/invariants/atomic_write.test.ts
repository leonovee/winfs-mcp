import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, atomicAppend } from "../../src/core/atomic_write.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";

describe("invariant: atomic writes (spec §2.5)", () => {
  let root: string;

  beforeEach(async () => {
    const created = await makeTempConfig();
    root = created.root;
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("writes without a BOM and without partial-file remnants", async () => {
    const target = path.join(root, "out.txt");
    await atomicWriteFile(target, Buffer.from("Привет"));
    const buf = await fs.readFile(target);
    expect(buf[0]).not.toBe(0xef);
    expect(buf.toString("utf8")).toBe("Привет");

    const entries = await fs.readdir(root);
    const tmp = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmp).toEqual([]);
  });

  it("overwrites existing file in a single observable step", async () => {
    const target = path.join(root, "race.txt");
    await fs.writeFile(target, "v1", "utf8");
    await atomicWriteFile(target, Buffer.from("version-two", "utf8"));
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("version-two");
  });

  it("atomic append concatenates and never leaves a temp file", async () => {
    const target = path.join(root, "log.txt");
    await fs.writeFile(target, "header\n", "utf8");
    await atomicAppend(target, Buffer.from("line1\n", "utf8"));
    await atomicAppend(target, Buffer.from("line2\n", "utf8"));
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("header\nline1\nline2\n");

    const entries = await fs.readdir(root);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

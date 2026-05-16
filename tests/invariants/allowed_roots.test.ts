import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { checkAllowed } from "../../src/core/allowed_roots.js";
import { readImpl } from "../../src/tools/fs/read.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

describe("invariant: allowedRoots realpath canonicalization (spec §2.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("rejects a `..`-escape attempt", async () => {
    const escape = path.join(root, "..", "..", "evil.txt");
    const res = await checkAllowed(escape, config);
    expect("ok" in res && res.ok === false).toBe(true);
    if (!("ok" in res) || res.ok !== false) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("rejects a path strictly outside allowedRoots", async () => {
    const outside =
      process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
    const res = await readImpl({ path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
    expect(res.error.hint).toMatch(/allowedRoots/);
  });

  it("rejects an empty / non-absolute path with EINVAL", async () => {
    const res = await checkAllowed("relative/path.txt", config);
    expect("ok" in res && res.ok === false).toBe(true);
    if (!("ok" in res) || res.ok !== false) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("accepts a path inside the allowed root", async () => {
    const target = path.join(root, "inside.txt");
    await fs.writeFile(target, "ok", "utf8");
    const res = await checkAllowed(target, config);
    expect("realPath" in res).toBe(true);
  });

  it("symlink/junction escape outside allowed root is blocked (skipped if symlink unavailable)", async () => {
    // Create a directory OUTSIDE the allowed root, then a symlink inside it.
    // Junctions/symlinks on Windows need elevated rights so we fall back to
    // a regular symlink and skip the test if creation fails (e.g. dev mode off).
    const { config: cfgOutside, root: outsideRoot } = await makeTempConfig();
    try {
      await fs.writeFile(path.join(outsideRoot, "secret.txt"), "secret", "utf8");
      const linkPath = path.join(root, "evil-link");
      try {
        await fs.symlink(outsideRoot, linkPath, "dir");
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e?.code === "EPERM" || e?.code === "EACCES") return; // skip
        throw err;
      }
      const traversed = path.join(linkPath, "secret.txt");
      const res = await checkAllowed(traversed, config);
      // realPath resolution should land in outsideRoot, which is not in config.allowedRoots.
      expect("ok" in res && res.ok === false).toBe(true);
      if (!("ok" in res) || res.ok !== false) throw new Error("expected error");
      expect(res.error.code).toBe("EPERM_ROOT");
    } finally {
      await cleanupTempConfig(outsideRoot);
      void cfgOutside;
    }
  });
});

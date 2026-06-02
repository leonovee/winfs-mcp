import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RootsResolver } from "../../../src/core/roots_resolver.js";
import { loadConfig } from "../../../src/core/config.js";
import { reloadConfigRoots, watchConfigFile } from "../../../src/core/config_watch.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { flushAudit } from "../../../src/core/audit.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("core hot-reload (Phase G)", () => {
  let config: ResolvedConfig;
  let configRoot: string;
  let extraRoot: string;
  let newRoot: string;
  let tmpDir: string;

  beforeEach(async () => {
    ({ config, root: configRoot } = await makeTempConfig());
    extraRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "winfs-hr-extra-")));
    newRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "winfs-hr-new-")));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-hr-cfg-"));
  });

  afterEach(async () => {
    await flushAudit();
    await cleanupTempConfig(configRoot);
    for (const d of [extraRoot, newRoot, tmpDir]) {
      try { await fs.rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── RootsResolver.setConfigRoots ──────────────────────────────────────────

  it("setConfigRoots replaces config roots in place, preserving client roots", async () => {
    const r = new RootsResolver(config); // config roots = [configRoot]
    await r.setClientRoots([extraRoot]); // client = [extraRoot]
    const arrRef = config.resolvedAllowedRoots; // capture array identity
    r.setConfigRoots([path.normalize(newRoot)]);
    // Array identity is stable (mutated in place — the ~17 read sites keep their ref).
    expect(config.resolvedAllowedRoots).toBe(arrRef);
    expect(r.getConfigRoots()).toEqual([path.normalize(newRoot)]);
    expect(r.effective()).toContain(path.normalize(newRoot)); // new config root applied
    expect(r.effective()).toContain(path.normalize(extraRoot)); // client root preserved
    expect(r.effective()).not.toContain(path.normalize(configRoot)); // old config root dropped
  });

  // ── reloadConfigRoots (validate-before-apply) ─────────────────────────────

  async function writeCfg(content: Record<string, unknown>): Promise<string> {
    const p = path.join(tmpDir, "config.json");
    await fs.writeFile(p, JSON.stringify(content), "utf8");
    return p;
  }

  it("reloadConfigRoots applies a valid edited config's allowedRoots", async () => {
    const p = await writeCfg({ allowedRoots: [extraRoot] });
    const loaded = await loadConfig(p);
    const r = new RootsResolver(loaded);
    expect(r.effective()).toEqual([path.normalize(extraRoot)]);
    // Edit the file: add newRoot.
    await fs.writeFile(p, JSON.stringify({ allowedRoots: [extraRoot, newRoot] }), "utf8");
    const res = await reloadConfigRoots(p, r);
    expect(res.ok).toBe(true);
    expect(r.effective()).toContain(path.normalize(extraRoot));
    expect(r.effective()).toContain(path.normalize(newRoot));
  });

  it("reloadConfigRoots keeps the old roots and reports an error on an invalid edit", async () => {
    const p = await writeCfg({ allowedRoots: [extraRoot] });
    const loaded = await loadConfig(p);
    const r = new RootsResolver(loaded);
    const before = [...r.effective()];
    // Invalid edit: malformed JSON.
    await fs.writeFile(p, "{ this is not valid json ", "utf8");
    const res = await reloadConfigRoots(p, r);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.length).toBeGreaterThan(0);
    // Old roots retained — server not bricked.
    expect(r.effective()).toEqual(before);
  });

  it("reloadConfigRoots rejects a config that fails schema validation, keeping old roots", async () => {
    const p = await writeCfg({ allowedRoots: [extraRoot] });
    const r = new RootsResolver(await loadConfig(p));
    const before = [...r.effective()];
    // shellMaxTimeoutMs < shellTimeoutMs → loadConfig throws.
    await fs.writeFile(p, JSON.stringify({
      allowedRoots: [extraRoot, newRoot],
      shellTimeoutMs: 120_000,
      shellMaxTimeoutMs: 1_000,
    }), "utf8");
    const res = await reloadConfigRoots(p, r);
    expect(res.ok).toBe(false);
    expect(r.effective()).toEqual(before);
  });

  // ── watchConfigFile (debounced) ───────────────────────────────────────────

  it("watchConfigFile fires the debounced callback after the file changes", async () => {
    const p = await writeCfg({ allowedRoots: [extraRoot] });
    let fired = 0;
    const handle = watchConfigFile(p, () => { fired++; }, { debounceMs: 40 });
    try {
      // Modify the file a few times in a burst — debounce should coalesce.
      await fs.writeFile(p, JSON.stringify({ allowedRoots: [extraRoot, newRoot] }), "utf8");
      await new Promise((res) => setTimeout(res, 80));
      await fs.writeFile(p, JSON.stringify({ allowedRoots: [newRoot] }), "utf8");
      // Poll up to ~2s for the watcher to fire at least once.
      const deadline = Date.now() + 2000;
      while (fired === 0 && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(fired).toBeGreaterThanOrEqual(1);
    } finally {
      handle.close();
    }
  });
});

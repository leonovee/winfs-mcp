import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RootsResolver } from "../../../src/core/roots_resolver.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { flushAudit } from "../../../src/core/audit.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.9 — RootsResolver unit tests.
 *
 * The resolver owns config.resolvedAllowedRoots's effective value: it
 * snapshots the config-supplied roots at construction, accepts client
 * roots from MCP Roots protocol via setClientRoots, and mutates the
 * live config.resolvedAllowedRoots array in place to be the union.
 *
 * Spec §AC (invariant #42): effectiveAllowedRoots = union(config, client).
 * Client roots can only WIDEN access, never silently remove paths the
 * operator explicitly trusted via config.
 */
describe("core/roots_resolver", () => {
  let config: ResolvedConfig;
  let configRoot: string;
  let extraRoot: string;
  let nonExistent: string;

  beforeEach(async () => {
    ({ config, root: configRoot } = await makeTempConfig());
    // A second real directory the tests can offer as a client root.
    extraRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-roots-extra-"));
    extraRoot = await fs.realpath(extraRoot);
    nonExistent = path.join(os.tmpdir(), `winfs-roots-nope-${Date.now()}`);
  });

  afterEach(async () => {
    await flushAudit();
    await cleanupTempConfig(configRoot);
    try { await fs.rm(extraRoot, { recursive: true, force: true }); } catch {}
  });

  it("construction snapshots config roots; client roots start empty", () => {
    const r = new RootsResolver(config);
    expect(r.getConfigRoots()).toEqual([path.normalize(configRoot)]);
    expect(r.clientRoots()).toEqual([]);
    expect(r.effective()).toEqual([path.normalize(configRoot)]);
  });

  it("empty client + non-empty config → effective == config", async () => {
    const r = new RootsResolver(config);
    await r.setClientRoots([]);
    expect(r.effective()).toEqual([path.normalize(configRoot)]);
    expect(config.resolvedAllowedRoots).toEqual([path.normalize(configRoot)]);
  });

  it("non-empty client adds to config (union, not replace)", async () => {
    const r = new RootsResolver(config);
    await r.setClientRoots([extraRoot]);
    expect(r.effective().length).toBeGreaterThanOrEqual(2);
    expect(r.effective()).toContain(path.normalize(configRoot));
    expect(r.effective()).toContain(path.normalize(extraRoot));
    // Live config array is mutated in place — checkAllowed picks it up.
    expect(config.resolvedAllowedRoots).toContain(path.normalize(extraRoot));
  });

  it("dedup: same path in config + client appears once in effective", async () => {
    const r = new RootsResolver(config);
    // Client offers the same root the config already has.
    await r.setClientRoots([configRoot]);
    const occurrences = r.effective().filter((p) =>
      p.toLowerCase() === path.normalize(configRoot).toLowerCase(),
    ).length;
    expect(occurrences).toBe(1);
  });

  it("invalid client root (non-absolute) skipped with stderr warning; valid still applied", async () => {
    const r = new RootsResolver(config);
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: typeof origWrite }).write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof origWrite;
    try {
      await r.setClientRoots(["relative/path", extraRoot]);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    expect(warnings.some((w) => /non-absolute/.test(w))).toBe(true);
    expect(r.effective()).toContain(path.normalize(extraRoot));
    expect(r.effective()).not.toContain("relative/path");
  });

  it("non-existent client root skipped; valid still applied", async () => {
    const r = new RootsResolver(config);
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: typeof origWrite }).write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof origWrite;
    try {
      await r.setClientRoots([nonExistent, extraRoot]);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    expect(warnings.some((w) => /non-existent/.test(w))).toBe(true);
    expect(r.effective()).toContain(path.normalize(extraRoot));
  });

  it("non-directory (file) client root skipped", async () => {
    const file = path.join(extraRoot, "f.txt");
    await fs.writeFile(file, "x", "utf8");
    const r = new RootsResolver(config);
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: typeof origWrite }).write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof origWrite;
    try {
      await r.setClientRoots([file]);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    expect(warnings.some((w) => /non-directory/.test(w))).toBe(true);
    expect(r.clientRoots()).toEqual([]);
  });

  it("replacement call cleanly replaces prior client roots (not accumulative)", async () => {
    const r = new RootsResolver(config);
    await r.setClientRoots([extraRoot]);
    expect(r.effective().length).toBeGreaterThanOrEqual(2);

    // Second call with empty array → client roots go back to nothing.
    await r.setClientRoots([]);
    expect(r.clientRoots()).toEqual([]);
    expect(r.effective()).toEqual([path.normalize(configRoot)]);
    // Live config also rewound.
    expect(config.resolvedAllowedRoots).toEqual([path.normalize(configRoot)]);
  });

  it("config roots are NEVER removed by setClientRoots — union floor", async () => {
    const r = new RootsResolver(config);
    // Even if client signals only `extraRoot`, the config-supplied root stays.
    await r.setClientRoots([extraRoot]);
    expect(r.effective()).toContain(path.normalize(configRoot));
  });

  it("empty-string client root skipped (not crashed on)", async () => {
    const r = new RootsResolver(config);
    await r.setClientRoots(["", extraRoot]);
    expect(r.effective()).toContain(path.normalize(extraRoot));
  });

  it("setClientRoots emits a _client_roots_updated audit record (count-only, no paths)", async () => {
    const r = new RootsResolver(config);
    await r.setClientRoots([extraRoot]);
    await flushAudit();
    // Read the audit log directly and confirm the entry shape.
    const auditPath = config.resolvedAuditLogPath;
    const log = await fs.readFile(auditPath, "utf8");
    const lines = log.split(/\r?\n/).filter((l) => l.length > 0);
    const events = lines.map((l) => JSON.parse(l));
    const update = events.find((e) => e.tool === "_client_roots_updated");
    expect(update).toBeDefined();
    expect(update.args_summary.accepted_count).toBe(1);
    expect(update.args_summary.rejected_count).toBe(0);
    expect(update.args_summary.config_roots_count).toBe(1);
    expect(update.args_summary.effective_count).toBeGreaterThanOrEqual(2);
    // Critical: paths MUST NOT appear in the audit record.
    const serialized = JSON.stringify(update);
    expect(serialized).not.toContain(extraRoot);
    expect(serialized).not.toContain(configRoot);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RootsResolver } from "../../src/core/roots_resolver.js";
import { checkAllowed } from "../../src/core/allowed_roots.js";
import { readImpl } from "../../src/tools/fs/read.js";
import { listImpl } from "../../src/tools/fs/list.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import { flushAudit } from "../../src/core/audit.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * v0.9 §AC / invariant #42 — integration tests.
 *
 * Asserts the full end-to-end contract: when RootsResolver accepts a
 * client root, checkAllowed (and every tool layered on top of it)
 * immediately treats paths inside that root as allowed — no
 * checkAllowed signature change, no tool rewrite, no restart required.
 *
 * The mutation is via the resolver writing to config.resolvedAllowedRoots
 * in place. Tools continue to call checkAllowed(path, config) which
 * reads that live field.
 */
describe("v0.9 invariant #42: effective allowed roots = config ∪ client (integration)", () => {
  let config: ResolvedConfig;
  let configRoot: string;
  let clientRoot: string;

  beforeEach(async () => {
    ({ config, root: configRoot } = await makeTempConfig());
    clientRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-client-root-"));
    clientRoot = await fs.realpath(clientRoot);
  });

  afterEach(async () => {
    await flushAudit();
    await cleanupTempConfig(configRoot);
    try { await fs.rm(clientRoot, { recursive: true, force: true }); } catch {}
  });

  it("client-only root: read inside it is allowed after setClientRoots", async () => {
    const target = path.join(clientRoot, "client.txt");
    await fs.writeFile(target, "hello from client root", "utf8");

    // Before resolver accepts client roots, the path is OUTSIDE allowed.
    const before = await readImpl({ path: target }, config);
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error("expected EPERM_ROOT pre-resolve");
    expect(before.error.code).toBe("EPERM_ROOT");

    // Resolver accepts the client root → checkAllowed picks it up.
    const resolver = new RootsResolver(config);
    await resolver.setClientRoots([clientRoot]);

    const after = await readImpl({ path: target }, config);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(`expected ok after resolve: ${after.error.code}`);
    expect(after.value.content).toBe("hello from client root");
  });

  it("config-only root continues to work (back-compat sanity)", async () => {
    const target = path.join(configRoot, "config.txt");
    await fs.writeFile(target, "hello from config root", "utf8");

    const resolver = new RootsResolver(config);
    // No client roots ever set.
    expect(resolver.clientRoots()).toEqual([]);

    const res = await readImpl({ path: target }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.content).toBe("hello from config root");
  });

  it("path inside neither config nor client → EPERM_ROOT", async () => {
    const resolver = new RootsResolver(config);
    await resolver.setClientRoots([clientRoot]);

    const outside = process.platform === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/hosts";
    const res = await readImpl({ path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected EPERM_ROOT");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("removing a client root revokes its paths' access (config-trusted paths unaffected)", async () => {
    const clientTarget = path.join(clientRoot, "a.txt");
    const configTarget = path.join(configRoot, "b.txt");
    await fs.writeFile(clientTarget, "client", "utf8");
    await fs.writeFile(configTarget, "config", "utf8");

    const resolver = new RootsResolver(config);
    await resolver.setClientRoots([clientRoot]);

    // Both reads work.
    const a1 = await readImpl({ path: clientTarget }, config);
    expect(a1.ok).toBe(true);
    const b1 = await readImpl({ path: configTarget }, config);
    expect(b1.ok).toBe(true);

    // Client signals no roots — clientTarget revoked, configTarget keeps.
    await resolver.setClientRoots([]);

    const a2 = await readImpl({ path: clientTarget }, config);
    expect(a2.ok).toBe(false);
    if (a2.ok) throw new Error("expected EPERM_ROOT after revoke");
    expect(a2.error.code).toBe("EPERM_ROOT");

    const b2 = await readImpl({ path: configTarget }, config);
    expect(b2.ok).toBe(true);
  });

  it("checkAllowed direct: client root via realpath is recognised", async () => {
    const resolver = new RootsResolver(config);
    await resolver.setClientRoots([clientRoot]);

    const child = path.join(clientRoot, "sub.txt");
    await fs.writeFile(child, "x", "utf8");
    const res = await checkAllowed(child, config);
    expect("realPath" in res).toBe(true);
  });

  it("list works on a client-only root", async () => {
    await fs.writeFile(path.join(clientRoot, "a.txt"), "x", "utf8");
    await fs.writeFile(path.join(clientRoot, "b.txt"), "y", "utf8");

    const resolver = new RootsResolver(config);
    await resolver.setClientRoots([clientRoot]);

    const res = await listImpl({ path: clientRoot, max_depth: 1 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const names = res.value.entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });
});

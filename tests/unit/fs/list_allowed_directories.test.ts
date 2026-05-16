import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listAllowedDirectoriesImpl } from "../../../src/tools/fs/list_allowed_directories.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/fs/list_allowed_directories", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns the canonical allowedRoots + allowed_url_hosts", async () => {
    const cfg = { ...config, allowedUrlHosts: ["raw.githubusercontent.com"] };
    const res = await listAllowedDirectoriesImpl({}, cfg);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.allowed_roots).toEqual(cfg.resolvedAllowedRoots);
    expect(res.value.allowed_url_hosts).toEqual(["raw.githubusercontent.com"]);
  });

  it("does NOT leak audit path, blocklist, or timeouts", async () => {
    const res = await listAllowedDirectoriesImpl({}, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const keys = Object.keys(res.value).sort();
    expect(keys).toEqual(["allowed_url_hosts", "allowed_roots"].sort());
  });

  it("returns empty arrays when nothing is configured", async () => {
    const cfg: ResolvedConfig = { ...config, resolvedAllowedRoots: [], allowedUrlHosts: [] };
    const res = await listAllowedDirectoriesImpl({}, cfg);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.allowed_roots).toEqual([]);
    expect(res.value.allowed_url_hosts).toEqual([]);
  });
});

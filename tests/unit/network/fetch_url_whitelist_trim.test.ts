import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchUrlImpl } from "../../../src/tools/network/fetch_url.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — fetch_url P2.8 regression test.
 *
 * P2.8 (3/3 reviewer convergence): operator misconfiguration with leading
 * or trailing whitespace in allowedUrlHosts silently rejects every request
 * to the affected host. Fix: trim entries before lowercase comparison.
 */
describe("fetch_url: allowedUrlHosts whitespace trimming (P2.8)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("trailing space in whitelist entry does NOT silently reject (URL matches)", async () => {
    const cfg = { ...config, allowedUrlHosts: ["example.invalid.test "] };
    const res = await fetchUrlImpl({ url: "http://example.invalid.test/" }, cfg);
    // We expect EHOSTNOTALLOWED but specifically from the DNS-resolve layer
    // (host wasn't found), NOT from the whitelist layer. Pre-fix the
    // whitelist would have rejected with "host is not in allowedUrlHosts".
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    expect(res.error.message).not.toMatch(/not in allowedUrlHosts/);
  });

  it("leading space in whitelist entry does NOT silently reject", async () => {
    const cfg = { ...config, allowedUrlHosts: [" example.invalid.test"] };
    const res = await fetchUrlImpl({ url: "http://example.invalid.test/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    expect(res.error.message).not.toMatch(/not in allowedUrlHosts/);
  });

  it("entries with mixed case and surrounding whitespace still match", async () => {
    const cfg = { ...config, allowedUrlHosts: ["  Example.Invalid.Test  "] };
    const res = await fetchUrlImpl({ url: "http://example.invalid.test/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    expect(res.error.message).not.toMatch(/not in allowedUrlHosts/);
  });

  it("genuinely-mismatched host still rejected at whitelist layer", async () => {
    const cfg = { ...config, allowedUrlHosts: ["example.test"] };
    const res = await fetchUrlImpl({ url: "http://other.test/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    expect(res.error.message).toMatch(/not in allowedUrlHosts/);
  });
});

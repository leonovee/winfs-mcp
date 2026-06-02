import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchUrlImpl } from "../../src/tools/network/fetch_url.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * Spec §2 invariant #10: fetch_url defends against SSRF via TWO layers:
 *   1. Host whitelist (allowedUrlHosts, exact match, case-insensitive)
 *   2. DNS resolve → IP not in internal ranges
 *
 * Both layers must independently catch malicious destinations. These tests
 * pin the boundary on each.
 */
describe("invariant: fetch_url SSRF defenses (spec §2 #10)", { timeout: 30_000 }, () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("layer 1: non-whitelisted host blocked before DNS even runs", async () => {
    const res = await fetchUrlImpl({ url: "http://attacker.example.test/" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    // No DNS resolve happened (host wasn't even in the whitelist).
    expect(res.error.details).toMatchObject({ host: "attacker.example.test" });
  });

  it("layer 2: 127.0.0.1 literal blocked even when whitelisted", async () => {
    const cfg = { ...config, allowedUrlHosts: ["127.0.0.1"] };
    const res = await fetchUrlImpl({ url: "http://127.0.0.1:80/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
  });

  it("layer 2: ::1 (IPv6 loopback) blocked even when whitelisted", async () => {
    const cfg = { ...config, allowedUrlHosts: ["::1", "[::1]"] };
    const res = await fetchUrlImpl({ url: "http://[::1]:80/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
  });

  it("layer 2: 10.x.x.x private range blocked even when whitelisted", async () => {
    const cfg = { ...config, allowedUrlHosts: ["10.0.0.1"] };
    const res = await fetchUrlImpl({ url: "http://10.0.0.1/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
  });

  it("layer 2: 169.254.x.x link-local blocked", async () => {
    const cfg = { ...config, allowedUrlHosts: ["169.254.169.254"] };
    const res = await fetchUrlImpl({ url: "http://169.254.169.254/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
  });

  it("protocol whitelist: file:// rejected", async () => {
    const cfg = { ...config, allowedUrlHosts: ["anything"] };
    const res = await fetchUrlImpl({ url: "file:///etc/passwd" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    expect(res.error.details?.protocol).toBe("file:");
  });

  it("protocol whitelist: gopher:// rejected", async () => {
    const cfg = { ...config, allowedUrlHosts: ["example.com"] };
    const res = await fetchUrlImpl({ url: "gopher://example.com/" }, cfg);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
  });

  it("EINVAL on malformed URL", async () => {
    const res = await fetchUrlImpl({ url: "not a url at all" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });
});

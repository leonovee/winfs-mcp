import { describe, it, expect } from "vitest";
import { isInternalIP } from "../../../src/tools/network/fetch_url.js";

/**
 * v0.7 pre-tag bug-fix wave — verify-first for fetch_url P1.3 + P1.4.
 *
 * P1.3 (Kimi review F8): `isInternalIP` uses `lower.startsWith("fe80")` for
 * the link-local IPv6 check. The fe80::/10 prefix covers `fe80::` through
 * `febf::` (10-bit mask), so `fe90::1`, `fea0::1`, `febc::1` are link-local
 * but evade the literal `startsWith("fe80")` check. DNS-controlled attacker
 * could return one of these for a whitelisted host and SSRF the request.
 *
 * P1.4 (Kimi review F9): the IPv4-mapped IPv6 regex `/^::ffff:([0-9a-f.:]+)$/`
 * matches `::ffff:c0a8:0101` (= `::ffff:192.168.1.1`) with `inner = "c0a8:0101"`.
 * `net.isIPv4("c0a8:0101")` returns false → isInternalIP returns false →
 * SSRF guard considers the address external and proceeds to connect to
 * 192.168.1.1.
 *
 * Both findings are Kimi-only (single-source) and security-relevant. Per the
 * wave prompt's verify-first rule: write the test, run it. If it fails, the
 * bug is real and we proceed to apply the fix in Phase 2. If it passes, the
 * finding is invalid and we close it in `_invalidated_findings.md`.
 */
describe("verify-first: fetch_url isInternalIP SSRF guard coverage", () => {
  describe("fe80::/10 link-local IPv6 (P1.3)", () => {
    it("isInternalIP('fe80::1') is true (sanity — start of range)", () => {
      expect(isInternalIP("fe80::1")).toBe(true);
    });

    it("isInternalIP('fe90::1') is true (mid-range link-local)", () => {
      expect(isInternalIP("fe90::1")).toBe(true);
    });

    it("isInternalIP('fea0::1') is true (mid-range link-local)", () => {
      expect(isInternalIP("fea0::1")).toBe(true);
    });

    it("isInternalIP('febc::1') is true (mid-range link-local)", () => {
      expect(isInternalIP("febc::1")).toBe(true);
    });

    it("isInternalIP('febf::ffff') is true (last address in fe80::/10)", () => {
      expect(isInternalIP("febf::ffff")).toBe(true);
    });

    it("isInternalIP('fec0::1') stays whatever the current code returns (just outside fe80::/10 — sentinel)", () => {
      // fec0::/10 was deprecated site-local; not currently classified internal.
      // Test pins the boundary so the fix doesn't accidentally over-extend.
      expect(isInternalIP("fec0::1")).toBe(false);
    });
  });

  describe("IPv4-mapped IPv6 hex-colon form (P1.4)", () => {
    it("isInternalIP('::ffff:192.168.1.1') is true (sanity — dotted form works)", () => {
      expect(isInternalIP("::ffff:192.168.1.1")).toBe(true);
    });

    it("isInternalIP('::ffff:c0a8:0101') is true (= 192.168.1.1 in hex-colon form)", () => {
      expect(isInternalIP("::ffff:c0a8:0101")).toBe(true);
    });

    it("isInternalIP('::ffff:7f00:1') is true (= 127.0.0.1 in hex-colon form)", () => {
      expect(isInternalIP("::ffff:7f00:1")).toBe(true);
    });

    it("isInternalIP('::ffff:0a00:1') is true (= 10.0.0.1 in hex-colon form)", () => {
      expect(isInternalIP("::ffff:0a00:1")).toBe(true);
    });

    it("isInternalIP('::ffff:0808:0808') is false (= 8.8.8.8 — external)", () => {
      expect(isInternalIP("::ffff:0808:0808")).toBe(false);
    });
  });
});

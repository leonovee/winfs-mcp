import { describe, it, expect } from "vitest";
import { isProtocolDowngrade } from "../../../src/tools/network/fetch_url.js";

/**
 * v0.7 pre-tag bug-fix wave — fetch_url P1.1 regression test.
 *
 * Tests the `isProtocolDowngrade` predicate that gates the redirect-hop
 * downgrade check in `fetchUrlImpl`. End-to-end coverage of the redirect
 * loop against a local server is not feasible without bypassing the SSRF
 * guard (127.0.0.1 is blocked), so coverage is via the extracted predicate
 * + spec contract.
 *
 * The integration is asserted indirectly: the predicate's call site in
 * fetchUrlImpl is one line; if `isProtocolDowngrade(currentUrl, nextUrl)`
 * returns true, the redirect is refused with EHOSTNOTALLOWED + details.reason
 * = "protocol_downgrade". See spec amendment §AA (v0.7 pre-tag bug-fix wave).
 */
describe("fetch_url: isProtocolDowngrade predicate (P1.1)", () => {
  it("https → http is a downgrade", () => {
    expect(
      isProtocolDowngrade(
        new URL("https://example.com/a"),
        new URL("http://example.com/b"),
      ),
    ).toBe(true);
  });

  it("https → http on the SAME host is still a downgrade (the canonical attack)", () => {
    expect(
      isProtocolDowngrade(
        new URL("https://allowed.example/sso"),
        new URL("http://allowed.example/sso"),
      ),
    ).toBe(true);
  });

  it("https → https with different host is NOT a downgrade (host gets re-validated separately)", () => {
    expect(
      isProtocolDowngrade(
        new URL("https://a.example/"),
        new URL("https://b.example/"),
      ),
    ).toBe(false);
  });

  it("http → https is NOT a downgrade (channel upgrade is benign)", () => {
    expect(
      isProtocolDowngrade(
        new URL("http://example.com/"),
        new URL("https://example.com/"),
      ),
    ).toBe(false);
  });

  it("http → http stays http (no downgrade — already plain)", () => {
    expect(
      isProtocolDowngrade(
        new URL("http://example.com/a"),
        new URL("http://example.com/b"),
      ),
    ).toBe(false);
  });

  it("https → https stays https (no downgrade)", () => {
    expect(
      isProtocolDowngrade(
        new URL("https://example.com/a"),
        new URL("https://example.com/b"),
      ),
    ).toBe(false);
  });
});

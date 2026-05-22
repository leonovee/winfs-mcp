import { describe, it, expect } from "vitest";
import { redactUrlForAudit } from "../../../src/tools/network/fetch_url.js";

/**
 * v0.7 pre-tag bug-fix wave — verify-first for fetch_url P2.4.
 *
 * P2.4 (DeepSeek review Q5-D): `final_url: currentUrl.toString()` (line 451)
 * returns the full URL including query string to the caller. Audit log
 * redacts via `redactUrlForAudit`, but the tool's return value does not.
 * API keys or tokens in query strings leak to whatever the caller does
 * with the output.
 *
 * Verify-first: prove the leak mechanism via direct URL.toString() observation,
 * and confirm `redactUrlForAudit` exists and works as intended (the function
 * to apply during the Phase 2 fix).
 */
describe("verify-first: fetch_url final_url query-string leak (P2.4)", () => {
  it("URL.toString() preserves query string (= mechanism of the leak in fetchUrlImpl line 451)", () => {
    const u = new URL("https://example.com/path?token=sk-secret-12345");
    const asImplAssigns = u.toString();
    expect(asImplAssigns).toContain("token=sk-secret-12345");
  });

  it("redactUrlForAudit DOES remove the original query string content (mechanism for Phase 2 fix)", () => {
    const raw = "https://example.com/path?token=sk-secret-12345&other=value";
    const redacted = redactUrlForAudit(raw);
    expect(redacted).not.toContain("token=sk-secret-12345");
    expect(redacted).not.toContain("other=value");
  });

  it("redactUrlForAudit strips username:password from userinfo (defense for credential URLs)", () => {
    const r = redactUrlForAudit("https://user:p4ssw0rd@a.com/p");
    expect(r).not.toContain("p4ssw0rd");
  });

  it("redactUrlForAudit returns <malformed> for non-URLs", () => {
    expect(redactUrlForAudit("not a url")).toBe("<malformed>");
  });
});

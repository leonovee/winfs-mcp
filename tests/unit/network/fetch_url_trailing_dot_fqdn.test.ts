import { describe, it, expect } from "vitest";
import { fetchUrlImpl } from "../../../src/tools/network/fetch_url.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.9.1 Phase C6 — trailing-dot FQDN normalization.
 *
 * WHATWG URL parser does NOT strip trailing dot from hostnames
 * (`new URL("https://example.com./").hostname === "example.com."`), but
 * DNS treats `example.com` and `example.com.` as the same name. Before
 * the fix, a mismatch in trailing-dot form between the URL and the
 * allowlist caused EHOSTNOTALLOWED in either direction. After, both
 * forms canonicalize to the same key.
 *
 * Tests probe with hosts that won't actually resolve / connect (we only
 * exercise the whitelist check; DNS failure later is fine — we only
 * assert that the allowlist gate matched).
 */
function makeConfig(allowedUrlHosts: string[]): ResolvedConfig {
  return {
    allowedRoots: [],
    allowedUrlHosts,
    deniedUrlPatterns: [],
    shellBlocklist: [],
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10000,
    shellTimeoutMs: 5000,
    shellMaxTimeoutMs: 30000,
    fetchUrlMaxBytes: 1024,
    fetchUrlTimeoutMs: 2000,
    readMaxBytes: 1024,
    maxDiffBytes: 1024,
    execMaxOutputBytes: 1024,
    execExtraBlocklist: [],
    execSanitizeEnv: false,
    unrestrictedFilesystem: false,
    unrestrictedFilesystemConfirm: undefined,
    sshExePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    processMaxConcurrent: 4,
    processBufferCap: 1024,
    processSessionTtlMs: 10_000,
    processGcIntervalMs: 5_000,
    auditLogMaxBytes: 1024,
    configPath: "<test>",
    resolvedAllowedRoots: [],
    resolvedAuditLogPath: "C:\\tmp\\mcp-winfs\\audit.jsonl",
    version: "0.1.0-test",
    serverMode: "strict",
  };
}

describe("fetch_url: trailing-dot FQDN canonicalization (P2.9)", () => {
  // Both whitelist-miss and DNS-failure return EHOSTNOTALLOWED, so we
  // distinguish by message: whitelist failure says "host is not in
  // allowedUrlHosts", DNS failure says "DNS lookup failed".
  const WHITELIST_MSG = "host is not in allowedUrlHosts";

  it("URL with trailing dot is NOT rejected by the whitelist when allowlist has no dot", async () => {
    const config = makeConfig(["example.invalid"]);
    const res = await fetchUrlImpl({ url: "https://example.invalid./" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // Whitelist must have passed; the surviving error should be from DNS.
    expect(res.error.message).not.toBe(WHITELIST_MSG);
  });

  it("URL without trailing dot is NOT rejected by the whitelist when allowlist HAS dot", async () => {
    const config = makeConfig(["example.invalid."]);
    const res = await fetchUrlImpl({ url: "https://example.invalid/" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).not.toBe(WHITELIST_MSG);
  });

  it("URL host actually not in allowlist still rejected by whitelist (sanity)", async () => {
    const config = makeConfig(["example.invalid"]);
    const res = await fetchUrlImpl({ url: "https://other.invalid/" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.code).toBe("EHOSTNOTALLOWED");
    expect(res.error.message).toBe(WHITELIST_MSG);
  });
});

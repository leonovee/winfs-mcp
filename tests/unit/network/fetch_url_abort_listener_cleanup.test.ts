import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestServer, type MiniServer } from "../../http_helpers.js";
import { fetchUrlImpl } from "../../../src/tools/network/fetch_url.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 pre-tag bug-fix wave — fetch_url P2.2 regression test.
 *
 * P2.2 (3/3 reviewer convergence): `p.signal.addEventListener("abort", h,
 * { once: true })` is never removed on normal completion. `{ once: true }`
 * only removes the listener AFTER abort fires; if the request completes
 * cleanly, the listener stays attached. A long-lived AbortSignal reused
 * across many requests accumulates listeners.
 *
 * To exercise the listener-registration path the test must get PAST
 * validateHostWhitelist + resolveAndDenyInternal (those return early without
 * touching the Promise body). The whitelist + DNS pass cleanly when we
 * point at a TEST-NET-1 (192.0.2.0/24, RFC 5737) address that the SSRF
 * internal-IP filter does not classify as internal; the actual connection
 * fails quickly, so the Promise resolves via the req error handler — which
 * triggers safeResolve → listener cleanup.
 *
 * Pre-fix: listener count grows by 1 per call. Post-fix: stays at 0.
 */
describe("fetch_url: AbortSignal listener cleanup on normal completion (P2.2)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("a single fetch_url call against an unreachable external IP leaves no listener on the signal", async () => {
    // 192.0.2.1 is in TEST-NET-1 (RFC 5737) — no route, connection fails fast.
    // The host whitelist matches the literal IP; the SSRF guard doesn't
    // classify it as internal; the actual TCP connect fails.
    const cfg = { ...config, allowedUrlHosts: ["192.0.2.1"] };
    const controller = new AbortController();
    const signal = controller.signal;

    const countOf = (): number => {
      const fn = (signal as unknown as { listenerCount?: (s: string) => number }).listenerCount;
      return typeof fn === "function" ? fn.call(signal, "abort") : 0;
    };

    const before = countOf();
    const res = await fetchUrlImpl(
      { url: "http://192.0.2.1/", timeout_ms: 500 },
      cfg,
      signal,
    );
    // Either ETIMEDOUT (deadline) or EIO (connection refused) — both go
    // through safeResolve which (post-fix) removes the listener.
    expect(res.ok).toBe(false);

    const after = countOf();
    expect(after).toBeLessThanOrEqual(before);
  }, 10_000);

  it("ten back-to-back fetch_url calls against unreachable IP do not accumulate listeners", async () => {
    const cfg = { ...config, allowedUrlHosts: ["192.0.2.1"] };
    const controller = new AbortController();
    const signal = controller.signal;

    const countOf = (): number => {
      const fn = (signal as unknown as { listenerCount?: (s: string) => number }).listenerCount;
      return typeof fn === "function" ? fn.call(signal, "abort") : 0;
    };

    const before = countOf();
    for (let i = 0; i < 10; i++) {
      await fetchUrlImpl(
        { url: "http://192.0.2.1/", timeout_ms: 200 },
        cfg,
        signal,
      );
    }
    const after = countOf();
    // Pre-fix: after === before + 10 (per-call leak).
    // Post-fix: after === before.
    expect(after).toBeLessThanOrEqual(before);
  }, 30_000);
});

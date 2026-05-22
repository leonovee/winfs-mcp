# fetch_url.ts external review — findings consolidation — 2026-05-22T0859Z

Wave: `v0.7-pre-tag-fetch_url` against `main @ a885126`. File: `src/tools/network/fetch_url.ts`. **Highest-priority surface this wave** — only outbound network call, densest SSRF defense, most likely first attacker probe.

## ⚠ Wave provenance caveat

This surface has the **best coverage of the four**, with three substantive
artifacts (mixed provenance). One genuine API call, one substituted, one
with questionable provenance:

| Reviewer | Status | Provenance |
|---|---|---|
| **Codex** | substantive artifact (20.5 KB), substituted | CLI not installed; codex-reviewer subagent did Sonnet-driven analysis with explicit "NOT codex CLI output" disclaimer. Detailed Q1-Q5 walkthrough with line refs. |
| **Kimi** | substantive artifact (13.3 KB), real API | API call via `moonshot-v1-128k` fallback (preferred `kimi-k2.6` burned all tokens on thinking chain). Subagent post-triaged model output, re-graded model's P0s down to P1s, and corrected the model's suggested fixes for Areas 8 and 9 where the model's code was wrong. |
| **Gemini** | missing artifact | CLI not installed; agent stopped without fabrication. |
| **DeepSeek** | substantive artifact (11.9 KB), provenance claim unverifiable | Artifact claims "Model used: deepseek-v4-pro (no fallback)" — but every other DeepSeek call in this wave hit "API key not set". Either this one found the key by some route or the provenance line is overstated. Findings overlap significantly with Codex-substituted and Kimi-real, consistent with thoughtful static analysis regardless of provenance. |

**Effective convergence: 2 of 3 substantive findings agree on the same headline
items (HTTPS→HTTP downgrade, AbortSignal listener leak).** This is the
strongest signal in the wave. The convergence is partially weakened by
Codex's substitution (Sonnet-Sonnet "agreement" is less independent than
Codex-DeepSeek would be), but the items are also independently surfaced
by Kimi which IS real model output.

## Reviewer profiles (recap)

- Codex — sharp on P1. **Substituted** here.
- Kimi — adversarial. **Real API**. Subagent re-graded model's P0s down — disciplined triage.
- Gemini — Windows DNS / IPv6 spellings. **Did not run** — missing reviewer.
- DeepSeek — anti-hallucination structural. **Substantive output, provenance ambiguous**.

## P1 findings (cross-reviewer convergence on TWO items)

### P1.1 — HTTPS→HTTP redirect downgrade not blocked

Raised by: **Codex (substituted)** + **Kimi (real)** + **DeepSeek (provenance ambiguous)** — convergence on 3/3 substantive reviewers. Strongest signal in the entire wave.

- Codex P1-B: "Lines 464-471. A redirect from `https://host/` to `http://host/` is not blocked; the redirect passes all validation layers. Plain-HTTP hops are detectable by MITM and create a path to probe HTTP-only internal services."
- Kimi F1: "Lines 463-474. Reproduce: whitelist `allowed.com`; set up `https://allowed.com/redir` to return `Location: http://allowed.com/final`. fetchUrlImpl follows the redirect to plain HTTP without error."
- DeepSeek Q5-A (P2 in DeepSeek's grading, P1 in two other reviewers' grading): "The redirect loop re-validates protocol, host, and IP, but does not prevent a downgrade from HTTPS to HTTP. If `https://trusted.com` redirects to `http://trusted.com`, the request will follow it over plain HTTP, exposing the traffic."

**Converged description.** `validateProtocol` accepts both `http:` and `https:`. The redirect loop re-validates each hop's protocol against `validateProtocol`, but does NOT compare the next hop's scheme against the previous hop's scheme. An HTTPS-whitelisted host that redirects to its own plain-HTTP URL silently downgrades the connection — MITM-observable for all subsequent traffic.

Severity disagreement: Codex and Kimi grade P1; DeepSeek grades P2. Convergence on the existence + fix; debate on severity. Use the higher rating (P1) pre-tag.

**Recommended fix.** Add a protocol-downgrade check before advancing `currentUrl` in the redirect loop:

```typescript
if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
  return buildError("EHOSTNOTALLOWED", "protocol downgrade in redirect", {
    details: { from: currentUrl.protocol, to: nextUrl.protocol },
  });
}
```

(Or a fully symmetric check: `if (nextUrl.protocol !== currentUrl.protocol)` to also block http→https in case a caller is doing pre-validated http-only flows. Architect call.)

Test: setup a fake server that returns `Location: http://test.local/` from an `https://test.local/` endpoint; assert `EHOSTNOTALLOWED` (or new dedicated code `EPROTOCOL_DOWNGRADE`).

### P1.2 — `rejectUnauthorized` not explicitly set in HTTPS options

Raised by: **Codex (substituted)** only. Single-source.

- Codex P1-A: "Lines 307-311. `httpsOpts` passes `servername` for SNI but does not set `rejectUnauthorized: true`. Node's default is `true`, but this is an implicit reliance on a runtime default for the only HTTPS surface. A monkey-patched test environment or an `https.globalAgent` override could silently disable cert validation without any code change to `fetch_url.ts`."

**Converged description.** Defense-in-depth gap. Node's default IS `rejectUnauthorized: true`, so cert validation works today. But the value is implicit. Any global change (test setup, npm package side-effect, future Node-version default flip) could silently disable it.

DeepSeek's Q1 explicitly addressed this and noted: "For HTTPS, `rejectUnauthorized` is left at its secure default; `servername` (line 309) ensures SNI and certificate hostname verification use the original hostname. No `rejectUnauthorized: false` appears anywhere." DeepSeek classified this as not a finding (defaults are correct). Codex classified P1 (defaults are not contracts).

**Recommended fix.** One line:

```typescript
const httpsOpts: https.RequestOptions = {
  ...commonOpts,
  servername: hostname,
  rejectUnauthorized: true,  // explicit; do not rely on the default
};
```

Pure belt-and-suspenders. No runtime behavior change today; documentation-via-code for future maintainers.

### P1.3 — fe80::/10 link-local IPv6 only partially blocked

Raised by: **Kimi (real)** only. Single-source. **Security-relevant.**

- Kimi F8: "Line 107. `lower.startsWith("fe80")` misses `fe90::`, `fea0::`, `feb0::`, `febc::` etc. These are all in fe80::/10 (link-local) but evade the check."

**Converged description.** The fe80::/10 prefix covers `fe80::` through `febf::` (10 bits of prefix). `startsWith("fe80")` only catches addresses whose first 16 bits are exactly `fe80`. A DNS-controlled attacker returning `fe90::1`, `fea0::1`, or `febc::1` evades the link-local SSRF defense.

**Recommended fix.** Replace literal prefix check with bitwise mask:

```typescript
// Replace: if (lower.startsWith("fe80")) return true;
const firstWord = parseInt(lower.split(":")[0] || "0", 16);
if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10
```

Test: assert `isInternalIP("fe80::1")`, `isInternalIP("fe90::1")`, `isInternalIP("fea0::1")`, `isInternalIP("febf::1")` all return `true`; assert `isInternalIP("fec0::1")` (site-local, different prefix) returns its existing classification.

### P1.4 — IPv4-mapped IPv6 in hex-colon notation bypasses isInternalIP

Raised by: **Kimi (real)** only. Single-source. **Security-relevant.**

- Kimi F9: "The regex `/^::ffff:([0-9a-f.:]+)$/` matches `::ffff:c0a8:0101` (which is `::ffff:192.168.1.1`) with `inner = "c0a8:0101"`. Then `net.isIPv4("c0a8:0101")` returns false. The function returns false (not internal). This is a bypass."

**Converged description.** `::ffff:c0a8:0101` is a valid IPv6 representation of `::ffff:192.168.1.1` (which is the IPv4-mapped form of 192.168.1.1). The code recognises the `::ffff:` prefix, extracts the inner part `c0a8:0101`, then asks `net.isIPv4` to validate it. `net.isIPv4` expects dotted-decimal; hex-colon form returns false; the SSRF guard returns "not internal" and the address reaches the connect phase to `192.168.1.1`.

**Recommended fix.** Add hex-colon-form parsing after the dotted-decimal check:

```typescript
const m = lower.match(/^::ffff:([0-9a-f.:]+)$/);
if (m) {
  const inner = m[1]!;
  if (net.isIPv4(inner)) return isInternalIP(inner);
  // Hex-colon form: e.g. "c0a8:0101" = 192.168.1.1
  const hexColonMatch = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexColonMatch) {
    const hi = parseInt(hexColonMatch[1]!, 16);
    const lo = parseInt(hexColonMatch[2]!, 16);
    const dotted = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isInternalIP(dotted);
  }
}
```

Test: assert `isInternalIP("::ffff:c0a8:0101")` returns `true` (= 192.168.1.1, internal); assert `isInternalIP("::ffff:8.8.8.8")` and `isInternalIP("::ffff:0808:0808")` return same classification.

Caveat: Kimi notes the model's original suggested fix code was incomplete; the version above is the subagent-corrected version.

## P2 findings (multi-reviewer convergence on most items)

### P2.1 — `truncated` output flag is dead in the success path

Raised by: **Codex (substituted) P2-B** + **Kimi (real) F4** + **DeepSeek (ambiguous) Q3-A** — convergence 3/3.

`truncated = true` is set in the data-handler oversize branch (line 343) but `safeResolve(ESIZE)` is called immediately after (lines 346-350). The `end` event that would return `{truncated: true}` is never reached. In every successful response path, `truncated` is always `false`. Tool description / output schema make a false contract claim.

**Fix.** Remove the dead `truncated` setting in the data-handler oversize branch, OR rewire so truncation results in a successful response with `truncated: true` rather than ESIZE error (depends on whether the spec contract is "cap size with error" vs "cap size with truncation"). The spec says ESIZE; align the schema docs.

### P2.2 — AbortSignal listener leak on normal completion

Raised by: **Codex (substituted) P2-A** + **Kimi (real) F1 (model P1, reviewer-downgraded P3)** + **DeepSeek (ambiguous) Q4-A** — convergence 3/3, with P2/P3 disagreement.

`p.signal.addEventListener("abort", handler, { once: true })` is never removed on normal completion. `{ once: true }` only removes the listener after `abort` fires. Long-lived signals reused across many requests accumulate listeners.

**Fix.** Capture the listener reference, call `removeEventListener` inside `safeResolve`:

```typescript
const abortListener = () => { safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {})); };
if (p.signal && !p.signal.aborted) {
  p.signal.addEventListener("abort", abortListener, { once: true });
}
const safeResolve = (v) => {
  if (settled) return;
  settled = true;
  clearTimeout(deadlineTimer);
  try { req.destroy(); } catch {}
  if (p.signal) p.signal.removeEventListener("abort", abortListener);
  resolve(v);
};
```

### P2.3 — Silent gzip corruption when server ignores `Accept-Encoding: identity`

Raised by: **Codex (substituted) P2-D** + **DeepSeek (ambiguous) Q3-B** — convergence 2/3 substantive. Kimi did not specifically raise this.

`Accept-Encoding: identity` is sent (line 178) but Node's HTTP client doesn't auto-decompress. Misbehaving server returning `Content-Encoding: gzip` produces raw gzip bytes converted via `.toString("utf8")` → garbage. Data-integrity violation; no error.

**Fix.** Two options: (a) check response `Content-Encoding` header; if not `identity` or absent, return `EENCODING` with a hint. (b) implement decompression for gzip/br/deflate. Option (a) is the safer / simpler / spec-compliant choice for v0.7.

### P2.4 — `final_url` leaks unredacted query string

Raised by: **DeepSeek (ambiguous) Q5-D** only. Strong P2 if confirmed.

`final_url: currentUrl.toString()` (line 451) returns the full URL including query string to the caller. The audit log redacts query strings, but the tool's return value does not. API keys / tokens in URL query strings leak to whatever the caller does with the output.

**Fix.** Apply the same `redactUrlForAudit` (or a comparable function with appropriate output semantics — return-value redaction may differ from audit-log redaction) to `final_url`. Or document that the caller MUST treat `final_url` as sensitive.

### P2.5 — `data` handler missing `settled` guard

Raised by: **Codex (substituted) P2-C** only. Single-source.

Lines 333-335. Bytes can accumulate past cap after `safeResolve(ESIZE)` fires but before `req.destroy()` completes. Best-effort caveat in spec; "real cap" depends on Node's stream cleanup ordering. **Fix:** add `if (settled) return;` at the top of the `data` handler.

### P2.6 — 3xx body wasted bandwidth (DoS vector)

Raised by: **DeepSeek (ambiguous) Q5-B** + **Codex (substituted, P3 in Codex's grading)** — 2/3, severity split.

After extracting `Location` from a 3xx response, `fetchOnce` continues reading the full response body (up to `maxBytes = 5 MB`) before resolving with `redirectTo`. Up to 15 MB wasted per 3-hop chain. **Fix:** call `req.destroy()` right after stamping `redirectTo` from the headers.

### P2.7 — Wrong error code `EHOSTNOTALLOWED` for redirect-limit exhaustion

Raised by: **Codex (substituted) P3-F** + **DeepSeek (ambiguous) Q5-C** — 2/3.

Line 422 returns `EHOSTNOTALLOWED` when `hops > MAX_REDIRECTS`. Semantically wrong — it's a redirect limit, not a host restriction. **Fix:** introduce `EMAXREDIRECTS` code; update tests. Spec amendment §10 may need a note.

### P2.8 — Whitelist entries not `.trim()`-ed

Raised by: **Codex (substituted) P2-F** + **Kimi (real) F7** + **DeepSeek (ambiguous) Q2 (P3 in DeepSeek)** — convergence 3/3.

`config.allowedUrlHosts.map((h) => h.toLowerCase())` does not trim. Operator misconfiguration (trailing space) silently rejects all requests to that host. **Fix:** add `.trim()` to the map.

### P2.9 — Trailing-dot FQDN whitelist behavior

Raised by: **Codex (substituted) P2-E** + **Kimi (real, denied)** + **DeepSeek (ambiguous, denied as safe)**. Reviewer disagreement.

WHATWG URL parser behavior is implementation-dependent — Chrome preserves the dot, Node may or may not. DeepSeek tested and said safe. Codex flagged P2. Kimi denied as needing empirical verification. **Action:** write an empirical test against current Node version, then close or fix based on result.

## P3 findings

- **`dns.lookup({ all: false })` OS-family preference, undocumented** (Codex P2-G; downgrade to P3 — works correctly, just implicit).
- **`http.RequestOptions.host` (deprecated) used instead of `hostname`** (Codex P2-H). Cosmetic future-proofing.
- **`ETIMEDOUT` conflation: deadline vs abort signal indistinguishable** (Codex P3-E + Kimi F2 (P2) + DeepSeek Q4-B (P3)). Cosmetic; suggest `EABORT` for caller-initiated cancellation.
- **No wildcard/subdomain docs in tool description** (Codex P3-A).
- **IDN punycode operator-warning absent** (Codex P3-B).
- **IP-literal whitelist behavior undocumented** (Codex P3-C).
- **Whitelist lowercasing recomputed on every call** (Codex P3-D). Alloc churn.
- **`parseInt` on Content-Length silently produces NaN → skips pre-check** (Codex P3-H).
- **User headers forwarded verbatim on cross-host redirects** (Codex P2-J; privacy P3).

## Reviewer-unique findings flagged

- **P2.4 (`final_url` query string leak)** is DeepSeek-only. High signal if DeepSeek's provenance is real; recheck if not.
- **P2.5 (`data` handler `settled` guard)** is Codex-only.
- **P1.3 (fe80::/10) and P1.4 (IPv4-mapped IPv6 hex-colon)** are Kimi-only. Both are detailed enough and security-relevant enough that they should be validated empirically before applying the fix (write a test that demonstrates the bypass with a controlled DNS response, assert the SSRF guard rejects it). Kimi's real-API status gives some confidence; the security stakes still warrant verification.

## Recommended action plan

In severity-then-ease order. Each is a candidate `fix(fetch_url): …` commit. Chat-Claude approval gates.

1. **PRE-FIX EMPIRICAL VERIFICATION (P1.3, P1.4)** — write tests that mock `dns.lookup` to return `fe90::1`, `fea0::1`, `febc::1`, `::ffff:c0a8:0101`; assert `isInternalIP` returns `true` for each. If the tests pass before any code change, findings are invalid. If they fail (bypass real), proceed to #3, #4.
2. **`fix(fetch_url): block HTTPS→HTTP redirect downgrade` (P1.1)** — strongest convergence (3/3); single-method change in the redirect loop. Test: mock 302 from `https://` to `http://` for whitelisted host; assert `EHOSTNOTALLOWED` (or new `EPROTOCOL_DOWNGRADE`).
3. **`fix(fetch_url): isInternalIP recognises full fe80::/10 range` (P1.3)** — only if step 1 confirms bypass.
4. **`fix(fetch_url): isInternalIP recognises IPv4-mapped IPv6 in hex-colon form` (P1.4)** — only if step 1 confirms bypass.
5. **`fix(fetch_url): explicit rejectUnauthorized: true on HTTPS options` (P1.2)** — defense-in-depth; one-line; no behaviour change today.
6. **`fix(fetch_url): truncated flag — either rewire or drop from output schema` (P2.1)** — three-reviewer convergence. Architect call: keep ESIZE-on-overflow (drop the flag) or switch to truncation-as-success (rewire). Spec amendment likely.
7. **`fix(fetch_url): remove AbortSignal listener on safeResolve` (P2.2)** — three-reviewer convergence; small change.
8. **`fix(fetch_url): trim allowedUrlHosts entries` (P2.8)** — three-reviewer convergence; one-liner.
9. **`fix(fetch_url): redact final_url query string in response` (P2.4)** — single-source DeepSeek but high-impact data-leak finding. Verify (does final_url currently contain `?token=...`? Almost certainly yes); apply same redactor as audit-log path; document in tool description.
10. **`fix(fetch_url): Content-Encoding sanity check or decompression` (P2.3)** — two-reviewer convergence. Option (a) check + EENCODING is simpler.
11. **`fix(fetch_url): early req.destroy() on 3xx hop` (P2.6)** — two-reviewer; bandwidth/DoS hardening.
12. **`fix(fetch_url): introduce EMAXREDIRECTS code` (P2.7)** — two-reviewer; spec amendment + caller-facing breaking change consideration.
13. **`fix(fetch_url): settled guard on data handler` (P2.5)** — single-source Codex; small change.
14. **`fix(fetch_url): empirical test for trailing-dot FQDN whitelist behavior` (P2.9)** — test-first; outcome decides whether code change needed.

P3 items defer to v0.7.x cleanup pass.

## Re-run guidance

Gemini is the missing reviewer for this surface. Its Windows-specific
profile would be particularly valuable on the IPv6 spelling questions
(zone identifiers `fe80::%1`, localhost variants). DeepSeek's provenance is
worth re-validating with an explicit API call once `DEEPSEEK_API_KEY` is set.

**Bottom line for chat-Claude:** the fetch_url surface has the strongest
evidence base in the wave despite no real Codex / no Gemini. The three
P2-convergence items (truncated, listener leak, trim) are safe to land
post-tag without re-run. The two P1 single-source security findings (fe80,
::ffff: hex-colon) deserve empirical verification before fix lands.
P1.1 (HTTPS→HTTP downgrade) is the highest-confidence P1 in the entire
wave — 3/3 substantive reviewers agree and the fix is unambiguous.

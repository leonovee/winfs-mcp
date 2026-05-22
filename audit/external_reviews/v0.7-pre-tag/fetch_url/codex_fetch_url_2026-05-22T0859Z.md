# Codex review — Phase v0.7-pre-tag-fetch_url — 2026-05-22T0859Z

## Invocation

Model used: N/A — CLI not installed (see below)
Command (exact, including flags and PATH setup):
```
$env:PATH = "$pwd\.venv\Scripts;$env:PATH"
codex review --model "gpt-5.5 xhigh" --files src/tools/network/fetch_url.ts --output-format markdown
```

## Commit range

da1eb2a..a885126 (HEAD — fetch_url.ts UNCHANGED in wave 2a per drift note)

## Files in scope

- src/tools/network/fetch_url.ts (547 lines, fully read at HEAD a885126)

---

## CLI FAILURE — VERBATIM ERROR

```
Codex CLI invocation failed.

Command: codex review --model "gpt-5.5 xhigh" --files src/tools/network/fetch_url.ts --output-format markdown

Error (verbatim):
PowerShell: codex : The term 'codex' is not recognized as the name of a cmdlet, function, script file,
or operable program. Check the spelling of the name, or if a path was included, verify that the path
is correct and try again.
At line:1 char:50
+ Get-Command codex -ErrorAction SilentlyContinue; codex --version 2>&1
+                                                  ~~~~~
    + CategoryInfo          : ObjectNotFound: (codex:String) [], CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException

Bash: /usr/bin/bash: line 1: codex: command not found
npm global: ENOENT — npm AppData\Roaming\npm not found (npm never initialized for this user profile)
```

Recommended action: install codex CLI (`npm install -g @openai/codex` or per OpenAI docs),
or defer to architect. Manual review follows below as codex-reviewer static fallback.

NOTE: This is NOT a Codex CLI output. It is a manual static review by the codex-reviewer
subagent performed directly on the source file at HEAD (a885126), using the structured
review guidance in `_review_fetch_url.prompt.md`. The architect must treat this as a
subagent static review, NOT a Codex CLI review.

---

## Raw output

(No CLI output — CLI not installed.)

---

## Manual static review — src/tools/network/fetch_url.ts @ a885126

Performed against review guidance in `audit/external_reviews/_review_fetch_url.prompt.md`.
All line references are to `src/tools/network/fetch_url.ts` at HEAD a885126.

---

### Q1 — DNS rebinding TOCTOU + multi-address + IP-literal handling

**Q1.1 — `dns.lookup({ all: false })` single-address selection (P2)**

Line 156: `resolved = await dns.lookup(host, { all: false });`

`{ all: false }` returns exactly one address — the one Node's libc resolver selects based
on `getaddrinfo` ordering, which follows `/etc/hosts` and system address-family preferences.
If the DNS zone has multiple A records (round-robin CDN), the returned address is
deterministic within the call but is NOT guaranteed to be the one we actually pin for
connect. We do pin the returned IP at line 298 (`host: ip`), so within a single call the
TOCTOU vector is closed. Between calls (different requests), a different A record could
be returned — that is acceptable per-request isolation, not a vulnerability.

The more concerning sub-case: a hostname with both A (public) and AAAA (internal fe80::*)
records. `dns.lookup` with `{ all: false }` and no `family` option lets the OS pick. On
Linux with default `/etc/gai.conf`, IPv6 is preferred when available. If the OS selects
the fe80:: address, `isInternalIP` correctly catches it (line 107 covers `fe80` prefix).
If the OS selects the public IPv4, we allow it and connect to that IPv4. So the defense
holds in both orderings. No bypass identified, but the behavior is OS-dependent.

**Q1.2 — `http.RequestOptions.host` vs `hostname` (P2)**

Line 298: `host: ip,` in `reqOpts`.

Node's `http.request` docs deprecate `host` in favor of `hostname` (the `host` option
includes port, `hostname` does not; however in practice both work as the connect target
when `port` is also set separately). With `port` set explicitly (line 241-245), `host: ip`
functions correctly — the socket connects to `ip:port`. The risk flagged in the review
guide (Node silently defaulting to localhost) does not materialize here because `port` is
always explicitly set. Severity: P2 documentation/future-maintenance concern only.

**Q1.3 — IP-literal URLs bypass Layer 1 whitelist (P1)**

A caller supplying `url: "http://8.8.8.8/"` will have `url.hostname === "8.8.8.8"`.
Layer 1 (`validateHostWhitelist`, line 129-139) checks `allowed.includes("8.8.8.8")`.
Unless the operator explicitly whitelisted the IP literal, this correctly returns
`EHOSTNOTALLOWED`. So IP literals are blocked by Layer 1 unless intentionally added.

However: if an operator DOES add an IP literal to `allowedUrlHosts` (e.g., `"8.8.8.8"`),
the flow enters `resolveAndDenyInternal` where `net.isIP(host)` is true (line 146). The
`isInternalIP` check is applied, and if it passes (public IP), `{ ip: host, family: 4 }`
is returned. Connect proceeds. That is intentional and correct.

The risk: there is no documentation in the tool description or config hint that
`allowedUrlHosts` can contain IP literals, and the exact-match semantics mean `"8.8.8.8"`
in the whitelist allows ALL paths on that IP. Not a security bypass, but a documentation
gap. Severity: P3.

**Q1.4 — TLS cert validation — `rejectUnauthorized` not explicitly set (P1)**

Lines 307-311: `httpsOpts` includes `servername: p.url.hostname` for SNI but does NOT
explicitly set `rejectUnauthorized`. Node's default is `rejectUnauthorized: true` in
current LTS versions, so cert validation is on by default. However, this is an implicit
reliance on a runtime default for a security-critical property on the only outbound
network surface. If a future Node version changes the default, or if the `https` module
is monkey-patched (e.g., by a test harness that globally sets
`https.globalAgent.options.rejectUnauthorized = false`), cert validation silently drops.

Recommendation: explicitly set `rejectUnauthorized: true` in `httpsOpts`. One line, zero
ambiguity, immune to environment contamination.

Severity: P1 — implicit security default on the only HTTPS surface.

**Q1.5 — IPv6 scope ID in fe80 detection (P2)**

Line 107: `if (lower.startsWith("fe80")) return true;`

Link-local IPv6 addresses often appear with scope IDs: `fe80::1%eth0`. The `%eth0`
suffix is valid in some contexts. `net.isIPv6("fe80::1%eth0")` returns `true` in Node
(it accepts scope IDs). However, `lower.startsWith("fe80")` still matches, so the
internal check fires correctly. No bypass identified, but the regex for `::ffff:` mapping
(line 110) does not handle scope IDs. A hypothetical `::ffff:127.0.0.1%lo` would not
match the regex pattern and would fall through to `return false` — treating a
loopback-mapped IPv6 with scope ID as NOT internal. In practice `dns.lookup` does not
return scope IDs, so the risk is theoretical for the DNS path; it could matter if an
operator whitelists an IPv6 literal with scope ID. Severity: P2.

---

### Q2 — Layer 1 whitelist edge cases

**Q2.1 — Trailing dot FQDN normalization absent (P2)**

Lines 130-131: `url.hostname.toLowerCase()`. WHATWG URL parser behavior for
`https://example.com./path`: in Node's WHATWG URL implementation, `new URL("https://example.com./")
.hostname` returns `"example.com."` (trailing dot preserved). This does NOT match
whitelist entry `"example.com"`. Result: every trailing-dot FQDN is rejected even if the
hostname is whitelisted. False rejection, not a security bypass. But DNS-resolving clients
that canonicalize to FQDN form (some corporate proxies emit trailing-dot hostnames) would
see unexpected EHOSTNOTALLOWED. Recommend: `host.replace(/\.$/, "")` before comparison.

Severity: P2 — correctness/availability concern.

**Q2.2 — Whitelist entry whitespace not trimmed (P2)**

Line 131: `config.allowedUrlHosts.map((h) => h.toLowerCase())`. If an operator
misconfigures `"example.com "` with trailing space, the entry lowercases but keeps the
space. `url.hostname` will never have trailing space. All requests to `example.com` would
be rejected with no clear error (the error message says "host is not in allowedUrlHosts"
— operator would have to diff the strings carefully to spot the space). Recommend:
`.map((h) => h.toLowerCase().trim())`.

Severity: P2 — operator UX / misconfiguration trap.

**Q2.3 — No wildcard/subdomain support, undocumented (P3)**

The tool description (lines 488-494) documents exact-match semantics but does not
explicitly state "subdomains are NOT matched; `sub.example.com` requires its own entry."
Callers expecting DNS-zone-level whitelisting will be surprised. Recommend one sentence
in the tool description. Severity: P3.

**Q2.4 — IDN/Punycode (P3, correctly handled)**

WHATWG URL parser normalizes `https://еxample.com/` (Cyrillic е) to
`xn--xample-r2a.com` in `url.hostname`. This does not match `"example.com"` in the
whitelist — correctly rejected. No bypass. However, the operator warning about accidental
whitelisting of the punycode form is absent from docs. Severity: P3.

**Q2.5 — Whitelist rebuilt on every call (P3 — performance)**

Line 131: `config.allowedUrlHosts.map((h) => h.toLowerCase())` allocates a new lowercased
array on every `validateHostWhitelist` call (every hop, every request). If
`allowedUrlHosts` has many entries and requests are frequent, this is unnecessary
allocation. Precompute at config load time. Severity: P3.

---

### Q3 — Body cap enforcement

**Q3.1 — `truncated` field is dead code on success path (P2)**

Lines 343-354: every oversize chunk path eventually calls `safeResolve(ESIZE)`. The `end`
event (line 356) can only fire with `truncated = true` if a chunk pushed partial bytes
(`received = p.maxBytes`) but the `if (chunks.length === 0 || received >= p.maxBytes)`
condition is always true after `received = p.maxBytes`, so `safeResolve(ESIZE)` fires and
`settled = true` before `end` can fire. Conclusion: `truncated` in the `FetchOnceResult`
/ `FetchUrlResult` output is always `false` on a successful return — it is structurally
dead. This is misleading (the output schema advertises `truncated: boolean` as meaningful).
Recommend either (a) remove the field, (b) document it as always-false and reserved, or
(c) change policy to return partial body with `truncated: true` instead of ESIZE.

Severity: P2 — schema correctness / caller contract confusion.

**Q3.2 — Data handler does not check `settled` (P2)**

Lines 333-355: the `data` handler has no `if (settled) return` guard at the top. After
`safeResolve(ESIZE)` fires (which calls `req.destroy()`), the stream destruction is
asynchronous. More `data` events can arrive before the socket actually closes. Each
subsequent `data` event re-evaluates the oversize branch and calls `safeResolve` again —
but `safeResolve` is guarded by `settled`, so no double-resolution. However, `received`
is not guarded and can grow past `maxBytes` if multiple large chunks arrive pre-destroy.
The `bytes_received` in the eventual audit log would reflect the settled call's value
(capped at `maxBytes` in the truncation path), not the actual bytes transferred. Net effect:
no correctness failure, but memory spike up to one extra chunk's worth after cap.

Recommend adding `if (settled) return;` as first line of the `data` handler.

Severity: P2 — minor memory / auditability issue.

**Q3.3 — Content-Encoding ignored (P2)**

Line 360: `Buffer.concat(chunks).toString("utf8")`. `Accept-Encoding: identity` is sent
(line 178) but servers may ignore it and return `Content-Encoding: gzip`. The raw gzip
bytes would be returned as the `body` string — garbage to any caller expecting text. No
memory blowup risk (we don't decompress, so no compression bomb). But caller gets silent
data corruption. There is no response `Content-Encoding` header check or warning.

Recommend: check `res.headers["content-encoding"]`; if not `"identity"` or absent, either
decompress (adding zlib dependency) or return an `EIO` error with `content_encoding:
<value>` in details so caller knows why body is not text. At minimum, include
`content_encoding` in the success result so caller can detect and handle.

Severity: P2 — silent data corruption vector.

**Q3.4 — Content-Length parsed with `parseInt` — NaN becomes 0 (P3)**

Line 318: `parseInt((res.headers["content-length"] ?? "0"), 10)`. If the server returns
a malformed `Content-Length: abc`, `parseInt("abc", 10)` returns `NaN`. The guard
`cl > 0` is false for `NaN` (NaN comparisons are always false), so the pre-check is
skipped. Stream check still applies — body cap is enforced by the data handler. No
bypass, but the pre-check silently no-ops on malformed headers. Severity: P3.

---

### Q4 — AbortSignal lifecycle

**Q4.1 — Abort listener not removed on normal completion (P2)**

Lines 287-294: `p.signal.addEventListener("abort", handler, { once: true })` is called
but the listener is only removed if the abort event actually fires (`{ once: true }`
handles that case). On normal successful completion (200 OK, `end` event, `safeResolve`
called), the listener remains attached to `p.signal` for the signal's remaining lifetime.

If the same `AbortController` / `AbortSignal` is reused across multiple `fetch_url`
calls (which `runTool` may do via a shared signal from the MCP session), listeners
accumulate — one per call, never GC'd until the signal is GC'd. Memory leak proportional
to request count per signal lifetime.

Fix: capture listener reference, call `p.signal.removeEventListener("abort", listener)`
inside `safeResolve`. Alternatively, use `http.request({ signal })` (Node >= v15) which
handles cleanup automatically.

Severity: P2 — memory leak for long-lived sessions with many requests.

**Q4.2 — `ETIMEDOUT` code used for both deadline and abort (P3)**

Lines 271-273 and 289-291: both deadline timer and abort signal fire `ETIMEDOUT`. Caller
cannot distinguish "wall-clock exceeded" from "caller-initiated cancel". If future retry
logic wants to retry on deadline but not on abort (or vice versa), this conflation blocks
that. Consider `EABORT` for abort-signal path. Severity: P3.

---

### Q5 — Redirect chain

**Q5.1 — HTTPS-to-HTTP protocol downgrade allowed (P1)**

`fetchUrlImpl` (lines 464-471) constructs `nextUrl = new URL(hop.redirectTo, currentUrl)`.
If `currentUrl` is `https://example.com/` and the server returns `Location: http://example.com/other`,
`nextUrl.protocol === "http:"`. The next call to `fetchOnce` runs `validateProtocol` which
accepts both `http:` and `https:`. Layer 1 whitelist checks only hostname, not protocol.
Layer 2 checks IP. If the host and IP both pass, the redirect to plain HTTP succeeds.

Result: a request that started as HTTPS can be silently downgraded to HTTP on a redirect.
Any headers sent on the HTTP hop (User-Agent, Accept-Language, even implicit fingerprinting
headers) are transmitted unencrypted and can be intercepted or modified by a MITM.

Note: caller-supplied `Authorization` is blocked by the header allowlist — so credential
theft is not directly exposed. But the SSRF defense is weakened because a redirect chain
can be used to probe internal HTTP services that don't support TLS.

Fix: in `fetchUrlImpl`, before incrementing `hops` and advancing `currentUrl`, check:
```typescript
if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") {
  return buildError("EHOSTNOTALLOWED", "redirect would downgrade https to http", {
    details: { from: redactUrlForAudit(currentUrl.toString()), to: redactUrlForAudit(hop.redirectTo) }
  });
}
```

Severity: P1 — protocol downgrade on redirect, potential SSRF vector via HTTP-only internal services.

**Q5.2 — Redirect limit error code is `EHOSTNOTALLOWED` (P3)**

Line 422: `buildError("EHOSTNOTALLOWED", "redirect chain exceeded max hops", ...)`. The
error code is semantically wrong — EHOSTNOTALLOWED means the target host is disallowed,
not that a hop count was exceeded. Suggest a dedicated code or at minimum `ELIMITS`.
Callers who catch `EHOSTNOTALLOWED` to "retry with a different host" would incorrectly
handle this case. Severity: P3.

**Q5.3 — 3xx body downloaded unnecessarily (P3)**

On a 3xx response, `fetchOnce` continues receiving body bytes up to `maxBytes` before
setting `redirectTo`. The body is accumulated in `chunks`, then the `end` event fires and
`safeResolve({..., redirectTo})` is called — the body is returned but discarded in
`fetchUrlImpl` (lines 443-461 skip body when `redirectTo` is set). Up to `maxBytes`
(default 5 MB) × 3 hops = 15 MB wasted transfer and memory allocation. Optimization:
on 3xx detection, `req.destroy()` immediately. Severity: P3.

**Q5.4 — `userHeaders` passed on every redirect hop (P2)**

Line 432-438: `fetchOnce` is called with `userHeaders: args.headers` on every hop.
User-supplied `User-Agent`, `Accept`, `Accept-Language` headers are re-sent verbatim on
all redirect hops, including cross-host redirects. If hop 1 is
`https://trusted.com/` → hop 2 redirect to `https://other-whitelisted.com/`,
`User-Agent: Mozilla/5.0 (Windows; custom fingerprint)` is sent to the second host.
This is a minor privacy concern; browsers strip custom headers on cross-origin redirects.
The current allowlist (only User-Agent / Accept / Accept-Language) limits leakage to
non-sensitive headers, so risk is low. Flagging for documentation only. Severity: P2
(documentation / policy gap — no active exploit identified).

---

## Summary (codex-reviewer subagent reading)

### P0 / BLOCKING
None identified.

### P1 / HIGH

**P1-A — `rejectUnauthorized` not explicitly set in HTTPS options (Q1.4)**
Lines 307-311. Node's default is `true` but it is an implicit reliance on a runtime
default for the only HTTPS surface. Monkey-patched test environments or future Node
changes could silently disable cert validation. Fix: add `rejectUnauthorized: true` to
`httpsOpts`.

**P1-B — HTTPS-to-HTTP redirect downgrade allowed (Q5.1)**
Lines 464-471. A redirect from `https://host/` to `http://host/` is not blocked; the
redirect passes all validation layers. Plain-HTTP hops are detectable by MITM and
create a path to probe HTTP-only internal services. Fix: check protocol downgrade before
advancing `currentUrl`.

### P2 / MEDIUM

**P2-A — Abort listener not removed on normal completion** (Q4.1, lines 287-294) —
memory leak for long-lived signals.

**P2-B — `truncated` output field is always false — dead code** (Q3.1, lines 343-366) —
misleading schema, caller contract confusion.

**P2-C — `data` handler missing `settled` guard** (Q3.2, lines 333-335) — bytes can
accumulate past cap after safeResolve fires.

**P2-D — Content-Encoding not checked; gzip response returned as garbage** (Q3.3,
line 360) — silent data corruption if server ignores `Accept-Encoding: identity`.

**P2-E — Trailing dot FQDN rejected even when hostname is whitelisted** (Q2.1,
lines 130-131) — false rejection for FQDN-canonicalizing clients.

**P2-F — Whitelist entries not trimmed** (Q2.2, line 131) — operator misconfiguration
trap; trailing/leading spaces cause silent total rejection.

**P2-G — `dns.lookup({ all: false })` OS-family preference, undocumented** (Q1.1,
line 156) — behavior is OS-dependent when A+AAAA both present. Defense holds, but
implicit.

**P2-H — `http.RequestOptions.host` (deprecated) used instead of `hostname`** (Q1.2,
line 298) — works correctly now, future-maintenance hazard.

**P2-I — IPv6 scope ID in ::ffff: regex may bypass mapped-loopback detection** (Q1.5,
line 110) — theoretical, not reachable via dns.lookup path.

**P2-J — User headers forwarded verbatim on all redirect hops including cross-host** (Q5.4,
lines 432-438) — minor privacy concern, no active exploit.

### P3 / LOW

**P3-A — No wildcard/subdomain documentation in tool description** (Q2.3, line 488).

**P3-B — IDN punycode operator warning absent** (Q2.4).

**P3-C — IP-literal whitelist behavior undocumented** (Q1.3).

**P3-D — Whitelist lowercasing re-computed on every call** (Q2.5, line 131) — alloc churn.

**P3-E — `ETIMEDOUT` used for both deadline and abort signal** (Q4.2, lines 271, 289).

**P3-F — Redirect limit error code `EHOSTNOTALLOWED` is semantically wrong** (Q5.2, line 422).

**P3-G — 3xx body downloaded and discarded wastefully** (Q5.3).

**P3-H — `parseInt` on Content-Length silently produces NaN → skips pre-check** (Q3.4, line 318).

---

## Verdict

NEEDS FIXES — P1 findings present (P1-A: implicit rejectUnauthorized; P1-B: HTTPS→HTTP downgrade on redirect).

# External code review — winfs `fetch_url.ts` — v0.5.0 post-tag

## Context

winfs `fetch_url` is the **only network surface** in the codebase. GET only, http/https only, hard 5 MB body cap, hard 15 s wall-clock cap. Implements **two-layer SSRF defense** per spec invariant #10:

- **Layer 1 — Host whitelist (pre-DNS).** `url.hostname` matched exactly (case-insensitive) against `config.allowedUrlHosts`. Miss → `EHOSTNOTALLOWED` before any DNS lookup.
- **Layer 2 — DNS + IP deny (post-DNS).** `dns.lookup(host, { all: false })` resolves to one IP. IP checked against internal ranges (IPv4: 127/8, 10/8, 172.16-31/12, 192.168/16, 169.254/16, 0.0.0.0; IPv6: ::1, fe80::/10, fc00::/7, ::ffff:<internal IPv4>). Match → `EHOSTNOTALLOWED`.
- **TOCTOU mitigation — connect by IP.** Resolved IP passed to `http.request({ host: ip, ... })` as actual connect target. Original hostname goes in manual `Host:` header. TLS SNI + cert validation use original hostname via `servername` option. A DNS rebind between resolve and connect cannot redirect the socket.
- **Redirect re-validation.** Up to 3 redirect hops. Each hop runs through ALL layers (protocol, whitelist, DNS+IP). Hop 2 to a denied target → `EHOSTNOTALLOWED`.
- **Header whitelist.** Only `User-Agent`, `Accept`, `Accept-Language` from caller. `Authorization`, `Cookie`, custom `X-*` → `EINVAL`. `Accept-Encoding: identity` forced (no gzip; honest byte counts).
- **Body cap.** `Content-Length > max_bytes` pre-check → `ESIZE`. Streamed overrun kills socket + `ESIZE`.

Audit log redacts URL query string + userinfo (`username` / `password`). Headers logged are only the names that survived the allowlist.

See `_review_audit_tail.prompt.md`, `_review_edit_file.prompt.md`, `_review_execute_command.prompt.md` for full project context (invariants, error envelope conventions, audit redaction policy, AbortSignal threading precedent from v0.3.2 Kimi P2.2).

## Your task

Review `src/tools/network/fetch_url.ts` for: SSRF defense correctness across DNS rebinding / multi-address / IDN / IPv4-mapped-IPv6 vectors; redirect chain validation completeness; body cap enforcement races; AbortSignal lifecycle and cleanup; audit redaction coverage. This is the **only network surface** in winfs — its trust boundary is the entire public internet. The bar is strict.

Threat model: caller is benign but operating in an untrusted target environment. Outbound network surface should defend against:
- Server-side request forgery to internal services (cloud metadata: `169.254.169.254/latest/meta-data/`)
- DNS rebinding attacks (TOCTOU between resolve and connect)
- Redirect chains landing on internal targets
- Compression bombs / oversized responses
- Header injection via caller-supplied values
- Audit log credential leakage (tokens in URL query, in Authorization-like values)

## Targeted questions

**Q1 (DNS rebinding TOCTOU mitigation + multi-address support).**

Look at `resolveAndDenyInternal`:

```typescript
async function resolveAndDenyInternal(url: URL): Promise<...> {
  const host = url.hostname;
  if (net.isIP(host)) {
    if (isInternalIP(host)) { return EHOSTNOTALLOWED }
    return { ip: host, family: ... };
  }
  let resolved;
  try {
    resolved = await dns.lookup(host, { all: false });
  } catch (err) { return EHOSTNOTALLOWED }
  if (isInternalIP(resolved.address)) { return EHOSTNOTALLOWED }
  return { ip: resolved.address, family: ... };
}
```

Then in `fetchOnce`:
```typescript
const reqOpts: http.RequestOptions = {
  method: "GET",
  host: ip,           // IP, not hostname
  port,
  path,
  headers,            // includes manual Host: original.hostname
};
const lib = isHttps ? https : http;
const httpsOpts = isHttps ? { ...reqOpts, servername: p.url.hostname } : reqOpts;
req = lib.request(httpsOpts, ...);
```

This is a textbook DNS-rebinding mitigation: resolve once → connect to resolved IP → set Host header manually → use SNI servername for TLS. **But** review for:

- **`dns.lookup({ all: false })` returns a single address.** If the hostname has multiple A records (round-robin DNS, CDN failover), only one is checked. A malicious DNS server could return first the public IP (Layer 2 sees it, allows), then internal IP (we connect to the public, but next caller might get internal — between calls, not within a call, so per-request safe).

  More concerning: what if the hostname has both A (public) and AAAA (internal `fe80::...`) records, and Node's `dns.lookup` picks based on family preference? Does the choice match what `http.request` would have chosen on its own? If not, there's a mismatch — we check the IPv4, but `http.request({ host: ip4 })` connects to IPv4, OK. But what if a future change adds `family: 0` or similar that lets Node pick? Verify.

- **`net.isIP(host)` for hostname-is-already-an-IP-literal path:** if caller passes `fetch_url({url: "http://203.0.113.5"})`, `host === "203.0.113.5"`, `isInternalIP` returns false, we connect to 203.0.113.5. Good. But: does the Layer 1 whitelist (`validateHostWhitelist`) match an IP literal against entries that are hostnames? Probably not — `"203.0.113.5"` won't match `"example.com"`. So IP-literal URLs would all hit Layer 1 whitelist rejection (unless operator explicitly whitelisted IP literals). Verify intended behavior. Should IP literals be unconditionally rejected (treat as Layer 1 fail) for clarity?

- **`http.request({ host: ip })` actually uses `ip` as the TCP connect target.** Verify Node's behavior: `host` vs `hostname` option naming inconsistency. In some Node http API surfaces, `host` is deprecated in favor of `hostname`. If both are present, which wins? If neither matches the expected key, Node might silently default to localhost. Test: spy on the socket connect, verify it's hitting the resolved IP, not re-resolving hostname through Node's default DNS path.

- **TLS cert validation.** For HTTPS, `servername: p.url.hostname` is set for SNI. Node's default `checkServerIdentity` validates against the cert's SAN/CN. But: what if the resolved IP serves a cert for a DIFFERENT hostname (because of DNS rebinding planting an attacker-controlled IP)? The cert MUST match `p.url.hostname` for validation to pass. Node enforces this by default — verify `rejectUnauthorized: true` is the default and isn't accidentally disabled.

How serious? P0 if multi-address race exposes internal IPs. P1 if cert validation can be downgraded. P2 if IP-literal handling is ambiguous.

**Q2 (Layer 1 whitelist edge cases: IDN, subdomain semantics, trailing dot, port).**

```typescript
function validateHostWhitelist(url: URL, config: ResolvedConfig): StructuredError | undefined {
  const host = url.hostname.toLowerCase();
  const allowed = config.allowedUrlHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    return EHOSTNOTALLOWED;
  }
}
```

Audit edge cases that may surface as bypass or denial-of-service:

- **IDN / Punycode confusables.** Whitelist entry `"example.com"`. Attacker constructs URL `https://еxample.com/...` (Cyrillic 'е' = U+0435, looks like Latin 'e'). WHATWG URL parser converts IDN hostnames to A-label punycode form in `url.hostname` — verify this is the case. If yes: `url.hostname === "xn--xample-r2a.com"`, doesn't match `"example.com"` in whitelist → correctly rejected. But: if operator manually adds the punycode form to whitelist thinking they're adding the Latin form, they'd accidentally allow the Cyrillic-look-alike. Document this in the description? Add operator-side warning?

- **Trailing dot FQDN.** URL `https://example.com./...` — WHATWG URL parser may or may not strip the trailing dot in `url.hostname`. If preserved, `"example.com."` doesn't match `"example.com"` → rejected. Probably the desired behavior, but creates a class of false-rejection. Maybe normalize before compare: `host.replace(/\.$/, "")`?

- **Subdomain semantics.** Whitelist `"example.com"` does NOT match `"sub.example.com"`. Good. But: callers expecting "whitelist this domain and all subdomains" pattern will find this surprising. There's no wildcard support (`*.example.com`). Should there be? If yes, design carefully — naive wildcards introduce their own SSRF risk (e.g., does `*.example.com` match `evil.example.com` if attacker controls `evil`?). Document current "exact-match-only" semantics in the tool description.

- **Port in URL.** `https://example.com:8443/path`. `url.hostname === "example.com"` (without port), matches whitelist entry `"example.com"`. Good — port doesn't break the match. But: what if operator wants to whitelist `example.com` on port 443 only, not 8443? Current impl doesn't support port-scoped whitelist. Document.

- **URL-encoded host:** `https://%65xample.com/` (percent-encoded 'e'). Does WHATWG parser decode `%65` in hostname? Per spec, no — hostnames don't percent-decode. Verify with test.

- **Whitespace in whitelist entries.** Operator misconfigures `"example.com "` with trailing space. `toLowerCase()` preserves whitespace. `url.hostname` won't have trailing space. Mismatch → all requests to example.com rejected. Operator confused. Worth trimming: `h.toLowerCase().trim()`.

Severity: P2 cluster — each individually is a UX/correctness concern, but no obvious bypass.

**Q3 (Body size cap enforcement: race conditions, Content-Encoding handling, partial-chunk logic).**

```typescript
res.on("data", (chunk: Buffer) => {
  if (received + chunk.length <= p.maxBytes) {
    chunks.push(chunk);
    received += chunk.length;
  } else {
    const remaining = p.maxBytes - received;
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
      received = p.maxBytes;
    }
    truncated = true;
    if (chunks.length === 0 || received >= p.maxBytes) {
      safeResolve(buildError("ESIZE", ...));
      return;
    }
  }
});
```

Concerns to investigate:

- **Race after `safeResolve(ESIZE)`.** `safeResolve` sets `settled = true` and calls `req.destroy()`. But the `data` event handler may continue receiving chunks before destroy completes — Node's stream destruction isn't synchronous. Are subsequent chunks pushed past the cap? Look at `settled` flag — is it checked in data handler? No — only inside `safeResolve`. So subsequent `data` events would still try to push and re-call `safeResolve`, which guards. So no double-resolution, but `received` could grow past `maxBytes` if more chunks arrive before destroy lands. The truncation cap is best-effort, not strict. Document: actual bytes received may be up to one chunk's worth above `max_bytes`.

- **Truncation logic edge case.** Look at the `else` branch when chunk fits partially: `remaining > 0 → push partial, received = maxBytes; truncated = true; if (chunks.length === 0 || received >= maxBytes) → ESIZE`. Condition `chunks.length === 0` is impossible at this point because if `remaining > 0` we just pushed. Condition `received >= maxBytes` is always true after `received = maxBytes`. So **every** oversize chunk triggers `ESIZE` (an error envelope), not "return the truncated body with truncated=true flag". 

  Compare to the documented contract: "Body cap: max_bytes (≤ config.fetchUrlMaxBytes, default 5 MB). Content-Length checked pre-body; streamed overrun kills the socket → ESIZE." So ESIZE on streamed overrun is intentional. But the `truncated: bool` flag in the output schema is never set on a successful return path — it can only be `false` because every cap-hit path returns ESIZE before the `end` event fires. Is the `truncated` field useful? Or dead code?

  Two possibilities:
  - (a) Intentional: caller never gets partial body on cap-hit; ESIZE means "you got nothing, ask again with higher cap if you really want it". `truncated` is a vestigial field. Recommend removing from output schema OR rewiring to a different signal.
  - (b) Unintentional: caller SHOULD get partial body with `truncated: true` when reasonable (e.g., download first 5 MB of a 10 MB response). Refactor data handler to keep returning chunks up to cap, then on `end` (or on cap-hit without further data) return the truncated body. Only fire ESIZE if Content-Length predeclared > cap. Different policy.

- **`Content-Encoding` ignored.** `Accept-Encoding: identity` is forced server-side, but **server may ignore** and return `Content-Encoding: gzip` anyway. Current code doesn't decompress — `body: Buffer.concat(chunks).toString("utf8")` returns the gzip bytes as UTF-8 (probably garbage). Compression bomb defense: a 5 MB gzip can decompress to 100 MB+. Since we don't decompress, no memory blowup on our side. But caller gets a body that's gzip-encoded without realizing. Document: "If server ignores Accept-Encoding: identity and returns Content-Encoding != identity, body field contains raw bytes; caller must decode."

- **Chunked transfer encoding without Content-Length.** Pre-check `cl > 0 && cl > maxBytes` skipped. Stream check applies. OK functionally but worth pinning in test.

- **Concurrent fetch_url calls.** Each holds up to `max_bytes` (5 MB default) in memory until `end`. N concurrent calls × 5 MB = N×5 MB peak. Is there server-level concurrency cap? Looking at runTool wrapper — probably not. Worth flagging if multi-call DoS via memory pressure is a concern.

Severity: P2 (race) + P3 (truncated dead code) + P3 (Content-Encoding docs).

**Q4 (AbortSignal lifecycle: listener leak + ETIMEDOUT conflation).**

```typescript
if (p.signal) {
  if (p.signal.aborted) {
    safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {}));
    return;
  }
  p.signal.addEventListener(
    "abort",
    () => {
      safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {}));
    },
    { once: true },
  );
}
```

Two distinct concerns:

- **Listener leak.** The abort listener is added to `p.signal` but never removed on normal completion. `{ once: true }` removes the listener IF the abort event fires; if the request completes normally (200 OK, body received, `end` event), the listener stays attached to `signal`. If the same `signal` is reused across multiple requests (e.g., a long-lived AbortController in the runTool wrapper), listeners accumulate per request, never garbage-collected as long as `signal` is reachable. Memory leak proportional to request count × duration of signal lifetime.

  Fix candidates:
  - (a) Capture listener reference; call `p.signal.removeEventListener("abort", listener)` inside `safeResolve`.
  - (b) Use Node's native AbortSignal support in `http.request({ signal })` — Node ≥ v15 supports this. Handles cleanup automatically. Worth investigating; would replace manual addEventListener.

- **`ETIMEDOUT` conflation: deadline vs abort.** Both the deadline timer and the abort signal use the same error code `"ETIMEDOUT"` with different messages. Caller sees `error.code === "ETIMEDOUT"` and can't distinguish "wall-clock exceeded" from "caller-initiated abort". Spec §5 error catalog has both — should impl use distinct codes (e.g., `ETIMEDOUT` for deadline, `EABORT` for caller signal)? Or distinguish via `details.reason`?

  Minor for now (callers usually don't care), but creates a friction point if future logic wants to retry on abort but not on timeout.

- **Race: signal abort vs deadline timer firing.** Both call `safeResolve` with `ETIMEDOUT`. Guarded by `settled` flag. OK. But: what if both fire in rapid succession? The first one wins (settled flag), the second is a no-op. Race is benign but worth confirming the guard is tight.

Severity: P2 (listener leak) + P3 (code conflation).

**Q5 (Redirect chain: protocol downgrade, body discard, infinite-loop guard, header retention).**

```typescript
while (true) {
  if (hops > MAX_REDIRECTS) {
    return EHOSTNOTALLOWED("redirect chain exceeded max hops");
  }
  const remaining = totalDeadline - (Date.now() - overallStart);
  if (remaining <= 0) {
    return ETIMEDOUT(...);
  }
  const res = await fetchOnce({ url: currentUrl, ..., deadlineRemainingMs: remaining, signal });
  if (res is error) return res;
  if (hop.redirectTo === undefined) {
    // Final response — build FetchUrlResult, return.
  }
  let nextUrl: URL;
  try {
    nextUrl = new URL(hop.redirectTo, currentUrl);
  } catch {
    return EIO("redirect target is not a valid URL");
  }
  hops++;
  currentUrl = nextUrl;
}
```

Concerns:

- **Protocol downgrade allowed.** `validateProtocol(url)` accepts both `http:` and `https:`. If hop 1 is `https://allowed.example.com/`, hop 2 (redirect) lands on `http://allowed.example.com/`, it passes Layer 1 (same host whitelist), passes Layer 2 (assuming non-internal IP), and we connect over plain HTTP. Credentials in headers (User-Agent is OK, but Accept-Language could leak browser fingerprint to a MITM) sent unencrypted. This is the **classic redirect downgrade attack** that browsers explicitly block (HSTS, etc).

  Recommendation: if hop N was https, hop N+1 redirect to http should be rejected. Add to redirect re-validation: `if (currentUrl.protocol === "https:" && nextUrl.protocol === "http:") return EHOSTNOTALLOWED("https-to-http downgrade")`. Severity P2.

- **3xx body discarded silently.** When `fetchOnce` sees `statusCode >= 300 && statusCode < 400`, it sets `redirectTo` but continues reading body until `end`. The body is in `chunks` but never returned to caller — `fetchUrlImpl` only reads `hop.redirectTo` and recurses. 3xx body is silently consumed and dropped.

  Is this intentional? Probably yes (3xx bodies are typically "click here, your browser doesn't support automatic redirect" HTML, not useful to caller). But: bandwidth wasted, potentially large body on 3xx if server is malicious. Capping by `max_bytes` does apply (the data handler enforces cap on 3xx body too), but it's still up to 5 MB of wasted transfer per redirect hop × 3 hops max = 15 MB worst case.

  Optimization: on 3xx detection, immediately `req.destroy()` + `safeResolve({statusCode, redirectTo, body: ""})`. Skips body download for 3xx. Recommend for v0.5.x perf, not security-critical. Severity P3.

- **Redirect loop A→B→A:** counted by `hops > MAX_REDIRECTS` (3). After 3 hops, returns `EHOSTNOTALLOWED("redirect chain exceeded max hops")`. The error code is questionable — it's not really "host not allowed", it's "redirect limit hit". Maybe `ELIMITS` or `EREDIRECT_LIMIT` is cleaner. Severity P3.

- **Cookies / Set-Cookie headers across redirects.** Spec §21 says no cookie jar in v0.5 (GET only, no auth-header pass-through). What if server returns `Set-Cookie` in 3xx response? Our impl ignores response cookies entirely (good) — they're not echoed back on the redirect hop. Verify by inspection: are response Set-Cookie headers parsed, stored, or echoed? Code doesn't look at them. OK.

- **`Authorization` re-validation across redirects.** Even though caller can't pass `Authorization` (header whitelist blocks), the implicit `User-Agent` and other allowed headers are echoed verbatim on every hop. Is that intentional? Browsers strip auth on cross-origin redirect; we don't have a cross-origin concept since whitelist is host-only. Probably fine, but worth noting.

Severity: P2 (https→http downgrade) + P3 (3xx body waste) + P3 (error code naming).

## Output format

P1/P2/P3 tiers as in audit_tail / grep / edit_file / execute_command prompts. Title + line numbers + reproduction + fix per finding. Explicit "Pn: none" if a tier is clear.

## File content (security-critical sections inlined)

```typescript
// imports + constants:
const MAX_REDIRECTS = 3;
const ALLOWED_HEADERS = new Set(["user-agent", "accept", "accept-language"]);

// ============================================================
// Audit redaction (Q on audit coverage)
// ============================================================
function redactUrlForAudit(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.search) u.search = "?<redacted>";
    if (u.username) u.username = "<redacted>";
    if (u.password) u.password = "<redacted>";
    return u.toString();
  } catch {
    return "<malformed>";
  }
}

// ============================================================
// Layer 2 — Internal IP deny (Q1 on TOCTOU)
// ============================================================
function isInternalIP(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    const [a, b, c, d] = parts as [number, number, number, number];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0 && b === 0 && c === 0 && d === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    const m = lower.match(/^::ffff:([0-9a-f.:]+)$/);
    if (m) {
      const inner = m[1]!;
      if (net.isIPv4(inner)) return isInternalIP(inner);
    }
    return false;
  }
  return true; // unknown form — refuse
}

// ============================================================
// Protocol whitelist (trivial, included for completeness)
// ============================================================
function validateProtocol(url: URL): StructuredError | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return buildError("EHOSTNOTALLOWED", "only http:// and https:// are allowed", { ... });
  }
  return undefined;
}

// ============================================================
// Layer 1 — Host whitelist (Q2 on edge cases)
// ============================================================
function validateHostWhitelist(url: URL, config: ResolvedConfig): StructuredError | undefined {
  const host = url.hostname.toLowerCase();
  const allowed = config.allowedUrlHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    return buildError("EHOSTNOTALLOWED", "host is not in allowedUrlHosts", { ... });
  }
  return undefined;
}

// ============================================================
// Layer 2 — DNS resolve + IP deny (Q1 on TOCTOU + multi-address)
// ============================================================
async function resolveAndDenyInternal(url: URL): Promise<{ ip: string; family: 4 | 6 } | StructuredError> {
  const host = url.hostname;
  if (net.isIP(host)) {
    if (isInternalIP(host)) {
      return buildError("EHOSTNOTALLOWED", "host resolves to an internal IP", { ... });
    }
    return { ip: host, family: net.isIPv4(host) ? 4 : 6 };
  }
  let resolved;
  try {
    resolved = await dns.lookup(host, { all: false });
  } catch (err) {
    return buildError("EHOSTNOTALLOWED", "DNS lookup failed", { ... });
  }
  if (isInternalIP(resolved.address)) {
    return buildError("EHOSTNOTALLOWED", "host resolves to an internal IP", { ... });
  }
  return { ip: resolved.address, family: resolved.family === 6 ? 6 : 4 };
}

// ============================================================
// Header allowlist build (Q on header injection)
// ============================================================
function buildRequestHeaders(
  url: URL,
  userHeaders: Record<string, string> | undefined,
): { headers: Record<string, string>; allowed: string[] } | StructuredError {
  const headers: Record<string, string> = {
    Host: url.host,
    "User-Agent": "mcp-winfs/0.5 (https://github.com/leonovee/winfs-mcp)",
    Accept: "*/*",
    "Accept-Encoding": "identity",
    Connection: "close",
  };
  const allowedList: string[] = [];
  if (userHeaders) {
    for (const [k, v] of Object.entries(userHeaders)) {
      const lower = k.toLowerCase();
      if (!ALLOWED_HEADERS.has(lower)) {
        return buildError("EINVAL", `header not allowed: ${k}`, { ... });
      }
      const canonical = lower
        .split("-")
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
        .join("-");
      headers[canonical] = v;
      allowedList.push(canonical);
    }
  }
  return { headers, allowed: allowedList };
}

// ============================================================
// Per-hop fetch (Q1 + Q3 + Q4: connect-by-IP, body cap, AbortSignal)
// ============================================================
async function fetchOnce(p: FetchOnceArgs): Promise<FetchOnceResult | StructuredError> {
  const protoCheck = validateProtocol(p.url);
  if (protoCheck) return protoCheck;
  const wlCheck = validateHostWhitelist(p.url, p.config);
  if (wlCheck) return wlCheck;
  const resolved = await resolveAndDenyInternal(p.url);
  if ("ok" in resolved && resolved.ok === false) return resolved as StructuredError;
  const { ip } = resolved as { ip: string; family: 4 | 6 };

  const hdrBuild = buildRequestHeaders(p.url, p.userHeaders);
  if ("ok" in hdrBuild && hdrBuild.ok === false) return hdrBuild as StructuredError;
  const { headers, allowed } = hdrBuild as { headers: Record<string, string>; allowed: string[] };

  const isHttps = p.url.protocol === "https:";
  const port = p.url.port !== "" ? parseInt(p.url.port, 10) : isHttps ? 443 : 80;
  const path = `${p.url.pathname}${p.url.search}`;

  return new Promise<FetchOnceResult | StructuredError>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    let statusCode = 0;
    let contentType = "";
    let redirectTo: string | undefined;
    let req: http.ClientRequest;

    const safeResolve = (v: FetchOnceResult | StructuredError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      try { req.destroy(); } catch { /* ignore */ }
      resolve(v);
    };

    const deadlineTimer = setTimeout(() => {
      safeResolve(buildError("ETIMEDOUT", "fetch_url exceeded deadline", { ... }));
    }, p.deadlineRemainingMs);
    deadlineTimer.unref?.();

    if (p.signal) {
      if (p.signal.aborted) {
        safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {}));
        return;
      }
      p.signal.addEventListener(
        "abort",
        () => { safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {})); },
        { once: true },
      );
    }

    const reqOpts: http.RequestOptions = {
      method: "GET",
      host: ip,             // RESOLVED IP, not hostname (TOCTOU mitigation)
      port,
      path,
      headers,              // includes manual Host: url.host
    };
    const lib = isHttps ? https : http;
    const httpsOpts = isHttps
      ? { ...reqOpts, servername: p.url.hostname }   // SNI uses real hostname
      : reqOpts;

    try {
      req = lib.request(httpsOpts, (res) => {
        statusCode = res.statusCode ?? 0;
        contentType = (res.headers["content-type"] as string | undefined) ?? "";
        const cl = parseInt((res.headers["content-length"] as string | undefined) ?? "0", 10);
        if (cl > 0 && cl > p.maxBytes) {
          safeResolve(buildError("ESIZE", "Content-Length exceeds max_bytes", { ... }));
          return;
        }
        if (statusCode >= 300 && statusCode < 400) {
          const loc = res.headers["location"];
          if (typeof loc === "string") redirectTo = loc;
        }
        res.on("data", (chunk: Buffer) => {
          if (received + chunk.length <= p.maxBytes) {
            chunks.push(chunk);
            received += chunk.length;
          } else {
            const remaining = p.maxBytes - received;
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, remaining));
              received = p.maxBytes;
            }
            truncated = true;
            if (chunks.length === 0 || received >= p.maxBytes) {
              safeResolve(buildError("ESIZE", "streamed body exceeds max_bytes", { ... }));
              return;
            }
          }
        });
        res.on("end", () => {
          safeResolve({
            statusCode, contentType,
            body: Buffer.concat(chunks).toString("utf8"),
            bytesReceived: received, truncated,
            ...(redirectTo ? { redirectTo } : {}),
            headersAllowed: allowed,
          });
        });
        res.on("error", (err) => {
          safeResolve(buildError("EIO", "fetch_url response error", { ... }));
        });
      });
      req.on("error", (err) => {
        safeResolve(buildError("EIO", "fetch_url request error", { ... }));
      });
      req.end();
    } catch (err) {
      safeResolve(buildError("EIO", "fetch_url failed to start request", { ... }));
    }
  });
}

// ============================================================
// Redirect chain orchestrator (Q5: protocol downgrade, body waste, loop guard)
// ============================================================
export async function fetchUrlImpl(args, config, signal): Promise<Result<FetchUrlResult>> {
  let url: URL;
  try { url = new URL(args.url); }
  catch { return buildError("EINVAL", "url is not a valid absolute URL", { ... }); }

  const hardCap = config.fetchUrlMaxBytes;
  const maxBytes = Math.min(args.max_bytes ?? hardCap, hardCap);
  const totalDeadline = resolveTimeoutMs(
    args.timeout_ms,
    config.fetchUrlTimeoutMs,
    config.fetchUrlTimeoutMs,   // wall-clock max == default; override can only LOWER
  );
  const overallStart = Date.now();

  let currentUrl = url;
  let hops = 0;

  while (true) {
    if (hops > MAX_REDIRECTS) {
      return buildError("EHOSTNOTALLOWED", "redirect chain exceeded max hops", { ... });
    }
    const remaining = totalDeadline - (Date.now() - overallStart);
    if (remaining <= 0) {
      return buildError("ETIMEDOUT", "fetch_url exceeded total deadline", { ... });
    }
    const res = await fetchOnce({ url: currentUrl, config, maxBytes, deadlineRemainingMs: remaining, userHeaders: args.headers, signal });
    if ("ok" in res && res.ok === false) return res as StructuredError;
    const hop = res as FetchOnceResult;
    if (hop.redirectTo === undefined) {
      // Final response — build result, audit extras, return.
      return ok({ ... });
    }
    // Resolve next URL (relative or absolute).
    let nextUrl: URL;
    try { nextUrl = new URL(hop.redirectTo, currentUrl); }
    catch { return buildError("EIO", "redirect target is not a valid URL", { ... }); }
    hops++;
    currentUrl = nextUrl;
  }
}
```

## Known context

- Spec invariant #10 is the authoritative source for fetch_url's defense layers.
- Spec §R (v0.5 amendment) formalises the two-layer SSRF defense + TOCTOU mitigation.
- Spec §S (v0.5 amendment) formalises redirect re-validation.
- Spec §T (v0.5 amendment) formalises audit redaction extensions including URL query string redaction past `?`.
- `runTool` wrapper: applies wall-clock timeout via `withTimeout`, audits args + result, threads AbortSignal into impl. Trusted.
- `tests/invariants/fetch_url_ssrf.test.ts` covers SSRF matrix: direct IPv4 internal, DNS resolving to internal, redirect to internal, IPv6 internal. With mocked DNS for rebinding scenarios.
- `tests/unit/network/fetch_url.test.ts` covers happy https whitelist, http whitelist, blocked host, internal IP after DNS, body > 5 MB declared/streamed, redirect chains, file:// protocol, bad headers. 5 unit + 7 invariant = 12 tests.
- One happy-path test is structurally present but skipped in unit tests because no public-IP whitelist target is reachable in unit isolation. Covered at Inspector probe time via `raw.githubusercontent.com`.
- Audit redaction (per spec §T): `args.url` → `url_redacted` (query string + userinfo redacted). `headers_allowed` logs only the names that survived whitelist (not values). `body` never logged (only `bytes_received` count).
- v0.5.0 ships fetch_url WITHOUT external review per operator directive (b) on 2026-05-17 — this prompt is the post-tag review attempt. Expected v0.5.1+ patch wave on findings.

## Test scope (what's already pinned vs gaps for new tests post-review)

Already in `fetch_url_ssrf.test.ts`:
- Direct IPv4 internal (`http://127.0.0.1/`, `http://10.0.0.1/`, `http://169.254.169.254/` cloud metadata)
- Hostname resolving to internal (mocked DNS)
- Redirect-to-internal (hop 2 with mocked Location: `http://127.0.0.1/`)
- IPv6 internal ranges (`::1`, `fe80::*`, `fc00::*`)
- IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
- Malformed URL (EINVAL)

Gaps that this review may want to flag as new test coverage:
- DNS multi-address (one public + one internal in same lookup; verify lookup ordering doesn't bypass)
- IDN punycode normalization
- Trailing-dot FQDN
- Whitelist case + whitespace normalization
- HTTPS-to-HTTP redirect downgrade
- Listener leak on normal completion (memory test: 1000 sequential fetch_url calls, verify no listener accumulation on a long-lived signal)
- Compression bomb defense (`Content-Encoding: gzip` despite identity request)
- 3xx body waste (verify body NOT returned to caller)

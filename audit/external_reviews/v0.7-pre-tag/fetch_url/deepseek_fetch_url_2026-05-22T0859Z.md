# DeepSeek review — Phase v0.7-pre-tag-fetch_url — 2026-05-22T0859Z

## Invocation

Model used: deepseek-v4-pro
Audit type: code-review
Commit range: HEAD (a885126) — file review
File reviewed: src/tools/network/fetch_url.ts


## Raw output

**Review of `src/tools/network/fetch_url.ts` at HEAD a885126**

### Q1 – DNS rebinding / multi-address / IP-literal
**No security regression or bypass.**
- `dns.lookup({ all: false })` returns **one** IP, and that same IP is used for connection (line 298: `host: ip`). Node’s HTTP client will connect *exactly* to that IP; no re‑resolution occurs.
- For HTTPS, `rejectUnauthorized` is left at its secure default; `servername` (line 309) ensures SNI and certificate hostname verification use the original hostname.
- IP‑literal URLs: the IP is caught by `net.isIP(host)` inside `resolveAndDenyInternal` (line 146) **after** the host whitelist check in `fetchOnce` (line 227). If the IP is not literally in the whitelist, Layer‑1 rejects it. This is correct.
- No `rejectUnauthorized: false` appears anywhere.

→ **P0: none, P1: none, P2: none, P3: none.**

---

### Q2 – Host whitelist edge cases

**P3: Operator mis‑configuration (whitespace) silently breaks all requests**
- `validateHostWhitelist` (lines 130‑138) lower‑cases `url.hostname` and the allowed list, but **does not trim** entries from `config.allowedUrlHosts`.
- A trailing space (e.g. `"example.com "`) will never match the properly‑parsed hostname `"example.com"`. Every request will be rejected with `EHOSTNOTALLOWED`.
- The WHATWG URL parser strips a trailing dot from domain names (e.g. `"http://example.com./"` → `url.hostname = "example.com"`), so that edge case is safe. Subdomain semantics are explicitly documented as exact‑match only.

**Quote:**  
`const allowed = config.allowedUrlHosts.map((h) => h.toLowerCase());` (line 131) – no `.trim()`.

**Severity: P3** (operator error can cause total denial of service, but no SSRF downgrade).

→ **P0/P1/P2: none. P3: 1 finding.**

---

### Q3 – Body cap race + truncated flag

#### A. `truncated` is dead in the success path (P2)
- In the `'data'` handler oversize branch, as soon as `truncated = true` is set, `safeResolve` is called with an `ESIZE` error (lines 343‑351).  
- The promise resolves immediately; the `'end'` event (which would return `truncated: true`) is never reached.
- For a successful (non‑redirect) response, `truncated` will **always** be `false` in the output. The `OutputShape` and tool description claim it indicates truncation, but it is never `true` for a successful result.

**Quote:**
```
343:            truncated = true;
346:            if (chunks.length === 0 || received >= p.maxBytes) {
347:              safeResolve(
348:                buildError("ESIZE", "streamed body exceeds max_bytes", { … }),
349:              );
350:              return;
351:            }
```
and later returned via `truncated: hop.truncated` (line 450).

**Severity: P2** – spec drift; the field is promised but never set to `true` in a successful response.

#### B. Content‑Encoding: no decompression (P2)
- The tool sends `Accept-Encoding: identity` (line 178) and the Node.js HTTP client *does not* decompress responses. If the server ignores the request and sends `Content-Encoding: gzip`, the response will be raw gzip bytes, converted to a UTF‑8 string (line 360), producing garbage. There is no warning, error, or transparent decompression.
- This violates the implicit contract that the body is the intended content and that byte counts are “honest” (the bytes received will be the compressed size, not the uncompressed size).

**Quote:**  
`"Accept-Encoding": "identity"` (line 178) with no handling of actual `Content-Encoding`.

**Severity: P2** – data integrity gap; callers receive corrupted content with no indication.

→ **P0/P1: none. P2: 2 findings. P3: none additional.**

---

### Q4 – AbortSignal listener leak

#### A. Listener leak (P2)
- `p.signal.addEventListener('abort', handler, { once: true })` adds a listener that is **never removed** if the request completes normally (lines 287‑293). The `{ once: true }` option only removes the listener after the `abort` event fires, not on promise settlement.
- If the same `AbortSignal` is reused across many tool invocations, listeners will accumulate, holding references to request closures and potentially causing a memory leak.

**Quote:**
```
287:      p.signal.addEventListener(
288:        "abort",
289:        () => { safeResolve(buildError("ETIMEDOUT", "fetch_url aborted", {})); },
290:        { once: true },
291:      );
```

**Severity: P2** – resource leak in long‑lived signal scenarios.

#### B. Error code confusion (P3)
- Both the deadline timer (line 271) and the abort handler (line 290) produce errors with code `ETIMEDOUT`. The caller cannot distinguish a wall‑clock timeout from an external abort, which hinders debugging and proper error handling.

**Severity: P3** – cosmetic/design; no security impact.

→ **P0/P1: none. P2: 1 finding. P3: 1 finding.**

---

### Q5 – Redirect chain

#### A. HTTPS→HTTP downgrade (P2)
- The redirect loop re‑validates protocol, host, and IP, but **does not prevent a downgrade** from HTTPS to HTTP. If `https://trusted.com` redirects to `http://trusted.com`, the request will follow it over plain HTTP, exposing the traffic. No policy (`allowDowngrade: false`) is enforced.

**Quote:**  
The redirect is accepted as long as `validateProtocol` passes both `http:` and `https:` (line 120‑127) and the host remains in the whitelist. No scheme comparison is made.

**Severity: P2** – defense gap; the tool can be tricked into using unencrypted connections.

#### B. 3xx body wasted bandwidth (P2)
- In `fetchOnce`, after detecting a 3xx status and extracting the `Location` header (lines 327‑332), the entire response body is still read (up to `maxBytes`) before the promise resolves with `redirectTo`. This wastes up to 5 MB per redirect hop (3 hops = 15 MB).

**Quote:**
```
327:        if (statusCode >= 300 && statusCode < 400) {
328:          const loc = res.headers["location"];
329:          if (typeof loc === "string") {
330:            redirectTo = loc;
331:          }
332:        }
```
Subsequent `data`/`end` events still run; no early destruction.

**Severity: P2** – unnecessary resource consumption and potential DoS vector.

#### C. Wrong error code for redirect limit (P2)
- When `hops > MAX_REDIRECTS`, the tool returns **`EHOSTNOTALLOWED`** (line 422). This code should be something like `EMAXREDIRECTS`, not a host‑restriction violation. It misleads callers and compromises error‑handling logic.

**Quote:**
```
422:      return buildError("EHOSTNOTALLOWED", "redirect chain exceeded max hops", {
423:        details: { max_redirects: MAX_REDIRECTS, final_url: redactUrlForAudit(currentUrl.toString()) },
424:      });
```

**Severity: P2** – semantically incorrect error code.

#### D. `final_url` leaks full query string (P2)
- In the successful result, `final_url` is set to `currentUrl.toString()` (line 451) **without any redaction**. This exposes the entire query string and potentially sensitive parameters to the caller, even though the audit log redacts them. The tool’s description states that the audit log redacts the URL; it does not warn that the return value contains the raw URL.

**Quote:**
```
451:        final_url: currentUrl.toString(),
```

**Severity: P2** – sensitive data exposure via the tool’s output.

---

### Summary of severity tiers

- **P0 (Blocking): none**
- **P1 (High): none**
- **P2 (Medium):**
  1. `truncated` flag dead in success path (Q3)
  2. Missing decompression / silent corruption when content is compressed (Q3)
  3. `AbortSignal` listener leak (Q4)
  4. HTTPS→HTTP downgrade not prevented (Q5)
  5. 3xx responses waste bandwidth (Q5)
  6. Redirect‑limit error uses wrong code `EHOSTNOTALLOWED` (Q5)
  7. `final_url` exposes unredacted query string (Q5)
- **P3 (Low):**
  1. Whitelist entry trimming omission (Q2)
  2. `ETIMEDOUT` used for both timeout and abort (Q4)

## Summary (deepseek-reviewer subagent reading)

### P0 (BLOCKING): none

### P1 (HIGH): none

### P2 (MEDIUM): 7 findings

1. **`truncated` flag dead in success path** — `truncated` is set to `true` in the data-handler oversize branch (line 343) but `safeResolve(ESIZE)` is called immediately after (lines 346-350). The `end` event that would return `{truncated: true}` is never reached. In every successful response path, `truncated` is always `false`. The output schema and tool description make a false contract claim. _(Q3-A)_

2. **Silent gzip corruption when server ignores `Accept-Encoding: identity`** — `Accept-Encoding: identity` is sent (line 178) but the server may return `Content-Encoding: gzip` regardless. Node's HTTP client does not auto-decompress. The body at line 360 (`Buffer.concat(chunks).toString("utf8")`) would be raw gzip bytes, producing garbage. No error is raised and no `Content-Encoding` header is checked. Data integrity violation for callers. _(Q3-B)_

3. **AbortSignal listener leak** — `p.signal.addEventListener("abort", handler, { once: true })` (lines 287-291) is never removed on normal completion; `{ once: true }` only cleans up if abort fires. Long-lived signals reused across many requests accumulate listeners, holding closed-over request state. Memory leak proportional to request count × signal lifetime. _(Q4-A)_

4. **HTTPS→HTTP redirect downgrade not blocked** — The redirect loop re-validates protocol (both http: and https: pass, line 120-127), host whitelist, and IP, but does not compare the new scheme against the previous hop. A redirect from `https://trusted.com` to `http://trusted.com` is accepted silently and executes over plain HTTP. _(Q5-A)_

5. **3xx body wasted bandwidth / DoS vector** — After extracting `Location` header (lines 327-332), `fetchOnce` continues reading the full response body (up to `maxBytes = 5 MB`) on every redirect hop. No early `req.destroy()` on 3xx detection. Up to 15 MB wasted per 3-hop chain. _(Q5-B)_

6. **Wrong error code for redirect-limit exhaustion** — `EHOSTNOTALLOWED` is returned when `hops > MAX_REDIRECTS` (line 422). This is semantically incorrect; it is a redirect limit, not a host restriction. Callers and error-handling logic are misled. _(Q5-C)_

7. **`final_url` leaks unredacted query string** — `final_url: currentUrl.toString()` (line 451) returns the full URL including query string without redaction. The audit log redacts query strings, but the tool's return value exposes them to callers. Sensitive parameters (API keys, tokens in query) leak in the tool output. _(Q5-D)_

### P3 (LOW): 2 findings

1. **Whitelist entry whitespace not trimmed** — `config.allowedUrlHosts.map((h) => h.toLowerCase())` (line 131) does not trim entries. Operator misconfiguration (`"example.com "` with trailing space) silently rejects all requests to that host. Fix: `.trim()` each entry. _(Q2)_

2. **`ETIMEDOUT` conflation for deadline vs abort** — Both the deadline timer (line 271-277) and the abort signal handler (lines 287-291) emit `ETIMEDOUT`. Callers cannot distinguish a wall-clock timeout from an externally initiated abort. Suggested: use `EABORT` for caller-initiated cancellation. _(Q4-B)_

### New test gaps identified

- HTTPS→HTTP redirect downgrade (no test exists).
- `final_url` query string exposure in returned value.
- AbortSignal listener accumulation (memory regression).
- `Content-Encoding: gzip` body corruption despite `Accept-Encoding: identity` request.
- `truncated: true` path reachability (dead-code confirmation).

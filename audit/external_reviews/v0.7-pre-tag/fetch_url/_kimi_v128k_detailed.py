import json, os, pathlib, http.client, ssl, sys, time

env_path = pathlib.Path("C:/Users/User/Desktop/ai/ai-judge/.env")
for line in env_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, _, v = line.partition("=")
        if k.strip() == "MOONSHOT_API_KEY":
            os.environ["MOONSHOT_API_KEY"] = v.strip()
            break

api_key = os.environ["MOONSHOT_API_KEY"]
src = pathlib.Path("C:/Users/User/Desktop/ai/tools/winfs/src/tools/network/fetch_url.ts").read_text(encoding="utf-8")

areas = """
**Area 1: AbortSignal listener leak (lines 282-293)**

The abort listener is registered with { once: true }. This removes the listener ONLY if the abort event fires. If the request completes normally (200 OK, end event fires, safeResolve called with success), the listener remains on p.signal forever. If p.signal is long-lived (e.g. an AbortController reused across many requests), listeners accumulate one per request causing a memory leak.

Verify: does { once: true } also fire on non-abort-triggered cleanup? It does NOT -- once:true only removes on the event itself firing. Assess severity. Fix: capture listener reference and call removeEventListener inside safeResolve.

**Area 2: ETIMEDOUT conflation (lines 271-278 and 284, 289-292)**

Both the deadline timer and the abort signal handler emit buildError("ETIMEDOUT", ...). Callers cannot distinguish wall-clock exceeded from caller-initiated abort. Is this a problem? Suggest distinct codes.

**Area 3: HTTPS-to-HTTP redirect downgrade (lines 420-474)**

The redirect loop accepts any protocol change. If hop 1 is https://allowed.com/redirect and server returns Location: http://allowed.com/final, validateProtocol accepts http:. No check blocks protocol downgrade. This is a P1/P2 security issue. Confirm and provide fix.

**Area 4: Body cap -- truncated field dead-code analysis (lines 333-354)**

In the data event handler, when a chunk overflows: remaining = maxBytes - received. If remaining > 0, partial chunk pushed and received = maxBytes. Then truncated = true. Then: if (chunks.length === 0 || received >= maxBytes) -- this is ALWAYS TRUE after the assignment received = maxBytes. So safeResolve(ESIZE) is always called on overflow. The end event handler success path therefore can never have truncated=true. Confirm this analysis. The truncated output field is dead code on success path.

**Area 5: Race after safeResolve(ESIZE) (lines 344-354)**

After safeResolve(ESIZE), req.destroy() is called but not synchronously effective. data events may continue arriving. safeResolve guards double-resolve via settled. But received and chunks may grow past maxBytes briefly. Document.

**Area 6: Whitelist -- trailing-dot FQDN**

Test: new URL("https://example.com./path").hostname -- WHATWG URL standard behavior. Does it return "example.com." or "example.com"? If it preserves the dot, then a request with trailing-dot hostname fails whitelist even if example.com is whitelisted. Is this false-rejection (P2)?

**Area 7: Whitelist -- whitespace in config entries**

Operator configures allowedUrlHosts: ["example.com "] (trailing space). Line 131: config.allowedUrlHosts.map((h) => h.toLowerCase()) -- toLowerCase() preserves whitespace. url.hostname never has trailing space. Mismatch. P2 -- recommend .trim().

**Area 8: isInternalIP -- fe80::/10 coverage gap**

Line 107: lower.startsWith("fe80"). The fe80::/10 range covers fe80:: through febf::. Addresses like fea0::1 or feb0::1 are in fe80::/10 but do NOT start with "fe80". This is a P1 gap -- an attacker could use fea0:: or febc:: as SSRF target evading the check. Verify and provide fix.

**Area 9: IPv4-mapped IPv6 in hex colon notation (line 110)**

The regex /^::ffff:([0-9a-f.:]+)$/ matches both dotted (::ffff:192.168.1.1) and hex-colon (::ffff:c0a8:0101) forms. When inner = "c0a8:0101", net.isIPv4("c0a8:0101") returns false, so the address falls through to return false (not internal). But ::ffff:c0a8:0101 IS ::ffff:192.168.1.1 (192=0xc0, 168=0xa8, 1=0x01, 1=0x01). This is a P1 SSRF bypass: internal IPv4-mapped IPv6 in hex colon notation evades the check. Verify and provide fix.

**Area 10: Header value CRLF injection**

Caller passes headers: {"User-Agent": "foo\r\nX-Injected: bar"}. Does Node http module reject or pass through? Node v14+ raises TypeError on CRLF in header values. This would surface as EIO from the catch block. So CRLF injection is blocked by Node itself. Confirm. What about null bytes and tab characters?

For each area: confirm or deny the bug, state severity, give line numbers, give exact fix. At end, produce summary table:

| ID | Severity | Title | Confirmed? |
And total P0/P1/P2/P3 counts.
"""

prompt = f"""You are an independent, rigorous security code reviewer. Your task is to produce a DETAILED, COMPREHENSIVE review of fetch_url.ts, the only network surface in winfs MCP server.

Complete source of src/tools/network/fetch_url.ts:

```typescript
{src}
```

Review each area below in full detail. Be thorough and specific. For each: confirm or deny, exact line numbers, severity, fix.

{areas}
"""

payload = json.dumps({
    "model": "moonshot-v1-128k",
    "messages": [{"role": "user", "content": prompt}],
    "temperature": 0.3,
    "max_tokens": 8192,
}).encode("utf-8")

ctx = ssl.create_default_context()
conn = http.client.HTTPSConnection("api.moonshot.ai", port=443, timeout=None, context=ctx)
print(f"Sending detailed request to moonshot-v1-128k (payload size: {len(payload)} bytes) ...", flush=True)
conn.request("POST", "/v1/chat/completions", body=payload, headers={
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
})
print("Request sent, waiting ...", flush=True)
t0 = time.time()
resp = conn.getresponse()
body_bytes = resp.read()
elapsed = time.time() - t0
conn.close()

print(f"STATUS: {resp.status} elapsed={elapsed:.1f}s", flush=True)
data = json.loads(body_bytes.decode("utf-8"))
msg = data["choices"][0]["message"]
content = msg.get("content", "")
print(f"content length: {len(content)}", flush=True)
print(f"finish_reason: {data['choices'][0].get('finish_reason')}", flush=True)
if data.get("usage"):
    print(f"usage: {data['usage']}", flush=True)

out_path = pathlib.Path("C:/Users/User/Desktop/ai/tools/winfs/audit/external_reviews/v0.7-pre-tag/fetch_url/_v128k_detailed_response.json")
out_path.write_text(json.dumps({"content": content}, ensure_ascii=False), encoding="utf-8")
print(f"SAVED to {out_path}", flush=True)

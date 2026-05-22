import json
import os
import pathlib
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# Load API key from ai-judge .env
env_path = pathlib.Path("C:/Users/User/Desktop/ai/ai-judge/.env")
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            if k.strip() == "MOONSHOT_API_KEY":
                os.environ["MOONSHOT_API_KEY"] = v.strip()
                break

phase = "v0.7-pre-tag-fetch_url"
commit_range = "HEAD (a885126)"
audit_type = "code-review"

# Read source file for inclusion in prompt
src_path = pathlib.Path("C:/Users/User/Desktop/ai/tools/winfs/src/tools/network/fetch_url.ts")
source_code = src_path.read_text(encoding="utf-8")

prompt = f"""You are an independent code reviewer for the AI Judge project -- specifically reviewing `fetch_url.ts`, the ONLY network surface in the winfs MCP server. Review this file with extreme scrutiny. The threat model: caller is benign but the target environment is untrusted public internet.

Your focus areas, in priority order:
1. SSRF defense correctness (DNS rebinding, multi-address DNS, IPv6 representations, IDN, IPv4-mapped IPv6)
2. Redirect chain validation gaps (protocol downgrade, body waste, loop guard error codes)
3. Body cap enforcement races and Content-Encoding handling
4. AbortSignal lifecycle (listener leak, ETIMEDOUT conflation)
5. Header injection edge cases
6. Audit redaction coverage

Severity tags: P0 (exploit in production now) / P1 (real bug, should fix before tag) / P2 (defensive, fix in patch wave) / P3 (polish/docs).

Per finding: title, line numbers, reproduction steps, recommended fix.

Known context:
- Two-layer SSRF: Layer 1 = host whitelist (pre-DNS, exact match, case-insensitive); Layer 2 = dns.lookup + internal IP deny; TOCTOU mitigation = connect-by-resolved-IP + manual Host header + SNI servername.
- Redirect re-validation: each hop runs ALL layers.
- MAX_REDIRECTS = 3. Header allowlist: user-agent, accept, accept-language only.
- Body cap: Content-Length pre-check + streamed overrun kills socket => ESIZE.
- Accept-Encoding: identity forced to disable compression.
- Node.js http/https module. TypeScript.

Here is the COMPLETE source file `src/tools/network/fetch_url.ts` at commit a885126:

```typescript
{source_code}
```

Additionally, review these TARGETED QUESTIONS from the security review prompt:

Q1: DNS rebinding TOCTOU -- dns.lookup(all: false) returns single address. What if hostname has multiple A records? What if one A is public, one AAAA is internal (fe80::...)? Does Node's family preference match what http.request would have chosen independently? Is rejectUnauthorized accidentally disabled for HTTPS?

Q2: Layer 1 whitelist edge cases -- IDN/Punycode confusables, trailing-dot FQDN (url.hostname for "example.com." -- does WHATWG strip the dot?), subdomain semantics (exact-match-only -- is this documented?), whitespace in whitelist entries (operator config "example.com " vs "example.com"), URL-encoded hostname characters.

Q3: Body cap -- race after safeResolve(ESIZE) where data handler continues receiving; truncation logic dead-code analysis (chunks.length === 0 is always false at that branch; received >= maxBytes is always true -- so truncated field is never set on a success path); Content-Encoding ignored (server may return gzip despite identity request; memory safe but caller gets garbage).

Q4: AbortSignal -- listener leak on normal completion (once: true only removes if abort fires; on normal 200 OK completion listener stays attached); ETIMEDOUT conflation (same error code for deadline vs caller-abort).

Q5: Redirect chain -- HTTPS-to-HTTP downgrade not blocked; 3xx body downloaded but silently discarded (up to 5 MB x 3 hops = 15 MB wasted); redirect limit error uses EHOSTNOTALLOWED which is semantically wrong.

For each issue, state: severity (P0/P1/P2/P3), exact line numbers in the source, reproduction steps, and recommended fix. State "P0: none" / "P1: none" etc. if a tier has no findings.
"""

PREFERRED_MODEL = "kimi-k2.6"
FALLBACK_MODEL = "moonshot-v1-128k"
PREFERRED_TEMPERATURE = 1
FALLBACK_TEMPERATURE = 0.3
MAX_TOKENS = 8192
API_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions"
MAX_ATTEMPTS = 3
ATTEMPT_DELAY = 10  # seconds between retries


def try_cli():
    kimi_bin = shutil.which("kimi")
    if kimi_bin is None:
        return None, "kimi CLI binary not on PATH"
    try:
        result = subprocess.run(
            [
                kimi_bin,
                "--model", PREFERRED_MODEL,
                "--thinking",
                "--print",
                "--input-format", "text",
                "--output-format", "text",
                "--final-message-only",
                "--afk",
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=600,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return None, "kimi CLI timed out after 600s"
    except OSError as e:
        return None, f"kimi CLI launch failed: {e}"
    if result.returncode != 0:
        err_msg = (result.stderr or "").strip() or f"exit code {result.returncode}"
        return None, f"kimi CLI exited non-zero: {err_msg}"
    output = (result.stdout or "").strip()
    if not output:
        return None, "kimi CLI returned empty output"
    return output, ""


def try_api_once(model, temperature, attempt_timeout=540):
    """Single API attempt with custom socket timeout."""
    api_key = os.environ.get("MOONSHOT_API_KEY")
    if not api_key:
        return 0, "MOONSHOT_API_KEY not set in environment"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": MAX_TOKENS,
    }).encode("utf-8")

    # Use http.client directly to get control over socket timeout
    import http.client
    ctx = ssl.create_default_context()
    conn = http.client.HTTPSConnection(
        "api.moonshot.ai",
        port=443,
        timeout=attempt_timeout,
        context=ctx,
    )
    try:
        conn.request(
            "POST",
            "/v1/chat/completions",
            body=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        resp = conn.getresponse()
        status = resp.status
        body = resp.read().decode("utf-8")
        return status, body
    except (socket.timeout, TimeoutError) as e:
        return 0, f"TimeoutError: {e}"
    except Exception as e:
        return 0, f"Exception: {type(e).__name__}: {e}"
    finally:
        conn.close()


def try_api(model, temperature):
    last_status, last_body = 0, ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        print(f"  API attempt {attempt}/{MAX_ATTEMPTS} model={model} ...", flush=True)
        status, body = try_api_once(model, temperature)
        if status == 200:
            print(f"  API attempt {attempt} succeeded (status=200)", flush=True)
            return status, body
        if status in (400, 404):
            # Model rejection -- don't retry
            print(f"  API attempt {attempt} model-rejection status={status}", flush=True)
            return status, body
        print(f"  API attempt {attempt} failed: status={status}, body_prefix={body[:200]}", flush=True)
        last_status, last_body = status, body
        if attempt < MAX_ATTEMPTS:
            print(f"  Waiting {ATTEMPT_DELAY}s before retry ...", flush=True)
            time.sleep(ATTEMPT_DELAY)
    return last_status, last_body


execution_path = ""
model_used = ""
fallback_warning = ""
content = ""

cli_output, cli_error = try_cli()
if cli_output is not None:
    execution_path = "CLI"
    model_used = f"{PREFERRED_MODEL} (CLI, --thinking)"
    content = cli_output
else:
    cli_failure_note = f"CLI path failed: {cli_error}; fell back to API"
    print(cli_failure_note, flush=True)
    status, body = try_api(PREFERRED_MODEL, PREFERRED_TEMPERATURE)
    if status == 200:
        execution_path = "API"
        model_used = PREFERRED_MODEL
        fallback_warning = cli_failure_note
        data = json.loads(body)
        content = data["choices"][0]["message"]["content"]
    elif status in (400, 404) and "model" in body.lower() and any(
        kw in body.lower() for kw in ("not found", "invalid", "unknown", "permission")
    ):
        api_preferred_failure = (
            f"PREFERRED API model '{PREFERRED_MODEL}' rejected: {body}; "
            f"fell back to '{FALLBACK_MODEL}'."
        )
        status2, body2 = try_api(FALLBACK_MODEL, FALLBACK_TEMPERATURE)
        if status2 == 200:
            execution_path = "API"
            model_used = FALLBACK_MODEL
            fallback_warning = f"{cli_failure_note}. {api_preferred_failure}"
            data = json.loads(body2)
            content = data["choices"][0]["message"]["content"]
        else:
            print(f"ERROR: API fallback also failed (status={status2}): {body2}")
            sys.exit(1)
    else:
        print(f"ERROR: API path failed (status={status}): {body}")
        print(f"CLI path note: {cli_error}")
        sys.exit(1)

ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%MZ")
out_dir = pathlib.Path("C:/Users/User/Desktop/ai/tools/winfs/audit/external_reviews/v0.7-pre-tag/fetch_url")
out_dir.mkdir(parents=True, exist_ok=True)
out_path = out_dir / "kimi_fetch_url_2026-05-22T0859Z.md"

artifact = f"""# Kimi review -- Phase {phase} -- {ts}

## Invocation

Execution path: {execution_path}
Model used: {model_used}
Audit type: {audit_type}
Commit range / files in scope: {commit_range}
{fallback_warning}

## Raw output

{content}

## Summary (kimi-reviewer subagent reading)

<to be filled by subagent after parsing>
"""

out_path.write_text(artifact, encoding="utf-8")
print(f"WROTE {out_path}")
print(f"EXECUTION_PATH {execution_path}")
print(f"MODEL_USED {model_used}")
if fallback_warning:
    print(f"FALLBACK_WARNING {fallback_warning}")
print(f"CONTENT_LENGTH {len(content)}")

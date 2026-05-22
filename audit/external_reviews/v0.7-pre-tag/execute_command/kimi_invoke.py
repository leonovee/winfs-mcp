import json
import os
import pathlib
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

phase = "v0.7-pre-tag-execute_command"
commit_range = "HEAD (a885126) — file review"
audit_type = "adversarial-test-brainstorm"

prompt = r"""You are an adversarial test generator for the winfs-mcp project — a Node.js/TypeScript MCP (Model Context Protocol) server that wraps Windows filesystem and process operations, exposed as MCP tools.

Your task: generate adversarial test cases for execute_command.ts and its dependencies (exec_safety.ts, exec_hints.ts). This tool spawns PowerShell and is the largest attack surface in the codebase.

## Source under review

### execute_command.ts — key logic

```typescript
// Line 80: argument composition — NO quoting
const composed = args.args.length > 0
  ? `${args.command} ${args.args.join(" ")}`
  : args.command;

// Line 83: pre-spawn blocklist check
const blocked = checkExecBlocklist(composed, config);
if (blocked) return blocked;

// Line 121: PowerShell invocation
const psArgs = ["-NoProfile", "-NonInteractive", "-Command", composed];

// Line 149: hints on stderr
const hints = diagnoseHints(spawnRes.stderr);

// Line 161-167: audit record
auditByResult.set(value, {
  composed_prefix: composed.slice(0, 64),
  composed_length: composed.length,
  stdout_prefix: spawnRes.stdout.slice(0, AUDIT_PREFIX_CAP),  // 4096
  stderr_prefix: spawnRes.stderr.slice(0, AUDIT_PREFIX_CAP),
  truncated_at_audit: AUDIT_PREFIX_CAP,
});
```

### exec_safety.ts — blocklist patterns (DEFAULT_EXEC_BLOCKLIST)

All patterns compiled with flag "i" (case-insensitive only — NOT "s" or "m", so "." does NOT match newlines):

```
"Remove-Item\\s.*-Recurse"
"Remove-Item\\s.*-rf"
"rm\\s.*-rf"
"rmdir\\s.*\\/[Ss]"
"del\\s.*\\/[Ss]"
"format\\s+[A-Za-z]:"
"Format-Volume"
"Initialize-Disk"
"Clear-Disk"
"Reset-PhysicalDisk"
"cipher\\s+\\/w"
"Optimize-Volume\\s.*ReTrim"
"bcdedit"
"bcdboot"
"reg\\s+delete\\s+HK(LM|EY_LOCAL_MACHINE)"
"Remove-ItemProperty\\s.*HKLM:"
"shutdown"
"Restart-Computer"
"Stop-Computer"
"Stop-Process\\s.*-Force"
"taskkill\\s.*\\/F"
"net\\s+user\\s+.*\\/add"
"Add-LocalUser"
"New-LocalUser"
"Invoke-WebRequest.*\\|\\s*Invoke-Expression"
"Invoke-Expression\\s+\\(.*Invoke-WebRequest"
"iex\\s+\\(.*iwr"
"curl\\s.*\\|\\s*(bash|sh|pwsh|powershell)"
"wget\\s.*\\|\\s*(bash|sh|pwsh|powershell)"
```

### exec_safety.ts — sanitized PATH (subprocess inherits this PATH only)

```
C:\Windows\System32
C:\Windows\System32\WindowsPowerShell\v1.0
C:\Windows
C:\Program Files\PowerShell\7
C:\Program Files\Git\cmd
C:\Program Files\Git\bin
C:\Program Files\nodejs
<config.pythonHome if set>
```

User's $PATH is NOT inherited.

### exec_safety.ts — spawnSubprocess key logic

```typescript
// stdio: stdin=ignore, stdout=pipe, stderr=pipe
child = spawn(opts.bin, opts.args, {
  cwd: opts.cwd,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

// Deadline timer: SIGTERM at deadline, killTree() 2s later
const deadlineTimer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => { if (!settled) killTree(); }, 2000).unref();
}, opts.deadlineMs);

// AbortSignal handler
const onAbort = () => {
  child.kill("SIGTERM");
  setTimeout(() => { if (!settled) killTree(); }, 2000).unref();
  // NOTE: timedOut is NOT set here — only deadlineTimer sets timedOut
};
if (opts.signal) {
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
}

// Output cap: per-stream, kills process on overflow
child.stdout.on("data", (chunk) => {
  if (stdoutBytes + chunk.length <= opts.maxOutputBytes) {
    stdoutChunks.push(chunk); stdoutBytes += chunk.length;
  } else {
    const remaining = opts.maxOutputBytes - stdoutBytes;
    if (remaining > 0) { stdoutChunks.push(chunk.subarray(0, remaining)); stdoutBytes = opts.maxOutputBytes; }
    truncatedStdout = true;
    if (!killedByCap) { killedByCap = true; killTree(); }
  }
});
// same for stderr

// killTree on Windows:
const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
  windowsHide: true,
  stdio: "ignore",
  // NO explicit env — inherits process.env (full user PATH)
});
killer.on("error", () => { child.kill("SIGKILL"); });
```

### exec_hints.ts — diagnoseHints

```typescript
export function diagnoseHints(stderr: string): string[] {
  if (!stderr) return [];
  const lower = stderr.toLowerCase();
  const matched: string[] = [];
  for (const entry of HINT_REGISTRY) {
    if (lower.includes(entry.marker.toLowerCase())) {
      matched.push(entry.hint);
    }
  }
  return matched;
}
// HINT_REGISTRY: one entry — marker = "Cannot run a document in the middle of a pipeline"
```

## Already-known issues (skip these)

1. Silent output for & operator invocations (P2 in docs/v0.5-acceptance.md) — SKIP
2. Git not found via find_command (P3, PATH mismatch) — SKIP

## Generate adversarial test cases

For each test case:
- **Title**: short name
- **Input**: exact command, args, relevant config (e.g., execSanitizeEnv, execExtraBlocklist, timeout_ms)
- **Expected behavior**: what the tool SHOULD do (per spec: block, error, or succeed safely)
- **Actual behavior**: what the implementation WILL do
- **Tag**: Real bug / Theoretical
- **Priority**: P1 (security boundary bypassed or data loss) / P2 (observable incorrect behavior) / P3 (minor)

Be concrete and specific. The architect will turn real-bug findings into actual test cases.

### Focus areas

**A. Blocklist bypass — .NET / COM / WMI API calls**

The blocklist is pure string regex on the PowerShell command string. It only catches CMDLET names. Consider:
- [System.IO.Directory]::Delete('C:\Windows', $true) — deletes recursively via .NET
- [System.IO.File]::Delete('C:\critical.sys')
- (New-Object -ComObject Shell.Application).ShellExecute("cmd", "/c rd /s /q C:\", "", "runas")
- $wmi = [wmiclass]"Win32_Process"; $wmi.Create("cmd /c rd /s /q C:\")
- [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKeyTree("SOFTWARE\MyKey")
- Add-Type -TypeDefinition 'class X { ... }' with P/Invoke to Win32 API for file destruction

**B. Blocklist bypass — PowerShell aliases and alternative spellings**

The blocklist pattern for Remove-Item is "Remove-Item\s.*-Recurse". PowerShell has these aliases:
- ri = Remove-Item
- del = Remove-Item (but also has "del\s.*\/[Ss]" for cmd-style del)
- erase = Remove-Item
- rd = Remove-Item (for directories)
- rmdir = Remove-Item (has pattern "rmdir\s.*\/[Ss]" but not "-Recurse" style)

Test: command = "ri C:\critical_data -Recurse -Force" — does blocklist catch it?
Pattern "Remove-Item\s.*-Recurse" would NOT match "ri" (case-insensitive only, not alias-aware).
Pattern "rmdir\s.*\/[Ss]" would NOT match "ri".

**C. Blocklist bypass — string concatenation reassembly**

PowerShell's -Command string is interpreted by PowerShell parser. Consider:
- command = "('Remove' + '-Item') -Recurse C:\" — composed = "('Remove' + '-Item') -Recurse C:\". Does "Remove-Item\s.*-Recurse" match? No — "Remove-Item" does not appear as a literal substring. PowerShell WILL execute this and delete recursively. REAL BUG?
- command = "$a = 'Remove-Item'; $a -Recurse C:\" — composed contains "Remove-Item" literally. Blocklist DOES match. Safe.
- command = "& ([char]82+[char]101+...) -Recurse C:\" — character code reassembly. No literal "Remove-Item". Blocklist misses.

**D. Blocklist bypass — Start-Process detachment**

Start-Process is not on the blocklist. Consider:
- command = "Start-Process -FilePath 'cmd' -ArgumentList '/c rd /s /q C:\Users\User\critical' -NoNewWindow -Wait"
  This launches cmd.exe (in System32, on sanitized PATH) and runs rd /s /q. The rd command is not on the blocklist. Is "rd" (rmdir synonym) blocked? Pattern "rmdir\s.*\/[Ss]" — does it match "rd"? No — "rd" and "rmdir" are different strings. REAL BUG?
- command = "Start-Process powershell -ArgumentList '-Command Remove-Item -Recurse C:\'"
  The inner Remove-Item is inside a string argument, not visible to the blocklist regex on the composed string.

**E. Blocklist bypass — Invoke-Expression with non-WebRequest source**

The blocklist catches "iex\s+\(.*iwr" and "Invoke-Expression\s+\(.*Invoke-WebRequest". But consider:
- command = "iex (Get-Content C:\my_script.ps1 -Raw)" — reads a file and executes it. File could contain Remove-Item -Recurse.
- command = "iex ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('UmVtb3ZlLUl0ZW0gLVJlY3Vyc2UgQzpcPg==')))" — base64-decodes "Remove-Item -Recurse C:\>" and executes it. Blocklist sees "iex" but pattern requires "iex\s+\(.*iwr" — this doesn't have "iwr". Pattern "Invoke-Expression\s+\(.*Invoke-WebRequest" also doesn't match. REAL BYPASS.

**F. Blocklist bypass — taskkill without /F**

Pattern: "taskkill\s.*\/F". Command: "taskkill /PID 4 /T" (no /F flag). Blocklist does NOT match. But this is a softer kill — less dangerous but still process interference. P3.

**G. Argument quoting — newline injection**

command = "Write-Output", args = ["safe\nRemove-Item -Recurse C:\important"]
composed = "Write-Output safe\nRemove-Item -Recurse C:\important"

Does blocklist catch this? Pattern "Remove-Item\s.*-Recurse" — wait, the pattern is "Remove-Item\s.*-Recurse", the text is "Remove-Item -Recurse". Does "Remove-Item -Recurse" match? YES! The "-Recurse" comes AFTER "Remove-Item" and "-" is not in the ".*" range — actually ".*" matches any character (except newline). So: "Remove-Item" then \s (space) then ".*" then "-Recurse". In "Remove-Item -Recurse", \s matches space, ".*" matches "" (empty), "-Recurse" matches. YES, BLOCKED.

But wait — what if the newline injects a SECOND command line? In PowerShell -Command, newlines DO separate statements. So "Write-Output safe\nRemove-Item -Recurse C:\" would execute BOTH lines. BUT the blocklist on composed string sees "Remove-Item -Recurse" (even across newlines, since \s includes \n). So this IS caught. Confirm?

Actually re-examine: pattern is "Remove-Item\\s.*-Recurse". With "i" flag. The string is "Write-Output safe\nRemove-Item -Recurse C:\". The pattern starts matching at "Remove-Item", then \s matches " ", then ".*" matches "-" (but ".*" stops at newline since "s" flag is absent). Hmm. In "Remove-Item -Recurse", the \s matches the space after "Remove-Item", then ".*" matches "" (greedy, empty match), then "-Recurse" matches. Result: MATCHES. BLOCKED. OK, safe.

But: "Remove-Item\n-Recurse" (newline between). Pattern: "Remove-Item\s.*-Recurse". \s matches \n. Then ".*" matches "" (no newline after the \n since "." doesn't match newline). Then "-Recurse" matches. So still BLOCKED. Good.

**H. Argument quoting — null byte in args**

command = "Write-Output", args = ["hello\x00world"]
composed = "Write-Output hello\x00world"
Blocklist: runs on this string. Null byte doesn't match \s. No blocklist pattern has \x00. Blocked commands can't be hidden behind null bytes easily (null byte doesn't split at "Remove-Item").
PowerShell behavior: PowerShell's -Command with a null byte — likely truncates at null. So composed "Write-Output hello\x00world" → PowerShell sees "Write-Output hello". Result: stdout = "hello", not "hello\x00world". Correctness issue: args are silently truncated. P2/P3?

**I. Argument composition — args with PowerShell injection characters**

command = "Get-Content", args = ["file.txt; Remove-Item C:\important.txt"]
composed = "Get-Content file.txt; Remove-Item C:\important.txt"
Blocklist: pattern "Remove-Item" (no pattern for just Remove-Item without -Recurse). Wait — pattern "Remove-Item\s.*-Recurse" requires -Recurse. Without -Recurse, "Get-Content file.txt; Remove-Item C:\important.txt" → blocklist MISSES IT. PowerShell executes both: reads file AND deletes important.txt. REAL BUG (P1)?

**J. Audit prefix leakage — sensitive token in position 60-68**

command = "A" * 62 + " ", args = ["SECRET_TOKEN_HERE"]
composed = "A" * 62 + " " + "SECRET_TOKEN_HERE..."
composed_prefix = composed.slice(0, 64) = "A" * 62 + " S" — captures first 2 chars of "SECRET_TOKEN_HERE".

Hmm, "SECRET_TOKEN_HERE" starts at position 63 (0-indexed), so prefix captures chars 0-63, which is the "S" from SECRET. Partial leak. The spec says "never full command (passwords on CLI)" — the prefix captures the start of the secret. P2?

Actually: command max length is 8192, args max 2048 each. A typical password passed as an arg element: if command is short (e.g., "curl -u"), the password arg could appear at position ~8 in the composed string, well within the 64-char prefix. The spec says "never full command" not "never any secrets". This is a design tension, not necessarily a code bug.

**K. timed_out flag not set on AbortSignal kill**

When AbortSignal fires (caller aborts), onAbort() kills the process. But `timedOut` remains `false` — only the `deadlineTimer` callback sets `timedOut = true`. So the result has:
```
{ timed_out: false, stdout: "", stderr: "", exit_code: null }
```

This is indistinguishable from a fast clean exit with no output. The caller aborted because they wanted to cancel, but they get back a result that looks like success. REAL BUG (P2)?

**L. compileBlocklist cache with malformed extra pattern**

If config.execExtraBlocklist contains a malformed regex (e.g., "[invalid"), the try/catch skips it silently. The pattern is dropped without any user-visible error. An operator who adds "." (expecting literal dot) gets a regex that matches any character — different behavior from expected. P3.

**M. killTree taskkill without explicit env**

When killTree() runs via taskkill, spawn("taskkill", ...) has no explicit env, so it inherits process.env — the FULL user PATH, not the sanitized PATH. This is intentional (taskkill is in System32). But: if taskkill.exe is shadowed by a malicious binary earlier on the user's PATH... on Windows, PATH search would find the real taskkill in System32. But with a shadowed binary, killTree could be hijacked. Theoretical on a non-compromised machine. P3.

**N. Double PATH key in execSanitizeEnv mode**

buildExecEnv with execSanitizeEnv=true:
```typescript
const env: NodeJS.ProcessEnv = {
  PATH: sanitizedPathVar,
  Path: sanitizedPathVar,  // Windows case-insensitive variant
};
```

The env object has both PATH and Path set. On Windows, environment variable names are case-insensitive. So the actual subprocess might see both. Node's env spread behavior: both keys exist in the JS object. When passed to spawn(), Node.js on Windows should handle the duplicate. But: is this actually safe? If the subprocess environment treats PATH and Path as distinct, one would override the other. In practice, Windows uses the LAST one found, or merges them. Needs testing. P2?

**O. maxOutputBytes boundary at exactly cap**

stdout output = exactly maxOutputBytes bytes in ONE chunk:
```
chunk.length == opts.maxOutputBytes
stdoutBytes == 0
stdoutBytes + chunk.length == opts.maxOutputBytes  (equal, NOT greater)
```
Condition: `stdoutBytes + chunk.length <= opts.maxOutputBytes` → TRUE (equal). So chunk is pushed entirely, stdoutBytes = maxOutputBytes. truncatedStdout remains false.

Then if process sends another byte:
stdoutBytes + 1 > maxOutputBytes → remaining = 0 → nothing pushed → truncatedStdout = true → killTree().

This is correct. But: what if the process sends exactly maxOutputBytes in one chunk, then exits cleanly? truncatedStdout = false. The caller gets all bytes and no truncation flag. Correct behavior.

But: what if the process sends maxOutputBytes+1 bytes in one chunk?
stdoutBytes(0) + (maxOutputBytes+1) > maxOutputBytes → remaining = maxOutputBytes > 0 → push chunk[0..maxOutputBytes] → stdoutBytes = maxOutputBytes → truncatedStdout = true → killedByCap. Correct, 1 byte dropped. Good.

**P. args array with 64 elements each 2048 chars — MAX_ARGS_LEN boundary**

args.max(MAX_ARGS_LEN) = max 64 elements. Each element max 2048 chars. Zod validates this before reaching executeCommandImpl. MAX_COMMAND_LEN = 8192 for command. Total composed max = 8192 + 64*2048 + 63 = 139327 chars. Blocklist runs on this string. All patterns are O(N) scan. For 139327 chars: fast, not a concern.

**Q. checkAllowed result type cast**

```typescript
const cwdCheck = await checkAllowed(args.cwd, config);
if ("ok" in cwdCheck && cwdCheck.ok === false) return cwdCheck;
cwd = (cwdCheck as { realPath: string }).realPath;
```

If checkAllowed returns a success result that does NOT have a `realPath` property (e.g., it returns `{ ok: true }` without realPath), this cast silently assigns `undefined` to `cwd`. Then `fs.stat(undefined)` throws — caught by the catch block as ENOENT. But the error message says "cwd does not exist" which is misleading (the real issue is a type contract violation). P2/theoretical?

Now generate your findings table. Be direct. Include only findings that are either genuine real bugs or highly instructive theoretical edge cases.
"""

PREFERRED_MODEL = "kimi-k2.6"
FALLBACK_MODEL = "moonshot-v1-128k"
PREFERRED_TEMPERATURE = 1
FALLBACK_TEMPERATURE = 0.3
MAX_TOKENS = 8192


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


def try_api(model, temperature):
    env_path = pathlib.Path(r"C:\Users\User\Desktop\ai\tools\winfs\.env")
    api_key = None
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("MOONSHOT_API_KEY"):
                parts = line.split("=", 1)
                if len(parts) == 2:
                    api_key = parts[1].strip().strip('"').strip("'")
                    break
    if not api_key:
        api_key = os.environ.get("MOONSHOT_API_KEY")
    if not api_key:
        return 0, "MOONSHOT_API_KEY not set in environment or .env"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": MAX_TOKENS,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.moonshot.ai/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")
    except urllib.error.URLError as e:
        return 0, f"URLError: {e}"


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
out_path = pathlib.Path(
    r"C:\Users\User\Desktop\ai\tools\winfs\audit\external_reviews\v0.7-pre-tag\execute_command\kimi_execute_command_2026-05-22T0859Z.md"
)
out_path.parent.mkdir(parents=True, exist_ok=True)

artifact = f"""# Kimi review — Phase {phase} — {ts}

## Invocation

Execution path: {execution_path}
Model used: {model_used}
Audit type: {audit_type}
Commit range: {commit_range}
{('Fallback warning: ' + fallback_warning) if fallback_warning else ''}

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

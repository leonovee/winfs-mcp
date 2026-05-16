# Codex review — winfs audit_tail.ts — 2026-05-16T0901Z

## Invocation

NOTE: Preferred model 'gpt-5.5 xhigh' rejected by codex CLI; fell back to CLI default.
Raw error: ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.5 xhigh' model is not supported when using Codex with a ChatGPT account."}}

Model used: gpt-5.5 (CLI default after fallback)
Command (exact):

```
export PATH="/c/Users/Expert/AppData/Roaming/npm:$PATH"
cd "C:/Users/Expert/Desktop/AI/tools/winfs"
codex review - < "audit/external_reviews/_review_audit_tail.prompt.md"
```

Review prompt file: audit/external_reviews/_review_audit_tail.prompt.md
Working directory: C:\Users\Expert\Desktop\AI\tools\winfs
Codex CLI version: 0.130.0

## Commit range

N/A — static review of source embedded inline in prompt file.
File in scope: src/tools/system/audit_tail.ts

## Files in scope (auto-detected by Codex)

src/tools/system/audit_tail.ts (source provided inline in prompt)

## Raw output

```
OpenAI Codex v0.130.0
--------
workdir: C:\Users\Expert\Desktop\AI\tools\winfs
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: medium
reasoning summaries: none
session id: 019e3005-fd4d-7ce3-9b05-e705bdec542e
--------
The implementation has a security-relevant path validation gap because lexical checks do not
constrain the actual file opened through symlinks, junctions, or races. It also has a resource
exhaustion issue from reading the entire unbounded audit log.

Full review comments:

- [P1] Reject symlinked or reparse-point audit paths — C:\Users\Expert\Desktop\AI\tools\winfs\src\tools\system\audit_tail.ts:47-50
  If an attacker can manipulate the config path or replace `%LOCALAPPDATA%\mcp-winfs\...jsonl`
  with a symlink/junction/reparse-point path, this lexical `path.normalize`/basename check still
  passes while the later `fs.readFile` follows the OS-level target outside the intended audit log.
  For example, `mcp-winfs\audit.jsonl` can point at another parseable JSONL file outside the
  sandbox and `audit_tail` will return matching records. Resolve and validate the canonical path,
  reject symlink/reparse components, and avoid the check/read TOCTOU by opening a verified file
  handle or by pinning the audit log to a trusted canonical path created with safe permissions.

- [P2] Bound audit log tailing by bytes and time — C:\Users\Expert\Desktop\AI\tools\winfs\src\tools\system\audit_tail.ts:64-64
  Even with `n` capped at 500, `fs.readFile` loads the entire audit log and `split("\n")` allocates
  for every line, so a large or maliciously grown audit log can consume excessive memory/CPU and has
  no operation timeout. Reproduce by appending a multi-GB audit log and calling `audit_tail({n:1})`;
  the tool still reads and splits the whole file. Tail from the end in bounded chunks, impose a byte
  cap and timeout, and parse only enough lines to satisfy `n`.

- [P2] Fill results after filtering self audit entries — C:\Users\Expert\Desktop\AI\tools\winfs\src\tools\system\audit_tail.ts:86-88
  Because the code tails only the last `n` raw lines and then pops every trailing `audit_tail`,
  repeated calls can hide all prior useful history: if the last 500 records are `audit_tail` and the
  preceding record is a real tool call, `audit_tail({n:500})` returns an empty list. For the
  self-recovery use case, scan backward until collecting up to `n` non-`audit_tail` entries, or
  clearly document that `n` is counted before self-filtering.

- [P3] Strip a UTF-8 BOM before parsing JSONL — C:\Users\Expert\Desktop\AI\tools\winfs\src\tools\system\audit_tail.ts:75-75
  If the audit log is manually edited or created with a UTF-8 BOM, the first line starts with
  `﻿` and `JSON.parse` drops that otherwise valid entry silently. Strip a leading BOM from
  `raw` before splitting so a small or newly edited audit log does not lose its first record.
```

## Summary (codex-reviewer subagent reading)

### P1 / BLOCKING (1)

**[P1] Symlink / reparse-point bypass — `isAuditLogPathLegitimate` is a lexical check only.**
Lines 47-50 (isAuditLogPathLegitimate) + line 121 (fs.readFile in tailLines).

Codex verbatim: "If an attacker can manipulate the config path or replace `%LOCALAPPDATA%\mcp-winfs\...jsonl` with a symlink/junction/reparse-point path, this lexical `path.normalize`/basename check still passes while the later `fs.readFile` follows the OS-level target outside the intended audit log."

The check validates path shape on a string, but `fs.readFile` follows symlinks/junctions at the OS level. This is a TOCTOU: pass the check with a valid-looking path, then have the filesystem resolve it to an arbitrary target. Because `audit_tail` is the only tool that reads outside `allowedRoots`, exploiting this is a full sandbox escape (arbitrary file read).

Suggested fix (Codex): use `fs.realpath` to resolve the path after the shape check, and verify the resolved path still satisfies the shape check; or open via a file descriptor obtained through safe `O_NOFOLLOW` flags (platform-dependent); or restrict the audit log's parent directory permissions so symlinks cannot be created there.

### P2 / HIGH (2)

**[P2] Unbounded memory / no timeout in `tailLines` — entire file read into RAM regardless of `n`.**
Line 64 (fs.readFile call in tailLines) + line 121 (raw.split).

Codex verbatim: "Even with `n` capped at 500, `fs.readFile` loads the entire audit log and `split('\n')` allocates for every line, so a large or maliciously grown audit log can consume excessive memory/CPU and has no operation timeout."

Attack: grow audit log to GBs (any tool that writes records repeatedly), then call `audit_tail({n:1})` — the entire file is still loaded.

**[P2] Self-deduplication loop drains all entries when all recent records are `audit_tail`.**
Lines 86-88.

Codex verbatim: "if the last 500 records are `audit_tail` and the preceding record is a real tool call, `audit_tail({n:500})` returns an empty list."

Reproduction: call `audit_tail` in a tight loop ~500 times; the dedup pop exhausts the window and real history becomes invisible — the primary use case (self-recovery after context loss) silently fails.

### P3 / LOW (1)

**[P3] UTF-8 BOM in audit log silently drops first JSONL record.**
Line 75 (raw.split("\n")).

Codex verbatim: "If the audit log is manually edited or created with a UTF-8 BOM, the first line starts with `﻿` and `JSON.parse` drops that otherwise valid entry silently."

Suggested fix: strip a leading BOM from `raw` before the split.

### Not found by Codex (explicit coverage gaps)

Codex did not address:
- Q3: file rotation/truncation between readFile and processing (acknowledged implicitly via TOCTOU mention but not separately)
- Q3: incomplete last line (partial JSONL record) — the trailing-`\n` strip + empty-line skip handle most of this, not flagged
- Q4: race between auditTailImpl return and runTool wrapper's appendAudit write — not flagged (Codex treated wrapper contract as held)
- Q1: "mcp-winfs" rename / config override — acknowledged as known tech debt per prompt context, correctly not flagged as new finding
```

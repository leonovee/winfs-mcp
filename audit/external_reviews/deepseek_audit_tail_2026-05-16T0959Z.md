# DeepSeek review — winfs audit_tail.ts — 2026-05-16T0959Z

## Invocation

Model used: deepseek-v4-pro
Audit type: code-review
Commit range / files in scope: winfs/src/tools/system/audit_tail.ts (full source, static review)


## Raw output

## Security Review: `src/tools/system/audit_tail.ts`

### P1 (critical: security bypass, sandbox escape, data corruption)

**P1-1: Sandbox escape via symlink/junction/reparse-point following   (lines 82-101, 118-120)**
*Attack*
- The guard `isAuditLogPathLegitimate` performs a purely string-based check: the path must end with `.jsonl` and its immediate parent directory must be named `mcp-winfs`.
- `fs.readFile` (line 111) resolves symbolic links, junction points and reparse points transparently on Windows.
- An attacker who can:
  - create a directory named `mcp-winfs` anywhere, place a symlink `pwn.jsonl` inside pointing to `C:\secret\passwords.txt`, and then
  - convince the server to use that path as `resolvedAuditLogPath` (e.g. via a crafted configuration file)
  will satisfy `isAuditLogPathLegitimate` while reading the target of the symlink.
- **Race condition**: Even with a legitimate `auditLogPath`, a local attacker with write access to the directory could atomically replace the real audit log file with a symlink to any system file *after* the string check but *before* `fs.readFile`, achieving the same bypass (TOCTOU).
*Fix*
- Before reading, resolve the real path with `fs.promises.realpath()`.
- Apply the same shape check (`endsWith('.jsonl')`, parent basename `== 'mcp-winfs'`) to the **resolved** path.
- Alternatively, open the file with `O_NOFOLLOW` (not directly available in Node.js; `fs.realpath` is the practical cross-platform approach) or use a Windows-specific API to disable reparse-point following.

---

### P2 (important: incorrect behavior, race condition with non-trivial consequences, missing input validation)

**P2-1: Unbounded memory consumption via `fs.readFile` of entire audit log (line 111)**
*Attack*
- The audit log file has no size limit. A single `audit_tail` call reads the whole file into memory, regardless of the requested `n`.
- An attacker can fill the log (e.g. by rapidly running other tools) to many gigabytes. A subsequent `audit_tail` then allocates that much RAM, potentially crashing the server or causing severe performance degradation.
*Fix*
- Use a streaming reverse reader (e.g. `fs.createReadStream` with seek-to-end logic) or impose a hard maximum file-size check before reading (`fs.stat` and reject if larger than, say, 50 MB). This matches the bounded-time and bounded-resource invariants.

**P2-2: Aggressive self-deduplication enables log suppression (lines 136-138)**
*Attack*
- The while-loop unconditionally pops *all* consecutive trailing entries whose `tool` is `"audit_tail"`.
- An attacker who repeatedly invokes `audit_tail` can fill the recent window entirely with `audit_tail` entries. When a legitimate user later runs `audit_tail` to review recent activity, all entries are stripped, and the response is empty — effectively hiding every prior action from the view. This harms the tool's purpose of reconstructing history.
- Even a single legitimate previous operation that is now the last non-`audit_tail` entry may be hidden if it gets pushed out of the tail window by the attacker's flood.
*Fix*
- Remove **only the very last entry** if it is an `audit_tail` record that plausibly belongs to the current call. One robust way: pass the current call's timestamp (from the wrapper) and drop the last entry only if its `ts` is within a small delta (e.g. 2 seconds) and its tool is `audit_tail`.
- Alternatively, accept that the current call *might* appear in the output and remove the deduplication entirely; a stray `audit_tail` entry is far less harmful than disappearing history.

**P2-3: No timeout on file read operation (line 111)**
*Attack*
- Although the whole tool call is guarded by a global timeout (default 10 s, max 60 s), `fs.readFile` itself has no internal deadline.
- If the audit log path points to a named pipe, a network mount, or a device that blocks indefinitely, the call will hang until the global timeout fires, tying up the handler (and possibly thread-pool) for up to 60 s. This can cause backpressure and degrade service.
*Fix*
- Add a dedicated timeout for the file read (e.g. `Promise.race` with a 5 s timer) or use a streaming approach with configurable read deadline.

---

### P3 (nice-to-have: code smell, defensive coding, documentation gap)

**P3-1: Audit-log file size unchecked before read**
- No `stat` call to verify file size; even without malintent, a long-running server will produce a large file and a casual `audit_tail` could inadvertently allocate hundreds of MB.

**P3-2: Hardcoded parent directory name `"mcp-winfs"` (line 99)**
- Already acknowledged as legacy technical debt. If the project is renamed, the tool will reject the new default path, breaking functionality. Mitigation: make the expected directory name configurable, or derive it from the server identity.

**P3-3: Error messages may leak the configured file path**
- On `EIO` (line 122), the error message includes the full error string, which often contains the path. While the path is part of the server configuration, leaking it in error responses could aid reconnaissance in constrained environments. A generic error message is safer.

**P3-4: First entry silently dropped if the file starts with a BOM**
- `fs.readFile` with UTF-8 does not strip the BOM; the first line will fail to parse as JSON and be dropped. This loses one legitimate audit entry. A pre-processing step to remove a leading BOM is advisable.

**P3-5: No guard against `resolvedAuditLogPath` being a relative path**
- If `ResolvedConfig` unexpectedly contains a relative path, `path.normalize` will not make it absolute, and `fs.readFile` resolves it against `process.cwd()` — which could be outside the intended audit directory. While unlikely given the config pipeline, an explicit `if (!path.isAbsolute(norm))` check would be defensive.

---

**Summary of non-findings**
- P1: The only critical vector is the symlink/reparse-point bypass; all other path-manipulation attempts fail the shape check unless a directory named `mcp-winfs` is used.
- Q4 (race with the wrapper's audit write): Because the wrapper writes atomically via temp+rename, `fs.readFile` sees a consistent snapshot. The deduplication loop handles the current call whether or not the wrapper's write is visible; no additional race condition was found.
- Multi-instance merging (Q3): Not a security boundary issue, but documented as a potential correctness concern under P3-2 (hardcoded directory name).

## Summary (deepseek-reviewer subagent reading)

### Critical (P1) — 1 finding

**P1-1** — Symlink/junction/TOCTOU sandbox escape — `isAuditLogPathLegitimate` L110-115 + `tailLines` L121.
String-only path check does not resolve symlinks or reparse points before opening. An attacker can craft a directory named `mcp-winfs` anywhere with a `.jsonl` symlink pointing to an arbitrary file, or race-replace the real log with a symlink between the check and `fs.readFile`. Fix: call `fs.promises.realpath()` on `resolvedAuditLogPath` BEFORE the shape check, then apply the shape check to the resolved path.

### High (P2) — 3 findings

**P2-1** — Unbounded memory allocation — `tailLines` L121.
`fs.readFile` slurps the entire audit log regardless of requested `n`. A full log of several GB causes OOM. Fix: `fs.stat` size gate (e.g. 50 MB hard cap) before read, or streaming tail.

**P2-2** — Self-deduplication strips all history when `audit_tail` is run in a loop — L170-172.
The `while` loop removes every trailing `audit_tail` entry, not just the current call. An attacker (or automated loop) that fills the `n`-window with `audit_tail` calls causes the response to return zero entries, erasing all visible history. Fix: remove at most one trailing entry that falls within a timestamp delta of the current invocation.

**P2-3** — No per-read timeout, hang on non-file path — `tailLines` L121.
If `resolvedAuditLogPath` resolves to a named pipe or network mount, `fs.readFile` blocks until the global 60 s tool timeout, monopolizing the Node thread pool. Fix: `Promise.race` with a short (5 s) per-read deadline.

### Medium (P3) — 5 findings

**P3-1** — No file-size stat before read — L121. Incidental OOM even without attacker involvement on a long-running server.

**P3-2** — Hardcoded `"mcp-winfs"` parent-name check — L114. Acknowledged debt; will break if default `auditLogPath` is updated to match the renamed project.

**P3-3** — `EIO` error message leaks resolved path — L166. Full error string from Node often includes the FS path; prefer a sanitized generic message.

**P3-4** — BOM in audit log silently drops first JSONL line — L121/L129. `fs.readFile("utf8")` does not strip BOM; first line becomes unparseable. Fix: strip `﻿` before splitting.

**P3-5** — No absolute-path assertion on `resolvedAuditLogPath` — L111. Relative paths accepted by `path.normalize` but resolved against `process.cwd()`, which may be unexpected. Fix: `if (!path.isAbsolute(norm)) return buildError(...)`.

### Not found

- Q4 (race with wrapper audit write): DeepSeek assessed no race — wrapper uses atomic temp+rename, `fs.readFile` sees a consistent snapshot.
- Multi-instance merging: not a security boundary issue per DeepSeek.

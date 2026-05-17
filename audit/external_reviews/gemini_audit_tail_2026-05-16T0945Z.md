# Gemini review — winfs audit_tail.ts — 2026-05-16T0945Z

## Invocation

Model used: CLI default (gemini-2.5-flash-preview-05-20 rejected with ModelNotFoundError 404; fell back to CLI default)

NOTE: Preferred model 'gemini-2.5-flash-preview-05-20' rejected by gemini CLI; fell back to CLI default.
Raw error: ModelNotFoundError: Requested entity was not found. (code: 404)

Audit type: security / correctness review (targeted questions Q1–Q4)

Command (exact):
  /c/Users/Expert/AppData/Roaming/npm/gemini --prompt "<contents of _review_audit_tail.prompt.md>" > gemini_audit_tail_2026-05-16T0945Z.md

## Commit range / files in scope

File: src/tools/system/audit_tail.ts (source embedded in prompt)
No diff/commit range — single-file review.

## Raw output

'chcp' is not recognized as an internal or external command,
operable program or batch file.
'chcp' is not recognized as an internal or external command,
operable program or batch file.
Warning: Windows 10 detected. Some UI features like smooth scrolling may be degraded. Windows 11 is recommended for the best experience.
Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.
Ripgrep is not available. Falling back to GrepTool.
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 5s.. Retrying after 6622ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 6s.. Retrying after 7023ms...
Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after 6s.. Retrying after 6813ms...
(node:25792) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.
(Use `node --trace-deprecation ...` to show where the warning was created)
I have completed the security and robustness review of `src/tools/system/audit_tail.ts`. The findings are categorized by severity.

### P1 (Critical: Security Bypass, DoS, Data Corruption)

**1. Denial of Service (DoS) via Unbounded Memory Allocation**
- **Line:** 68 (`raw = await fs.readFile(filePath, "utf8");`)
- **Description:** The tool reads the entire audit log into a single UTF-8 string in memory before processing. Audit logs are append-only and can grow to several gigabytes. Node.js strings have hard limits (often 512MB-1GB), and `fs.readFile` of a multi-gigabyte file will cause an Out-Of-Memory (OOM) crash or severe event-loop blockage during the `split("\n")` operation.
- **Attack Scenario:** An attacker (or a long-running system) grows the audit log to 1GB. Any call to `audit_tail` with `n > 0` will crash the MCP server.
- **Suggested Fix:** Use `fs.open` and `fs.read` to seek to the end of the file and read backward in chunks until `n` valid JSONL lines are found, or use a streaming reverse-tail library.

**2. Sandbox Escape via Symlink/Junction Attack (TOCTOU)**
- **Lines:** 53-58 (`isAuditLogPathLegitimate`), 70 (`fs.readFile`)
- **Description:** The path validation is purely syntactic and does not account for filesystem-level redirections. Since this tool is a "deliberate exception" to the sandbox, a string check is insufficient. An attacker with write access to the parent directory of the audit log (e.g., `%LOCALAPPDATA%`) can replace the `mcp-winfs` directory or the `audit.jsonl` file with a junction or symlink pointing to a sensitive file elsewhere on the system.
- **Attack Scenario:** 
  1. LLM/Attacker creates a junction: `C:\Users\Expert\AppData\Local\mcp-winfs` -> `C:\Users\Expert\.ssh`.
  2. Attacker renames a sensitive file to end in `.jsonl` (if they have write access) or finds an existing one.
  3. `audit_tail` reads the sensitive file because the string check passes (`parent === "mcp-winfs"`).
- **Suggested Fix:** Use `fs.realpath()` to resolve the path before checking. Verify that the resolved path is rooted in a trusted system directory.

---

### P2 (Important: Incorrect Behavior, Race Conditions)

**1. Broken on Windows due to CRLF Line Endings**
- **Lines:** 75-77 (`raw.split("\n")`)
- **Description:** On Windows, JSONL files typically use `\r\n`. `split("\n")` preserves the trailing `\r` on every line. `JSON.parse()` is strict; it will throw a `SyntaxError` when it encounters a trailing carriage return (e.g., `{"ts":"..."}\r`). The code catches this and silently drops the line.
- **Attack Scenario:** On a standard Windows installation, `audit_tail` will consistently return 0 results because every line fails to parse.
- **Suggested Fix:** Use `line.trim()` before calling `JSON.parse()`, or split using `/\r?\n/`.

**2. Missing UTF-8 BOM Handling**
- **Line:** 68 (`fs.readFile(filePath, "utf8")`)
- **Description:** If the audit log starts with a Byte Order Mark (BOM) — common if a user manually edits the log with Notepad — `fs.readFile` will include `﻿` at the start of the first line. This will cause `JSON.parse` to fail for the most recent (or oldest) entries.
- **Suggested Fix:** Strip the BOM if present: `if (raw.startsWith('﻿')) raw = raw.slice(1);`.

---

### P3 (Nice-to-have: Code Smell, Defensive Coding)

**1. Incorrect `total` Count**
- **Line:** 114 (`total: entries.length`)
- **Description:** The `total` field returns the length of the filtered subset, not the total number of entries in the file. This makes the field redundant and misleading, especially when `n=0` is passed to "retrieve only the structural envelope."
- **Suggested Fix:** Count the total lines in the file (without parsing them all) to provide a true `total`.

**2. Weak Syntactic Guard**
- **Lines:** 53-58 (`isAuditLogPathLegitimate`)
- **Description:** The check `parent === "mcp-winfs"` is easily spoofed. Any folder named `mcp-winfs` anywhere on the disk (e.g., `C:\Temp\mcp-winfs\`) can satisfy this check if the configuration is manipulated.
- **Suggested Fix:** Match against the absolute expected system path prefix.

**3. Inconsistent Self-Deduplication**
- **Lines:** 111-113 (`while (...) { entries.pop(); }`)
- **Description:** The logic only removes `audit_tail` calls from the very end of the array. if an `audit_tail` call is followed by a different tool call, the previous `audit_tail` entry remains visible.
- **Suggested Fix:** Use `entries.filter(e => e.tool !== "audit_tail")` if the intent is to hide the tool's usage entirely from the context reconstruction.

**Q4 Response:** The tool will NOT race with its own current call. The `runTool` wrapper writes the audit record *after* the implementation returns (since it needs the `duration_ms` and `result_status`), meaning the record does not exist on disk while `tailLines` is reading.

## Summary (gemini-reviewer subagent reading)

### P1 / BLOCKING (2 findings)

**P1-1 — Unbounded memory allocation / OOM DoS**
Line 68 (`fs.readFile` whole file into RAM). Audit logs are unbounded append-only; large logs crash Node with OOM or freeze event loop during `split("\n")`. Fix: reverse-read in chunks from file end.

**P1-2 — Symlink/junction sandbox escape (TOCTOU)**
Lines 53-58 + 70. `isAuditLogPathLegitimate` is a purely syntactic string check. Attacker replaces `%LOCALAPPDATA%\mcp-winfs\` directory (or the `.jsonl` file itself) with a Windows junction/symlink pointing to any sensitive file. String check passes; `fs.readFile` follows the redirect. Fix: call `fs.realpath()` on the path before the shape check, and verify it resolves inside a trusted prefix.

### P2 / HIGH (2 findings)

**P2-1 — CRLF line endings: returns 0 results on standard Windows**
Lines 75-77. `split("\n")` leaves trailing `\r`; `JSON.parse` rejects every line silently. On a normal Windows system `audit_tail` is effectively broken. Fix: split on `/\r?\n/`.

**P2-2 — UTF-8 BOM corrupts first line parsing**
Line 68. BOM (`﻿`) prepended by Notepad/Windows editors breaks `JSON.parse` on the first line. Fix: strip BOM after read.

### P3 / LOW (2 findings + Q4 answer)

**P3-1 — `total` field is misleading (returns subset length, not file total)**
Line 114. `total: entries.length` after deduplication and slicing — not the true record count in the file. Misleads callers when `n=0` is used for envelope-only calls.

**P3-2 — Weak directory-name guard (`"mcp-winfs"` check is spoofable)**
Lines 53-58. Any directory named `mcp-winfs` anywhere on disk satisfies the guard if config is manipulated. Should also check the path is rooted at `%LOCALAPPDATA%` (or `APPDATA` equivalent).

**P3-3 — Self-deduplication only removes tail runs, not interleaved entries**
Lines 111-113. `while (last === "audit_tail") pop()` only strips a trailing streak. A single intervening entry stops the loop. If intent is full suppression, use `.filter()`.

**Q4 (race with wrapper audit write): NO RACE** — Gemini confirms the `runTool` wrapper writes its audit record after the impl returns, so the current call's record cannot appear in the tail output.

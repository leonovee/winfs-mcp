# Codex review — Phase v0.7-pre-tag-edit_file — 2026-05-22T0859Z

## Invocation

Model used: N/A — CLI not installed (see error below)
Command attempted (would have been):
```
$env:PATH = "$pwd\.venv\Scripts;$env:PATH"
codex review --model "gpt-5.5 xhigh" --range da1eb2a..a885126 --output-format markdown --files src/tools/editor/edit_file.ts
```

## Codex CLI Error (verbatim)

```
codex : The term 'codex' is not recognized as the name of a cmdlet, function,
script file, or operable program. Check the spelling of the name, or if a path
was included, verify that the path is correct and try again.
At line:1 char:1
+ codex --version 2>&1
+ ~~~~~
    + CategoryInfo          : ObjectNotFound: (codex:String) [],
      CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException
```

`Get-Command codex` also returned exit code 1 with no output — the binary is not on PATH and does not appear to be installed anywhere discoverable on this machine.

Recommended action: Install codex CLI (e.g., `npm install -g @openai/codex`) then re-invoke this subagent with the same parameters.

## Fallback: Static analysis by codex-reviewer subagent (NOT a codex CLI run)

Per trust-model rule 3 ("Never substitute manual review and present as Codex output"), the following is clearly labeled as independent static analysis by the codex-reviewer subagent reading the source directly. It is NOT codex CLI output.

---

## Commit range

da1eb2a..a885126 (requested); HEAD resolves to a885126

## Files in scope

- `src/tools/editor/edit_file.ts` (332 lines, HEAD)
- Supporting files read for context: `src/core/tool_wrapper.ts`, `src/core/audit.ts`, `src/core/atomic_write.ts`, `src/core/timeouts.ts`

## Raw output

N/A — codex CLI not installed. See error above.

## Summary (codex-reviewer subagent static analysis)

### P0 / BLOCKING

None found.

---

### P1 / HIGH

**P1.1 — AbortSignal silently dropped: editFileImpl ignores the signal passed by runTool**

Lines 94–253, `editFileImpl` signature:
```typescript
export async function editFileImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<EditFileResult>>
```

`runTool` (tool_wrapper.ts line 83) declares its `impl` parameter as
`(args: TArgs, signal: AbortSignal) => Promise<Result<TValue>>`, and the wrapper
calls it at line 95 as `(signal) => impl(args, signal)` — so `signal` IS passed.

However the registration call at edit_file.ts line 328 is:
```typescript
(a) => editFileImpl(a as Input, config),
```
The arrow function silently drops the second argument (`signal`). `editFileImpl`
itself has no `signal` parameter at all. Consequently `fs.stat`, `fs.readFile`,
and `atomicWriteFile` receive no abort signal. On a slow network share or
OneDrive-backed path, a wall-clock timeout fires from `withTimeout` but the
underlying I/O continues running in the background, holding the file handle,
and the signal is never actually propagated.

This is the same pattern that Kimi flagged as P2.2 in the v0.3.2 audit_tail
review; the review prompt (Q3) explicitly calls it out. `atomicWriteFile`
also lacks a `signal` parameter (confirmed in `src/core/atomic_write.ts`),
so the fix requires two steps: (1) add `signal` to `atomicWriteFile`; (2) add
`signal` to `editFileImpl` and thread it through all three I/O calls.

Severity rationale: the wall-clock timeout in `withTimeout` (timeouts.ts lines
14–41) uses `Promise.race`, so the tool call DOES return at the deadline with
ETIMEDOUT — the process is not permanently hung. However, orphaned in-flight
I/O (especially `atomicWriteFile` mid-rename) can leave a `.tmp` orphan on
disk, and resource handles are held longer than necessary. Classified P1 for
resource-correctness; not P0 because ETIMEDOUT is surfaced correctly.

**Fix:** Add `signal: AbortSignal` to `editFileImpl`, pass it to each I/O
call, and update `atomicWriteFile` to accept and forward `signal` to
`fs.open`, `handle.writeFile`, `handle.sync`, and `fs.rename` (where
Node.js supports it — Node 18+ `fs.promises` accepts `{signal}` on most
operations).

---

**P1.2 — Multi-replace path miscounts replacementsMade when expected equals actual but string.split().join() matches fewer (or more) due to overlapping patterns**

Lines 185–189:
```typescript
buffer = buffer.split(e.old_str).join(e.new_str);
replacementsMade += expected;
```

`countOccurrences` (lines 70–81) uses non-overlapping indexOf scanning, which
matches the behaviour of `String.prototype.split` (also non-overlapping). So
for the purpose of EUNIQUE gating, the counts are consistent. However
`replacementsMade += expected` adds the asserted count rather than the count
actually produced by split/join. If the user passes `expected_count: 3` and the
file genuinely has 3 occurrences, split produces 4 segments and join produces
exactly 3 replacements — so `+= expected` is correct in that scenario.

The subtle bug: if `old_str` overlaps with `new_str` (e.g., old_str="aa",
new_str="a", text="aaa") `countOccurrences` returns 1 (non-overlapping), so
`expected_count: 1` gating passes, the single-replace branch runs
(`buffer.replace`), and `replacementsMade += 1` is correct. For the
multi-replace path with overlapping patterns the split count and the indexOf
count can diverge because `String.split` is greedy-left while `indexOf` in
`countOccurrences` advances by `needle.length` after each hit — these are
actually identical algorithms, so no divergence exists in practice.

Revised assessment: the `replacementsMade += expected` accounting is logically
correct when the EUNIQUE gate has just confirmed `occ === expected`. The count
produced by split().join() equals `expected` because split produces
`(occurrences + 1)` parts and join inserts `(parts - 1)` = `occurrences`
replacements. This is NOT a bug after careful analysis; downgrading to P2 note
below.

**Correction — this item is P2, not P1. See P2.1.**

---

**P1.3 — ENOENT is not in the error catalog surface of the tool description, but stat/readFile can produce it**

Line 294 (tool description Errors line):
```
Errors: EPERM_ROOT, ENOENT, EISDIR, EUNIQUE ..., EBUSY (locked destination), ETIMEDOUT.
```

Actually the tool DOES list ENOENT. And `fromNodeError` (errors.ts) maps
ENOENT from `fs.stat` correctly. Not a bug. Removing from P1.

**Correction — not a finding.**

---

### P1 findings (final): 1

**P1.1** (AbortSignal dropped) is the sole P1.

---

### P2 / MEDIUM

**P2.1 — EUNIQUE conflates absence (occ=0) and ambiguity (occ>1) under one error code; hint for edit[0] with occ=0 is misleading**

Lines 153–155:
```typescript
if (expected === 1 && occ === 0) {
  message = `edit[${i}].old_str not found in current buffer`;
  hint = "An earlier edit may have removed the target. Edits apply sequentially to the in-memory buffer.";
```

When `i === 0`, no prior edit has run, so the hint "An earlier edit may have
removed the target" is factually misleading. The user's very first old_str is
simply absent from the file. The hint should be conditional on `i > 0`.

Spec §5 also defines `ENOMATCH` as a distinct code (used by `read_section`),
originally intended for edit_file 0-occurrence case. Using a single `EUNIQUE`
code distinguishes via `details.occurrences_found === 0` vs `> 1` —
programmatically workable, but a client wanting to give distinct UX for "not
found" vs "ambiguous" must inspect the details field rather than the code.

Suggested fix for hint (low-risk, no contract change):
```typescript
hint = i > 0
  ? "An earlier edit may have removed the target. Edits apply sequentially to the in-memory buffer."
  : "The substring was not found in the file. Check spelling and whitespace.";
```

Whether to split `ENOENT` vs `EUNIQUE` is a design call for the architect.

---

**P2.2 — Diff truncation uses a possibly-split UTF-8 boundary, producing a malformed trailing sequence**

Lines 219–222:
```typescript
const head = Buffer.from(diff, "utf8").subarray(0, DIFF_BODY_CAP_BYTES).toString("utf8");
const dropped = Buffer.byteLength(diff, "utf8") - Buffer.byteLength(head, "utf8");
diff = `${head}... [${dropped} more bytes truncated]\n`;
```

`Buffer.subarray(0, 16384)` cuts at an exact byte offset. If the diff string
contains multi-byte UTF-8 characters (e.g., non-ASCII filenames in the unified
diff header, or non-ASCII file content in the `-`/`+` lines), the cut can land
in the middle of a multi-byte sequence. `Buffer.toString("utf8")` on Node.js
replaces incomplete sequences with U+FFFD (replacement character) rather than
throwing, so the round-trip is safe and won't cause crashes. But:

1. `head` may contain a trailing U+FFFD that was not in the original diff.
2. `dropped` is computed as `byteLength(diff) - byteLength(head)` — because
   `toString("utf8")` may shorten `head` by dropping the incomplete tail bytes,
   `byteLength(head) < 16384` in that case, so `dropped` overestimates the
   truncated bytes by up to 3 bytes. This is cosmetic.
3. The spec says the cap is "at 16 KB"; a caller checking
   `diff.length > 16384` in bytes after receiving the response would see the
   cap was honoured; the issue is only the potential U+FFFD in the tail.

Suggested fix: use `Buffer.from(diff, "utf8").subarray(0, DIFF_BODY_CAP_BYTES)`
then walk backwards to find the last complete UTF-8 sequence boundary before
slicing. Alternatively, since diffs for ASCII source code will almost never hit
this (the header line uses the realPath which is a Windows absolute path — pure
ASCII in practice), this can be accepted as a known limitation with a comment.
Severity: P2 because it violates strict UTF-8 correctness guarantee; not P1
because Node silently emits U+FFFD, the response is still parseable, and
real-world impact on this codebase (ASCII Windows paths, predominantly ASCII
source) is negligible.

---

**P2.3 — WeakMap audit-extras: key identity depends on object reference equality; any result re-wrapping breaks the lookup**

Lines 88, 248–251, 319:
```typescript
const auditByResult = new WeakMap<object, EditFileAuditExtras>();
// ...
auditByResult.set(value, { bytes_before: stat.size, bytes_after: afterBytes });
return ok(value);
// ...
const extras = getEditFileAuditExtras(result.value as EditFileResult);
```

The WeakMap stores the exact `value` object created at line 240. `ok(value)`
wraps it (see errors.ts), and `runTool` reads `result.value` back. If `ok()`
returns `{ ok: true, value }` (i.e., the original object reference is
preserved in `.value`), the WeakMap lookup works. If any layer clones or
spreads `result.value` — e.g., if a future version of `runTool` destructures it
for sanitization or schema validation — the WeakMap entry becomes unreachable
and `extras` returns `undefined`, silently dropping `bytes_before`/`bytes_after`
from the audit record. There is no current bug (the reference chain is intact in
this version), but the fragility is real as noted in Q5.

Alternative with less hidden coupling: make `editFileImpl` return a discriminated
tuple `[EditFileResult, EditFileAuditExtras]` and have the registration unwrap
it before passing to `runTool`. This keeps audit data visible in the call chain
without relying on object identity through multiple wrapping layers.

---

**P2.4 — TOCTOU: checkAllowed realpath is stale by the time readFile and atomicWriteFile run**

Lines 98–100, 121, 228 — path-based `stat`, `readFile`, and `atomicWriteFile`
all use the string `realPath` from `checkAllowed`. On Windows (NTFS), symlink
attacks during normal operation within `allowedRoots` are constrained because:
(a) the attacker would need write access to the same allowedRoot directory, and
(b) NTFS symlinks require admin or SeCreateSymbolicLinkPrivilege. Attack surface
is therefore smaller than the audit_tail case (which read files outside
allowedRoots). However, the race is architecturally present.

The v0.3.2 audit_tail fix used fd-bound operations (`fs.open` → `fileHandle.stat`
→ `fileHandle.readFile`) to pin the inode. Applying the same pattern here:
open the file once, stat and read through the handle, then atomicWriteFile using
the now-confirmed path. The write side still uses path-based rename (unavoidable
for atomic temp+rename), but the read side becomes race-free.

Severity: P2 in this threat model (low exploitability on Windows within
allowedRoots without admin rights); would be P1 if allowedRoots included
world-writable directories or if the server ran with elevated privileges.

---

### P2 findings: 4 (P2.1, P2.2, P2.3, P2.4)

---

### P3 / LOW

**P3.1 — `atomic: true` is always hardcoded in the result even for dry_run**

Line 241:
```typescript
atomic: true,
```

On the `dry_run: true` path, no write occurs, so "atomic" is technically
vacuous. A caller might interpret `atomic: true` in a dry_run result as meaning
the eventual live write will be atomic — which is true — but the field is
structurally misleading. Options: always emit it (current, defensible), emit
`atomic: !args.dry_run`, or drop from dry_run responses. Low impact; cosmetic.

---

**P3.2 — Description says `with_diff: false` → `diff` is empty and `truncated_diff` is absent; but diff="" is also the value when with_diff: true produces an identical buffer (no actual changes)**

Line 284–285 (tool description):
```
- with_diff (boolean, default true): when false, response `diff` is empty and `truncated_diff`
  is absent.
```

A caller receiving `diff: ""` cannot distinguish "with_diff was false" from
"with_diff was true but no changes were made" (e.g., when `expected_count: 0`
for all edits, which is assertion-only and performs no replacements, leaving
buffer === original, diff === ""). This is cosmetically confusing but not a
correctness issue since `replacements_made` correctly reflects whether anything
changed. Low impact.

---

**P3.3 — `details.occurrences` field name in the review prompt (Q2) vs `details.occurrences_found` in the current source**

The drift note says v0.6 renamed `details.occurrences` → `details.occurrences_found`
(edit_file.ts line 169). The review prompt Q2 still uses the old name
`details.occurrences` in its code snippet. The source is correct;
the prompt is stale. No code change needed; prompt can be updated for future
review waves.

---

**P3 findings: 3 (P3.1, P3.2, P3.3)**

---

## Counts

| Severity | Count |
|---|---|
| P0 / BLOCKING | 0 |
| P1 / HIGH | 1 |
| P2 / MEDIUM | 4 |
| P3 / LOW | 3 |

---

*Review performed by: codex-reviewer subagent (static analysis — codex CLI not available on this machine)*
*Source read at commit a885126*

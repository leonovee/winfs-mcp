# edit_file.ts external review — findings consolidation — 2026-05-22T0859Z

Wave: `v0.7-pre-tag-edit_file` against `main @ a885126`. File: `src/tools/editor/edit_file.ts`.

## ⚠ Wave provenance caveat

This surface has the **weakest reviewer coverage** of the four. Only one of
four reviewers produced substantive content, and that one was substituted:

| Reviewer | Status | Provenance |
|---|---|---|
| **Codex** | substantive artifact (14.6 KB), substituted | CLI not installed; codex-reviewer subagent did Sonnet-driven static analysis with explicit "NOT codex CLI output" disclaimer. Did real cross-file reads (tool_wrapper.ts, audit.ts, atomic_write.ts) and self-corrected two false positives during triage. |
| **Kimi** | failure-only artifact (1.4 KB) | Neither kimi CLI nor `MOONSHOT_API_KEY` available; agent correctly stopped without fabrication. |
| **Gemini** | missing artifact | CLI not installed; agent stopped. No file written. |
| **DeepSeek** | missing artifact | API key absent; agent stopped. No file written. |

**Effective convergence: 1/4.** All findings below come from one Sonnet-driven
analysis. Treat as engineering opinion from a careful single reader, not as
multi-reviewer signal. Recommend re-run with at least one real CLI/API
before applying P1.

## Reviewer profiles (recap)

- Codex — tightest, sharp on P1, ~4 findings. **Substituted** here.
- Kimi — adversarial process-risk. **Did not run**.
- Gemini — Windows-specific. **Did not run**.
- DeepSeek — anti-hallucination structural. **Did not run**.

## P1 findings

### P1.1 — AbortSignal silently dropped: `editFileImpl` ignores the signal `runTool` passes

Raised by: **Codex (substituted)** only. Single-source.

- Codex P1.1: "`editFileImpl` has no `signal` parameter. The registration call at line 328 is `(a) => editFileImpl(a as Input, config)` — the second argument from `runTool`'s impl signature (`signal: AbortSignal`) is silently discarded. All three I/O operations (`fs.stat`, `fs.readFile`, `atomicWriteFile`) run uninterruptibly. `atomicWriteFile` itself has no signal parameter either."

**Converged description.** The wall-clock deadline in `withTimeout` (via `Promise.race`) does surface `ETIMEDOUT` at the deadline — the process is not permanently hung. But the underlying I/O continues as an orphan and can leave a `.tmp` file on disk. On slow paths (OneDrive-backed, network share, NTFS junction-heavy trees), this matters.

**Recommended fix (two PRs).**

1. **`fix(core): atomicWriteFile accepts and forwards AbortSignal`** — thread `signal` through `fs.open`, `handle.writeFile`, `handle.sync`, `fs.rename`. Node 18+ `fs.promises` accepts `{signal}` on most operations.
2. **`fix(edit_file): editFileImpl signature + forward signal to all three I/O calls`** — add `signal: AbortSignal` parameter; pass it to `fs.stat`, `fs.readFile`, `atomicWriteFile`.

Severity rationale: Codex classified P1 for resource-correctness (orphaned `.tmp` files; held handles); not P0 because the user-visible response still reports `ETIMEDOUT` correctly. Defensible at P1; could be P2 if you accept the orphan-cleanup risk as low-probability on typical NTFS-on-internal-drive workloads.

## P2 findings (all from Codex-substituted)

### P2.1 — `EUNIQUE` hint for `edit[0]` with `occ=0` is misleading

Lines 153-155. When `i === 0` and `occ === 0`, the hint says "An earlier edit may have removed the target" — but no prior edit has run. The user's first `old_str` is simply absent. **Fix:** make the hint conditional on `i > 0`:

```typescript
hint = i > 0
  ? "An earlier edit may have removed the target. Edits apply sequentially to the in-memory buffer."
  : "The substring was not found in the file. Check spelling and whitespace.";
```

One-liner, low-risk, no contract change. Possible follow-on: introduce distinct `ENOMATCH` error code for the 0-occurrence case vs `EUNIQUE` for ambiguous (>1), but that's a spec change — defer.

### P2.2 — Diff truncation may split UTF-8 boundary, emitting trailing U+FFFD

Lines 219-222. `Buffer.subarray(0, 16384).toString("utf8")` cuts at byte boundary, not character boundary. For non-ASCII diffs (rare in this codebase — ASCII Windows paths predominate), the trailing fragment becomes a replacement character; `dropped` byte-count over-counts by up to 3 bytes. Node's `toString("utf8")` doesn't crash, just emits U+FFFD.

**Fix:** walk backwards from the cut to the last complete UTF-8 sequence boundary before slicing. Or accept as known limitation with a comment, since real-world impact is negligible on this codebase. Cosmetic P2.

### P2.3 — `auditByResult` WeakMap fragility — depends on object-identity preservation

Lines 88, 248-251, 319. `editFileImpl` returns `ok(value)` and `runTool` reads `result.value` back. The WeakMap lookup works only if `ok()` and any wrapping layers preserve the original `value` reference. Currently they do. If a future change destructures or clones `result.value` (for schema validation or sanitization), the WeakMap entry becomes unreachable and `bytes_before` / `bytes_after` silently drop from the audit record. No current bug, structural fragility.

**Fix:** return discriminated tuple `[EditFileResult, EditFileAuditExtras]` from `editFileImpl` and unwrap at the registration site. Eliminates WeakMap-via-identity coupling. Defer if WeakMap is acceptable — flag in spec amendment as known-fragile.

### P2.4 — TOCTOU: `checkAllowed` realpath is stale by the time `readFile` / `atomicWriteFile` run

Lines 98-100, 121, 228. Path-based `stat`, `readFile`, `atomicWriteFile` all use the string `realPath` from `checkAllowed`. On Windows within `allowedRoots`, exploit surface is small (attacker needs write access to the allowedRoot AND SeCreateSymbolicLinkPrivilege). But the race is architecturally present — same pattern as the v0.3.2 `audit_tail` fix that pinned the inode via fd-bound operations (`fs.open` → `fileHandle.stat` → `fileHandle.readFile`).

**Fix:** apply audit_tail's fd-bound pattern to the read side. Write side still uses path-based rename (unavoidable for atomic temp+rename), but read-then-write becomes race-free relative to symlink swaps. Severity P2 in this threat model; would be P1 if allowedRoots included world-writable directories or if the server ran with elevated privileges. Defer to v0.7.x security pass alongside other TOCTOU sweeps.

## P3 findings (all from Codex-substituted)

- **P3.1 — `atomic: true` is always hardcoded in result, even for `dry_run`** (line 241). Cosmetic. Consider `atomic: !args.dry_run` or drop from dry-run responses.
- **P3.2 — Caller cannot distinguish `with_diff: false` from "no changes made"**. Both return `diff: ""`. `replacements_made` correctly reflects whether anything changed, so not a correctness issue.
- **P3.3 — Review prompt drift**: `_review_edit_file.prompt.md` still references `details.occurrences` (renamed to `details.occurrences_found` in v0.6 §W). Source is correct; prompt is stale. Prompt-update task for chat-Claude.

## Self-corrected non-findings (Codex triage discipline)

The codex-reviewer subagent flagged two initial P1 items and dismissed both during its own triage:

- **Dismissed P1.2** ("multi-replace `replacementsMade` miscounts") — after careful analysis the `split().join()` count equals `expected` because split produces `(occurrences + 1)` parts and join inserts `(parts - 1) = occurrences` replacements. Logic is correct.
- **Dismissed P1.3** ("ENOENT not in error catalog") — wrong; `ENOENT` IS listed in the tool description, and `fromNodeError` maps it correctly.

Self-correction discipline is a credit to the substituted analysis quality — better than many real-CLI outputs that don't triage themselves.

## Reviewer-unique findings flagged

**All findings are single-source (Codex-substituted only).** No cross-reviewer convergence available for this surface. P1.1 (AbortSignal dropped) is the highest-confidence finding because (a) it's structurally verifiable from the source (registration site at line 328 + `editFileImpl` signature), (b) the codex-reviewer subagent's instinct here aligns with the same finding's prior-wave version (Kimi raised an analogous P2 in the v0.3.2 audit_tail review), and (c) the suggested fix is straightforward two-step thread-through.

## Recommended action plan

In severity-then-ease order. Each is a candidate `fix(edit_file): …` commit (or `fix(core): …` for atomicWriteFile). Chat-Claude approval gates first.

1. **`fix(core): atomicWriteFile accepts AbortSignal`** (precursor to P1.1) — thread `signal` through to `fs.open`, `handle.writeFile`, `handle.sync`, `fs.rename`. Test: mock slow rename + abort, assert temp cleanup. Touches `src/core/atomic_write.ts` and probably 2-3 callers — same pattern can be applied to `write` and `append`.
2. **`fix(edit_file): forward AbortSignal to editFileImpl` (P1.1)** — depends on #1. Edit signature + thread `signal` to `fs.stat`, `fs.readFile`, `atomicWriteFile`. Test: slow `fs.readFile` + abort, assert no orphan `.tmp`.
3. **`fix(edit_file): make EUNIQUE absence-hint conditional on i > 0` (P2.1)** — one-line change + one unit-test assertion (single edit[0] with absent old_str gets the new hint).
4. **`fix(edit_file): walk UTF-8 boundary backward on diff truncation` (P2.2)** — small helper. Test: diff with non-ASCII filename, truncated to a boundary that splits the sequence.
5. **`spec+code: drop WeakMap audit-extras pattern; return tuple from editFileImpl` (P2.3)** — invariant-tightening, no behaviour change for callers. Defer if WeakMap accepted.
6. **`fix(edit_file): fd-bound read side` (P2.4)** — apply audit_tail TOCTOU pattern. Defer to v0.7.x TOCTOU sweep covering edit_file + read + read_section.
7. **`fix(edit_file): atomic: !args.dry_run` (P3.1)** — cosmetic.

## Re-run guidance

This surface is the most undersupplied of the four. Strongly recommend re-running at least one of:

- **DeepSeek** (structural anti-hallucination profile — would validate Codex's P1.1 signal-drop claim independently). Set `DEEPSEEK_API_KEY` in env / project `.env` and re-invoke `deepseek-reviewer`.
- **Kimi** (adversarial — would test the multi-edit cascade, sequential cascade, dry-run-no-disk-touch invariants). Set `MOONSHOT_API_KEY` (key exists in `C:\Users\User\Desktop\ai\ai-judge\.env`).
- **Real codex** to replace the substituted artifact. Install `@openai/codex` after creating npm global directory.

Single re-run per missing/substituted cell is sufficient.

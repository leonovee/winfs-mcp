# CC prompt — winfs-mcp v0.4 — `edit_file` + `read_section` + `read_since` + `diff_files`

> **Audience:** Claude Code (VS Code-CC) working in `C:\Users\Expert\Desktop\AI\tools\winfs\` on `main` after `v0.3.3` (commit `328a935`).
>
> **Phase boundary (spec §7):** v0.3 closed Search + self-recovery. v0.4 closes "**Edit + slice + tail + diff** — Claude can modify code without dropping to a shell, slice large files without blowing context, watch logs/output incrementally, and compare two versions textually."
>
> **Source of truth:** `docs/design/mcp-winfs-spec.md` §4.x rows for each new tool. If spec wording and this prompt disagree, the spec wins — call it out and propose an amendment.

---

## 0. Pre-flight (do once)

1. `git status` — working tree clean on `main`, HEAD = `v0.3.3`.
2. `npm ci` — confirms lockfile + node_modules are consistent.
3. `npm run build` (i.e. `tsc`) — must exit 0, zero diagnostics. Use absolute `node.exe` if `tsc` fails with `'node' is not recognized` (MSIX PATH quirk — see README troubleshooting).
4. `npm test` — must report **129 passing** in 28 files at v0.3.3 baseline. If anything below 129, stop and reconcile before adding scope.
5. Read `docs/v0.3-acceptance.md` and `docs/design/mcp-winfs-spec.md` §4 + §7 + §F. Internalize the envelope rules (`{<plural>, total, ...flags}`) and the error-code taxonomy.

If anything in steps 1–4 fails, fix that first and only that, in a single chore commit — do **not** start v0.4 work on a dirty baseline.

---

## 1. What ships in v0.4

Four new tools. **Implementation order is fixed** — each builds on patterns from the previous.

| Order | Tool          | Read-only | One-line                                                                                  |
|-------|---------------|-----------|-------------------------------------------------------------------------------------------|
| 1     | `read_section`| yes       | Slice a file by line range or byte range without loading the whole file.                  |
| 2     | `diff_files`  | yes       | Unified-format textual diff between two files (or a file and an inline string).           |
| 3     | `edit_file`   | **no**    | Atomic find-and-replace with `dry_run`, unique-match invariant, multi-edit batching.       |
| 4     | `read_since`  | yes       | Incremental tail: read content appended to a file since a caller-supplied byte offset.    |

The two read-only slice tools land first. They establish helpers (line-index, range arithmetic, content slicing under UTF-8 boundaries) that `edit_file` and `read_since` reuse. `edit_file` is the marquee mutation tool — it lands third with full review attention. `read_since` is small and lands last as a polish.

Atomic-write invariant (temp + fsync + rename) and allowedRoots + UTF-8-no-BOM + bounded timeouts + structured errors apply to all four exactly as in v0.1–v0.3.

---

## 2. Tool specifications

### 2.1 `read_section`

**Motivation.** `read` returns the entire file. For 200 KB source files this floods the chat. `read_section` lets Claude pull a precise slice — e.g. lines 412–478, or bytes 0..4096 — without paying for the rest.

**Args (Zod):**
- `path: string` — absolute, inside `allowedRoots`.
- One of these two mutually exclusive selectors:
  - `line_range: [number, number]` — inclusive, 1-based; `[10, 25]` returns lines 10..25.
  - `byte_range: [number, number]` — inclusive, 0-based; `[0, 4095]` returns the first 4096 bytes.
- `encoding?: "utf8" | "raw"` — default `utf8`. With `byte_range`, `utf8` shrinks the slice on both ends if cutting a multi-byte sequence (returns the largest valid UTF-8 substring within the requested range, with `adjusted: true` in the response). `raw` returns base64 of the exact byte slice.

**Returns:** `{ content: string, range: {kind: "line"|"byte", start, end}, total_lines?: number, total_bytes: number, adjusted?: boolean, encoding: "utf8"|"raw" }`.
- `total_lines` is filled only for `line_range` requests (would require a full scan otherwise).
- `total_bytes` always reflects file size — cheap from `fstat`.

**Errors:**
- `EPERM_ROOT` — path outside allowedRoots.
- `ENOENT` — file does not exist.
- `EISDIR` — path is a directory.
- `EINVAL` — both selectors given, neither given, negative numbers, end < start, line_range end > total_lines, byte_range end >= total_bytes.
- `ETOOLARGE` — requested slice exceeds `config.maxReadBytes` (same limit as `read`).
- `EENCODING` — `encoding: "utf8"` and the slice contains decode-rejected sequences in the interior (not at the boundaries — boundary trimming is the `adjusted` path, not an error).
- `ETIMEDOUT` — deadline.

**Edge cases:**
- Empty file + `line_range: [1, 1]` → `EINVAL` (no such line). Empty file + `byte_range: [0, 0]` → `EINVAL` (end >= total_bytes=0).
- File ending with `\n` vs no final `\n` — `total_lines` counts the line *after* a trailing newline only if there is content after it. So `"a\nb\n"` has 2 lines, `"a\nb"` has 2 lines, `"a\nb\nc"` has 3 lines. Document this; pin with tests.
- CRLF: lines are split on `\n`; `\r` stays attached to the line. Don't normalize.

**Implementation hint.** Don't `readFile` the whole thing for `line_range`. Use `createReadStream` with line-by-line counting, and stop reading once the end of the requested range is buffered. For `byte_range`, `fs.read` with explicit offset+length — single syscall.

---

### 2.2 `diff_files`

**Motivation.** When Claude is asked "did this change?" or "show me what's different between these two configs", a unified diff is the right primitive. Avoids the user-eye-on-two-files comparison and lets Claude make decisions ("only the comment changed, safe to ignore").

**Args (Zod):**
- `a: string` — absolute path inside allowedRoots, OR
- `a_inline: string` — string content to use as the left side. Exactly one of `a` / `a_inline` is required.
- `b: string` / `b_inline: string` — same shape, exactly one required.
- `context_lines?: number` — default 3, max 10 (mirrors `grep`).
- `format?: "unified" | "minimal"` — default `unified`. `minimal` returns only changed-line counts + first 20 changed lines, for fast same/different checks.

**Returns:** `{ diff: string, identical: boolean, lines_added: number, lines_removed: number, format: "unified"|"minimal", a_label: string, b_label: string, truncated: boolean }`.
- `a_label` / `b_label` — filename (basename) for file inputs, `"<inline>"` for inline.
- `truncated: true` when the unified diff exceeded `config.maxDiffBytes` (new config knob, default 256 KB).

**Errors:**
- `EPERM_ROOT` — either side's path outside allowedRoots.
- `ENOENT`, `EISDIR` — per side.
- `EINVAL` — both `a` and `a_inline` (or neither); same for b.
- `EENCODING` — either side decodes to a binary file (UTF-16 BOM, NUL byte) — `diff_files` is text-only.
- `ETOOLARGE` — either input exceeds `config.maxReadBytes` after read.

**Edge cases:**
- Identical files → `diff: ""`, `identical: true`, both counts 0.
- One side empty, other non-empty → diff is the entire other side, `identical: false`.
- UTF-8 BOM on one side only — strip before diff (BOM never leaks into output).

**Implementation hint.** Use the `diff` npm package (`structuredPatch` for unified output). No shell-out. Don't write your own — the package is 30 KB and well-tested. The diff algorithm itself isn't a security boundary; the inputs are already realpath-checked.

---

### 2.3 `edit_file`

**Motivation.** The marquee v0.4 tool. Replaces "open in editor → find → replace → save" with one tool call. Atomic semantics same as `write` (temp + fsync + rename). The uniqueness invariant prevents accidental "replace all" footguns: if `old_str` appears more than once, the call fails with `EUNIQUE` and the file is untouched.

**Args (Zod):**
- `path: string` — absolute, inside allowedRoots.
- `edits: Array<{ old_str: string, new_str: string }>` — 1..50 edits, applied in order to the in-memory buffer.
- `dry_run?: boolean` — default `false`. If `true`, performs all edit validations and returns the would-be diff but does **not** touch disk.

**Returns:** `{ path: string, replacements_made: number, atomic: boolean, dry_run: boolean, diff: string }`.
- `replacements_made` always equals `edits.length` on success (each edit replaces exactly one occurrence — see EUNIQUE below).
- `atomic: true` always (same atomic-write path as `write`). Mirror the `move` v0.2.x decision to expose the flag explicitly even when it's tautological — a future failure mode might flip it.
- `diff: string` — unified diff (3 lines context) of the pre/post buffer. Always returned, both for `dry_run` and real edits, so callers always have visibility into what changed.

**Errors:**
- `EPERM_ROOT` — path outside allowedRoots.
- `ENOENT` — file does not exist. `edit_file` does **not** create files — `write` does. Be explicit in the description.
- `EISDIR` — path is a directory.
- `EUNIQUE` — at least one edit's `old_str` appears 0 times or 2+ times in the (then-current) buffer. Error `details` include `{edit_index: number, occurrences: number}` so the caller knows which edit failed and why.
- `EBLOCKED_CMD` — out of scope here, do not reuse this code for edit_file.
- `ETOOLARGE` — post-edit size exceeds `config.maxWriteBytes`.
- `EENCODING` — file fails the binary heuristic (UTF-16 BOM, NUL byte). `edit_file` is text-only.
- `EBUSY` — write of the temp file failed (rename target locked, etc).
- `ETIMEDOUT` — deadline.

**Edge cases:**
- `old_str === new_str` for some edit → valid no-op, counts toward `replacements_made`. (Useful for `dry_run`-style probing.)
- Edits applied sequentially: edit N is checked against the buffer after edits 0..N-1 are applied. So if `edit[0]` removes a string that `edit[1]` targets, `edit[1]` will report `EUNIQUE` (0 occurrences) — this is correct, not a bug.
- Empty `old_str` → `EINVAL` (refuse; prevents accidental whole-file overwrites).
- `new_str` containing `\r\n` while file uses `\n` (or vice versa) — do **not** normalize. The caller is responsible. Document this and pin with a test.
- BOM behavior: file already has a BOM → it's stripped on read (per `utf8.ts`), edits apply to the BOM-less buffer, write back without BOM. This matches `write` semantics exactly.
- `dry_run: true` must not even create the temp file. The implementation path forks before atomic-write begins.

**Audit log shape.** `args_summary` includes:
```
{ path, edits_count: number, dry_run: boolean, bytes_before: number, bytes_after: number }
```
**Never** put `old_str` / `new_str` content in the audit log (content-field redaction principle from `audit.ts`). The audit record proves "an edit was made"; reconstruction is intentionally out of scope.

**Implementation order.**
1. Read + decode file (reuse `read`'s `readFileUtf8` path).
2. For each edit in order: validate uniqueness (`occurrences = countOccurrences(buf, old_str)`; require exactly 1), apply.
3. Compute diff (reuse the `diff_files` `structuredPatch` helper).
4. If `dry_run`: return `{path, replacements_made: edits.length, atomic: true, dry_run: true, diff}` — no disk write.
5. Atomic write via `atomic_write.ts` (temp + fsync + rename).
6. Return.

---

### 2.4 `read_since`

**Motivation.** Incremental tail. Used to watch log files, build output, command output captured to disk, etc. Claude calls it with a byte offset returned from a previous call; gets back only the new content.

**Args (Zod):**
- `path: string` — absolute, inside allowedRoots.
- `since_offset: number` — non-negative integer byte offset.
- `max_bytes?: number` — cap on returned chunk size. Default 64 KB, hard cap 1 MB.

**Returns:** `{ content: string, new_offset: number, total_bytes: number, mtime: string, truncated: boolean, file_rotated: boolean }`.
- `new_offset` = `since_offset + content.length` (in bytes; UTF-8-trimmed if needed). Caller passes this as `since_offset` next time.
- `truncated: true` when `total_bytes - since_offset > max_bytes` and the response was capped.
- `file_rotated: true` when `total_bytes < since_offset` (file got smaller than where we left off; the log was rotated/truncated). In this case `content` returns the **whole file** and `new_offset = total_bytes`; the caller is expected to acknowledge by passing the new offset on the next call.

**Errors:**
- `EPERM_ROOT`, `ENOENT`, `EISDIR` — usual.
- `EINVAL` — `since_offset < 0` or non-integer.
- `EENCODING` — content from `since_offset..new_offset` fails strict UTF-8 decode (file likely binary or mid-rotation).
- `ETIMEDOUT` — deadline.

**Edge cases:**
- `since_offset === total_bytes` → empty content, `new_offset === since_offset`, `truncated: false`, `file_rotated: false`. Polling steady-state.
- File appended to between `fstat` and `read` — the read returns only what `fstat` saw. Next call picks up the rest. Document.
- UTF-8 boundary: if `since_offset` lands mid-multibyte, the read advances forward to the next valid UTF-8 boundary and returns that as `new_offset`. The skipped bytes are reported in `error.details` of an `EENCODING` result only when the boundary skip exceeds 4 bytes (a real corruption signal vs. a 1–3 byte alignment).

**Implementation hint.** `fs.open` + `fileHandle.read` with explicit `position`. One syscall in the common path. Stat first to determine rotation; read second.

---

## 3. Spec amendments to draft

Land these in `docs/design/mcp-winfs-spec.md` as a dated amendment block, before the implementation lands:

- **§I — `edit_file` semantics**. Pins: (a) `EUNIQUE` on 0 or 2+ occurrences, (b) sequential application of edits, (c) `dry_run` must not touch disk, (d) `diff` field always populated, (e) audit-log redaction of `old_str` / `new_str`.
- **§J — `read_section` slice semantics**. Pins: (a) mutually exclusive `line_range` / `byte_range`, (b) line counting on `\n` with no normalization, (c) UTF-8 boundary trim with `adjusted: true`, (d) interior decode failure is `EENCODING`, not adjustment.
- **§K — `read_since` rotation semantics**. Pins: (a) `file_rotated` returns whole file, (b) `new_offset === total_bytes` after rotation, (c) UTF-8 boundary advance up to 4 bytes silent, more is `EENCODING`.
- **§L — `diff_files` text-only**. Pins: (a) inline-or-path on each side, (b) BOM stripped, (c) `format: "minimal"` semantics, (d) binary input is `EENCODING`.

Each amendment is 3–6 sentences. The pattern is set by the v0.2/v0.3 amendments (§A–§H) — match their format exactly.

---

## 4. Tests

Layout follows v0.3 exactly: per-tool unit suite under `tests/unit/`, invariants suite under `tests/invariants/`.

**Required new unit files** (target counts inclusive):

- `tests/unit/fs/edit_file.test.ts` — ~12 tests:
  - happy single-edit
  - happy multi-edit batched
  - dry-run preserves disk + returns diff
  - `EUNIQUE` on 0 occurrences (details.occurrences = 0, edit_index correct)
  - `EUNIQUE` on 2+ occurrences (details.occurrences = 2)
  - sequential-application ordering (edit[0] makes edit[1] no-longer-unique → EUNIQUE)
  - `EPERM_ROOT`, `ENOENT`, `EISDIR`
  - `EENCODING` on binary file
  - empty `old_str` → `EINVAL`
  - identity edit (`old_str === new_str`) counts and produces empty diff
  - BOM round-trip (file in: BOM; file out: no BOM)

- `tests/unit/fs/read_section.test.ts` — ~10 tests:
  - `line_range` happy path
  - `byte_range` happy path
  - both selectors → `EINVAL`
  - neither → `EINVAL`
  - line_range end > total_lines → `EINVAL`
  - byte_range straddling multi-byte UTF-8 → `adjusted: true`
  - `encoding: "raw"` returns base64
  - `ETOOLARGE` on oversize slice
  - `EPERM_ROOT`, `ENOENT`, `EISDIR`

- `tests/unit/fs/read_since.test.ts` — ~8 tests:
  - steady-state: `since_offset === total_bytes` → empty
  - append: returns delta
  - `truncated: true` when delta > `max_bytes`
  - `file_rotated: true` when file shrank
  - UTF-8 boundary advance (1–3 byte silent skip)
  - UTF-8 corruption → `EENCODING`
  - `EINVAL` on negative offset
  - `EPERM_ROOT`, `ENOENT`

- `tests/unit/fs/diff_files.test.ts` — ~10 tests:
  - identical files → `identical: true`, empty diff, counts 0
  - file vs inline
  - inline vs inline
  - mutual exclusion (both path + inline) → `EINVAL`
  - both empty → identical
  - one empty → diff is whole other side
  - BOM on one side stripped before diff
  - binary input → `EENCODING`
  - `format: "minimal"` returns capped output
  - `truncated: true` on oversize diff

**Required new invariants** (one new file or extend existing):

- `tests/invariants/edit_file_atomic.test.ts` — pin that:
  - `dry_run: true` does not create the temp file (use `fs.readdir` of parent dir before/after and assert no `.tmp` artifact).
  - mid-write process kill (simulated via mock `fs.writeFile` throwing) leaves the original file intact (atomic invariant).
- Extend `tests/invariants/structured_content.test.ts` — pure-payload check for each of the 4 new tools (mirror the v0.3 envelope additions).
- Extend `tests/invariants/timeouts.test.ts` — deadline path for `edit_file` (slow disk → `ETIMEDOUT`, file unchanged).

**Target final test count:** 129 (v0.3.3) + ~40 (v0.4) = **~169 passing**. If the final number is meaningfully lower, scope is missing tests; if higher, scope ballooned — both deserve a paragraph in the acceptance report.

---

## 5. Commit + release procedure

**Conventional commits, atomic per scope.** Suggested sequence:

```
docs(spec): amend §I–§L for v0.4 tool surface
feat(read_section): line/byte range slicing with UTF-8 boundary trim
feat(diff_files): unified textual diff between files or inline strings
feat(edit_file): atomic find-and-replace with dry_run + uniqueness invariant
feat(read_since): incremental byte-offset tail with rotation detection
test(invariants): pin v0.4 envelope shapes + edit_file atomicity
docs(changelog): v0.4 entry
chore(release): bump VERSION 0.3.3 → 0.4.0
```

That's 8 commits. Each builds cleanly, each tested in isolation. The release commit bumps both `package.json` and `src/core/config.ts` `VERSION` constant — keep these in sync, they're checked at runtime.

**Tag:** `v0.4.0` (annotated). Push order: `git push origin main` then `git push origin v0.4.0`. Verify with `git ls-remote origin refs/heads/main refs/tags/v0.4.0`.

**Acceptance report:** `docs/v0.4-acceptance.md`. Mirror the structure of `docs/v0.3-acceptance.md` — same headings, same Inspector smoke-probe checklist (one probe per new tool, plus `dry_run` separately), same red-team probes section. Aim for a probe that demonstrates the `EUNIQUE` invariant ("write a file with two `foo` occurrences, try `edit_file` with `old_str: 'foo'`, expect EUNIQUE with `occurrences: 2` in details").

---

## 6. Known quirks (carry forward from v0.3.x)

- **MSIX node PATH.** Build/test scripts may need absolute `C:\Program Files\nodejs\node.exe` invocations. README troubleshooting has the workaround.
- **Inspector `--config` flag clash.** Use the `--` separator: `npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json`.
- **package.json BOM.** Some editors re-add UTF-8 BOM. Check first if a build breaks inexplicably.
- **MCP transport hangs.** Both `winfs` and `DC` sometimes wedge for ~4 minutes mid-session. Not a server bug; not introduced by v0.4. Restart Claude Desktop if it happens.
- **Strict Zod config.** `configs/local.json` rejects `_comment` fields. Anything documentary goes in a sibling `.md`.

---

## 7. Out of scope for v0.4

Not in this phase, even though tempting:

- **`edit_file` with regex.** Caller-supplied regex matching invites footguns and CPU-bomb potential. If wanted later, ship as a separate `edit_file_regex` tool with explicit timeout and an opt-in danger flag.
- **`edit_file` line-based addressing.** Line numbers drift the moment another edit lands. The `old_str` uniqueness invariant is the safer primitive.
- **`read_section` with regex address.** Belongs to `grep`'s domain. Don't blur surfaces.
- **`diff_files` with three-way merge / patch application.** That's a v0.5+ feature (`apply_patch` or similar). v0.4 is read-the-difference, not apply-a-difference.
- **`read_since` with mtime cursor instead of byte offset.** Byte offset is exact and rotation-detectable; mtime is fuzzy and breaks on filesystem-resolution boundaries. Stay with bytes.
- **Watch / subscribe variants of `read_since`.** Polling is the contract. Anyone wanting a true watch can poll with backoff.

If any of these come up during implementation, log them to a v0.5-backlog.md draft and move on. Do not let scope drift; v0.4 is large enough.

---

## 8. External review (optional but expected)

Per the v0.3 pattern, after the implementation is green and committed but **before** the `v0.4.0` tag is published, generate an external review prompt for at least `edit_file` (the marquee mutation tool) and run it through the 4 reviewers (Codex / Kimi / Gemini / DeepSeek) via `ai-judge-external-review` skill.

The grep.ts review (`audit/external_reviews/_review_grep.prompt.md`) is still pending from v0.3.x — Vladimir's call whether to fold that into the v0.4 review wave or run it separately first. Recommend doing grep.ts first, separately, so v0.4's review attention is undivided.

Apply review findings as P1 fix commits before tag. P2/P3 findings → v0.4.1/v0.4.2 patch releases (same cadence as v0.3.1/v0.3.2/v0.3.3).

---

## 9. Definition of done

- [ ] Spec §I–§L drafted and committed.
- [ ] All four tools implemented under `src/tools/fs/` (and registered in `src/server.ts`).
- [ ] `npm run build` exits 0 with zero TS diagnostics.
- [ ] `npm test` reports ≥169 passing in ~32 files.
- [ ] `tests/invariants/structured_content.test.ts` covers all 4 new envelopes.
- [ ] `tests/invariants/edit_file_atomic.test.ts` exists and passes.
- [ ] CHANGELOG.md has a `[0.4.0]` entry matching the v0.3.0 entry's depth.
- [ ] `package.json` + `src/core/config.ts` VERSION both `0.4.0`.
- [ ] `docs/v0.4-acceptance.md` written, Inspector smoke section filled in with real probe transcripts.
- [ ] At least `edit_file` has been through 4-reviewer external review; P1 findings either fixed or filed.
- [ ] `git push origin main v0.4.0` succeeds; `ls-remote` confirms both refs.

When all boxes are ticked, hand off with a short status comment listing the final commit SHA, test count, and any deferred items.

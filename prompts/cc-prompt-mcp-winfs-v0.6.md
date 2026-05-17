# Claude Code Prompt — winfs v0.6.0 — Configurable Scope + Chunked I/O

> **Audience:** Claude Code working in `C:\Users\Expert\Desktop\AI\tools\winfs\` on `main` after v0.5.0 ship (HEAD = `ba4ae7a` or later, tag `v0.5.0 → 2dc2a89` immutable on remote).
>
> **Scope:** v0.6.0 — two architectural features on top of v0.5.0's 29-tool surface. **Two new tools** + **one cross-cutting config option** + **one existing-tool extension**. No tool removal, no breaking changes to v0.5 surface.
>
> **Parallel to v0.5.x review wave:** if the v0.5.1+ external review wave is in flight (or queued), v0.6 work proceeds on a feature branch `v0.6` to avoid merge conflicts with review-wave fix commits landing on main. Final v0.6.0 tag waits for v0.5.x patch waves to settle, then merges to main.

---

## Step 0 — Scope summary

Three additions:

1. **Feature A — Configurable filesystem scope.** Cross-cutting config option `unrestrictedFilesystem: bool` + magic-string confirm. Default = false (strict allowedRoots, current behavior). When enabled with magic string `"I-UNDERSTAND-THE-RISK"`, `checkAllowed` short-circuits — paths outside allowedRoots accepted. All other security defenses (exec blocklist, SSRF defense layers, audit log, atomic writes) remain in force.

2. **Feature B — Chunked I/O: `write_chunk` tool.** New tool for byte-offset in-place file mutation. NOT atomic (in-place write). Companion to existing `read` (which already supports `offset`/`length` per spec §1.1). Enables surgical edits on huge files without loading them whole. Explicitly documented as non-atomic.

3. **Feature C — `edit_file.edits[].expected_count` extension.** Existing `edit_file` gains optional `expected_count: number` field per edit. Default 1 (current behavior). Allows assertions like "this string MUST appear exactly 3 times" or "MUST appear 0 times" (delete-if-present semantics). Atomic-preserving.

Net surface delta: **+2 tools (29 → 31)** + 1 schema field extension on edit_file.

---

## Step 1 — Hard invariants (v0.5 carry-forward + v0.6 additions)

All 27 hard invariants from v0.5 base prompt §1 carry forward. New invariants for v0.6:

**Invariant #28 — unrestricted mode requires explicit confirm.** `config.unrestrictedFilesystem: true` is rejected at startup unless `config.unrestrictedFilesystemConfirm: "I-UNDERSTAND-THE-RISK"` (exact string match). Without the magic string, server fails startup with structured `Config validation error: unrestrictedFilesystem requires confirm`. Makes accidental enable structurally impossible.

**Invariant #29 — unrestricted mode banner.** When unrestricted, server prints prominent 3-line stderr warning at startup AND records `server_mode: "unrestricted"` as the first audit log entry. When strict (default), `server_mode: "strict"` logged. Mode is visible in both real-time observation and forensic audit.

**Invariant #30 — mutation-tool audit entries include `mode` field.** Every audit entry for a mutation tool (`write`, `append`, `mkdir`, `move`, `copy`, `edit_file`, `write_chunk`, `execute_command`, `run_python`, `run_pytest`) includes `mode: "strict" | "unrestricted"` field. Read-only tools don't need it. Makes post-hoc filtering trivial.

**Invariant #31 — `write_chunk` non-atomicity is explicit.** Return value includes `atomic: false`. Tool description LEADS with "**This tool performs IN-PLACE writes. A crash or power failure mid-write can leave the file partially modified. Use `write` (atomic) for whole-file replacement.**" No silent atomic guarantee.

**Invariant #32 — `write_chunk` byte-offset bounds.** `offset <= file_size_before` strictly. `offset > file_size_before` → `EOFFSET` error. No sparse-file creation. Write may extend the file if `offset + content_length > file_size_before` — file grows naturally to hold new content.

**Invariant #33 — `write_chunk` UTF-8 boundary check.** If `encoding: "utf8"` (default) and `validate_byte_range: true` (default), boundaries at `offset` and `offset+content_length` MUST align with UTF-8 character boundaries. Misalignment → `EENCODING`. Prevents producing files that are valid sequences before and after the chunk but corrupted at the seam.

**Invariant #34 — `edit_file.edits[].expected_count` enforces exact count, not minimum.** If specified, the number of occurrences of `old_str` must equal `expected_count` exactly. Default 1 preserves v0.5 semantics. `expected_count: 0` is valid (assertion-only, no replacement performed). Values 2+ replace ALL occurrences atomically.

---

## Step 2 — Methodology amendments

New spec amendments to append to `docs/design/mcp-winfs-spec.md`:

**§U — Configurable filesystem scope.**
- Define `config.unrestrictedFilesystem: bool` (default false) and `config.unrestrictedFilesystemConfirm: string` (required when unrestricted = true, must equal magic string `"I-UNDERSTAND-THE-RISK"`).
- Define `serverMode: "strict" | "unrestricted"` derived field on ResolvedConfig.
- Document the `checkAllowed` short-circuit semantics: when unrestricted, `checkAllowed(path)` returns `{ok: true, realPath: await fs.realpath(path)}` (still canonicalises for symlink/relative-path handling) without checking against `allowedRoots`.
- Document what stays in force vs what gets bypassed.
- Document audit log `mode` field for mutation-tool entries.
- **Security note:** unrestricted mode is for development sandboxes, automated agent VMs, and environments where filesystem-wide access is the explicit goal. NEVER use in production on a multi-tenant host. NEVER use when the server is exposed to untrusted callers.

**§V — `write_chunk` tool contract.**
- Input schema: `{path: AbsolutePath, offset: number ≥ 0, content: string, encoding?: "utf8" | "base64", validate_byte_range?: bool}`.
- Output schema: `{path: string, offset: number, bytes_written: number, total_bytes_after: number, atomic: false}`.
- Behavior: read file size → check `offset <= size` (else EOFFSET) → if utf8+validate, check UTF-8 boundary alignment → `fs.open(path, "r+")` → `fileHandle.write(buf, 0, len, offset)` → `fileHandle.close()`.
- Errors: EPERM_ROOT (unless unrestricted), ENOENT (file must exist; NOT create), EISDIR, EOFFSET, EENCODING (utf8 boundary fail or content not valid utf8), ETOOLARGE (offset + content_length > config.readMaxBytes), ETIMEDOUT.
- Audit redaction: `path` full, `offset` full, `content_length` (NOT content), `mode`. Content first 256 chars logged with `<truncated_at: N>` marker, same pattern as `edit_file.edits[].new_str`.

**§W — `edit_file.expected_count` extension.**
- New optional field on each edit entry: `expected_count?: number` (non-negative integer).
- Default 1 (preserves v0.5 contract).
- Value 0 → assertion-only mode for that edit: verify `count(old_str in buffer) === 0`, no replacement performed. Useful for "ensure this code is removed" assertions.
- Values 2+ → multi-occurrence find-replace: all occurrences replaced atomically within the edit. `replacements_made` in response reflects actual count (must equal `expected_count`, else EUNIQUE).
- EUNIQUE error details: `{edit_index, occurrences_found, expected_count}`.

---

## Step 3 — Lessons learned (from v0.5 ship cycle)

**L1.** Always run `npm run build` AFTER source edits, BEFORE Inspector restart. v0.5.0 hit a 4-amend cycle on the release commit because `dist/` wasn't rebuilt after `config.ts` VERSION constant was updated. dist/ contains the compiled VERSION; stale dist/ = stale Inspector banner.

**L2.** Version bumps live in TWO files. `package.json` "version" field (npm metadata) AND `src/core/config.ts` `const VERSION` (runtime). Both must change. Consider adding an invariant test or pre-commit hook that pins their equality.

**L3.** Spec amendments use chronological append. §J supersedes §4.5 but §4.5 prose stays in body. v0.6 amendments §U–§W follow this convention. NO retroactive spec rewrites unless explicitly noted in a "consolidation pass" commit.

**L4.** `winfs:execute_command` silent-output bug (P2, v0.5 carryover). When CC orchestrates git ops via winfs's own execute_command tool (`& "C:\Program Files\Git\cmd\git.exe" ...`), stdout/stderr return empty even on success. Commands EXECUTE correctly; only observable output is lost. **Verify state changes via filesystem inspection** (`.git/refs/heads/main`, `.git/refs/remotes/origin/main`) instead of relying on command output.

**L5.** Inspector smoke methodology must match actual schemas. v0.5 smoke had 5 arg-shape drifts (read_json `data` not `value`, git_show requires hex sha not symbolic HEAD, git_blame requires absolute path, run_python `{mode, script}` not `{args:[]}`, read_section uses ranges not markers). v0.6 methodology must read actual `outputSchema` from source before writing probe arg shapes.

**L6.** Inspector pre-flight version check is the cheap gate. Tag the release commit, restart Inspector, verify server panel shows expected version. v0.5 took 4 cycles because version was missed in 2 files. v0.6 release MUST verify pre-flight version FIRST before declaring acceptance.

**L7.** `find_command("git")` returned false in v0.5. PATH sanitization in exec_safety.ts may exclude git's directory (or git's standard path doesn't match operator's install). v0.6 spec §P amendment should be reviewed; for v0.6 cycle, when invoking git via `winfs:execute_command` continue using absolute path `& "C:\Program Files\Git\cmd\git.exe"`.

---

## Step 4 — Phased delivery

### Phase 6a — Feature A: Configurable scope (2-3 hours CC)

1. **Update `src/core/config.ts`:**
   - Add `unrestrictedFilesystem: z.boolean().default(false)` to schema
   - Add `unrestrictedFilesystemConfirm: z.string().optional()` to schema
   - Add post-parse validator: `if (raw.unrestrictedFilesystem && raw.unrestrictedFilesystemConfirm !== "I-UNDERSTAND-THE-RISK") throw new Error("unrestrictedFilesystem requires unrestrictedFilesystemConfirm = 'I-UNDERSTAND-THE-RISK'")`
   - Add derived field on ResolvedConfig: `serverMode: "strict" | "unrestricted"` (computed from `unrestrictedFilesystem`)

2. **Update `src/core/allowed_roots.ts` `checkAllowed`:**
   - At top of function, if `config.serverMode === "unrestricted"`: skip allowedRoots check, return `{ok: true, realPath: await fs.realpath(p).catch(() => path.resolve(p))}` — still canonicalise to handle symlinks/relative, but accept any resolved path
   - Keep all other behavior identical for strict mode

3. **Update `src/index.ts` server startup:**
   - After config loaded, if unrestricted: print 3-line stderr warning:
     ```
     ⚠️ ⚠️ ⚠️  UNRESTRICTED FILESYSTEM MODE — all paths accessible
     ⚠️ ⚠️ ⚠️  Confirm: "I-UNDERSTAND-THE-RISK"
     ⚠️ ⚠️ ⚠️  See docs/design/mcp-winfs-spec.md §U
     ```
   - Pass `config.serverMode` to audit log initialization

4. **Update `src/core/audit.ts`:**
   - First audit entry on server startup: `{ts, event: "server_start", server_mode: <mode>, version: <VERSION>, pid: <process.pid>}`
   - Mutation tool audit entries get `mode: <serverMode>` field added

5. **Update `serverInfo` (MCP handshake metadata):**
   - Add `metadata.serverMode: <mode>` to the handshake response

6. **Tests:**
   - `tests/unit/config_unrestricted.test.ts` — 5 cases: strict default, unrestricted+confirm OK, unrestricted without confirm throws, unrestricted with wrong confirm throws, confirm without unrestricted is ignored (no-op)
   - `tests/invariants/unrestricted_mode.test.ts` — 4 cases: strict mode rejects out-of-roots path with EPERM_ROOT, unrestricted mode accepts out-of-roots path, audit log shows correct mode field, server_start entry includes mode

7. **Commit:** `feat(core): configurable filesystem scope (unrestrictedFilesystem + confirm)`

### Phase 6b — Feature B: `write_chunk` tool (3-4 hours CC)

1. **Create `src/tools/file/write_chunk.ts`:**
   - InputSchema per §V
   - OutputSchema per §V
   - Impl: checkAllowed → fs.stat for size+isDir → bounds check (EOFFSET) → if utf8: decode content + check UTF-8 boundary alignment via Buffer.byteLength + read existing range to verify boundary → fs.open(r+) → fileHandle.write(buf, 0, len, offset) → close → fs.stat for total_bytes_after
   - Audit extras: `{path, offset, content_length, content_prefix: content.slice(0,256), mode: serverMode}` via WeakMap pattern (consistent with edit_file v0.4)

2. **Register tool in `src/server.ts`:**
   - Import + registerWriteChunkTool
   - Add to TOOL_COUNT_HARDCODED (now 30)

3. **Tests:**
   - `tests/unit/file/write_chunk.test.ts` — 12 cases: happy in-place utf8, base64 encoding, extending file beyond EOF, offset 0 (replace start), offset == size (append), offset > size → EOFFSET, EPERM_ROOT, ENOENT (file must exist), EISDIR, EENCODING (invalid utf8 content), EENCODING (utf8 boundary misalign), audit extras populated
   - `tests/invariants/write_chunk_nonatomic.test.ts` — pin contract: returned `atomic: false`, no temp file created, no fsync ceremony, direct in-place mutation observable

4. **Commit:** `feat(file): write_chunk — byte-offset surgical writes for large files`

### Phase 6c — Feature C: `edit_file.expected_count` extension (1-2 hours CC)

1. **Update `src/tools/editor/edit_file.ts`:**
   - Extend edits[] schema: add optional `expected_count: z.number().int().nonnegative().default(1)`
   - In countOccurrences loop, compare `count` against `expected_count` (not hardcoded 1)
   - EUNIQUE error details now include `expected_count`
   - If `expected_count === 0`: skip the replace step (assertion-only), don't increment replacements_made
   - If `expected_count >= 2`: replace ALL occurrences. Switch from `buffer.replace(old, new)` (replaces first only) to `buffer.split(old).join(new)` for multi-occurrence atomic replace

2. **Tests:**
   - `tests/unit/editor/edit_file_expected_count.test.ts` — 8 cases: default 1 (back-compat), expected_count: 3 with exactly 3 occurrences (passes), expected_count: 3 with 2 occurrences (EUNIQUE, count=2, expected=3), expected_count: 0 assertion mode (no edit, no error), expected_count: 0 with 1+ occurrence (EUNIQUE, count=1, expected=0), expected_count: 5 with 5 occurrences replaced (replacements_made=5), mixed: edit 0 has expected_count 2, edit 1 has expected_count 1, edit 2 has expected_count 0 (delete-assertion)

3. **Commit:** `feat(editor): edit_file.expected_count — assertion-based occurrence counting`

### Phase 6d — Cross-cutting docs + tests + Inspector

8. **Spec amendments §U–§W** in `docs/design/mcp-winfs-spec.md`. Single commit: `docs(spec): §U–§W amendments for v0.6 features`.

9. **CHANGELOG `[0.6.0]` entry** matching v0.5.0's depth. Per-feature description, infrastructure additions, spec amendment refs, test count delta.

10. **README updates:**
    - Tools table: 29 → 31
    - Config reference: document `unrestrictedFilesystem` + `unrestrictedFilesystemConfirm`
    - Big RED section on unrestricted mode: when to use, when NOT, security implications
    - `write_chunk` non-atomicity caveat in tools table

11. **`docs/v0.6-acceptance.md`** following v0.5 acceptance template.

12. **Inspector smoke methodology `prompts/cc-prompt-v0.6-inspector-smoke.md`:**
    - Pre-flight: 31 tools visible, version 0.6.0, schema warnings 0, `serverMode: "strict"` in handshake
    - Happy-path: existing 29 probes + 2 new (write_chunk, edit_file with expected_count)
    - Red-team v0.6: unrestricted mode probe (start server with config flag, verify path outside allowedRoots accessible; restart in strict, verify EPERM_ROOT returns); write_chunk EOFFSET; write_chunk EENCODING utf8 boundary; edit_file expected_count assertion; edit_file expected_count multi-replace
    - **Fix all 5 methodology drifts** from v0.5 smoke per L5: read_json `data`, git_show hex sha, git_blame absolute path, run_python `{mode, script}`, read_section ranges

13. **Single full test sweep:** `npm test`. Target ≥ 280 tests (261 v0.5 + ~25 new). If red — fix-iterate, don't proceed to docs.

14. **Inspector smoke run.** Single session. All 31 tools probed. Both server modes exercised (strict default, plus separate restart with unrestricted+confirm).

15. **Tag v0.6.0 annotated.**

16. **Push origin main + v0.6.0.**

### Phase 6 hand-off points (chat Claude)

- **After Phase 6a #6 green** → before Phase 6b: sanity check unrestricted-mode invariant tests pass + audit log mode field populates correctly
- **After Phase 6abc #13 green** → before docs (#9–#12): test sweep ≥ 280, sanity check ratios per feature
- **After Phase 6 #14 green** → before tag (#15): Inspector clean, docs complete, acceptance.md verifies all 31 tools

These are the **mandatory** hand-off points. Everything else autonomous CC execution.

---

## Step 5 — Acceptance criteria

1. `npm run build` exit 0, zero TS diagnostics
2. `npm test` ≥ 280 passing
3. structured_content invariant covers `write_chunk` envelope (5 keys exactly)
4. `unrestricted_mode.test.ts` exists and passes (4+ cases)
5. `write_chunk_nonatomic.test.ts` exists and passes (atomic: false contract pinned)
6. `edit_file_expected_count.test.ts` exists and passes (8 cases)
7. Inspector smoke probes 31 tools + both server modes (strict + unrestricted)
8. Spec amendments §U–§W appended to spec
9. CHANGELOG entry matching v0.5 depth
10. README + acceptance.md updated
11. Tag v0.6.0 annotated, pushed
12. Branch `v0.6` merged to main only after v0.5.x review-wave patches settle

---

## Step 6 — Out of scope

❌ Streaming reads/writes for files > readMaxBytes (interpretation C — defer to v0.7+)
❌ Transactional rollback for write_chunk (would re-introduce atomic ceremony — defeats the purpose)
❌ POST/PUT body support for fetch_url (v0.5.x or v0.7)
❌ HTTP/2 / HTTP/3 support (v0.5.x or v0.7)
❌ MCPB packaging (v1.0)
❌ Comprehensive evals harness (v1.0)
❌ Production README rewrite (v1.0)

If v0.5.x review wave surfaces P1 findings on `write_chunk`-adjacent code (e.g., atomic_write.ts), apply those fixes on `main` and rebase v0.6 branch onto post-fix main. Don't ship v0.6 with known v0.5.x P1s outstanding.

---

## Готов?

Sequence:

1. Create branch `v0.6` off `main` (`git checkout -b v0.6`)
2. Phase 6a → commit → hand-off #1
3. Phase 6b → commit → (no hand-off, continue)
4. Phase 6c → commit → continue
5. Phase 6d docs commits
6. #13 full test sweep green → hand-off #2 (if not already)
7. #14 Inspector smoke green → hand-off #3
8. Tag + push → done

Wall-clock estimate: ~8-12 hours CC work for code, ~30-45 min Inspector, ~5 min tag/push.

Поехали.

# Claude Code Prompt — winfs v0.6.0 — Configurable Scope + Chunked I/O

> **Audience:** Claude Code working in `C:\Users\Expert\Desktop\AI\tools\winfs\` on branch `v0.6` (created off `main` HEAD `ba4ae7a` or later, tag `v0.5.0 → 2dc2a89` immutable on remote).
>
> **Scope:** v0.6.0 — two architectural features on top of v0.5.0's 29-tool surface. **Two new tools + one cross-cutting config option + one existing-tool extension.** No tool removal, no breaking changes to v0.5 surface.
>
> **Parallel to v0.5.x review wave:** if the v0.5.1+ external review wave is in flight (or queued), v0.6 work proceeds on feature branch `v0.6` to avoid merge conflicts with review-wave fix commits landing on `main`. Final v0.6.0 tag waits for v0.5.x patch waves to settle, then merges to `main`.

---

## Step 0 — Scope summary

Three additions:

1. **Feature A: Configurable filesystem scope.** Cross-cutting config option `unrestrictedFilesystem: bool` + magic-string confirm. Default = false (strict allowedRoots, current behavior). When enabled with magic string `"I-UNDERSTAND-THE-RISK"`, `checkAllowed` short-circuits — paths outside allowedRoots are accepted. All other security defenses (exec blocklist, SSRF, audit log, atomic writes) remain in force.

2. **Feature B: Chunked I/O — `write_chunk` tool.** New tool for byte-offset in-place file mutation. NOT atomic (in-place write). Companion to existing `read` (which already supports `offset` / `length` per spec §1.1). Enables surgical edits on huge files without loading them whole. Explicitly documented as non-atomic.

3. **Feature C: `edit_file.edits[].expected_count` extension.** Existing `edit_file` gains optional `expected_count: number` field per edit. Default 1 (current behavior). Allows assertions like "this string MUST appear exactly 3 times" or "MUST appear 0 times" (delete-if-present semantics). Atomic-preserving.

Net surface delta: **+1 tool (29 → 30)** + 1 schema field extension + 1 cross-cutting config.

---

## Step 1 — Hard invariants (v0.5 carry-forward + v0.6 additions)

All 27 hard invariants from v0.5 base prompt §1 carry forward. New invariants for v0.6:

**Invariant #28 — unrestricted mode requires explicit confirm.** `config.unrestrictedFilesystem: true` is rejected at startup unless `config.unrestrictedFilesystemConfirm: "I-UNDERSTAND-THE-RISK"`. Without the magic string, server fails startup with a `Config validation error`. This makes accidental enable structurally impossible.

**Invariant #29 — unrestricted mode banner.** When unrestricted, server prints a prominent 3-line warning to stderr at startup AND records `server_mode: "unrestricted"` as the first audit log entry. When strict (default), `server_mode: "strict"` is logged.

**Invariant #30 — mutation-tool audit entries include `mode` field.** Every audit entry for a mutation tool (write, append, mkdir, move, copy, edit_file, write_chunk, execute_command, run_python, run_pytest) includes a `mode: "strict" | "unrestricted"` field.

**Invariant #31 — `write_chunk` non-atomicity is explicit.** Return value includes `atomic: false`. Tool description leads with explicit non-atomicity warning. Use `write` (atomic) for whole-file replacement.

**Invariant #32 — `write_chunk` byte-offset bounds.** `offset <= file_size_before` strictly. `offset > file_size_before` → `EOFFSET` error. No sparse-file creation. Write may extend the file if `offset + content_length > file_size_before`.

**Invariant #33 — `write_chunk` UTF-8 boundary check.** If `encoding: "utf8"` (default) and `validate_byte_range: true` (default), the existing file bytes at `[offset, offset+len)` AND the new content boundaries must align with UTF-8 character boundaries. Misalignment → `EENCODING`.

**Invariant #34 — `edit_file.edits[].expected_count` enforces exact count, not minimum.** If specified, the number of occurrences of `old_str` must equal `expected_count` exactly. Default 1 preserves v0.5 semantics. `expected_count: 0` is valid (assertion-only, no replacement performed).

---

## Step 2 — Spec amendments

New amendments to append to `docs/design/mcp-winfs-spec.md` (chronological after §M–§T):

**§U — Configurable filesystem scope.** Document `config.unrestrictedFilesystem`, `config.unrestrictedFilesystemConfirm`, `server_mode`, `checkAllowed` short-circuit semantics, what stays in force vs bypassed (exec blocklist + SSRF + audit + atomic writes all unaffected), audit `mode` field, security guidance (dev sandboxes / agent VMs only, NEVER in production or multi-tenant).

**§V — `write_chunk` tool contract.** Input schema `{path, offset, content, encoding, validate_byte_range}`. Output `{path, offset, bytes_written, total_bytes_after, atomic: false}`. Behavior (open r+ → write at offset → close). Error codes (EPERM_ROOT unless unrestricted, ENOENT, EISDIR, EOFFSET, EENCODING, ETOOLARGE, ETIMEDOUT). Audit redaction (content first 256 chars, never full content).

**§W — `edit_file.expected_count` extension.** Optional field semantics, default 1 (back-compat), value 0 = assertion-only (no replacement, error if found), values 2+ = multi-occurrence atomic replace (all occurrences replaced, count must equal expected_count exactly). EUNIQUE error details extended with `expected_count`.

---

## Step 3 — Lessons learned from v0.5 ship cycle

**L1.** Always `npm run build` AFTER source edits, BEFORE Inspector restart. v0.5 hit a 4-amend cycle on the release commit because dist/ wasn't rebuilt after `config.ts` VERSION constant was updated.

**L2.** Version bumps live in TWO files: `package.json` "version" AND `src/core/config.ts` VERSION constant. Both must change. Add invariant test or pre-commit hook pinning equality.

**L3.** Spec amendments use chronological append. §J supersedes §4.5 but §4.5 prose stays in body. v0.6 amendments §U–§W follow this convention.

**L4.** `winfs:execute_command` silent-output bug (P2 v0.5 carryover): when CC orchestrates git ops via winfs's own execute_command, stdout/stderr return empty even on success. Commands EXECUTE correctly; verify state via filesystem inspection (`.git/refs/heads/main`, etc.).

**L5.** Inspector smoke methodology must match actual schemas. v0.5 smoke had 5 arg-shape drifts. v0.6 methodology must read actual `outputSchema` from source before writing probe arg shapes.

**L6.** Inspector pre-flight version check is the cheap gate. Verify server panel shows expected version FIRST before declaring acceptance.

**L7.** `find_command("git")` returned false in v0.5 — PATH sanitization may exclude git's directory. For git ops via winfs:execute_command, use absolute path `& "C:\Program Files\Git\cmd\git.exe"`.

---

## Step 4 — Phased delivery

### Phase 6a — Feature A: Configurable scope (2-3 hours CC)

1. **`src/core/config.ts`:**
   - Add `unrestrictedFilesystem: z.boolean().default(false)` to schema
   - Add `unrestrictedFilesystemConfirm: z.string().optional()` to schema
   - Post-parse validator: if `raw.unrestrictedFilesystem && raw.unrestrictedFilesystemConfirm !== "I-UNDERSTAND-THE-RISK"` → throw `"unrestrictedFilesystem requires unrestrictedFilesystemConfirm = 'I-UNDERSTAND-THE-RISK'"`
   - ResolvedConfig derived field: `serverMode: "strict" | "unrestricted"`

2. **`src/core/allowed_roots.ts` `checkAllowed`:**
   - At top of function: `if (config.serverMode === "unrestricted") { try { const real = await fs.realpath(path); return {ok: true, realPath: path.normalize(real)} } catch { return {ok: true, realPath: path.normalize(path.resolve(path))} } }`
   - All other code paths (strict mode) unchanged

3. **`src/index.ts` startup:**
   - After config loaded, if `serverMode === "unrestricted"`: print 3-line stderr warning banner
   - Pass `serverMode` to audit init

4. **`src/core/audit.ts`:**
   - First entry on startup: `{ts, event: "server_start", server_mode, version, pid}`
   - Mutation-tool audit entries get `mode: serverMode` field

5. **Server handshake metadata:**
   - `serverInfo.metadata.serverMode: <mode>` in MCP handshake response

6. **Tests:**
   - `tests/unit/config_unrestricted.test.ts` (5 cases): strict default, unrestricted+confirm OK, unrestricted without confirm throws, unrestricted with wrong confirm throws, confirm without unrestricted is no-op
   - `tests/invariants/unrestricted_mode.test.ts` (4 cases): strict rejects out-of-roots, unrestricted accepts out-of-roots, audit mode field per entry, server_start entry mode field

7. **Commit:** `feat(core): configurable filesystem scope (unrestrictedFilesystem + confirm)`

### Phase 6b — Feature B: `write_chunk` tool (3-4 hours CC)

1. **Create `src/tools/file/write_chunk.ts`:**
   - InputShape: `{path: AbsolutePath, offset: z.number().int().nonnegative(), content: z.string().max(config.readMaxBytes), encoding: z.enum(["utf8","base64"]).default("utf8"), validate_byte_range: z.boolean().default(true)}`
   - OutputShape: `{path, offset, bytes_written, total_bytes_after, atomic: z.literal(false)}`
   - Impl flow:
     a. `checkAllowed(path, config)` → realPath
     b. `fs.stat(realPath)` → check `isDirectory` (EISDIR) + capture `size`
     c. Bounds check: `offset <= size` else `EOFFSET`
     d. If `encoding === "utf8"`: decode content via `Buffer.from(content, "utf8")`. If `validate_byte_range`: read existing `[offset, offset+contentBytes.length)` from file, check UTF-8 boundaries at both ends. Misalign → `EENCODING`
     e. If `encoding === "base64"`: `Buffer.from(content, "base64")`. Bypass UTF-8 boundary check
     f. Cap check: `offset + contentBytes.length <= config.readMaxBytes` else `ETOOLARGE`
     g. `fs.open(realPath, "r+")` → `fileHandle.write(buf, 0, contentBytes.length, offset)` → `fileHandle.close()`
     h. `fs.stat` again → `total_bytes_after`
   - Audit extras via WeakMap: `{path: realPath, offset, content_length: contentBytes.length, content_prefix: content.slice(0,256), mode: serverMode}`

2. **Register in `src/server.ts`:**
   - Import `registerWriteChunkTool`
   - Call after existing tool registrations
   - Bump `TOOL_COUNT_HARDCODED` (if such constant exists, else hardcode in tests)

3. **Tests:**
   - `tests/unit/file/write_chunk.test.ts` (12 cases): happy in-place utf8 replace, happy base64 encoding, extend file (offset+len > size), offset 0 replace from start, offset == size append, offset > size → EOFFSET, EPERM_ROOT (strict mode out-of-roots), ENOENT (file must exist), EISDIR, EENCODING (invalid utf8 content), EENCODING (utf8 boundary misalign), audit extras populated correctly
   - `tests/invariants/write_chunk_nonatomic.test.ts`: pin `atomic: false` contract, verify no `.tmp.*` file created during operation (readdir before/after), verify file mtime advances exactly once (single write, not temp+rename)

4. **Commit:** `feat(file): write_chunk — byte-offset surgical writes for large files`

### Phase 6c — Feature C: `edit_file.expected_count` (1-2 hours CC)

1. **`src/tools/editor/edit_file.ts`:**
   - Extend edits[] schema: `expected_count: z.number().int().nonnegative().default(1)`
   - In edit loop: compute `occ = countOccurrences(buffer, e.old_str)`. Compare against `e.expected_count` (not hardcoded 1).
   - If `occ !== e.expected_count` → `EUNIQUE` with `details: {edit_index: i, occurrences_found: occ, expected_count: e.expected_count, path: realPath}`
   - If `e.expected_count === 0`: skip the `buffer.replace` step entirely (assertion only — verify absence, don't modify). Still counts toward edits array iteration.
   - If `e.expected_count >= 2`: replace ALL occurrences atomically. Switch from `buffer.replace(old, new)` (replaces first only) to `buffer.split(old).join(new)` (replaces all). `replacements_made` aggregate reflects sum across all edits.
   - Return value `replacements_made: edits.reduce((sum, e) => sum + e.expected_count, 0)` (excluding expected_count=0 edits which contribute 0)

2. **Tests:**
   - `tests/unit/editor/edit_file_expected_count.test.ts` (8 cases): default 1 back-compat, expected_count: 3 with exactly 3 occurrences (passes, replacements_made=3), expected_count: 3 with 2 occurrences (EUNIQUE found=2 expected=3), expected_count: 0 assertion mode passes (no edit), expected_count: 0 with 1+ occurrence (EUNIQUE found=1 expected=0), expected_count: 5 with 5 occurrences replaced (replacements_made=5, all distinct sites), mixed batch: edit[0]=2, edit[1]=1 (default), edit[2]=0 (assertion-only) — all succeed if counts match, file modified appropriately

3. **Commit:** `feat(editor): edit_file.expected_count — assertion-based occurrence counting`

### Phase 6d — Cross-cutting docs + tests + Inspector

8. **Spec amendments §U–§W** in `docs/design/mcp-winfs-spec.md`. Single commit: `docs(spec): §U–§W amendments for v0.6 features`

9. **CHANGELOG.md `[0.6.0]` entry** matching v0.5.0 depth (per-feature description, infrastructure additions, spec amendment refs, test count delta, known-issues callout if any)

10. **README updates:**
    - Tools table extended (29 → 30 = add write_chunk row)
    - Config reference section documents `unrestrictedFilesystem` + `unrestrictedFilesystemConfirm`
    - Big RED section on unrestricted mode (when to use, when NOT, security implications)
    - `write_chunk` non-atomicity caveat in tools table

11. **`docs/v0.6-acceptance.md`** following v0.5 template. Cover: scope, build, test counts, structured_content for new tools, per-tool unit tests, invariant tests, Inspector smoke summary, hard invariants reaffirmed §U–§W, known issues (if any), open questions for v0.7/v1.0

12. **`prompts/cc-prompt-v0.6-inspector-smoke.md`** with methodology drift fixes from v0.5:
    - Pre-flight: 30 tools visible, version 0.6.0, schema warnings 0, `serverMode: "strict"` in handshake
    - Happy-path: 28 existing v0.5 probes (run_python EPYTHONNOTFOUND if python missing — accept either) + 2 new (`write_chunk` happy + `edit_file` with expected_count=2)
    - Red-team v0.6 (5): unrestricted mode (restart server with config flag, verify out-of-roots accessible; revert to strict, verify EPERM_ROOT); write_chunk EOFFSET; write_chunk EENCODING boundary; edit_file expected_count=0 assertion passes; edit_file expected_count=3 with 2 occurrences → EUNIQUE
    - **Fix 5 v0.5 methodology drifts:** read_json field is `data` not `value`; git_show requires hex sha (use actual HEAD sha from probe #20); git_blame requires absolute path (use full path); run_python args shape `{mode, script}` not `{args:[]}`; read_section uses `line_range`/`byte_range`, not marker fields

13. **Full test sweep:** `npm run build && npm test`. Target ≥ 280 tests (261 v0.5 + ~22 new for Phase 6abc + invariant additions). If red — fix-iterate, don't proceed to docs. **Iterate until green.**

14. **Inspector smoke run.** Single session, all 30 tools probed. Both server modes exercised (strict default in main run, then separate Inspector restart with `configs/local.json` patched to `unrestrictedFilesystem: true` + confirm, verify out-of-roots access).

15. **Tag v0.6.0 annotated.**

16. **Push origin main + v0.6.0.** (After branch v0.6 merged to main — see hand-off #3.)

### Hand-off points (chat Claude)

Three mandatory hand-offs:

- **After Phase 6a #6 green** → before Phase 6b: sanity check unrestricted-mode invariant tests pass + audit log `mode` field populates correctly. Show test output + 1 audit log entry sample.
- **After Phase 6abc #13 green** → before docs (#9–#12): test sweep ≥ 280, sanity check ratios per feature. Show test count + per-suite breakdown.
- **After Phase 6 #14 green** → before tag (#15): Inspector clean across both modes, docs complete, acceptance.md verified. Show §7 status block from smoke + acceptance.md commit SHA.

These are the **mandatory** review gates. Everything else autonomous CC execution.

---

## Step 5 — Acceptance criteria

1. `npm run build` exit 0, zero TS diagnostics
2. `npm test` ≥ 280 passing
3. structured_content invariant covers `write_chunk` envelope (5 keys exactly)
4. `unrestricted_mode.test.ts` exists and passes (4+ cases)
5. `write_chunk_nonatomic.test.ts` exists and passes (atomic: false contract pinned)
6. `edit_file_expected_count.test.ts` exists and passes (8 cases)
7. Inspector smoke probes 30 tools + both server modes (strict + unrestricted)
8. Spec amendments §U–§W appended to spec
9. CHANGELOG entry matching v0.5 depth
10. README + acceptance.md updated
11. Tag v0.6.0 annotated, pushed
12. Branch `v0.6` merged to main only after v0.5.x review-wave patches settle

---

## Step 6 — Out of scope

❌ Streaming reads/writes for files > readMaxBytes (interpretation C — defer to v0.7+ if real-use surfaces)
❌ Transactional rollback for write_chunk (re-introduces atomic ceremony, defeats purpose)
❌ POST/PUT body for fetch_url (v0.7)
❌ HTTP/2 / HTTP/3 (v0.7)
❌ MCPB packaging (v1.0)
❌ Comprehensive evals harness (v1.0)
❌ Production README rewrite (v1.0)

If v0.5.x review wave surfaces P1 findings on `write_chunk`-adjacent code (e.g., atomic_write.ts), apply those fixes on `main` and rebase v0.6 branch onto post-fix main. Don't ship v0.6 with known v0.5.x P1s outstanding.

---

## Готов?

Sequence:

1. `git checkout -b v0.6` off `main`
2. Phase 6a → commit → **hand-off #1 to chat Claude**
3. Phase 6b → commit → continue
4. Phase 6c → commit → continue
5. Phase 6d steps 8-12 → docs commits
6. #13 full test sweep → **hand-off #2 to chat Claude**
7. #14 Inspector smoke → **hand-off #3 to chat Claude**
8. Tag + push → done

Wall-clock: ~8-12 hours CC for code + ~30-45 min Inspector + ~5 min tag/push.

Поехали.

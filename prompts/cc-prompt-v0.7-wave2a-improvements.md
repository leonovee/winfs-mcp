# CC prompt — v0.7 wave 2a: existing-tool improvements + docs polish

## Origin

v0.7 wave 1 shipped clean: ssh_exec + list_path_dirs + write_json at `main @ d5210a2`, 325 tests passing. This wave 2a is a compact set of improvements to existing tools plus two documentation hangovers. Process control suite (start_process / interact / list_process / kill_process) is held for wave 2b — it's a separate domain and merits its own pass.

Four items in 2a:

1. **`edit_file` diff output** — currently returns `{ replacements_made, occurrences_found, ... }`. Add an optional `diff` field showing what changed. From consumer feedback (2026-05-18 ecom): "the diff feature looks nice for agent self-verification." Format: unified diff with context lines (standard `diff -u` style) — char-level is too noisy for typical edits. Toggled by an opt-in input flag to avoid blowing up response size on large files.

2. **`grep` pagination** — currently caps results at a fixed limit. Make pagination explicit so agents can walk large match sets without recomputing the search.

3. **`execute_command` PowerShell-pipeline wrap** — when child stderr contains the PowerShell document-in-pipeline classification error ("Cannot run a document in the middle of a pipeline"), append a hint to help agents understand what failed and what to try. From consumer feedback friction: the error is technically accurate but cryptic.

4. **Docs polish** — two paragraphs that should have landed earlier:
   - `ETIMEDOUT` response shape example in spec, for `execute_command`, `ssh_exec`, and `run_python` (all the timeout-capable tools).
   - `sshExePath` override note in README — wave 1 wired the config field but couldn't surface a commented example in `configs/local.json` (gitignored). Document override syntax explicitly so operators on non-standard ssh installations (Git-bundled at `C:\Program Files\Git\usr\bin\ssh.exe`, MSYS2, etc.) know what to put where.

## Phase A — `edit_file` unified diff

### A1. Read current edit_file implementation and tests

```
cat src/tools/file/edit_file.ts
cat tests/file/edit_file.test.ts
```

(Adjust if paths differ.) Report current input shape, response shape, and where in the implementation we'd splice diff generation.

### A2. Implement diff output

- Add input field: `with_diff?: boolean` (default `false`).
- When `with_diff: true`, generate a unified diff (standard `diff -u` style, 3 lines of context) between the pre-edit content and post-edit content. Use any existing diff library already in package.json; only add a new dep if nothing suitable exists, and prefer `diff` (the common npm package, MIT) if a dep is needed.
- Output field: `diff?: string` — present only when `with_diff: true` and at least one replacement happened. On dry_run or zero replacements, diff is empty string, not present, or absent — choose what's cleanest given existing conventions.
- Bound the diff size: cap at 16 KB. If exceeded, truncate with a trailing `... [N more bytes truncated]\n` marker and add `truncated_diff: true` to the response envelope.
- Audit entry: do not include the diff in audit (we already truncate write payloads; diff would just duplicate).

### A3. Tests

- `with_diff: false` (default): existing tests untouched, no `diff` field in response.
- `with_diff: true`, single replacement: `diff` is a parseable unified diff with the expected hunk.
- `with_diff: true`, multiple replacements in same file: single combined diff.
- `with_diff: true`, dry_run: diff still computed (because dry_run shows what *would* change).
- Truncation: forced large file edit produces `truncated_diff: true` and a marker line.

## Phase B — `grep` pagination

### B1. Read current grep implementation and tests

```
cat src/tools/search/grep.ts
cat tests/search/grep.test.ts
```

Report current input shape, response shape, current cap behavior, and how results are materialized (streaming vs collected).

### B2. Implement pagination

- Add input fields: `offset?: number` (default 0), `limit?: number` (default = current cap, e.g. 100). Both must be non-negative integers; reject negatives with the existing input-validation error code.
- Add output fields: `total_matches: number` (count across the whole search, not just current page), `next_offset?: number` (present when more results exist beyond current page).
- Preserve current behavior at defaults: `offset=0, limit=<current cap>` returns the same first-page envelope as today (modulo the two new output fields), so existing callers don't break.
- For very large match sets, do not load everything into memory just to count. Either stream and count, or cap `total_matches` at some reasonable ceiling (e.g. 10000) with a flag `total_matches_capped: true`. Match the project's existing posture on bounded responses.

### B3. Tests

- Default call (no offset/limit) returns same matches as today plus `total_matches` field.
- Explicit `offset=0, limit=10` returns first 10, `next_offset=10` if more exist.
- `offset` past the end returns empty matches, `next_offset` absent.
- `total_matches` is correct across pages (sum of all page sizes ≤ `total_matches`).
- Cap behavior (if applicable): `total_matches_capped: true` set when ceiling hit.
- Existing grep tests still pass without modification.

## Phase C — `execute_command` PowerShell-pipeline wrap

### C1. Read execute_command and exec_safety

```
cat src/tools/system/execute_command.ts
cat src/core/exec_safety.ts
```

Locate the stderr-capture path. Confirm where post-process error message massaging would land cleanly.

### C2. Implement the wrap

- After child process exits, inspect stderr. If it matches (case-insensitive) the PowerShell document-in-pipeline error — practical match: stderr contains the literal substring `Cannot run a document in the middle of a pipeline` — append a hint paragraph to the response.
- Mechanism: prefer a NEW response envelope field over mutating stderr. Suggested field: `hints: string[]` — array of short diagnostic strings that the server attached. For this case, push:
  ```
  PowerShell refused to execute the target binary as a process. This typically means the binary is missing from PATHEXT or has an unusual file association registered. Try invoking it via a different shell (cmd) or with the full path, or use a passthrough tool if available.
  ```
- Don't replace or modify the actual stderr — keep raw output verbatim.
- Audit: hints array NOT included in audit (avoid noise). Audit keeps existing fields.
- Architecture: keep the matcher pattern in a small registry so future hints can be added the same way. One entry today, room for more.

### C3. Tests

- Stderr containing the document-in-pipeline marker → response has `hints` array with the expected hint.
- Stderr without the marker → response `hints` either absent or empty array (pick one and be consistent).
- Stderr containing the marker as part of a larger output → hint still attached (substring match).
- Existing execute_command tests unaffected.

## Phase D — docs polish

### D1. ETIMEDOUT response example

Edit `docs/design/mcp-winfs-spec.md`. Find the section that defines error codes / response shapes. Add a worked JSON example for ETIMEDOUT under each of: `execute_command`, `ssh_exec`, `run_python`. Each example shows the exact envelope an agent receives — `error.code`, `error.message`, `timed_out: true`, `duration_ms` near the timeout value, captured `stdout_prefix` / `stderr_prefix` if applicable.

Keep it short — 3-5 lines per example, just enough that an agent reading the spec can predict the shape.

### D2. sshExePath override note in README

Edit `README.md`. In the configuration section (or under the existing wave-1 ssh_exec entry — wherever flows naturally), add a paragraph:

> By default `ssh_exec` uses `C:\Windows\System32\OpenSSH\ssh.exe`. To override (for example to use Git-bundled OpenSSH at `C:\Program Files\Git\usr\bin\ssh.exe`, or MSYS2 at `C:\msys64\usr\bin\ssh.exe`), add `"sshExePath": "<full path>"` to your local config file. Note that `configs/local.json` is gitignored; create or edit it as needed for your machine.

Adjust path to whatever local-config file the project actually uses (CC reads `configs/` to confirm).

### D3. CHANGELOG

Under `[Unreleased]`, three new `Added` entries (or under `Changed` for edit_file/grep — match existing conventions):

- `edit_file`: optional `with_diff` flag and `diff` / `truncated_diff` output fields.
- `grep`: pagination via `offset` / `limit` input and `total_matches` / `next_offset` output.
- `execute_command`: `hints` field surfacing PowerShell document-in-pipeline diagnostics.

Plus a `Docs` entry for the ETIMEDOUT examples and sshExePath override note.

## Commit decomposition

Suggested (CC may fold/split with judgment, no force-pushes):

```
feat(file): edit_file unified-diff output (with_diff flag)
feat(search): grep pagination (offset/limit + total_matches)
feat(system): execute_command hints for PowerShell document-in-pipeline failures
docs(spec): ETIMEDOUT response examples + sshExePath override
docs: CHANGELOG entries for wave 2a
```

Push to origin/main at end.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green at every commit boundary. Baseline: 325 passing. Expected after wave: 325 + new tests.
- No version bump. `[Unreleased]` only in CHANGELOG.
- For `edit_file` diff: prefer using existing dep if any matches. Only add a new dep if necessary, and only the well-known `diff` package or equivalent. Report what was chosen.
- For `grep` pagination: do NOT break backward compatibility — defaults must reproduce today's first-page behavior.
- For `execute_command` hints: do NOT mutate stderr. Add new field. Keep audit shape stable (don't add hints to audit).
- For PowerShell pattern matching: case-insensitive substring match on the literal phrase. No regex creativity — we want a fast, predictable, easily-extended registry.

## Reporting

End of wave (single block):

```
wave 2a done: edit_file @ <sha>, grep @ <sha>, execute_command @ <sha>, docs @ <sha>, changelog @ <sha>, main @ <sha>
tests: <N> passing (was 325)
edit_file diff: <existing-dep | new-dep <name>@<version>>
grep total_matches: <uncapped | capped at <N>>
hints registry size: <N> (this wave adds 1)
```

On any failure: stop at the failing step, report step ID, command, full stdout/stderr. Each earlier-committed phase is already pushed and safe.

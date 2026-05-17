# External code review — winfs `edit_file.ts` — 2026-05-17

## Context

winfs is an MCP server with hard invariants: realpath→allowed_roots check, bounded timeouts (default 10s, max 60s), atomic writes (temp+fsync+rename), structured errors (never throw), UTF-8 without BOM, audit log with content redaction. See `_review_audit_tail.prompt.md` for full spec context.

`edit_file.ts` is the **marquee mutation tool** of v0.4 — it's the second user-controlled write path in the entire codebase (after `write`/`append`). It implements a **multi-edit transaction** where 1..50 `{old_str, new_str}` replacements are applied sequentially to an in-memory buffer, then committed in a single atomic write (or returned as a diff if `dry_run: true`).

Critical invariants from spec §I (v0.4 amendment):
- Each `old_str` MUST appear exactly once in the current buffer. 0 or 2+ → `EUNIQUE`.
- Edits apply sequentially: edit N is checked AFTER edits 0..N-1 have been applied.
- `dry_run: true` MUST NOT touch disk — no temp file, no rename.
- `diff` is always returned (both dry_run and live), so callers always see what changed.
- `old_str` / `new_str` content is NEVER persisted in audit (`bytes_before`/`bytes_after`/`edits_count`/`dry_run` only).

`atomicWriteFile` (in `src/core/atomic_write.ts`) is trusted — already audited separately. `runTool` wrapper is trusted — already audited (pure-payload structuredContent, audit redaction at args level, bounded timeout via outer wall-clock).

## Your task

Review `src/tools/editor/edit_file.ts` for transactional safety, sequential-edit correctness, dry_run boundary purity, audit-redaction completeness, TOCTOU windows, and AbortSignal threading. This is the highest-trust mutation tool in winfs — the bar is strict.

## Targeted questions

**Q1 (audit redaction completeness — does the diff leak `old_str`/`new_str`?).**

The spec says (§I, audit shape): `args_summary` includes `{path, edits_count, dry_run, bytes_before, bytes_after}` — **never** raw `old_str`/`new_str`. But the tool returns `diff: string` in its response, and `createPatch(realPath, original, buffer, ...)` produces a unified diff that **literally contains** the changed text — i.e., `old_str` removed lines (`-`) and `new_str` added lines (`+`).

If `runTool` audits the **response/result** in addition to args (e.g., for `result.value` shape verification or structuredContent logging), then `diff` lands in the audit log → spec violation.

Look at the audit pipeline: `runTool` → audit writer. Does the result of a successful edit_file call (the `EditFileResult` object containing `diff`) get serialized into the audit JSONL? If so, **`old_str`/`new_str` content leaks into the audit log via `diff`, defeating the redaction intent.**

How serious? What's the cleanest fix that preserves the response contract (caller still gets `diff`) while keeping audit clean? Options:
- Redact `diff` to `<diff: N lines, M bytes>` before audit writer sees the result
- Drop `diff` from audit but keep it in MCP response
- Apply `runTool`-level result redaction config per-tool

**Q2 (sequential edit error semantics — should ENOMATCH and EUNIQUE be distinct?).**

Look at lines ~117–135 in `editFileImpl`:

```typescript
const occ = countOccurrences(buffer, e.old_str);
if (occ !== 1) {
  return buildError(
    "EUNIQUE",
    occ === 0
      ? `edit[${i}].old_str not found in current buffer`
      : `edit[${i}].old_str appears ${occ} times; must be exactly 1`,
    { details: { edit_index: i, occurrences: occ, path: realPath }, hint: ... },
  );
}
```

The code conflates **0 occurrences** and **2+ occurrences** into a single `EUNIQUE` error code, distinguishing only by message text and `details.occurrences`. The spec §5 error catalog also defines a separate `ENOMATCH` code (used by `read_section` start_marker miss, and historically intended for edit_file 0-occurrence case).

Two questions:
- (a) Is conflation OK as a design decision (single error code, distinguish via `details.occurrences === 0` programmatically)? Or should 0-occurrence return `ENOMATCH` and 2+ return `EUNIQUE`?
- (b) The hint for `occ === 0` says "An earlier edit may have removed the target. Edits apply sequentially to the in-memory buffer." This is correct for **late edits** (edit[2] when edit[0] removed target) but misleading for **edit[0]** when the user's first old_str simply doesn't exist in the file at all. Should the hint be conditional on `edit_index > 0`?

**Q3 (AbortSignal not threaded into editFileImpl I/O).**

`editFileImpl` performs three I/O operations on the disk:
- `fs.stat(realPath)` (line ~85)
- `fs.readFile(realPath)` (line ~99)
- `atomicWriteFile(realPath, buffer)` (line ~154)

**None of them takes an `AbortSignal`**. The `runTool` wrapper sets an outer wall-clock deadline, but inside `editFileImpl`, a slow disk (e.g., roaming `%LOCALAPPDATA%` via OneDrive sync, or a network share) causes a synchronous hang until the wall-clock timer fires from the outside. This is exactly the pattern that Kimi flagged as P2.2 in the v0.3.2 audit_tail review (resolved by adding `signal` to all I/O calls).

How serious? Should `editFileImpl` accept a `signal: AbortSignal` parameter from `runTool` and thread it into `fs.stat({signal})`, `fs.readFile({signal})`, and `atomicWriteFile(realPath, buffer, {signal})`? Note `atomicWriteFile` doesn't currently accept signal — that's a precondition fix.

Cleanest sequencing: fix `atomicWriteFile` to accept signal first (in core), then thread through here.

**Q4 (TOCTOU between checkAllowed, stat, readFile, and atomicWriteFile).**

`checkAllowed` returns a canonicalised `realPath`. Then `editFileImpl` does:

1. `fs.stat(realPath)` — to check isDirectory + size
2. `fs.readFile(realPath)` — to load buffer
3. `atomicWriteFile(realPath, buffer)` — temp + fsync + rename

All four steps use **path-based** operations. Between them, an attacker (or just a concurrent process) can:
- Swap `realPath` to a symlink pointing outside `allowedRoots` (the `checkAllowed` realpath check is stale by step 2)
- Replace the regular file with a directory between stat and readFile (causes EISDIR mid-call)
- Truncate the file between stat and readFile (size check passes but readFile gets short content)
- Replace the file with a symlink between readFile and atomicWriteFile (rename target now points outside `allowedRoots`)

Compare to the v0.3.2 audit_tail Kimi P1.2 fix, which moved to **fd-bound operations**: `fs.open(resolvedPath)` → `fileHandle.stat()` → reads via the bound `fileHandle`. Once the fd is open, the inode is locked to that descriptor; subsequent path swaps don't affect the in-flight read.

For edit_file, the inside-allowedRoots scope makes the **attack surface smaller** than audit_tail (which was privileged-read on a path OUTSIDE allowedRoots), but it doesn't eliminate the race. Should edit_file adopt the same fd-bound pattern? Or is path-based acceptable because `atomicWriteFile`'s rename is atomic enough?

If fd-bound is the answer: how do you preserve the atomic-rename semantics? `atomicWriteFile` writes to `<path>.tmp.<hash>` then renames to `<path>`. A read-fd doesn't conflict with that — but the swap between read and rename still exists.

**Q5 (WeakMap audit-extras anti-pattern).**

Look at lines ~65–73 + 174–178:

```typescript
const auditByResult = new WeakMap<object, EditFileAuditExtras>();

export function getEditFileAuditExtras(value: EditFileResult): EditFileAuditExtras | undefined {
  return auditByResult.get(value);
}

// later, inside editFileImpl:
const value: EditFileResult = { path, replacements_made, atomic, dry_run, diff };
auditByResult.set(value, { bytes_before: stat.size, bytes_after: afterBytes });
return ok(value);
```

This module-level `WeakMap` is used to smuggle `{bytes_before, bytes_after}` from `editFileImpl` (which can't return them as part of the public output schema) to the audit wrapper in `registerEditFileTool` (which reads them via `getEditFileAuditExtras(result.value)`). The mechanism works, but it's a non-obvious pattern.

Two questions:
- (a) Is this a robustness concern? When could the WeakMap entry be missing or stale? (e.g., if `runTool` constructs a different result object somewhere along the way, the WeakMap key won't match.)
- (b) Is there a cleaner alternative — e.g., extending the `Result<T>` envelope with an optional `auditExtras` field that bypasses the public schema, or making `editFileImpl` return both the public value and the audit extras as a tuple? What's the right surface change?

Not a security bug — but if this pattern proliferates to other v0.5+ mutation tools, the codebase gets harder to reason about.

## Output format

P1/P2/P3 tiers as in audit_tail and grep prompts. Title + line numbers + reproduction + fix per finding. Explicit "Pn: none" if a tier is clear.

## File content

```typescript
import { promises as fs } from "node:fs";
import { z } from "zod";
import { createPatch } from "diff";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { tryDecodeUtf8Strict, looksBinary } from "../../core/utf8.js";
import { atomicWriteFile } from "../../core/atomic_write.js";
import { AbsolutePath } from "../../schemas/common.js";

const MAX_EDITS = 50;
const DEFAULT_CONTEXT = 3;

const InputShape = {
  path: AbsolutePath,
  edits: z
    .array(
      z
        .object({
          old_str: z.string().min(1, "old_str must be non-empty"),
          new_str: z.string(),
        })
        .strict(),
    )
    .min(1, "at least one edit required")
    .max(MAX_EDITS, `at most ${MAX_EDITS} edits per call`),
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, validate + compute diff but do not write to disk."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  path: z.string(),
  replacements_made: z.number().int().nonnegative(),
  atomic: z.boolean(),
  dry_run: z.boolean(),
  diff: z.string(),
} as const;

interface EditFileResult extends Record<string, unknown> {
  path: string;
  replacements_made: number;
  atomic: boolean;
  dry_run: boolean;
  diff: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

interface EditFileAuditExtras {
  bytes_before: number;
  bytes_after: number;
}

const auditByResult = new WeakMap<object, EditFileAuditExtras>();

export function getEditFileAuditExtras(value: EditFileResult): EditFileAuditExtras | undefined {
  return auditByResult.get(value);
}

export async function editFileImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<EditFileResult>> {
  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }
  if (stat.isDirectory()) {
    return buildError("EISDIR", "Expected a file, got a directory", {
      details: { path: realPath },
    });
  }
  if (stat.size > config.readMaxBytes) {
    return buildError("ETOOLARGE", "file exceeds readMaxBytes", {
      details: { path: realPath, size: stat.size, max_bytes: config.readMaxBytes },
    });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath);
  } catch (err) {
    return fromNodeError(err, "read failed");
  }
  if (looksBinary(buf)) {
    return buildError("EENCODING", "file appears to be binary", {
      details: { path: realPath },
    });
  }
  const original = tryDecodeUtf8Strict(buf);
  if (original === undefined) {
    return buildError("EENCODING", "file is not valid UTF-8", {
      details: { path: realPath },
    });
  }

  let buffer = original;
  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i]!;
    const occ = countOccurrences(buffer, e.old_str);
    if (occ !== 1) {
      return buildError(
        "EUNIQUE",
        occ === 0
          ? `edit[${i}].old_str not found in current buffer`
          : `edit[${i}].old_str appears ${occ} times; must be exactly 1`,
        {
          details: { edit_index: i, occurrences: occ, path: realPath },
          hint:
            occ === 0
              ? "An earlier edit may have removed the target. Edits apply sequentially to the in-memory buffer."
              : "Provide more surrounding context in old_str to make it unique.",
        },
      );
    }
    buffer = buffer.replace(e.old_str, e.new_str);
  }

  const afterBytes = Buffer.byteLength(buffer, "utf8");
  if (afterBytes > config.readMaxBytes) {
    return buildError("ETOOLARGE", "post-edit content exceeds readMaxBytes", {
      details: { path: realPath, bytes_after: afterBytes, max_bytes: config.readMaxBytes },
    });
  }

  const diff = createPatch(
    realPath,
    original,
    buffer,
    "before",
    "after",
    { context: DEFAULT_CONTEXT },
  );

  if (!args.dry_run) {
    try {
      await atomicWriteFile(realPath, buffer);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EBUSY" || e?.code === "EACCES" || e?.code === "EPERM") {
        return buildError("EBUSY", "destination is locked or not writable", {
          details: { path: realPath, errno: e.code },
        });
      }
      return fromNodeError(err, "atomic write failed");
    }
  }

  const value: EditFileResult = {
    path: realPath,
    replacements_made: args.edits.length,
    atomic: true,
    dry_run: args.dry_run,
    diff,
  };
  auditByResult.set(value, {
    bytes_before: stat.size,
    bytes_after: afterBytes,
  });
  return ok(value);
}

// registerEditFileTool below — registration shape; the relevant audit-extras
// wiring is shown verbatim in Q5.
```

## Known context

- `checkAllowed` returns `{realPath}` after `fs.realpath` canonicalisation; trusted.
- `atomicWriteFile` writes to `<path>.tmp.<random>` then renames to `<path>` via `fs.rename`. Trusted; signal threading is the open question in Q3.
- `runTool` wrapper applies wall-clock timeout via `withTimeout`, audits **args** through the `auditExtras` callback (which reads from the `WeakMap` per Q5), and serializes the result as `structuredContent`. Whether it audits **result** is the crux of Q1.
- `tryDecodeUtf8Strict` returns `undefined` on invalid UTF-8 (no replacement chars); strips BOM if present at start of buffer. Trusted.
- Config defaults: `readMaxBytes = 10 * 1024 * 1024` (10 MB).
- Spec §I (v0.4 amendment) is the authoritative source for edit_file semantics. Spec §5 error catalog has `EUNIQUE`, `ENOMATCH`, `EBUSY` as separate codes (relevant for Q2).
- v0.3.2 audit_tail Kimi P1.2 fix is the precedent for fd-bound TOCTOU mitigation (relevant for Q4).
- v0.3.2 audit_tail Kimi P2.2 fix is the precedent for AbortSignal threading through I/O (relevant for Q3).

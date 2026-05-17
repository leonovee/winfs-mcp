# External code review — winfs `grep.ts` — 2026-05-16

## Context

winfs is an MCP server with hard invariants: realpath→allowed_roots check, bounded timeouts (default 10s, max 60s), atomic writes, structured errors (never throw). See `_review_audit_tail.prompt.md` for full spec context.

`grep.ts` is the most complex tool in winfs. It implements a **two-level deadline scheme**: an inner deadline owned by `grep` itself (returns partial results with `truncated: true, reason: "timeout"` on expiry) and an outer wrapper deadline as fallback. Inner is set 2 seconds shorter than outer so it always fires first.

## Your task

Review `src/tools/search/grep.ts` for timing bugs, race conditions, resource exhaustion vectors, and correctness gaps. This is the most performance-sensitive tool in winfs.

## Targeted questions

**Q1 (deadline race at max).** Look at:
```typescript
const outerDeadline = Math.min(innerDeadline + OUTER_TIMEOUT_BUFFER_MS, config.maxTimeoutMs);
```

When `innerDeadline === config.maxTimeoutMs`, this becomes `outerDeadline = Math.min(max + 2000, max) = max`. Both timers race to fire at the same wall-clock instant. If the wrapper's outer timer wins, user gets `ETIMEDOUT` error instead of partial-result `truncated: true`. Half-non-determinism.

How serious is this? Cleanest fix that preserves all invariants (default behavior unchanged, max not exceeded)?

**Q2 (regex DoS).** Pattern is `new RegExp(args.pattern, flags)` — user input. Catastrophic backtracking patterns like `(a+)+b` on long strings of `a` can lock V8 for seconds. The `if (signal.aborted) break;` check is BETWEEN lines, but a single line's regex evaluation runs to completion regardless of the timeout.

Can a malicious user cause grep to hang for minutes despite the "bounded execution" invariant? What's a defense-in-depth mitigation (regex complexity static analysis? string-length pre-check? V8 flags?)? Note that pure regex DoS protection is hard in JS without external libraries.

**Q3 (silent errors).** In `searchFile`:
```typescript
try {
  buf = await fs.readFile(filePath);
} catch {
  return [];
}
if (looksBinary(buf)) return [];
const text = tryDecodeUtf8Strict(buf);
if (text === undefined) return [];
```

Files that match the glob but can't be read (permission denied, file locked, EBUSY), are binary, or fail UTF-8 decode — all silently dropped. User sees no indication their results are partial.

Is this acceptable? What's a clean schema addition (`files_unreadable: number`, `files_skipped_binary: number`, etc.) that surfaces signal without breaking existing consumers? Should some categories be errors (EPERM) vs counters (binary)?

**Q4 (walk trust).** `grep` does a single `checkAllowed(compiled.base)` at the top, then trusts `walkFiles(baseReal, config, callback)` to:
- realpath-check each entry encountered
- skip entries that resolve outside allowedRoots
- propagate the abort signal

You can't see `walk.ts`. What unit test or integration test would prove `walkFiles` is doing its job? What kind of bug would make this fail silently (i.e., walker reads files outside allowed_roots without error)? Suggest test cases for `tests/invariants/`.

## Output format

P1/P2/P3 tiers as in audit_tail prompt. Title + line numbers + reproduction + fix per finding. Explicit "Pn: none" if a tier is clear.

## File content

```typescript
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";
import { compileGlob, matchGlob, GlobCompileError } from "../../core/glob.js";
import { walkFiles } from "../../core/walk.js";
import { tryDecodeUtf8Strict, looksBinary } from "../../core/utf8.js";

const MAX_MATCHES_HARD_CAP = 500;
const MAX_MATCHES_DEFAULT = 50;
const MAX_CONTEXT_LINES = 10;
const OUTER_TIMEOUT_BUFFER_MS = 2000;

const InputShape = {
  path_glob: z.string().min(1),
  pattern: z.string().min(1),
  case_sensitive: z.boolean().default(false),
  context_lines: z.number().int().nonnegative().max(MAX_CONTEXT_LINES).default(0),
  max_matches: z.number().int().positive().max(MAX_MATCHES_HARD_CAP).optional(),
  timeout_ms: z.number().int().positive().optional(),
} as const;

// [schema definitions; full source has zod schemas + interfaces]

async function searchFile(
  filePath: string,
  re: RegExp,
  contextLines: number,
  remaining: number,
  signal: AbortSignal,
): Promise<Match[]> {
  if (signal.aborted) return [];
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch {
    return [];
  }
  if (looksBinary(buf)) return [];
  const text = tryDecodeUtf8Strict(buf);
  if (text === undefined) return [];

  const lines = text.split(/\r?\n/);
  const entries: Match[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (signal.aborted) break;
    const line = lines[i]!;
    if (!re.test(line)) continue;
    const match: Match = { file: filePath, line: i + 1, match: line };
    if (contextLines > 0) {
      const before = lines.slice(Math.max(0, i - contextLines), i);
      const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
      if (before.length > 0) match.context_before = before;
      if (after.length > 0) match.context_after = after;
    }
    entries.push(match);
    if (entries.length >= remaining) break;
  }
  return entries;
}

export async function grepImpl(
  args: Input,
  config: ResolvedConfig,
  deadlineMs: number,
): Promise<Result<GrepResult>> {
  let compiled;
  try {
    compiled = compileGlob(args.path_glob);
  } catch (err) {
    if (err instanceof GlobCompileError) {
      return buildError("EINVAL", err.message, { details: { path_glob: args.path_glob } });
    }
    throw err;
  }

  const baseCheck = await checkAllowed(compiled.base, config, { allowMissing: true });
  if ("ok" in baseCheck && baseCheck.ok === false) return baseCheck;
  const baseReal = (baseCheck as { realPath: string }).realPath;

  let re: RegExp;
  try {
    const flags = args.case_sensitive ? "" : "i";
    re = new RegExp(args.pattern, flags);
  } catch (err) {
    return buildError("EINVAL", `invalid regex: ${(err as Error).message}`, {
      details: { pattern: args.pattern },
    });
  }

  const cap = args.max_matches ?? MAX_MATCHES_DEFAULT;
  const matches: Match[] = [];
  let truncated = false;
  let reason: "timeout" | "max_matches" | undefined;

  // grep owns its deadline so it can return partial results on expiry
  const controller = new AbortController();
  const timer = setTimeout(() => {
    truncated = true;
    if (reason === undefined) reason = "timeout";
    controller.abort();
  }, deadlineMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    await walkFiles(baseReal, config, async (absPath) => {
      if (controller.signal.aborted) return false;
      if (!matchGlob(compiled, absPath)) return true;
      const remaining = cap - matches.length;
      if (remaining <= 0) {
        truncated = true;
        reason = "max_matches";
        return false;
      }
      const entries = await searchFile(absPath, re, args.context_lines, remaining, controller.signal);
      for (const m of entries) {
        matches.push(m);
        if (matches.length >= cap) {
          truncated = true;
          reason = "max_matches";
          return false;
        }
      }
      return true;
    }, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return ok({ matches, total: matches.length, truncated, ...(reason ? { reason } : {}) });
}

// Registration excerpt — the deadline race lives here:
//   const innerDeadline = resolveTimeoutMs(args.timeout_ms, config.defaultTimeoutMs, config.maxTimeoutMs);
//   const outerDeadline = Math.min(innerDeadline + OUTER_TIMEOUT_BUFFER_MS, config.maxTimeoutMs);
//   return runTool({ tool: "grep", config, timeoutMs: outerDeadline }, args, () => grepImpl(args, config, innerDeadline));
```

## Known context

- `runTool` wrapper already audited separately; trust its contract (pure-payload structuredContent, audit redaction, bounded timeout via `withTimeout`).
- `walkFiles` lives in `src/core/walk.ts` (not shown). JSDoc claims "realpath-checked during the walk so symlink-escape entries are skipped silently". Q4 is exactly about verifying that claim.
- Config defaults: `OUTER_TIMEOUT_BUFFER_MS = 2000`. `config.defaultTimeoutMs = 10000`. `config.maxTimeoutMs = 60000`.

import { promises as fs } from "node:fs";
import * as path from "node:path";
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
import type { ToolContext } from "../../core/tool_context.js";

const MAX_MATCHES_HARD_CAP = 500;
const MAX_MATCHES_DEFAULT = 50;
const MAX_CONTEXT_LINES = 10;
const OUTER_TIMEOUT_BUFFER_MS = 2000;
// v0.7 wave 2a: pagination needs to know how many matches exist in total, but
// counting unbounded is a DoS risk. Ceiling = stop scanning past this point;
// surface `total_matches_capped: true` so callers know the count is a lower
// bound. 10 KB matches × ~512 B each ≈ 5 MB worst case before slicing.
const TOTAL_MATCH_CEILING = 10000;

const InputShape = {
  path_glob: z
    .string()
    .min(1)
    .describe("Absolute glob over which to search, e.g. `C:\\proj\\**\\*.md`."),
  pattern: z
    .string()
    .min(1)
    .describe("JavaScript-flavoured regex source. Compiled with `new RegExp(...)`, never eval'd."),
  case_sensitive: z
    .boolean()
    .default(false)
    .describe("If false (default), the `i` regex flag is added."),
  context_lines: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CONTEXT_LINES)
    .default(0)
    .describe(`Lines of context before AND after each match. 0..${MAX_CONTEXT_LINES}.`),
  max_matches: z
    .number()
    .int()
    .positive()
    .max(MAX_MATCHES_HARD_CAP)
    .optional()
    .describe(`Legacy alias for \`limit\`. Cap on per-page match count. Default ${MAX_MATCHES_DEFAULT}, hard cap ${MAX_MATCHES_HARD_CAP}. If both \`max_matches\` and \`limit\` are supplied, \`limit\` wins.`),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Pagination: skip the first N matches. Default 0."),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_MATCHES_HARD_CAP)
    .optional()
    .describe(`Pagination: per-page match cap. Default ${MAX_MATCHES_DEFAULT}, hard cap ${MAX_MATCHES_HARD_CAP}. Wins over \`max_matches\` if both supplied.`),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Search deadline. On expiry returns the partial result set with truncated:true, reason:timeout. Defaults to config.defaultTimeoutMs."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().positive(),
      match: z.string(),
      context_before: z.array(z.string()).optional(),
      context_after: z.array(z.string()).optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  reason: z.union([z.literal("timeout"), z.literal("max_matches")]).optional(),
  total_matches: z.number().int().nonnegative(),
  total_matches_capped: z.boolean().optional(),
  next_offset: z.number().int().nonnegative().optional(),
} as const;

interface Match {
  file: string;
  line: number;
  match: string;
  context_before?: string[];
  context_after?: string[];
}

interface GrepResult extends Record<string, unknown> {
  matches: Match[];
  total: number;
  truncated: boolean;
  reason?: "timeout" | "max_matches";
  total_matches: number;
  total_matches_capped?: boolean;
  next_offset?: number;
}

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
    // P2.5 (v0.7 pre-tag bug-fix): defensive lastIndex reset. With the
    // current (no `g`/`y` flags) compile path this is a no-op, but if a
    // future change adds those flags the same RegExp instance is reused
    // across all files and lines — accumulating lastIndex would cause
    // silent false negatives. One-line guarantee against that regression.
    re.lastIndex = 0;
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

/**
 * Pagination scan: enumerates every match in the file up to a global
 * `remainingToCeiling` budget. Doesn't apply a per-page cap inside the file —
 * pagination slicing happens at the caller using the global ordinal.
 */
async function searchFileFull(
  filePath: string,
  re: RegExp,
  contextLines: number,
  remainingToCeiling: number,
  signal: AbortSignal,
): Promise<Match[]> {
  if (signal.aborted || remainingToCeiling <= 0) return [];
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
    if (entries.length >= remainingToCeiling) break;
    const line = lines[i]!;
    // P2.5 defensive reset — see searchFile for rationale.
    re.lastIndex = 0;
    if (!re.test(line)) continue;
    const match: Match = { file: filePath, line: i + 1, match: line };
    if (contextLines > 0) {
      const before = lines.slice(Math.max(0, i - contextLines), i);
      const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
      if (before.length > 0) match.context_before = before;
      if (after.length > 0) match.context_after = after;
    }
    entries.push(match);
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

  // P2.8 (v0.7 pre-tag bug-fix): defense-in-depth — assert compileGlob
  // returned a non-empty absolute base before handing it to checkAllowed.
  // A wildcards-only pattern like `**/*.ts` could (depending on compileGlob
  // future changes) return base="" or base="." which checkAllowed would
  // resolve against process.cwd(), silently expanding the search outside
  // allowedRoots.
  if (!compiled.base || !path.isAbsolute(compiled.base)) {
    return buildError("EINVAL", "path_glob must have an absolute literal prefix", {
      details: { path_glob: args.path_glob, base: compiled.base },
      hint: "Use an absolute path glob like 'C:\\\\proj\\\\**\\\\*.ts'; wildcards-only patterns are not allowed.",
    });
  }

  // P1.3 (v0.7 pre-tag bug-fix): defense-in-depth context_lines guard.
  // Zod rejects negatives at the registered-tool boundary, but impl
  // callers (unit tests, future internal tools) may bypass that schema.
  if (
    args.context_lines !== undefined &&
    (args.context_lines < 0 || !Number.isInteger(args.context_lines))
  ) {
    return buildError("EINVAL", "context_lines must be a non-negative integer", {
      details: { context_lines: args.context_lines },
    });
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

  // v0.7 wave 2a: `limit` is the canonical pagination knob; `max_matches`
  // remains the v0.6 legacy alias. Both default to MAX_MATCHES_DEFAULT. If
  // both are supplied, `limit` wins.
  const pageSize = args.limit ?? args.max_matches ?? MAX_MATCHES_DEFAULT;
  const offset = args.offset ?? 0;
  // Defense-in-depth: Zod rejects negatives at the registered-tool boundary,
  // but impl callers (unit tests, internal callers) may bypass that schema.
  if (offset < 0 || !Number.isInteger(offset)) {
    return buildError("EINVAL", "offset must be a non-negative integer", {
      details: { offset },
    });
  }
  const allMatches: Match[] = [];
  let totalMatches = 0;
  let totalMatchesCapped = false;
  let truncated = false;
  let reason: "timeout" | "max_matches" | undefined;

  // grep owns its deadline so it can return partial results on expiry instead
  // of the wrapper short-circuiting to ETIMEDOUT. The outer wrapper timeout is
  // set with a buffer to ensure this fires first.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    truncated = true;
    if (reason === undefined) reason = "timeout";
    controller.abort();
  }, deadlineMs);
  if (typeof timer.unref === "function") timer.unref();

  try {
    await walkFiles(
      baseReal,
      config,
      async (absPath) => {
        if (controller.signal.aborted) return false;
        if (!matchGlob(compiled, absPath)) return true;
        const remainingToCeiling = TOTAL_MATCH_CEILING - totalMatches;
        if (remainingToCeiling <= 0) {
          totalMatchesCapped = true;
          return false;
        }
        const entries = await searchFileFull(
          absPath,
          re,
          args.context_lines,
          remainingToCeiling,
          controller.signal,
        );
        for (const m of entries) {
          totalMatches++;
          allMatches.push(m);
        }
        if (totalMatches >= TOTAL_MATCH_CEILING) {
          totalMatchesCapped = true;
          return false;
        }
        return true;
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  allMatches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Page-slice over the sorted match sequence.
  const page = allMatches.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length < totalMatches ? offset + page.length : undefined;
  if (nextOffset !== undefined) {
    truncated = true;
    if (reason === undefined) reason = "max_matches";
  }

  return ok({
    matches: page,
    total: page.length,
    truncated,
    ...(reason ? { reason } : {}),
    total_matches: totalMatches,
    ...(totalMatchesCapped ? { total_matches_capped: true } : {}),
    ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
  });
}

export function registerGrepTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "grep",
    {
      title: "Regex search across files matching a glob",
      description: `Search every file matching \`path_glob\` for \`pattern\` and return matches with optional
context lines. The glob's literal prefix must be inside allowedRoots. Each candidate file
is realpath-checked during the walk so symlink-escape entries are skipped silently.

\`pattern\` is compiled with \`new RegExp(pattern, flags)\` — no \`eval\`, no \`Function\`.
Malformed patterns surface as EINVAL with the parser message. \`case_sensitive\` defaults
to false (adds the \`i\` flag). For multiline / dotall semantics use embedded \`(?m)\` /
\`(?s)\` flags inside the pattern itself.

Execution is bounded by \`timeout_ms\` (default config.defaultTimeoutMs, max config.maxTimeoutMs).
On deadline the partial result set is returned with \`{truncated: true, reason: "timeout"}\` —
this is the normal path, not an error.

Args:
  - path_glob (string): absolute glob (\`*\`, \`?\`, \`**\`, \`[...]\` supported)
  - pattern (string): JavaScript regex source
  - case_sensitive (boolean, default false)
  - context_lines (number, default 0, max ${MAX_CONTEXT_LINES})
  - offset (number, optional, default 0): skip the first N matches (pagination)
  - limit (number, optional, default ${MAX_MATCHES_DEFAULT}, hard cap ${MAX_MATCHES_HARD_CAP}): per-page match cap
  - max_matches (number, optional): legacy alias for \`limit\` (kept for v0.6 callers)
  - timeout_ms (number, optional): search deadline

Returns: { matches, total, truncated, reason?, total_matches, total_matches_capped?, next_offset? }
  - \`total_matches\` is the count across the whole search (not just the page),
    capped at ${TOTAL_MATCH_CEILING}. \`total_matches_capped: true\` when the
    ceiling is hit — count is then a lower bound.
  - \`next_offset\` is set when more results follow the current page; absent on the
    last page.
Errors: EPERM_ROOT, EINVAL (bad glob or regex).`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      // P1.1 (v0.7 pre-tag bug-fix): the prior clamp order made
      // outer = min(inner + buffer, maxTimeoutMs), so when the caller
      // requested timeout_ms === maxTimeoutMs both timers fired at the
      // same instant. V8 timer ordering is non-deterministic at equal
      // expiry — the outer wrapper could win, returning ETIMEDOUT
      // instead of grep's partial-result path.
      //
      // New order: compute the outer deadline against maxTimeoutMs FIRST,
      // then derive the inner deadline as `outerDeadline - BUFFER` (≥ 1 ms).
      // This guarantees the inner deadline always fires ≥ BUFFER_MS before
      // the outer regardless of caller input.
      const requested = resolveTimeoutMs(
        (args as Record<string, unknown>).timeout_ms as number | undefined,
        config.defaultTimeoutMs,
        config.maxTimeoutMs,
      );
      const outerDeadline = requested;
      const innerDeadline = Math.max(1, outerDeadline - OUTER_TIMEOUT_BUFFER_MS);
      return runTool(
        { tool: "grep", config, timeoutMs: outerDeadline },
        args,
        () => grepImpl(args as Input, config, innerDeadline),
      );
    },
  );
}

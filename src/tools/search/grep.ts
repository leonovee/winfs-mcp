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
    .describe(`Cap on total matches. Default ${MAX_MATCHES_DEFAULT}, hard cap ${MAX_MATCHES_HARD_CAP}.`),
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
        const remaining = cap - matches.length;
        if (remaining <= 0) {
          truncated = true;
          reason = "max_matches";
          return false;
        }
        const entries = await searchFile(
          absPath,
          re,
          args.context_lines,
          remaining,
          controller.signal,
        );
        for (const m of entries) {
          matches.push(m);
          if (matches.length >= cap) {
            truncated = true;
            reason = "max_matches";
            return false;
          }
        }
        return true;
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return ok({
    matches,
    total: matches.length,
    truncated,
    ...(reason ? { reason } : {}),
  });
}

export function registerGrepTool(server: McpServer, config: ResolvedConfig): void {
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
  - max_matches (number, default ${MAX_MATCHES_DEFAULT}, hard cap ${MAX_MATCHES_HARD_CAP})
  - timeout_ms (number, optional): search deadline

Returns: { matches: [{file, line, match, context_before?, context_after?}], total, truncated, reason? }
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
      const innerDeadline = resolveTimeoutMs(
        (args as Record<string, unknown>).timeout_ms as number | undefined,
        config.defaultTimeoutMs,
        config.maxTimeoutMs,
      );
      // Outer wrapper deadline = inner + buffer, clamped to maxTimeoutMs. This
      // guarantees the inner deadline fires first and returns partial results,
      // rather than the wrapper synthesising an ETIMEDOUT error.
      const outerDeadline = Math.min(
        innerDeadline + OUTER_TIMEOUT_BUFFER_MS,
        config.maxTimeoutMs,
      );
      return runTool(
        { tool: "grep", config, timeoutMs: outerDeadline },
        args,
        () => grepImpl(args as Input, config, innerDeadline),
      );
    },
  );
}

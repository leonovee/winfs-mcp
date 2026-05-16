import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { compileGlob, matchGlob, GlobCompileError } from "../../core/glob.js";
import { walkFiles } from "../../core/walk.js";

const HARD_CAP = 2000;
const DEFAULT_MAX = 200;

const InputShape = {
  pattern: z
    .string()
    .min(1, "pattern must be non-empty")
    .describe("Absolute glob pattern. Supports *, ?, **, [...]. Brace expansion is not supported."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(HARD_CAP)
    .optional()
    .describe(`Maximum matches to return. Default ${DEFAULT_MAX}, hard cap ${HARD_CAP}.`),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  matches: z.array(z.string()),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
} as const;

interface GlobResult extends Record<string, unknown> {
  matches: string[];
  total: number;
  truncated: boolean;
}

export async function globImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<GlobResult>> {
  let compiled;
  try {
    compiled = compileGlob(args.pattern);
  } catch (err) {
    if (err instanceof GlobCompileError) {
      return buildError("EINVAL", err.message, { details: { pattern: args.pattern } });
    }
    throw err;
  }

  // The base directory MUST be inside an allowed root. This blocks
  // `C:\Windows\System32\*.dll` style escapes before we touch the disk.
  const baseCheck = await checkAllowed(compiled.base, config, { allowMissing: true });
  if ("ok" in baseCheck && baseCheck.ok === false) return baseCheck;
  const baseReal = (baseCheck as { realPath: string }).realPath;

  const cap = args.max_results ?? DEFAULT_MAX;
  const matches: string[] = [];
  let truncated = false;

  await walkFiles(baseReal, config, (absPath) => {
    if (!matchGlob(compiled, absPath)) return true;
    matches.push(absPath);
    if (matches.length >= cap) {
      truncated = true;
      return false;
    }
    return true;
  });

  matches.sort((a, b) => a.localeCompare(b));
  return ok({ matches, total: matches.length, truncated });
}

export function registerGlobTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "glob",
    {
      title: "Find files matching a glob pattern",
      description: `Walk the filesystem from the pattern's literal prefix and return absolute paths
that match the glob. The pattern MUST be absolute. Supported syntax: \`*\`, \`?\`, \`[...]\`,
and \`**\` (zero or more path segments). Brace expansion (\`{a,b}\`) is not supported.

Each candidate file is realpath-checked and skipped if it resolves outside allowedRoots —
the literal prefix of the pattern must also lie inside an allowed root or the call returns
EPERM_ROOT before any filesystem walk.

Args:
  - pattern (string): absolute glob, e.g. \`C:\\Users\\me\\project\\**\\*.ts\`
  - max_results (number, optional): cap on returned matches. Default ${DEFAULT_MAX}, hard cap ${HARD_CAP}

Returns: { matches: string[], total: number, truncated: boolean }
Errors: EPERM_ROOT (base outside allowedRoots), EINVAL (malformed / non-absolute pattern), ETIMEDOUT.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "glob", config }, args, (a) => globImpl(a as Input, config)),
  );
}

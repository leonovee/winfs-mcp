import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result, type StructuredError } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { resolveGitRepo, spawnGit } from "../../core/git_safety.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const MAX_RANGE_LINES = 10000;

const InputShape = {
  repo_path: AbsolutePath,
  path: AbsolutePath.describe("Absolute path to the file inside repo_path."),
  range: z
    .string()
    .regex(/^\d+:\d+$/, "range must match start:end (e.g. \"10:50\")")
    .optional(),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const BlameEntry = z.object({
  line: z.number().int().positive(),
  sha: z.string(),
  author: z.string(),
  date: z.string(),
  content: z.string(),
});

const OutputShape = {
  blame: z.array(BlameEntry),
  total: z.number().int().nonnegative(),
} as const;

interface GitBlameResult extends Record<string, unknown> {
  blame: z.infer<typeof BlameEntry>[];
  total: number;
}

/**
 * Parse `git blame --line-porcelain` output. Each line's record:
 *   <sha> <orig-line> <final-line> [<group-size>]\n
 *   author <name>\n
 *   author-mail <<email>>\n
 *   author-time <unix>\n
 *   ... more metadata ...
 *   \t<content>\n
 */
function parsePorcelain(raw: string): z.infer<typeof BlameEntry>[] {
  const entries: z.infer<typeof BlameEntry>[] = [];
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = lines[i]!;
    const m = header.match(/^([0-9a-f]{4,40})\s+(\d+)\s+(\d+)/);
    if (!m) {
      i++;
      continue;
    }
    const sha = m[1]!;
    const finalLine = parseInt(m[3]!, 10);
    let author = "";
    let unixTime = 0;
    let tz = "+0000";
    let content = "";
    i++;
    while (i < lines.length) {
      const ln = lines[i]!;
      if (ln.startsWith("author ")) {
        author = ln.slice(7);
      } else if (ln.startsWith("author-time ")) {
        unixTime = parseInt(ln.slice(12), 10) || 0;
      } else if (ln.startsWith("author-tz ")) {
        tz = ln.slice(10);
      } else if (ln.startsWith("\t")) {
        content = ln.slice(1);
        i++;
        break;
      }
      i++;
    }
    void tz;
    entries.push({
      line: finalLine,
      sha,
      author,
      date: new Date(unixTime * 1000).toISOString(),
      content,
    });
  }
  return entries;
}

export async function gitBlameImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<GitBlameResult>> {
  const repo = await resolveGitRepo(args.repo_path, config);
  if ("ok" in repo && repo.ok === false) return repo as StructuredError;
  const { repoRoot } = repo as { repoRoot: string };

  // Independent allowedRoots check for the file path.
  const fileCheck = await checkAllowed(args.path, config);
  if ("ok" in fileCheck && fileCheck.ok === false) return fileCheck;
  const realFile = (fileCheck as { realPath: string }).realPath;

  // Build args. Range check: cap end-start+1 at MAX_RANGE_LINES.
  const gitArgs: string[] = ["blame", "--line-porcelain"];
  if (args.range !== undefined) {
    const [s, e] = args.range.split(":");
    const start = parseInt(s!, 10);
    const end = parseInt(e!, 10);
    if (start < 1 || end < start) {
      return buildError("EINVAL", "range bounds invalid (start >= 1, end >= start)", {
        details: { range: args.range },
      });
    }
    if (end - start + 1 > MAX_RANGE_LINES) {
      return buildError("EINVAL", `range exceeds ${MAX_RANGE_LINES} lines`, {
        details: { range: args.range, span: end - start + 1, cap: MAX_RANGE_LINES },
      });
    }
    gitArgs.push("-L", `${start},${end}`);
  }
  // Pass file as pathspec after `--` to avoid rev parsing.
  gitArgs.push("--", realFile);

  const deadline = Math.min(
    args.timeout_ms ?? config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );
  const res = await spawnGit(gitArgs, repoRoot, deadline);
  if (res.timedOut) {
    return buildError("ETIMEDOUT", "git blame exceeded deadline", {
      details: { repo_path: repoRoot, path: realFile, timeout_ms: deadline },
    });
  }
  if (res.exitCode !== 0) {
    if (/no such path|does not exist|no matches found/i.test(res.stderr)) {
      return buildError("ENOMATCH", "git blame: path not tracked or missing", {
        details: { path: realFile, cause: res.stderr.slice(0, 256) },
      });
    }
    return buildError("EIO", "git blame failed", {
      details: {
        path: realFile,
        exit_code: res.exitCode,
        cause: res.stderr.slice(0, 256),
      },
    });
  }

  const blame = parsePorcelain(res.stdout);
  return ok({ blame, total: blame.length });
}

export function registerGitBlameTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "git_blame",
    {
      title: "Read-only git blame for a file or line range",
      description: `Return per-line author / sha / date / content for a file.

Both \`repo_path\` and \`path\` are independently checked against allowedRoots.
\`range: "start:end"\` is inclusive 1-based; the span is capped at ${MAX_RANGE_LINES} lines.

Output envelope (spec §F): { blame, total } where total === blame.length.

Args:
  - repo_path (string): absolute repo root
  - path (string): absolute file path inside repo_path
  - range (string, optional): "start:end" format
  - timeout_ms (number, optional)

Errors: EPERM_ROOT (repo or path outside roots), ENOTREPO, ENOMATCH (file not tracked), EINVAL (range bounds / cap), ETIMEDOUT, EIO.`,
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
      runTool({ tool: "git_blame", config }, args, (a) =>
        gitBlameImpl(a as Input, config),
      ),
  );
}

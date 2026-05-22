import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result, type StructuredError } from "../../core/errors.js";
import { checkGitArgsReadOnly, checkPathFilter, resolveGitRepo, spawnGit } from "../../core/git_safety.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  repo_path: AbsolutePath,
  sha: z
    .string()
    .min(4, "sha must be at least 4 chars")
    .max(64)
    .regex(/^[A-Fa-f0-9]+$/, "sha must be hexadecimal"),
  path_filter: z.string().max(1024).optional(),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  sha: z.string(),
  author: z.string(),
  email: z.string(),
  date: z.string(),
  message: z.string(),
  diff: z.string(),
  files_changed: z.array(z.string()),
  truncated: z.boolean(),
} as const;

interface GitShowResult extends Record<string, unknown> {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  diff: string;
  files_changed: string[];
  truncated: boolean;
}

const US = "\x1f";

/**
 * Parse output of:
 *   git show --no-renames --format=%H<US>%an<US>%ae<US>%aI<US>%s<US>--END-META--<US> <sha>
 * Layout: metadata fields separated by US (0x1F) up to `--END-META--`, then
 * the full unified diff. files_changed is derived from the
 * `diff --git a/<path> b/<path>` headers in the diff text — keeps file
 * ordering aligned with the diff and avoids a second git call.
 */
function parseShowOutput(raw: string): {
  sha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  files_changed: string[];
  diff: string;
} | undefined {
  const endIdx = raw.indexOf(`${US}--END-META--${US}`);
  if (endIdx < 0) return undefined;
  const header = raw.slice(0, endIdx);
  const tail = raw.slice(endIdx + `${US}--END-META--${US}`.length);
  const fields = header.split(US);
  if (fields.length < 5) return undefined;

  const diffText = tail.replace(/^\n+/, "");

  // Extract files from `diff --git ... b/<path>` headers. We constrain to
  // [^"\n] to keep matches single-line. Quoted paths (renames, spaces) use
  // the "b/..." form; unquoted use \S+.
  const files_changed: string[] = [];
  const diffHeaderRe = /^diff --git (?:"a\/[^"\n]+"|a\/\S+) (?:"b\/([^"\n]+)"|b\/(\S+))/gm;
  let match: RegExpExecArray | null;
  while ((match = diffHeaderRe.exec(diffText)) !== null) {
    const bPath = match[1] ?? match[2];
    if (bPath !== undefined) files_changed.push(bPath);
  }

  return {
    sha: fields[0]!,
    author: fields[1]!,
    email: fields[2]!,
    date: fields[3]!,
    message: fields[4]!,
    files_changed,
    diff: diffText,
  };
}

export async function gitShowImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<GitShowResult>> {
  const repo = await resolveGitRepo(args.repo_path, config);
  if ("ok" in repo && repo.ok === false) return repo as StructuredError;
  const { repoRoot } = repo as { repoRoot: string };

  const gitArgs: string[] = [
    "show",
    "--no-renames",
    `--format=%H${US}%an${US}%ae${US}%aI${US}%s${US}--END-META--${US}`,
    args.sha,
  ];
  if (args.path_filter !== undefined) {
    const pfCheck = checkPathFilter(args.path_filter);
    if ("ok" in pfCheck && pfCheck.ok === false) return pfCheck as StructuredError;
    gitArgs.push("--", (pfCheck as { filter: string }).filter);
  }
  const mutCheck = checkGitArgsReadOnly(gitArgs);
  if (mutCheck) return mutCheck;

  const deadline = Math.min(
    args.timeout_ms ?? config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );
  const res = await spawnGit(gitArgs, repoRoot, deadline);
  if (res.timedOut) {
    return buildError("ETIMEDOUT", "git show exceeded deadline", {
      details: { repo_path: repoRoot, sha: args.sha, timeout_ms: deadline },
    });
  }
  if (res.exitCode !== 0) {
    if (/unknown revision|bad revision|ambiguous argument/i.test(res.stderr)) {
      return buildError("ENOMATCH", "git show: unknown or ambiguous revision", {
        details: { sha: args.sha, cause: res.stderr.slice(0, 256) },
      });
    }
    return buildError("EIO", "git show failed", {
      details: { sha: args.sha, exit_code: res.exitCode, cause: res.stderr.slice(0, 256) },
    });
  }

  const parsed = parseShowOutput(res.stdout);
  if (!parsed) {
    return buildError("EIO", "git show output could not be parsed", {
      details: { sha: args.sha, output_prefix: res.stdout.slice(0, 200) },
    });
  }
  // Truncation flag: spawnGit caps each stream at 4 MB. If stdout reached the
  // cap, the diff may be incomplete.
  const truncated = res.stdout.length >= 4 * 1024 * 1024;
  return ok({ ...parsed, truncated });
}

export function registerGitShowTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "git_show",
    {
      title: "Read-only git show for a single revision",
      description: `Return metadata + unified diff for a single commit / revision.

\`sha\` must be hexadecimal (4..64 chars). Unknown revisions return ENOMATCH.

Output: { sha, author, email, date, message, diff, files_changed, truncated }
\`truncated: true\` indicates the 4 MB per-stream cap was hit and the diff may be partial.

Args:
  - repo_path (string): absolute path to repo root
  - sha (string): hex revision (any disambiguating prefix accepted by git)
  - path_filter (string, optional): pathspec passed after \`--\`
  - timeout_ms (number, optional)

Errors: EPERM_ROOT, ENOTREPO, ENOMATCH (unknown rev), EINVAL (path_filter), ETIMEDOUT, EIO, EGITMUTATION.`,
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
      runTool({ tool: "git_show", config }, args, (a) =>
        gitShowImpl(a as Input, config),
      ),
  );
}

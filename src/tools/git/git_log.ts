import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result, type StructuredError } from "../../core/errors.js";
import { checkGitArgsReadOnly, checkPathFilter, resolveGitRepo, spawnGit } from "../../core/git_safety.js";
import { AbsolutePath } from "../../schemas/common.js";

const DEFAULT_COUNT = 20;
const MAX_COUNT = 200;

const InputShape = {
  repo_path: AbsolutePath.describe("Absolute path to the repository root."),
  range: z
    .string()
    .max(256)
    .optional()
    .describe("Git revision range, e.g. \"main..feature\" or \"HEAD~10..HEAD\"."),
  path_filter: z
    .string()
    .max(1024)
    .optional()
    .describe("Pathspec to limit log to (passed after `--`)."),
  count: z
    .number()
    .int()
    .positive()
    .max(MAX_COUNT)
    .optional()
    .describe(`Max commits returned. Default ${DEFAULT_COUNT}, hard cap ${MAX_COUNT}.`),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const CommitEntry = z.object({
  hash: z.string(),
  author: z.string(),
  email: z.string(),
  date: z.string(),
  message: z.string(),
});

const OutputShape = {
  commits: z.array(CommitEntry),
  total: z.number().int().nonnegative(),
} as const;

interface GitLogResult extends Record<string, unknown> {
  commits: z.infer<typeof CommitEntry>[];
  total: number;
}

// ASCII Record Separator (0x1E) between commits, Unit Separator (0x1F) between fields.
const RS = "\x1e";
const US = "\x1f";

function parseLogOutput(raw: string): z.infer<typeof CommitEntry>[] {
  if (raw.length === 0) return [];
  // First commit doesn't have a leading RS in some git versions; split on RS
  // and drop empty leading entry.
  const records = raw.split(RS).filter((r) => r.length > 0);
  const out: z.infer<typeof CommitEntry>[] = [];
  for (const rec of records) {
    const fields = rec.split(US);
    if (fields.length < 5) continue;
    out.push({
      hash: fields[0]!,
      author: fields[1]!,
      email: fields[2]!,
      date: fields[3]!,
      message: fields[4]!.replace(/\n$/, ""),
    });
  }
  return out;
}

/** Reject revisions that LOOK like flags or contain shell-suspicious chars.
 *  Git's `--` separator does NOT apply to rev arguments — they're parsed
 *  before pathspecs. We keep a strict allowlist for rev arguments. */
function checkRevSafe(rev: string): StructuredError | undefined {
  if (rev.startsWith("-")) {
    return buildError("EINVAL", "range/rev argument may not start with '-'", {
      details: { rev },
    });
  }
  // Allow alphanumerics, `.`, `_`, `/`, `-` (not leading), `~`, `^`, `@`, `{`, `}`, `:`.
  if (!/^[A-Za-z0-9._/~^@{}:-]+$/.test(rev)) {
    return buildError("EINVAL", "range/rev contains disallowed characters", {
      details: { rev },
    });
  }
  return undefined;
}

export async function gitLogImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<GitLogResult>> {
  const repo = await resolveGitRepo(args.repo_path, config);
  if ("ok" in repo && repo.ok === false) return repo as StructuredError;
  const { repoRoot } = repo as { repoRoot: string };

  const count = args.count ?? DEFAULT_COUNT;
  const gitArgs: string[] = [
    "log",
    `-n${count}`,
    `--format=${RS}%H${US}%an${US}%ae${US}%aI${US}%s`,
  ];

  if (args.range !== undefined) {
    const revCheck = checkRevSafe(args.range);
    if (revCheck) return revCheck;
    gitArgs.push(args.range);
  }
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
    return buildError("ETIMEDOUT", "git log exceeded deadline", {
      details: { repo_path: repoRoot, timeout_ms: deadline },
    });
  }
  if (res.exitCode !== 0) {
    return buildError("EIO", "git log failed", {
      details: {
        repo_path: repoRoot,
        exit_code: res.exitCode,
        cause: res.stderr.slice(0, 256),
      },
    });
  }

  const commits = parseLogOutput(res.stdout);
  return ok({ commits, total: commits.length });
}

export function registerGitLogTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "git_log",
    {
      title: "Read-only git log (typed commit list)",
      description: `Return up to \`count\` commits from a repository's history as a typed array.
\`repo_path\` must be inside allowedRoots and contain \`.git\`.

Range / path_filter validation:
  - \`range\` (optional): git revision range like "main..feature". Strict allowlist of
    characters; leading "-" rejected (would be parsed as a flag).
  - \`path_filter\` (optional): pathspec passed AFTER \`--\` so git treats it as a
    pathspec, not a rev. NUL / control chars rejected.

Output envelope (spec §F): { commits, total } where total === commits.length.

Args:
  - repo_path (string): absolute path to repo root
  - range (string, optional)
  - path_filter (string, optional)
  - count (number, default ${DEFAULT_COUNT}, max ${MAX_COUNT})
  - timeout_ms (number, optional)

Errors: EPERM_ROOT, ENOTREPO, EINVAL (rev/path_filter validation), ETIMEDOUT, EIO, EGITMUTATION.`,
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
      runTool({ tool: "git_log", config }, args, (a) =>
        gitLogImpl(a as Input, config),
      ),
  );
}

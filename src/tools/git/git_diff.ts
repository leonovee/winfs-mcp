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
  rev_a: z.string().max(256).optional().describe("Default 'HEAD'."),
  rev_b: z.string().max(256).optional().describe("Default: worktree (no rev)."),
  path_filter: z.string().max(1024).optional(),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  diff: z.string(),
  files_changed: z.array(z.string()),
  stats: z.object({
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
} as const;

interface GitDiffResult extends Record<string, unknown> {
  diff: string;
  files_changed: string[];
  stats: { insertions: number; deletions: number };
  truncated: boolean;
}

function checkRevSafe(rev: string, name: string): StructuredError | undefined {
  if (rev.startsWith("-")) {
    return buildError("EINVAL", `${name} may not start with '-'`, { details: { rev, field: name } });
  }
  if (!/^[A-Za-z0-9._/~^@{}:-]+$/.test(rev)) {
    return buildError("EINVAL", `${name} contains disallowed characters`, {
      details: { rev, field: name },
    });
  }
  return undefined;
}

function parseNumstat(raw: string): { files: string[]; insertions: number; deletions: number } {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    // Format: "<added>\t<deleted>\t<path>"  (binary files show "-\t-\t<path>")
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0]!;
    const removed = parts[1]!;
    const file = parts.slice(2).join("\t");
    files.push(file);
    if (added !== "-") insertions += parseInt(added, 10) || 0;
    if (removed !== "-") deletions += parseInt(removed, 10) || 0;
  }
  return { files, insertions, deletions };
}

export async function gitDiffImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<GitDiffResult>> {
  const repo = await resolveGitRepo(args.repo_path, config);
  if ("ok" in repo && repo.ok === false) return repo as StructuredError;
  const { repoRoot } = repo as { repoRoot: string };

  const deadline = Math.min(
    args.timeout_ms ?? config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );

  // First pass: text diff.
  const diffArgs: string[] = ["diff"];
  if (args.rev_a !== undefined) {
    const aCheck = checkRevSafe(args.rev_a, "rev_a");
    if (aCheck) return aCheck;
    diffArgs.push(args.rev_a);
  } else {
    diffArgs.push("HEAD");
  }
  if (args.rev_b !== undefined) {
    const bCheck = checkRevSafe(args.rev_b, "rev_b");
    if (bCheck) return bCheck;
    diffArgs.push(args.rev_b);
  }
  if (args.path_filter !== undefined) {
    const pfCheck = checkPathFilter(args.path_filter);
    if ("ok" in pfCheck && pfCheck.ok === false) return pfCheck as StructuredError;
    diffArgs.push("--", (pfCheck as { filter: string }).filter);
  }
  const mutCheck = checkGitArgsReadOnly(diffArgs);
  if (mutCheck) return mutCheck;

  const diffRes = await spawnGit(diffArgs, repoRoot, deadline);
  if (diffRes.timedOut) {
    return buildError("ETIMEDOUT", "git diff exceeded deadline", {
      details: { repo_path: repoRoot, timeout_ms: deadline },
    });
  }
  if (diffRes.exitCode !== 0 && diffRes.exitCode !== 1) {
    // exit 1 = differences exist (still a "success" for diff). Other codes = error.
    return buildError("EIO", "git diff failed", {
      details: {
        repo_path: repoRoot,
        exit_code: diffRes.exitCode,
        cause: diffRes.stderr.slice(0, 256),
      },
    });
  }

  // Second pass: --numstat for files + stats.
  const numstatArgs = ["diff", "--numstat", ...diffArgs.slice(1)];
  const statsRes = await spawnGit(numstatArgs, repoRoot, deadline);
  let files_changed: string[] = [];
  let insertions = 0;
  let deletions = 0;
  if (!statsRes.timedOut && (statsRes.exitCode === 0 || statsRes.exitCode === 1)) {
    const parsed = parseNumstat(statsRes.stdout);
    files_changed = parsed.files;
    insertions = parsed.insertions;
    deletions = parsed.deletions;
  }

  const truncated = diffRes.stdout.length >= 4 * 1024 * 1024;
  return ok({
    diff: diffRes.stdout,
    files_changed,
    stats: { insertions, deletions },
    truncated,
  });
}

export function registerGitDiffTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "git_diff",
    {
      title: "Read-only git diff with stats",
      description: `Return a unified text diff plus changed-file list and insertion/deletion counts.

\`rev_a\` defaults to "HEAD". \`rev_b\` omitted means diff against the worktree (i.e.
\`git diff HEAD\`). To diff the staging area only, pass \`rev_b: "--cached"\`.

Output: { diff, files_changed, stats: {insertions, deletions}, truncated }
\`truncated: true\` indicates the 4 MB per-stream cap was hit.

Args:
  - repo_path (string): absolute path to repo root
  - rev_a (string, default "HEAD")
  - rev_b (string, optional; worktree if omitted)
  - path_filter (string, optional)
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
      runTool({ tool: "git_diff", config }, args, (a) =>
        gitDiffImpl(a as Input, config),
      ),
  );
}

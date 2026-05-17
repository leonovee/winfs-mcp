import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result, type StructuredError } from "../../core/errors.js";
import { resolveGitRepo, spawnGit } from "../../core/git_safety.js";
import { AbsolutePath } from "../../schemas/common.js";

const InputShape = {
  repo_path: AbsolutePath.describe("Absolute path to the repository root."),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  detached: z.boolean(),
  staged: z.array(z.string()),
  modified: z.array(z.string()),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
} as const;

interface GitStatusResult extends Record<string, unknown> {
  branch: string;
  ahead: number;
  behind: number;
  detached: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}

type ParsedPorcelain = GitStatusResult;

/**
 * Parse `git status --porcelain=v2 --branch -z` output. NUL-separated
 * records; header lines start with `#`. v2 file records:
 *   1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>          ordinary
 *   2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>   rename/copy
 *   u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>  unmerged
 *   ? <path>                                              untracked
 *   ! <path>                                              ignored (we don't surface)
 */
function parsePorcelainV2(raw: string): ParsedPorcelain {
  const result: ParsedPorcelain = {
    branch: "",
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    modified: [],
    untracked: [],
    conflicted: [],
  };
  // Trim trailing NUL so split doesn't emit an empty record.
  const text = raw.endsWith("\0") ? raw.slice(0, -1) : raw;
  if (text.length === 0) return result;
  const records = text.split("\0");
  let i = 0;
  while (i < records.length) {
    const rec = records[i]!;
    if (rec.startsWith("# branch.head ")) {
      const head = rec.slice("# branch.head ".length).trim();
      result.branch = head;
      if (head === "(detached)") result.detached = true;
      i++;
      continue;
    }
    if (rec.startsWith("# branch.ab ")) {
      // `# branch.ab +<ahead> -<behind>`
      const tail = rec.slice("# branch.ab ".length);
      const match = tail.match(/^\+(\d+)\s+-(\d+)$/);
      if (match) {
        result.ahead = parseInt(match[1]!, 10);
        result.behind = parseInt(match[2]!, 10);
      }
      i++;
      continue;
    }
    if (rec.startsWith("# ")) {
      i++;
      continue;
    }
    // Non-header record.
    if (rec.startsWith("? ")) {
      result.untracked.push(rec.slice(2));
      i++;
      continue;
    }
    if (rec.startsWith("! ")) {
      // ignored — skip
      i++;
      continue;
    }
    if (rec.startsWith("u ")) {
      // unmerged / conflicted. Path is the last whitespace-separated field.
      const parts = rec.split(" ");
      const p = parts[parts.length - 1]!;
      result.conflicted.push(p);
      i++;
      continue;
    }
    if (rec.startsWith("1 ") || rec.startsWith("2 ")) {
      // ordinary or rename. Layout: "1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      // For rename (kind 2), the next record is the orig path (NUL-separated).
      const parts = rec.split(" ");
      const xy = parts[1] ?? "..";
      const X = xy[0] ?? ".";
      const Y = xy[1] ?? ".";
      const p = parts.slice(8).join(" ");
      if (X !== "." && X !== "?") result.staged.push(p);
      if (Y !== "." && Y !== "?") result.modified.push(p);
      if (rec.startsWith("2 ")) i++; // consume orig path slot
      i++;
      continue;
    }
    // Unknown record — skip silently.
    i++;
  }
  return result;
}

export async function gitStatusImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<GitStatusResult>> {
  const repo = await resolveGitRepo(args.repo_path, config);
  if ("ok" in repo && repo.ok === false) return repo as StructuredError;
  const { repoRoot } = repo as { repoRoot: string };

  const deadline = Math.min(
    args.timeout_ms ?? config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );
  const res = await spawnGit(
    ["status", "--porcelain=v2", "--branch", "-z"],
    repoRoot,
    deadline,
  );
  if (res.timedOut) {
    return buildError("ETIMEDOUT", "git status exceeded deadline", {
      details: { repo_path: repoRoot, timeout_ms: deadline },
    });
  }
  if (res.exitCode !== 0) {
    return buildError("EIO", "git status failed", {
      details: { repo_path: repoRoot, exit_code: res.exitCode, cause: res.stderr.slice(0, 256) },
    });
  }

  const parsed = parsePorcelainV2(res.stdout);
  return ok(parsed);
}

export function registerGitStatusTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "git_status",
    {
      title: "Read-only git status of a repository",
      description: `Return the working-tree status of a git repository as structured fields.
\`repo_path\` must be inside allowedRoots and contain a \`.git\` entry.

Output:
  - branch: current branch name, or "(detached)" if HEAD is detached
  - ahead / behind: counts against upstream (0 if no upstream)
  - detached: true if HEAD is detached
  - staged / modified / untracked / conflicted: arrays of paths

Args:
  - repo_path (string): absolute path to repo root
  - timeout_ms (number, optional): override default deadline

Errors: EPERM_ROOT (repo_path outside allowedRoots), ENOTREPO (no .git), ETIMEDOUT, EIO.`,
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
      runTool({ tool: "git_status", config }, args, (a) =>
        gitStatusImpl(a as Input, config),
      ),
  );
}

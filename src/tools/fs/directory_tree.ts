import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const MAX_DEPTH_HARD_CAP = 8;
const MAX_NODES_HARD_CAP = 10_000;

const InputShape = {
  path: AbsolutePath,
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH_HARD_CAP)
    .default(3)
    .describe(
      `Recursion depth (1 = top-level children only, max ${MAX_DEPTH_HARD_CAP}). Default 3 is a sensible mid-point for project-layout exploration.`,
    ),
  exclude_patterns: z
    .array(z.string().min(1).max(256))
    .max(64)
    .optional()
    .describe(
      "Optional basename globs to skip from the tree. Each is a simple shell-style glob (* / ? / [...]). Matches against the entry basename only. Common values: 'node_modules', '.git', 'dist', '*.tmp'.",
    ),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

interface TreeNode {
  name: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.union([z.literal("file"), z.literal("directory")]),
    children: z.array(TreeNodeSchema).optional(),
  }),
);

const OutputShape = {
  root: TreeNodeSchema,
  total_nodes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncated_reason: z.union([z.literal("max_depth"), z.literal("max_nodes")]).optional(),
} as const;

interface DirectoryTreeResult extends Record<string, unknown> {
  root: TreeNode;
  total_nodes: number;
  truncated: boolean;
  truncated_reason?: "max_depth" | "max_nodes";
}

/** Compile a list of basename globs into a single matcher. */
function compileExcludeMatcher(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => false;
  const regexes = patterns.map((p) => {
    let re = "^";
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === "*") re += "[^/\\\\]*";
      else if (ch === "?") re += "[^/\\\\]";
      else if (ch === "[") {
        const end = p.indexOf("]", i);
        if (end === -1) {
          re += "\\[";
        } else {
          re += p.slice(i, end + 1);
          i = end;
        }
      } else if (/[.+^${}()|\\]/.test(ch ?? "")) {
        re += `\\${ch}`;
      } else {
        re += ch;
      }
    }
    re += "$";
    return new RegExp(re, process.platform === "win32" ? "i" : "");
  });
  return (name) => regexes.some((r) => r.test(name));
}

interface WalkState {
  nodeCount: number;
  truncated: boolean;
  truncatedReason: "max_depth" | "max_nodes" | undefined;
}

async function buildSubtree(
  absPath: string,
  name: string,
  depth: number,
  maxDepth: number,
  excluded: (n: string) => boolean,
  state: WalkState,
): Promise<TreeNode> {
  state.nodeCount++;
  let st: import("node:fs").Stats;
  try {
    st = await fs.stat(absPath);
  } catch {
    // Skip unreadable entries; surface as file with no children.
    return { name, type: "file" };
  }
  if (!st.isDirectory()) return { name, type: "file" };

  if (depth >= maxDepth) {
    // Hit depth cap: include the directory node but no children.
    if (state.truncatedReason === undefined) {
      state.truncated = true;
      state.truncatedReason = "max_depth";
    }
    return { name, type: "directory", children: [] };
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(absPath, { withFileTypes: true });
  } catch {
    return { name, type: "directory", children: [] };
  }

  const children: TreeNode[] = [];
  for (const d of dirents) {
    if (state.nodeCount >= MAX_NODES_HARD_CAP) {
      if (state.truncatedReason === undefined) {
        state.truncated = true;
        state.truncatedReason = "max_nodes";
      }
      break;
    }
    if (excluded(d.name)) continue;
    const childAbs = path.join(absPath, d.name);
    const child = await buildSubtree(
      childAbs,
      d.name,
      depth + 1,
      maxDepth,
      excluded,
      state,
    );
    children.push(child);
  }
  return { name, type: "directory", children };
}

export async function directoryTreeImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<DirectoryTreeResult>> {
  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }
  if (!stat.isDirectory()) {
    return buildError("ENOTDIR", "Path is not a directory", {
      details: { path: realPath },
    });
  }

  const excluded = compileExcludeMatcher(args.exclude_patterns ?? []);
  const state: WalkState = { nodeCount: 0, truncated: false, truncatedReason: undefined };
  const root = await buildSubtree(
    realPath,
    path.basename(realPath) || realPath,
    0,
    args.max_depth,
    excluded,
    state,
  );

  return ok({
    root,
    total_nodes: state.nodeCount,
    truncated: state.truncated,
    ...(state.truncatedReason ? { truncated_reason: state.truncatedReason } : {}),
  });
}

export function registerDirectoryTreeTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "directory_tree",
    {
      title: "Recursive directory tree as JSON",
      description: `Walk a directory recursively and return the structure as a nested
\`{name, type: 'directory' | 'file', children?: TreeNode[]}\` tree. Use this
when you want to reason about project layout in one round-trip — \`list\`
returns a flat array with a \`depth\` field; \`directory_tree\` returns the
hierarchy directly.

Args:
  - path (string): Absolute directory path inside allowedRoots
  - max_depth (1..${MAX_DEPTH_HARD_CAP}, default 3): recursion depth
  - exclude_patterns (string[], optional): basename globs to skip
    (e.g. ['node_modules', '.git', 'dist', '*.tmp']). Simple shell-style
    matching (* / ? / [...]). Case-insensitive on Windows.

Returns: { root, total_nodes, truncated, truncated_reason? }
  - \`root\` is the tree rooted at \`path\`'s basename.
  - \`total_nodes\` counts every visited entry (file + directory).
  - \`truncated: true\` if the walk hit \`max_depth\` (sub-trees clipped to
    empty \`children\`) or the hard cap of ${MAX_NODES_HARD_CAP} nodes.

Errors: EPERM_ROOT, ENOENT, ENOTDIR, ETIMEDOUT.

Companion to \`list\` (flat array view). Symlink / junction entries are
walked as files (not followed) to avoid escape-out-of-allowedRoots paths.`,
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
      runTool({ tool: "directory_tree", config }, args, (a) =>
        directoryTreeImpl(a as Input, config),
      ),
  );
}

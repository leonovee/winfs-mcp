import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";

const InputShape = {
  path: AbsolutePath,
  recursive: z.boolean().default(true).describe("Create missing parents; idempotent on existing directory."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  created: z.boolean(),
  path: z.string(),
} as const;

interface MkdirResult extends Record<string, unknown> {
  created: boolean;
  path: string;
}

export async function mkdirImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<MkdirResult>> {
  // allowMissing: the target obviously doesn't exist if we're about to create
  // it. Spec §2.2 still applies — realpath the deepest existing ancestor and
  // confirm it's inside allowedRoots before we touch the disk.
  const check = await checkAllowed(args.path, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let alreadyExists = false;
  try {
    const st = await fs.stat(realPath);
    if (st.isDirectory()) {
      alreadyExists = true;
    } else {
      return buildError("EEXIST", "Target exists but is not a directory", {
        details: { path: realPath },
      });
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") return fromNodeError(err, "stat failed");
  }

  if (alreadyExists) {
    if (args.recursive) {
      // POSIX `mkdir -p` semantics: not an error, just a no-op.
      return ok({ created: false, path: realPath });
    }
    return buildError("EEXIST", "Directory already exists", {
      hint: "Pass recursive=true to make this call idempotent.",
      details: { path: realPath },
    });
  }

  try {
    await fs.mkdir(realPath, { recursive: args.recursive });
  } catch (err) {
    return fromNodeError(err, "mkdir failed");
  }
  return ok({ created: true, path: realPath });
}

export function registerMkdirTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "mkdir",
    {
      title: "Create directory (recursive by default)",
      description: `Create a directory. With recursive=true (default) missing parents are created and
calling on an existing directory is a no-op (created=false). With recursive=false, calling on
an existing directory returns EEXIST.

Args:
  - path (string): Absolute directory path inside allowedRoots
  - recursive (boolean, default true): mkdir -p semantics

Returns: { created, path }
Errors: EPERM_ROOT, EEXIST (recursive=false + already exists, or target is a file), EIO.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "mkdir", config }, args, (a) => mkdirImpl(a as Input, config)),
  );
}

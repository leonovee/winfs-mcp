import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { ok, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";

const InputShape = { path: AbsolutePath } as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  exists: z.boolean(),
  is_dir: z.boolean().optional(),
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
  ctime: z.string().optional(),
  mode: z.string().optional(),
} as const;

interface StatResult extends Record<string, unknown> {
  exists: boolean;
  is_dir?: boolean;
  size?: number;
  mtime?: string;
  ctime?: string;
  mode?: string;
}

export async function statImpl(args: Input, config: ResolvedConfig): Promise<Result<StatResult>> {
  // For stat we want allowMissing so non-existent paths get `{exists:false}`
  // instead of ENOENT (spec §4.1 stat behavior).
  const check = await checkAllowed(args.path, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  try {
    const st = await fs.stat(realPath);
    return ok({
      exists: true,
      is_dir: st.isDirectory(),
      size: st.size,
      mtime: st.mtime.toISOString(),
      ctime: st.ctime.toISOString(),
      mode: "0o" + (st.mode & 0o777).toString(8).padStart(3, "0"),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      return ok({ exists: false });
    }
    // Any other error: fall through to a "doesn't exist for us" answer
    // rather than leaking platform-specific errno values.
    return ok({ exists: false });
  }
}

export function registerStatTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "stat",
    {
      title: "Path metadata (no throw on missing)",
      description: `Return metadata for a path. Unlike read/list, a missing path returns
\`{exists: false}\` rather than ENOENT — this is the intended self-orientation behavior.
EPERM_ROOT still applies if the (resolved) path is outside allowedRoots.

Args: { path: absolute path inside allowedRoots }
Returns: { exists, is_dir?, size?, mtime?, ctime?, mode? }`,
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
      runTool({ tool: "stat", config }, args, (a) => statImpl(a as Input, config)),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { ok, type Result } from "../../core/errors.js";

const InputShape = {} as const;
export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  allowed_roots: z.array(z.string()),
  allowed_url_hosts: z.array(z.string()),
} as const;

interface ListAllowedResult extends Record<string, unknown> {
  allowed_roots: string[];
  allowed_url_hosts: string[];
}

/**
 * Read-only self-orientation. Returns only the two arrays Claude needs to
 * decide where it can read/write. Deliberately does NOT echo blocklists,
 * timeouts, audit path, etc. — see spec amendment 2026-05-16 §D.
 */
export async function listAllowedDirectoriesImpl(
  _args: Input,
  config: ResolvedConfig,
): Promise<Result<ListAllowedResult>> {
  return ok({
    allowed_roots: [...config.resolvedAllowedRoots],
    allowed_url_hosts: [...config.allowedUrlHosts],
  });
}

export function registerListAllowedDirectoriesTool(
  server: McpServer,
  config: ResolvedConfig,
): void {
  server.registerTool(
    "list_allowed_directories",
    {
      title: "Show the sandbox boundary",
      description: `Return the canonical allowed filesystem roots and the URL host allowlist for the
current server. Read-only; never touches the filesystem. Intended as a
self-orientation tool so Claude can decide which paths are accessible
before attempting any read/write/list/stat call.

Args: {} (none)
Returns: { allowed_roots: string[], allowed_url_hosts: string[] }

The output is intentionally minimal — blocklists, timeouts and the audit
log path are not exposed.`,
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
      runTool({ tool: "list_allowed_directories", config }, args, (a) =>
        listAllowedDirectoriesImpl(a as Input, config),
      ),
  );
}

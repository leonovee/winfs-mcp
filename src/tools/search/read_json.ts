import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { readImpl } from "../fs/read.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  path: AbsolutePath,
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  data: z.unknown(),
  size_bytes: z.number().int().nonnegative(),
} as const;

interface ReadJsonResult extends Record<string, unknown> {
  data: unknown;
  size_bytes: number;
}

/**
 * Extract a 1-based line/column + a short snippet from a SyntaxError message
 * produced by V8's JSON parser. Failures here are non-fatal — we just return
 * what we can so the caller still gets a useful error.
 */
function parsePosition(content: string, message: string): {
  line?: number;
  column?: number;
  snippet?: string;
} {
  const posMatch = message.match(/position (\d+)/);
  if (posMatch) {
    const offset = Math.min(parseInt(posMatch[1]!, 10), content.length);
    let line = 1;
    let col = 1;
    for (let i = 0; i < offset; i++) {
      if (content[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    const start = Math.max(0, offset - 20);
    const end = Math.min(content.length, offset + 20);
    return { line, column: col, snippet: content.slice(start, end) };
  }
  // Node 22+ messages drop the explicit position. Fall back to a leading
  // content snippet so the caller still has something to grep against. We
  // strip leading whitespace + newlines for compactness.
  const fallback = content.replace(/^\s+/, "").slice(0, 80);
  return fallback.length > 0 ? { snippet: fallback } : {};
}

export async function readJsonImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<ReadJsonResult>> {
  const inner = await readImpl({ path: args.path }, config);
  if (!inner.ok) {
    return inner;
  }
  if (inner.value.truncated) {
    return buildError("ETOOLARGE", "JSON file exceeds read cap", {
      details: { path: args.path, bytes_returned: inner.value.bytes_returned },
      hint: "Raise readMaxBytes or split the document.",
    });
  }

  let data: unknown;
  try {
    data = JSON.parse(inner.value.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const pos = parsePosition(inner.value.content, msg);
    return buildError("EBADJSON", `JSON parse failed: ${msg}`, {
      details: { path: args.path, ...pos },
      hint: "Use read to inspect the surrounding bytes before fixing.",
    });
  }
  return ok({ data, size_bytes: inner.value.bytes_returned });
}

export function registerReadJsonTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "read_json",
    {
      title: "Read + JSON.parse a file in one call",
      description: `Read a JSON file and return the parsed value. Wraps the v0.1 \`read\` tool —
allowedRoots, BOM stripping, ETOOLARGE and EENCODING semantics are identical. Parse failures
return a distinct \`EBADJSON\` error code with line / column / snippet in details so the
caller can fix the file without a separate read+inspect round trip.

Args:
  - path (string): Absolute path inside allowedRoots

Returns: { data: unknown, size_bytes: number }
Errors: EPERM_ROOT, ENOENT, EISDIR, ETOOLARGE, EENCODING, EBADJSON.`,
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
      runTool({ tool: "read_json", config }, args, (a) =>
        readJsonImpl(a as Input, config),
      ),
  );
}

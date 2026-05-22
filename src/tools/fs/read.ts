import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import {
  decodeUtf8StripBom,
  looksBinary,
  tryDecodeUtf8Strict,
} from "../../core/utf8.js";
import { AbsolutePath, LineRange } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  path: AbsolutePath,
  range: LineRange.optional(),
  head: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Return only the FIRST N lines. Convenience shorthand equivalent to `range: [1, N]`. Mutually exclusive with `tail` and `range`.",
    ),
  tail: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Return only the LAST N lines. Convenience shorthand for log-inspection. Mutually exclusive with `head` and `range`.",
    ),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Hard cap on bytes returned. Defaults to config.readMaxBytes."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  content: z.string(),
  lines_returned: z.number().int().nonnegative(),
  bytes_returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
} as const;

interface ReadResult extends Record<string, unknown> {
  content: string;
  lines_returned: number;
  bytes_returned: number;
  truncated: boolean;
}

export async function readImpl(args: Input, config: ResolvedConfig): Promise<Result<ReadResult>> {
  // v0.8: `head` / `tail` / `range` are mutually exclusive — at most one.
  const selectorCount =
    (args.range !== undefined ? 1 : 0) +
    (args.head !== undefined ? 1 : 0) +
    (args.tail !== undefined ? 1 : 0);
  if (selectorCount > 1) {
    return buildError(
      "EINVAL",
      "at most one of `range`, `head`, `tail` may be specified",
      { details: { has_range: args.range !== undefined, has_head: args.head !== undefined, has_tail: args.tail !== undefined } },
    );
  }

  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }
  if (stat.isDirectory()) {
    return buildError("EISDIR", "Expected a file, got a directory", {
      hint: "Use list for directories",
      details: { path: realPath },
    });
  }

  const maxBytes = args.max_bytes ?? config.readMaxBytes;
  const hasSelector = args.range !== undefined || args.head !== undefined || args.tail !== undefined;
  if (stat.size > maxBytes && !hasSelector) {
    return buildError("ETOOLARGE", `File exceeds max_bytes`, {
      details: { path: realPath, size: stat.size, max_bytes: maxBytes },
      hint: `Pass range:[start,end] / head:N / tail:N, or raise max_bytes (current limit ${maxBytes}).`,
    });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath);
  } catch (err) {
    return fromNodeError(err, "read failed");
  }

  if (looksBinary(buf)) {
    return buildError("EENCODING", "File appears to be binary or non-UTF-8", {
      hint: "Binary files are not supported in v0.1.",
      details: { path: realPath, size: buf.length },
    });
  }

  const strict = tryDecodeUtf8Strict(buf);
  if (strict === undefined) {
    return buildError("EENCODING", "File is not valid UTF-8", {
      details: { path: realPath, size: buf.length },
    });
  }

  let text = strict;
  let truncated = false;
  let linesReturned: number;

  // v0.8: head / tail compose to the existing range path. head:N → range [1,N].
  // tail:N → range [max(1, totalLines - N + 1), totalLines]. Both pass through
  // the same range-slicing + byte-cap logic so behaviour is identical to an
  // explicit range with the same end coordinates.
  let effectiveRange: [number, number] | undefined;
  if (args.range) {
    effectiveRange = args.range;
  } else if (args.head !== undefined) {
    effectiveRange = [1, args.head];
  } else if (args.tail !== undefined) {
    const totalLines = text.split(/\r?\n/).length;
    const start = Math.max(1, totalLines - args.tail + 1);
    effectiveRange = [start, totalLines];
  }

  if (effectiveRange) {
    const [start, end] = effectiveRange;
    const lines = text.split(/\r?\n/);
    const clampedEnd = Math.min(end, lines.length);
    if (start > lines.length) {
      return buildError("EINVAL", "range start past end of file", {
        details: { start, end, total_lines: lines.length },
      });
    }
    const slice = lines.slice(start - 1, clampedEnd);
    text = slice.join("\n");
    linesReturned = slice.length;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      // Hard cap even for ranged reads.
      const limitedBuf = Buffer.from(text, "utf8").subarray(0, maxBytes);
      const limited = decodeUtf8StripBom(limitedBuf);
      return ok({
        content: limited,
        lines_returned: limited.split(/\r?\n/).length,
        bytes_returned: Buffer.byteLength(limited, "utf8"),
        truncated: true,
      });
    }
    return ok({
      content: text,
      lines_returned: linesReturned,
      bytes_returned: bytes,
      truncated: clampedEnd < end,
    });
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    const limitedBuf = Buffer.from(text, "utf8").subarray(0, maxBytes);
    text = decodeUtf8StripBom(limitedBuf);
    truncated = true;
  }
  linesReturned = text.length === 0 ? 0 : text.split(/\r?\n/).length;

  return ok({
    content: text,
    lines_returned: linesReturned,
    bytes_returned: Buffer.byteLength(text, "utf8"),
    truncated,
  });
}

export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "read",
    {
      title: "Read text file (UTF-8)",
      description: `Read a text file as UTF-8 with optional 1-based inclusive line range and byte cap.

Args:
  - path (string): Absolute path inside allowedRoots
  - range ([number, number], optional): [start_line, end_line], 1-based inclusive
  - head (number, optional): return first N lines (= range [1, N])
  - tail (number, optional): return last N lines (log-inspection shortcut)
  - max_bytes (number, optional): byte cap, default ${config.readMaxBytes}

\`range\` / \`head\` / \`tail\` are mutually exclusive — at most one. Passing two → EINVAL.

Returns: { content, lines_returned, bytes_returned, truncated }

Errors: EPERM_ROOT (path outside allowedRoots), ENOENT, EISDIR, ETOOLARGE, EENCODING, ETIMEDOUT.

BOM is stripped on read; binary files are rejected with EENCODING.`,
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
      runTool({ tool: "read", config }, args, (a) => readImpl(a as Input, config)),
  );
}

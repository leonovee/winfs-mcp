import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { tryDecodeUtf8Strict, decodeUtf8StripBom, hasUtf8Bom } from "../../core/utf8.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  path: AbsolutePath,
  line_range: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .refine(([a, b]) => a <= b, { message: "line_range start must be <= end" })
    .optional()
    .describe("[start, end] inclusive, 1-based. Mutually exclusive with byte_range."),
  byte_range: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .refine(([a, b]) => a <= b, { message: "byte_range start must be <= end" })
    .optional()
    .describe("[start, end] inclusive, 0-based. Mutually exclusive with line_range."),
  encoding: z
    .union([z.literal("utf8"), z.literal("raw")])
    .default("utf8")
    .describe("With byte_range: utf8 trims to valid UTF-8 boundaries; raw returns base64."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  content: z.string(),
  range: z.object({
    kind: z.union([z.literal("line"), z.literal("byte")]),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
  total_lines: z.number().int().nonnegative().optional(),
  total_bytes: z.number().int().nonnegative(),
  adjusted: z.boolean().optional(),
  encoding: z.union([z.literal("utf8"), z.literal("raw")]),
} as const;

interface ReadSectionResult extends Record<string, unknown> {
  content: string;
  range: { kind: "line" | "byte"; start: number; end: number };
  total_lines?: number;
  total_bytes: number;
  adjusted?: boolean;
  encoding: "utf8" | "raw";
}

/**
 * Find the byte index of the start of a valid UTF-8 code point at-or-after
 * `offset`. UTF-8 continuation bytes are `10xxxxxx` (0x80..0xBF); a code
 * point starts at any byte that is NOT a continuation byte. Walks at most 3
 * bytes forward — beyond that the buffer isn't UTF-8 in the interior.
 */
function nextUtf8Boundary(buf: Buffer, offset: number): number {
  for (let i = offset; i < Math.min(buf.length, offset + 4); i++) {
    if ((buf[i]! & 0xc0) !== 0x80) return i;
  }
  return offset;
}

/**
 * Find the byte index just past the last complete UTF-8 code point with end
 * at-or-before `offset`. Walks backward at most 3 bytes.
 */
function prevUtf8Boundary(buf: Buffer, offset: number): number {
  // offset is exclusive end. Step back to find the last byte that is NOT a
  // continuation; the code point ends right after the last continuation.
  let end = offset;
  for (let i = 0; i < 4 && end > 0; i++) {
    const b = buf[end - 1]!;
    if ((b & 0x80) === 0) return end; // ASCII
    if ((b & 0xc0) === 0xc0) {
      // Lead byte — does the run between here and `offset` make a complete
      // code point? Quick approximation: count continuation bytes and see
      // if the lead's high bits match.
      const contCount = offset - end;
      if ((b & 0xe0) === 0xc0 && contCount === 1) return end + 1; // 2-byte
      if ((b & 0xf0) === 0xe0 && contCount === 2) return end + 1; // 3-byte
      if ((b & 0xf8) === 0xf0 && contCount === 3) return end + 1; // 4-byte
      // Lead with too few continuations following — trim this lead off.
      return end - 1;
    }
    end--;
  }
  return end;
}

export async function readSectionImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<ReadSectionResult>> {
  const hasLine = args.line_range !== undefined;
  const hasByte = args.byte_range !== undefined;
  if (hasLine === hasByte) {
    return buildError(
      "EINVAL",
      hasLine
        ? "exactly one of line_range or byte_range must be provided (both supplied)"
        : "exactly one of line_range or byte_range must be provided (neither supplied)",
      { details: { path: args.path } },
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
      details: { path: realPath },
    });
  }
  const totalBytes = stat.size;

  if (hasByte) {
    const [start, end] = args.byte_range!;
    if (totalBytes === 0) {
      return buildError("EINVAL", "byte_range invalid: file is empty", {
        details: { path: realPath, total_bytes: 0 },
      });
    }
    if (end >= totalBytes) {
      return buildError("EINVAL", "byte_range end is past EOF", {
        details: { path: realPath, end, total_bytes: totalBytes },
      });
    }
    const length = end - start + 1;
    if (length > config.readMaxBytes) {
      return buildError("ETOOLARGE", "byte_range exceeds readMaxBytes", {
        details: { path: realPath, requested_bytes: length, max_bytes: config.readMaxBytes },
      });
    }
    const buf = Buffer.alloc(length);
    let bytesRead: number;
    try {
      const fh = await fs.open(realPath, "r");
      try {
        ({ bytesRead } = await fh.read(buf, 0, length, start));
      } finally {
        await fh.close();
      }
    } catch (err) {
      return fromNodeError(err, "read failed");
    }
    const slice = buf.subarray(0, bytesRead);

    if (args.encoding === "raw") {
      return ok({
        content: slice.toString("base64"),
        range: { kind: "byte", start, end },
        total_bytes: totalBytes,
        encoding: "raw",
      });
    }

    // UTF-8: trim to valid boundaries. We trim FRONT first (advance past
    // partial continuations) and BACK second (cut off an incomplete trailing
    // code point). Adjustment is recorded if either trim shrunk the slice.
    const frontBoundary = nextUtf8Boundary(slice, 0);
    const trimmed = slice.subarray(frontBoundary);
    const backBoundary = prevUtf8Boundary(trimmed, trimmed.length);
    const finalSlice = trimmed.subarray(0, backBoundary);
    const adjusted = frontBoundary !== 0 || backBoundary !== trimmed.length;

    const text = tryDecodeUtf8Strict(finalSlice);
    if (text === undefined) {
      return buildError("EENCODING", "byte_range slice fails strict UTF-8 decode", {
        details: { path: realPath, start, end },
        hint: "Interior bytes are not valid UTF-8; consider encoding:\"raw\".",
      });
    }
    return ok({
      content: text,
      range: { kind: "byte", start, end },
      total_bytes: totalBytes,
      ...(adjusted ? { adjusted: true } : {}),
      encoding: "utf8",
    });
  }

  // line_range path
  const [startLine, endLine] = args.line_range!;
  if (totalBytes === 0) {
    return buildError("EINVAL", "line_range invalid: file is empty", {
      details: { path: realPath, total_bytes: 0 },
    });
  }
  if (totalBytes > config.readMaxBytes) {
    return buildError("ETOOLARGE", "file exceeds readMaxBytes; use byte_range to slice", {
      details: { path: realPath, total_bytes: totalBytes, max_bytes: config.readMaxBytes },
    });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath);
  } catch (err) {
    return fromNodeError(err, "read failed");
  }

  // We strip a leading BOM for line counting + content, mirroring read.ts.
  const decoded = decodeUtf8StripBom(buf);
  const text = tryDecodeUtf8Strict(buf);
  if (text === undefined) {
    return buildError("EENCODING", "file fails strict UTF-8 decode", {
      details: { path: realPath },
    });
  }
  // Re-use the BOM-stripped variant for splitting so line indices align with
  // what `read` would report.
  const _bomLen = hasUtf8Bom(buf) ? 3 : 0;
  void _bomLen;
  const lines = decoded.split("\n");
  // Spec §J: trailing \n produces an empty final element; drop it from the
  // count so "a\nb\n" has 2 lines, "a\nb" also has 2, "a\nb\nc" has 3.
  const totalLines =
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (startLine > totalLines) {
    return buildError("EINVAL", "line_range start past EOF", {
      details: { path: realPath, start: startLine, total_lines: totalLines },
    });
  }
  if (endLine > totalLines) {
    return buildError("EINVAL", "line_range end past EOF", {
      details: { path: realPath, end: endLine, total_lines: totalLines },
    });
  }
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  if (Buffer.byteLength(slice, "utf8") > config.readMaxBytes) {
    return buildError("ETOOLARGE", "line_range slice exceeds readMaxBytes", {
      details: { path: realPath, bytes: Buffer.byteLength(slice, "utf8") },
    });
  }
  return ok({
    content: slice,
    range: { kind: "line", start: startLine, end: endLine },
    total_lines: totalLines,
    total_bytes: totalBytes,
    encoding: "utf8",
  });
}

export function registerReadSectionTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "read_section",
    {
      title: "Read a line or byte slice of a file",
      description: `Slice a file by line range OR byte range. Exactly one selector must be provided.

Line ranges (\`line_range: [start, end]\`) are 1-based, inclusive. Lines split on \`\\n\`; \`\\r\`
stays attached to the line. Counting: \`a\\nb\\n\` has 2 lines, \`a\\nb\` also has 2, \`a\\nb\\nc\`
has 3.

Byte ranges (\`byte_range: [start, end]\`) are 0-based, inclusive. With \`encoding: "utf8"\`
(default) the slice is trimmed to the largest valid UTF-8 substring inside the requested
range — response includes \`adjusted: true\` if a boundary trim happened. \`encoding: "raw"\`
returns the exact byte slice as base64.

Args:
  - path (string): absolute path inside allowedRoots
  - line_range ([number, number]): inclusive, 1-based
  - byte_range ([number, number]): inclusive, 0-based
  - encoding ("utf8"|"raw", default "utf8"): byte_range only

Returns: { content, range, total_lines?, total_bytes, adjusted?, encoding }
Errors: EPERM_ROOT, ENOENT, EISDIR, EINVAL (mutex / range bounds), ETOOLARGE, EENCODING (interior decode failure), ETIMEDOUT.`,
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
      runTool({ tool: "read_section", config }, args, (a) =>
        readSectionImpl(a as Input, config),
      ),
  );
}

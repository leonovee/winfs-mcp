import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { tryDecodeUtf8Strict } from "../../core/utf8.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_CAP_BYTES = 1024 * 1024;

const InputShape = {
  path: AbsolutePath,
  since_offset: z
    .number()
    .int()
    .nonnegative()
    .describe("Byte offset from a previous call. 0 = start of file."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(HARD_CAP_BYTES)
    .optional()
    .describe(`Cap on bytes returned. Default ${DEFAULT_MAX_BYTES}, hard cap ${HARD_CAP_BYTES}.`),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  content: z.string(),
  new_offset: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  mtime: z.string(),
  truncated: z.boolean(),
  file_rotated: z.boolean(),
} as const;

interface ReadSinceResult extends Record<string, unknown> {
  content: string;
  new_offset: number;
  total_bytes: number;
  mtime: string;
  truncated: boolean;
  file_rotated: boolean;
}

/** Advance offset forward past any UTF-8 continuation bytes (0x80..0xBF).
 *  Returns the new offset and the number of bytes skipped. */
function advanceToUtf8Boundary(buf: Buffer, offset: number): { offset: number; skipped: number } {
  let cur = offset;
  while (cur < buf.length && (buf[cur]! & 0xc0) === 0x80) cur++;
  return { offset: cur, skipped: cur - offset };
}

/** Trim the end back to the last complete UTF-8 code point boundary. Walks
 *  back at most 3 bytes (max continuation run for a 4-byte code point). */
function backToUtf8Boundary(buf: Buffer, end: number): number {
  let cur = end;
  for (let steps = 0; steps < 4 && cur > 0; steps++) {
    const b = buf[cur - 1]!;
    if ((b & 0x80) === 0) return cur;
    if ((b & 0xc0) === 0xc0) {
      const contCount = end - cur;
      if ((b & 0xe0) === 0xc0 && contCount === 1) return end;
      if ((b & 0xf0) === 0xe0 && contCount === 2) return end;
      if ((b & 0xf8) === 0xf0 && contCount === 3) return end;
      return cur - 1;
    }
    cur--;
  }
  return cur;
}

export async function readSinceImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<ReadSinceResult>> {
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
  const mtime = stat.mtime.toISOString();
  const cap = args.max_bytes ?? DEFAULT_MAX_BYTES;

  // Rotation: file shrank below the prior offset. Return whole file.
  if (totalBytes < args.since_offset) {
    const readSize = Math.min(totalBytes, cap);
    const buf = Buffer.alloc(readSize);
    let bytesRead = 0;
    try {
      const fh = await fs.open(realPath, "r");
      try {
        ({ bytesRead } = await fh.read(buf, 0, readSize, 0));
      } finally {
        await fh.close();
      }
    } catch (err) {
      return fromNodeError(err, "read failed (rotation path)");
    }
    const trimmedEnd = backToUtf8Boundary(buf, bytesRead);
    const slice = buf.subarray(0, trimmedEnd);
    const text = tryDecodeUtf8Strict(slice);
    if (text === undefined) {
      return buildError("EENCODING", "rotated file content fails strict UTF-8 decode", {
        details: { path: realPath, total_bytes: totalBytes },
      });
    }
    return ok({
      content: text,
      new_offset: trimmedEnd,
      total_bytes: totalBytes,
      mtime,
      truncated: trimmedEnd < totalBytes,
      file_rotated: true,
    });
  }

  // Steady state: no new data.
  if (totalBytes === args.since_offset) {
    return ok({
      content: "",
      new_offset: args.since_offset,
      total_bytes: totalBytes,
      mtime,
      truncated: false,
      file_rotated: false,
    });
  }

  // Append path. We may need to advance past partial UTF-8 continuation bytes
  // (offset landed mid-multibyte). Read a small probe up to 4 bytes earlier
  // to detect the boundary; if since_offset is at a lead-byte boundary
  // already, no advance happens.
  const delta = totalBytes - args.since_offset;
  const readSize = Math.min(delta, cap);
  const truncated = delta > cap;

  // Read into a generously-sized buffer so we can examine the prefix for
  // UTF-8 alignment without a separate syscall.
  const buf = Buffer.alloc(readSize);
  let bytesRead = 0;
  try {
    const fh = await fs.open(realPath, "r");
    try {
      ({ bytesRead } = await fh.read(buf, 0, readSize, args.since_offset));
    } finally {
      await fh.close();
    }
  } catch (err) {
    return fromNodeError(err, "read failed");
  }
  const usable = buf.subarray(0, bytesRead);

  const { offset: startAdj, skipped } = advanceToUtf8Boundary(usable, 0);
  if (skipped > 3) {
    return buildError("EENCODING", "since_offset skipped more than 4 UTF-8 continuation bytes (likely corruption)", {
      details: { path: realPath, since_offset: args.since_offset, skipped_bytes: skipped },
    });
  }
  const endTrim = backToUtf8Boundary(usable, usable.length);
  const finalSlice = usable.subarray(startAdj, endTrim);

  const text = tryDecodeUtf8Strict(finalSlice);
  if (text === undefined) {
    return buildError("EENCODING", "appended content fails strict UTF-8 decode", {
      details: { path: realPath, since_offset: args.since_offset },
    });
  }
  const newOffset = args.since_offset + startAdj + finalSlice.length;
  return ok({
    content: text,
    new_offset: newOffset,
    total_bytes: totalBytes,
    mtime,
    truncated,
    file_rotated: false,
  });
}

export function registerReadSinceTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "read_since",
    {
      title: "Incremental tail — read content appended since a byte offset",
      description: `Read the bytes of \`path\` from \`since_offset\` to the current end. Designed for
log / build-output tailing — caller passes back the prior call's \`new_offset\` and gets only
the delta.

Steady state (\`since_offset === total_bytes\`) returns empty content. Append returns the
delta, capped at \`max_bytes\` (default ${DEFAULT_MAX_BYTES}, hard cap ${HARD_CAP_BYTES}).

Rotation detected when \`total_bytes < since_offset\`: response has \`file_rotated: true\` and
returns the whole (now-smaller) file with \`new_offset === total_bytes\`. Caller should pass
the new offset on the next call.

UTF-8 boundary: if \`since_offset\` falls mid-multibyte, the read advances forward to the
next valid boundary (silent skip up to 3 bytes). >4 byte skip → EENCODING (real corruption).

Args:
  - path (string): absolute path inside allowedRoots
  - since_offset (number): non-negative integer byte offset
  - max_bytes (number, optional): cap on returned chunk

Returns: { content, new_offset, total_bytes, mtime, truncated, file_rotated }
Errors: EPERM_ROOT, ENOENT, EISDIR, EINVAL (negative offset; Zod-enforced), EENCODING, ETIMEDOUT.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "read_since", config }, args, (a) =>
        readSinceImpl(a as Input, config),
      ),
  );
}

import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";

const AUDIT_PREFIX_CAP = 256;

const InputShape = {
  path: AbsolutePath,
  offset: z
    .number()
    .int()
    .nonnegative()
    .describe("Byte offset, 0..file_size inclusive. Strictly > file_size → EOFFSET."),
  content: z.string().describe("Payload bytes (decoded per `encoding`)."),
  encoding: z
    .union([z.literal("utf8"), z.literal("base64")])
    .default("utf8"),
  validate_byte_range: z
    .boolean()
    .default(true)
    .describe(
      "When encoding=utf8 (default), check that the boundaries at `offset` and `offset+content_length` align with existing UTF-8 code-point boundaries. Set false to skip (still validates that `content` itself is valid UTF-8).",
    ),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  path: z.string(),
  offset: z.number().int().nonnegative(),
  bytes_written: z.number().int().nonnegative(),
  total_bytes_after: z.number().int().nonnegative(),
  atomic: z.literal(false),
} as const;

interface WriteChunkResult extends Record<string, unknown> {
  path: string;
  offset: number;
  bytes_written: number;
  total_bytes_after: number;
  atomic: false;
}

interface WriteChunkAuditExtras {
  content_length: number;
  content_prefix: string;
  truncated_at: number;
}

const auditByResult = new WeakMap<object, WriteChunkAuditExtras>();

export function getWriteChunkAuditExtras(
  value: WriteChunkResult,
): WriteChunkAuditExtras | undefined {
  return auditByResult.get(value);
}

function isUtf8Continuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/** Round-trip validation: re-encoding a string and comparing to the original
 *  buffer detects invalid UTF-8 (Node's toString replaces with U+FFFD silently
 *  otherwise). */
function isValidUtf8(buf: Buffer): boolean {
  const text = buf.toString("utf8");
  const reEncoded = Buffer.from(text, "utf8");
  return reEncoded.equals(buf);
}

/** Probe a single byte at `offset` in `path`. Returns the byte or undefined if
 *  the file ends before that offset. Throws on I/O failure. */
async function probeByteAt(path: string, offset: number): Promise<number | undefined> {
  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(1);
    const { bytesRead } = await fh.read(buf, 0, 1, offset);
    if (bytesRead === 0) return undefined;
    return buf[0];
  } finally {
    await fh.close();
  }
}

export async function writeChunkImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<WriteChunkResult>> {
  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  // Decode content per encoding.
  let buf: Buffer;
  if (args.encoding === "base64") {
    // Node accepts non-base64 chars silently; verify by re-encoding.
    const candidate = Buffer.from(args.content, "base64");
    if (candidate.toString("base64").replace(/=+$/, "") !==
        args.content.replace(/=+$/, "").replace(/\s+/g, "")) {
      // Soft check — Node is liberal with whitespace; we just confirm the
      // decoded length is consistent with a valid base64 input.
      // If the user passed garbage, we still write what Node decoded.
    }
    buf = candidate;
  } else {
    // utf8: always validate the content itself is valid UTF-8, regardless of
    // validate_byte_range (that flag controls the *file-boundary* check).
    buf = Buffer.from(args.content, "utf8");
    if (!isValidUtf8(buf)) {
      return buildError("EENCODING", "content is not valid UTF-8", {
        details: { content_bytes: buf.length },
      });
    }
  }

  // Stat the file (must exist; write_chunk does NOT create).
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }
  if (stat.isDirectory()) {
    return buildError("EISDIR", "path is a directory; write_chunk requires a regular file", {
      details: { path: realPath },
    });
  }

  // Invariant #32: offset strictly bounded; no sparse-file creation.
  if (args.offset > stat.size) {
    return buildError("EOFFSET", "offset > file_size_before (sparse-file creation forbidden)", {
      details: { offset: args.offset, file_size: stat.size },
      hint: "Use offset <= file_size. Append-at-EOF works with offset = file_size.",
    });
  }

  // Size cap.
  const finalSize = Math.max(stat.size, args.offset + buf.length);
  if (finalSize > config.readMaxBytes) {
    return buildError("ETOOLARGE", "post-write file size would exceed readMaxBytes", {
      details: {
        offset: args.offset,
        content_length: buf.length,
        post_write_size: finalSize,
        max_bytes: config.readMaxBytes,
      },
    });
  }

  // Invariant #33: UTF-8 boundary check at offset and offset+content_length.
  // Skipped when encoding!=utf8 or validate_byte_range=false.
  if (args.encoding === "utf8" && args.validate_byte_range) {
    // Boundary 1: byte at `offset` in the existing file must not be a
    // continuation byte (we'd be overwriting mid-multibyte).
    if (args.offset > 0 && args.offset < stat.size) {
      let probe: number | undefined;
      try {
        probe = await probeByteAt(realPath, args.offset);
      } catch (err) {
        return fromNodeError(err, "boundary probe at offset failed");
      }
      if (probe !== undefined && isUtf8Continuation(probe)) {
        return buildError(
          "EENCODING",
          "offset lands mid-UTF-8 multi-byte sequence in the existing file",
          {
            details: { offset: args.offset, byte: probe },
            hint: "Choose an offset that aligns with a UTF-8 code-point boundary, or pass validate_byte_range: false.",
          },
        );
      }
    }
    // Boundary 2: byte at `offset + buf.length` in the existing file must not
    // be a continuation byte (we'd leave a broken multibyte after our write).
    const endOffset = args.offset + buf.length;
    if (endOffset < stat.size) {
      let probe: number | undefined;
      try {
        probe = await probeByteAt(realPath, endOffset);
      } catch (err) {
        return fromNodeError(err, "boundary probe at end_offset failed");
      }
      if (probe !== undefined && isUtf8Continuation(probe)) {
        return buildError(
          "EENCODING",
          "offset+content_length lands mid-UTF-8 multi-byte sequence in the existing file",
          {
            details: { end_offset: endOffset, byte: probe },
            hint: "Choose a content length that aligns with a UTF-8 code-point boundary, or pass validate_byte_range: false.",
          },
        );
      }
    }
  }

  // Perform the in-place write. r+ mode: opens for read+write, fails if file
  // doesn't exist (which we already verified above via fs.stat).
  let bytesWritten: number;
  try {
    const fh = await fs.open(realPath, "r+");
    try {
      const writeRes = await fh.write(buf, 0, buf.length, args.offset);
      bytesWritten = writeRes.bytesWritten;
    } finally {
      await fh.close();
    }
  } catch (err) {
    return fromNodeError(err, "in-place write failed");
  }

  // Re-stat for total_bytes_after.
  let postStat: import("node:fs").Stats;
  try {
    postStat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "post-write stat failed");
  }

  const value: WriteChunkResult = {
    path: realPath,
    offset: args.offset,
    bytes_written: bytesWritten,
    total_bytes_after: postStat.size,
    atomic: false,
  };
  auditByResult.set(value, {
    content_length: buf.length,
    content_prefix: args.content.slice(0, AUDIT_PREFIX_CAP),
    truncated_at: AUDIT_PREFIX_CAP,
  });
  return ok(value);
}

export function registerWriteChunkTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "write_chunk",
    {
      title: "Byte-offset in-place file write (NOT atomic)",
      description: `**This tool performs IN-PLACE writes. A crash or power failure mid-write can leave
the file partially modified. Use \`write\` (atomic) for whole-file replacement.**

\`write_chunk\` opens the file with \`r+\`, writes \`content\` at \`offset\` directly, and
closes — no temp file, no fsync, no atomic rename. The write may naturally extend the file
when \`offset + content_length > file_size_before\`; sparse-file creation is forbidden
(\`offset > file_size_before\` → \`EOFFSET\`).

UTF-8 boundary check (invariant #33): when \`encoding\` = "utf8" (default) and
\`validate_byte_range\` = true (default), both the boundary at \`offset\` and the boundary
at \`offset + content_length\` MUST align with existing UTF-8 code-point boundaries.
Mid-multibyte → \`EENCODING\`. Prevents producing a file that's valid UTF-8 before and after
the chunk but corrupted at the seam. Set \`validate_byte_range\` false to skip the boundary
check (the content-validity check on the payload itself still runs).

Args:
  - path (string): absolute path inside allowedRoots (or anywhere in unrestricted mode)
  - offset (number): byte offset, 0..file_size inclusive
  - content (string): payload (decoded per \`encoding\`)
  - encoding ("utf8" | "base64", default "utf8")
  - validate_byte_range (boolean, default true)

Returns: { path, offset, bytes_written, total_bytes_after, atomic: false }

Errors:
  - EPERM_ROOT (strict mode + outside allowedRoots)
  - ENOENT (file must exist; tool does NOT create)
  - EISDIR
  - EOFFSET (offset > file_size_before)
  - EENCODING (invalid UTF-8 content, or boundary misalign)
  - ETOOLARGE (post-write size > readMaxBytes)
  - ETIMEDOUT

Audit log records {path, offset, content_length, content_prefix (first 256 chars),
truncated_at, mode}. Full content is NEVER persisted — same redaction policy as
\`edit_file.edits[].new_str\`.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        {
          tool: "write_chunk",
          config,
          auditExtras: (result) => {
            const a = args as Input;
            const base = {
              offset: a.offset,
              content_length: Buffer.byteLength(a.content, a.encoding === "base64" ? "base64" : "utf8"),
            };
            if (!result.ok) return base;
            const extras = getWriteChunkAuditExtras(result.value as WriteChunkResult);
            return extras ? { ...base, ...extras } : base;
          },
        },
        args,
        (a) => writeChunkImpl(a as Input, config),
      ),
  );
}

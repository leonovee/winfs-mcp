import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

// Default cap: 16 MB. Media files of practical interest (screenshots,
// short audio clips, small video) are well under this. Caller can lower
// via max_bytes; cannot raise above the config-driven hard cap.
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

// Conservative content-type lookup. We don't pretend to be a full
// MIME database — this map covers the common media types where
// returning the right Content-Type matters for downstream
// (image rendering, audio playback, etc.). Unknown extensions fall
// back to application/octet-stream.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

const InputShape = {
  path: AbsolutePath,
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Hard cap on bytes read. Default ${DEFAULT_MAX_BYTES} (16 MB); caller cannot exceed config.readMaxBytes. Exceeds → ESIZE before any read.`,
    ),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  base64: z.string(),
  content_type: z.string(),
  bytes_read: z.number().int().nonnegative(),
  truncated: z.boolean(),
} as const;

interface ReadMediaResult extends Record<string, unknown> {
  base64: string;
  content_type: string;
  bytes_read: number;
  truncated: boolean;
}

/**
 * Stream a binary file in 64 KB chunks and concatenate to a single Buffer.
 * Streaming avoids the OOM risk of `fs.readFile().toString("base64")` on
 * large media payloads — the intermediate Buffer is the only allocation
 * larger than the chunk size.
 */
async function readBufferStreaming(
  filePath: string,
  cap: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let truncated = false;
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk: string | Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (received + buf.length <= cap) {
        chunks.push(buf);
        received += buf.length;
      } else {
        const remaining = cap - received;
        if (remaining > 0) {
          chunks.push(buf.subarray(0, remaining));
          received = cap;
        }
        truncated = true;
        stream.destroy();
      }
    });
    stream.on("end", () => resolve({ buf: Buffer.concat(chunks), truncated }));
    stream.on("error", (err) => reject(err));
    stream.on("close", () => {
      // If destroy() fired due to truncation, `end` will not — resolve here.
      if (truncated) resolve({ buf: Buffer.concat(chunks), truncated });
    });
  });
}

export async function readMediaFileImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<ReadMediaResult>> {
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
      hint: "Use list or directory_tree for directories.",
    });
  }

  // Caller cap, clamped by both the tool default and config.readMaxBytes.
  // (config.readMaxBytes is the project-wide hard cap on any single-read
  //  operation — read, read_section, write back-reading for append, etc.
  //  We honor it for read_media_file too.)
  const requestedCap = args.max_bytes ?? DEFAULT_MAX_BYTES;
  const cap = Math.min(requestedCap, config.readMaxBytes);

  // Pre-flight size check: refuse outright if the file is larger than cap
  // AND the caller wasn't expecting truncation (max_bytes not specified).
  // When max_bytes IS specified, the caller has opted in to truncation.
  if (stat.size > cap && args.max_bytes === undefined) {
    return buildError("ETOOLARGE", "media file exceeds max_bytes", {
      details: { path: realPath, size: stat.size, max_bytes: cap },
      hint: `Pass max_bytes:N to truncate (max ${config.readMaxBytes}); the response will set truncated:true.`,
    });
  }

  let buf: Buffer;
  let truncated: boolean;
  try {
    const result = await readBufferStreaming(realPath, cap);
    buf = result.buf;
    truncated = result.truncated;
  } catch (err) {
    return fromNodeError(err, "read failed");
  }

  const ext = path.extname(realPath).toLowerCase();
  const contentType = EXTENSION_CONTENT_TYPES[ext] ?? "application/octet-stream";
  const base64 = buf.toString("base64");

  return ok({
    base64,
    content_type: contentType,
    bytes_read: buf.length,
    truncated,
  });
}

export function registerReadMediaFileTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "read_media_file",
    {
      title: "Read a binary media file as base64",
      description: `Read a binary file (image, audio, video, PDF, etc.) and return its
contents as a base64 string. Streams the file in 64 KB chunks to avoid
OOM on large media payloads; concatenates to a single Buffer once read.

Companion to \`read\` (text/UTF-8 only — rejects binary with EENCODING).
Use \`read_media_file\` when an agent needs to inspect a screenshot,
audio sample, or document without a download-to-disk round-trip.

Args:
  - path (string): Absolute path inside allowedRoots
  - max_bytes (number, optional, default 16 MB, max config.readMaxBytes
    = ${config.readMaxBytes}): hard cap. When omitted and the file
    exceeds the default 16 MB cap → ETOOLARGE (caller hasn't opted
    in to truncation). When specified, oversize files truncate to
    \`max_bytes\` with \`truncated: true\` in the response.

Returns: { base64, content_type, bytes_read, truncated }
  - \`content_type\` is best-effort from the file extension
    (image/png, image/jpeg, audio/mpeg, application/pdf, etc.).
    Unknown extensions → application/octet-stream.

Errors: EPERM_ROOT, ENOENT, EISDIR, ETOOLARGE, ETIMEDOUT.

NOT supported: file-content sniffing (we trust the extension), partial
range reads (use byte-offset \`write_chunk\`-style read tools when added),
streaming response (full base64 string is returned in one shot).`,
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
      runTool({ tool: "read_media_file", config }, args, (a) =>
        readMediaFileImpl(a as Input, config),
      ),
  );
}

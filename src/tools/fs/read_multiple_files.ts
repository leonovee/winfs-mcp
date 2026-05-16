import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { ok, type Result, type StructuredError } from "../../core/errors.js";
import { withTimeout, resolveTimeoutMs } from "../../core/timeouts.js";
import { AbsolutePath, LineRange } from "../../schemas/common.js";
import { readImpl } from "./read.js";

const InputShape = {
  paths: z
    .array(AbsolutePath)
    .min(1, "paths must contain at least 1 entry")
    .max(50, "paths must contain at most 50 entries")
    .describe("Absolute paths inside allowedRoots."),
  range: LineRange.optional().describe("Applied uniformly to every file."),
  max_bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Per-file byte cap. Defaults to config.readMaxBytes."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

interface PerFileOk {
  path: string;
  content: string;
  lines_returned: number;
  bytes_returned: number;
  truncated: boolean;
}

interface PerFileErr {
  path: string;
  error: { code: string; message: string; hint?: string };
}

type PerFile = PerFileOk | PerFileErr;

const OutputShape = {
  files: z.array(
    z.union([
      z.object({
        path: z.string(),
        content: z.string(),
        lines_returned: z.number().int().nonnegative(),
        bytes_returned: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
      z.object({
        path: z.string(),
        error: z.object({
          code: z.string(),
          message: z.string(),
          hint: z.string().optional(),
        }),
      }),
    ]),
  ),
  total: z.number().int().nonnegative(),
  ok_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
} as const;

interface ReadMultipleResult extends Record<string, unknown> {
  files: PerFile[];
  total: number;
  ok_count: number;
  error_count: number;
}

async function readOne(
  filePath: string,
  range: [number, number] | undefined,
  maxBytes: number | undefined,
  config: ResolvedConfig,
  timeoutMs: number,
): Promise<PerFile> {
  const raced = await withTimeout(
    () => readImpl({ path: filePath, ...(range ? { range } : {}), ...(maxBytes ? { max_bytes: maxBytes } : {}) }, config),
    timeoutMs,
    { tool: `read_multiple_files:${filePath}` },
  );

  // withTimeout returns Result<…> | StructuredError; both share the discriminator.
  const r = raced as Result<{
    content: string;
    lines_returned: number;
    bytes_returned: number;
    truncated: boolean;
  }>;
  if (r.ok) {
    return {
      path: filePath,
      content: r.value.content,
      lines_returned: r.value.lines_returned,
      bytes_returned: r.value.bytes_returned,
      truncated: r.value.truncated,
    };
  }
  const err = r as StructuredError;
  return {
    path: filePath,
    error: {
      code: err.error.code,
      message: err.error.message,
      ...(err.error.hint ? { hint: err.error.hint } : {}),
    },
  };
}

export async function readMultipleFilesImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<ReadMultipleResult>> {
  // Per spec amendment §C: per-file timeout = config.defaultTimeoutMs.
  const perFileTimeoutMs = resolveTimeoutMs(
    undefined,
    config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );

  const settled = await Promise.all(
    args.paths.map((p) => readOne(p, args.range, args.max_bytes, config, perFileTimeoutMs)),
  );

  const ok_count = settled.filter((f) => "content" in f).length;
  return ok({
    files: settled,
    total: settled.length,
    ok_count,
    error_count: settled.length - ok_count,
  });
}

export function registerReadMultipleFilesTool(
  server: McpServer,
  config: ResolvedConfig,
): void {
  server.registerTool(
    "read_multiple_files",
    {
      title: "Batch read several files (per-file isolation)",
      description: `Read several files in one call. Each path is processed in parallel with an
independent timeout; an error on one file never blocks the others. The overall response is
always isError:false — per-file outcomes live in the \`files\` array.

Args:
  - paths (string[]): 1..50 absolute paths inside allowedRoots
  - range ([number, number], optional): applied uniformly to every file (1-based inclusive)
  - max_bytes (number, optional): per-file byte cap, default config.readMaxBytes

Returns:
  {
    files: Array<
      | { path, content, lines_returned, bytes_returned, truncated }    // success
      | { path, error: { code, message, hint? } }                       // per-file failure
    >,
    total, ok_count, error_count
  }

Errors at top level: none in normal operation. Per-file errors propagate inside files[].`,
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
      runTool({ tool: "read_multiple_files", config }, args, (a) =>
        readMultipleFilesImpl(a as Input, config),
      ),
  );
}

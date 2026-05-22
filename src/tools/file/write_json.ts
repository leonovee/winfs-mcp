import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { atomicWriteFile } from "../../core/atomic_write.js";
import { encodeUtf8NoBom } from "../../core/utf8.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  path: AbsolutePath,
  value: z
    .unknown()
    .describe("Any JSON-serialisable value (object, array, string, number, boolean, null)."),
  indent: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(2)
    .describe("Spaces of indent for pretty-printing. 0 → no indent (compact). Default 2."),
  overwrite: z
    .boolean()
    .default(false)
    .describe("If false and the file exists, returns EEXIST. Default false (safer than write)."),
  mkdirParents: z
    .boolean()
    .default(false)
    .describe("Create missing parent directories before writing."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  bytes_written: z.number().int().nonnegative(),
  lines_written: z.number().int().nonnegative(),
  created: z.boolean(),
} as const;

interface WriteJsonResult extends Record<string, unknown> {
  bytes_written: number;
  lines_written: number;
  created: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function hasJsonExtension(p: string): boolean {
  return p.toLowerCase().endsWith(".json");
}

export async function writeJsonImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<WriteJsonResult>> {
  // Extension check on the caller-supplied path (case-insensitive). We do it
  // before allowedRoots / realpath so a malformed call fails fast without
  // touching disk.
  if (!hasJsonExtension(args.path)) {
    return buildError("EEXT_NOT_JSON", "write_json target must end in .json (case-insensitive)", {
      details: { path: args.path },
      hint: "Use `write` for non-JSON files. Extension match is by suffix only — no MIME inspection.",
    });
  }

  const check = await checkAllowed(args.path, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  // Re-check the resolved path too — defense-in-depth against junctions that
  // might point a .json-named symlink at a non-.json target. realpath strips
  // the extension only if the target itself has a different one.
  if (!hasJsonExtension(realPath)) {
    return buildError("EEXT_NOT_JSON", "resolved path does not end in .json", {
      details: { path: args.path, realPath },
      hint: "Symlink/junction resolves to a non-.json target.",
    });
  }

  const parent = path.dirname(realPath);
  const parentExists = await exists(parent);
  if (!parentExists) {
    if (!args.mkdirParents) {
      return buildError("ENOENT", `Parent directory does not exist: ${parent}`, {
        hint: "Pass mkdirParents:true to create it.",
      });
    }
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch (err) {
      return fromNodeError(err, "mkdir parent failed");
    }
  }

  const fileExists = await exists(realPath);
  if (fileExists && !args.overwrite) {
    return buildError("EEXIST", "File exists and overwrite=false", {
      hint: "Pass overwrite=true if intended.",
      details: { path: realPath },
    });
  }

  // Serialize. JSON.stringify throws on cycles / BigInt / functions — we
  // surface those as EINVAL with the original message attached.
  let serialized: string;
  try {
    serialized =
      args.indent === 0
        ? JSON.stringify(args.value)
        : JSON.stringify(args.value, null, args.indent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return buildError("EINVAL", `value is not JSON-serialisable: ${msg}`, {
      hint: "Strip BigInt / functions / cyclic refs before passing.",
    });
  }
  // JSON.stringify returns undefined for top-level undefined / functions /
  // symbols. We treat that as EINVAL too — writing "undefined" to a .json
  // file would produce an unparseable document.
  if (serialized === undefined) {
    return buildError("EINVAL", "value serialised to undefined (top-level function/symbol/undefined)", {
      hint: "Wrap the value in an object or array, or use null.",
    });
  }

  const content = serialized + "\n";
  const buf = encodeUtf8NoBom(content);

  try {
    await atomicWriteFile(realPath, buf);
  } catch (err) {
    return fromNodeError(err, "atomic write failed");
  }

  return ok({
    bytes_written: buf.length,
    lines_written: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    created: !fileExists,
  });
}

export function registerWriteJsonTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "write_json",
    {
      title: "Atomic JSON write (symmetric to read_json)",
      description: `Atomically write a JSON-serialisable value to a \`.json\` file. Same
temp + fsync + rename primitive as \`write\`, so partial writes are impossible
on crash. Never writes a BOM. Trailing newline appended.

The path MUST end in \`.json\` (case-insensitive) on both the caller-supplied
string and the realpath-resolved path — junction-to-non-json escape is caught.

Args:
  - path (string): Absolute path inside allowedRoots, must end in .json
  - value (unknown): any JSON-serialisable value
  - indent (number, default 2): 0..10; 0 = compact
  - overwrite (boolean, default false): EEXIST when false and file exists
  - mkdirParents (boolean, default false)

Returns: { bytes_written, lines_written, created }
Errors: EPERM_ROOT, EEXIST (overwrite=false), ENOENT (parent missing),
  EINVAL (BigInt / cycle / function in value), EEXT_NOT_JSON (suffix
  mismatch), EIO, ETIMEDOUT.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool({ tool: "write_json", config }, args, (a) => writeJsonImpl(a as Input, config)),
  );
}

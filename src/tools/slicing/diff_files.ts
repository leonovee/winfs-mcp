import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { createTwoFilesPatch } from "diff";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { tryDecodeUtf8Strict, looksBinary } from "../../core/utf8.js";
import { AbsolutePath } from "../../schemas/common.js";

const MAX_CONTEXT_LINES = 10;
const MAX_MINIMAL_LINES = 20;

const InputShape = {
  a: AbsolutePath.optional().describe("Path for the left side. Mutually exclusive with a_inline."),
  a_inline: z.string().optional().describe("Inline content for the left side. Mutually exclusive with a."),
  b: AbsolutePath.optional().describe("Path for the right side. Mutually exclusive with b_inline."),
  b_inline: z.string().optional().describe("Inline content for the right side. Mutually exclusive with b."),
  context_lines: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CONTEXT_LINES)
    .default(3)
    .describe(`Context lines surrounding each hunk. Default 3, max ${MAX_CONTEXT_LINES}.`),
  format: z
    .union([z.literal("unified"), z.literal("minimal")])
    .default("unified")
    .describe("unified = full diff. minimal = changed-line counts + first 20 changed lines."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  diff: z.string(),
  identical: z.boolean(),
  lines_added: z.number().int().nonnegative(),
  lines_removed: z.number().int().nonnegative(),
  format: z.union([z.literal("unified"), z.literal("minimal")]),
  a_label: z.string(),
  b_label: z.string(),
  truncated: z.boolean(),
} as const;

interface DiffResult extends Record<string, unknown> {
  diff: string;
  identical: boolean;
  lines_added: number;
  lines_removed: number;
  format: "unified" | "minimal";
  a_label: string;
  b_label: string;
  truncated: boolean;
}

interface SideContent {
  text: string;
  label: string;
}

async function loadSide(
  pathArg: string | undefined,
  inlineArg: string | undefined,
  config: ResolvedConfig,
  sideName: "a" | "b",
): Promise<SideContent | ReturnType<typeof buildError>> {
  const hasPath = pathArg !== undefined;
  const hasInline = inlineArg !== undefined;
  if (hasPath === hasInline) {
    return buildError(
      "EINVAL",
      hasPath
        ? `exactly one of ${sideName} or ${sideName}_inline required (both supplied)`
        : `exactly one of ${sideName} or ${sideName}_inline required (neither supplied)`,
    );
  }
  if (hasInline) {
    if (Buffer.byteLength(inlineArg!, "utf8") > config.readMaxBytes) {
      return buildError("ETOOLARGE", `${sideName}_inline exceeds readMaxBytes`, {
        details: { side: sideName, bytes: Buffer.byteLength(inlineArg!, "utf8") },
      });
    }
    return { text: inlineArg!, label: "<inline>" };
  }
  const check = await checkAllowed(pathArg!, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, `stat ${sideName} failed`);
  }
  if (stat.isDirectory()) {
    return buildError("EISDIR", `${sideName} is a directory`, { details: { path: realPath } });
  }
  if (stat.size > config.readMaxBytes) {
    return buildError("ETOOLARGE", `${sideName} exceeds readMaxBytes`, {
      details: { path: realPath, size: stat.size, max_bytes: config.readMaxBytes },
    });
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath);
  } catch (err) {
    return fromNodeError(err, `read ${sideName} failed`);
  }
  if (looksBinary(buf)) {
    return buildError("EENCODING", `${sideName} appears to be binary`, {
      details: { path: realPath },
    });
  }
  const text = tryDecodeUtf8Strict(buf);
  if (text === undefined) {
    return buildError("EENCODING", `${sideName} is not valid UTF-8`, {
      details: { path: realPath },
    });
  }
  return { text, label: path.basename(realPath) };
}

function countDiffLines(unifiedDiff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function minimalSummary(unifiedDiff: string, added: number, removed: number): string {
  const changedLines: string[] = [];
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      changedLines.push(line);
      if (changedLines.length >= MAX_MINIMAL_LINES) break;
    }
  }
  const header = `--- summary: +${added} -${removed} lines ---`;
  return [header, ...changedLines].join("\n");
}

export async function diffFilesImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<DiffResult>> {
  const aSide = await loadSide(args.a, args.a_inline, config, "a");
  if ("ok" in aSide && aSide.ok === false) return aSide;
  const bSide = await loadSide(args.b, args.b_inline, config, "b");
  if ("ok" in bSide && bSide.ok === false) return bSide;
  const a = aSide as SideContent;
  const b = bSide as SideContent;

  if (a.text === b.text) {
    return ok({
      diff: "",
      identical: true,
      lines_added: 0,
      lines_removed: 0,
      format: args.format,
      a_label: a.label,
      b_label: b.label,
      truncated: false,
    });
  }

  const unified = createTwoFilesPatch(
    a.label,
    b.label,
    a.text,
    b.text,
    undefined,
    undefined,
    { context: args.context_lines },
  );
  const { added, removed } = countDiffLines(unified);

  let diffOut = args.format === "minimal" ? minimalSummary(unified, added, removed) : unified;
  let truncated = false;
  if (Buffer.byteLength(diffOut, "utf8") > config.maxDiffBytes) {
    truncated = true;
    const buf = Buffer.from(diffOut, "utf8").subarray(0, config.maxDiffBytes);
    diffOut = buf.toString("utf8");
  }

  return ok({
    diff: diffOut,
    identical: false,
    lines_added: added,
    lines_removed: removed,
    format: args.format,
    a_label: a.label,
    b_label: b.label,
    truncated,
  });
}

export function registerDiffFilesTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "diff_files",
    {
      title: "Unified textual diff between two files or inline strings",
      description: `Compute a unified diff between two sides. Each side is exactly one of:
file path (\`a\` / \`b\`) or inline string (\`a_inline\` / \`b_inline\`). Both → EINVAL; neither → EINVAL.

Text-only: UTF-16 BOM / NUL byte on either side returns EENCODING. UTF-8 BOM is stripped before diff.

Two formats:
  - "unified" (default): full unified diff with \`context_lines\` (default 3, max 10).
  - "minimal": summary line + up to 20 changed lines. Fast same/different probe.

Args:
  - a (string, optional) | a_inline (string, optional): exactly one required
  - b (string, optional) | b_inline (string, optional): exactly one required
  - context_lines (number, default 3, max 10)
  - format ("unified"|"minimal", default "unified")

Returns: { diff, identical, lines_added, lines_removed, format, a_label, b_label, truncated }
Errors: EPERM_ROOT (path side), ENOENT, EISDIR, EINVAL (mutex), EENCODING (binary), ETOOLARGE.`,
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
      runTool({ tool: "diff_files", config }, args, (a) =>
        diffFilesImpl(a as Input, config),
      ),
  );
}

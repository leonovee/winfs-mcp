import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";

const HARD_CAP = 500;
const DEFAULT_N = 50;

const InputShape = {
  n: z
    .number()
    .int()
    .nonnegative()
    .max(HARD_CAP)
    .optional()
    .describe(`Number of most-recent audit entries to return. Default ${DEFAULT_N}, hard cap ${HARD_CAP}. Pass 0 to retrieve only the structural envelope.`),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const AuditEntry = z.object({
  ts: z.string(),
  tool: z.string(),
  args_summary: z.unknown(),
  result_status: z.union([z.literal("ok"), z.literal("error")]),
  error_code: z.string().optional(),
  duration_ms: z.number().nonnegative(),
});

const OutputShape = {
  entries: z.array(AuditEntry),
  total: z.number().int().nonnegative(),
} as const;

interface AuditTailResult extends Record<string, unknown> {
  entries: z.infer<typeof AuditEntry>[];
  total: number;
}

/**
 * Guard against `config.resolvedAuditLogPath` being pointed at an arbitrary
 * file (config injection / malicious override). We only accept paths that
 * look like an mcp-winfs audit log: parent directory basename == "mcp-winfs"
 * AND filename ends with ".jsonl".
 *
 * This is a deliberate, narrow exception to spec §2.2 (allowedRoots) — the
 * audit log normally lives in `%LOCALAPPDATA%\mcp-winfs\` which is OUTSIDE
 * the sandbox by design. Without this shape check the tool would become a
 * universal file reader bypassing allowedRoots.
 */
export function isAuditLogPathLegitimate(resolvedAuditLogPath: string): boolean {
  const norm = path.normalize(resolvedAuditLogPath);
  if (!norm.toLowerCase().endsWith(".jsonl")) return false;
  const parent = path.basename(path.dirname(norm));
  return parent.toLowerCase() === "mcp-winfs";
}

/** Parse trailing lines from a file. Returns parsed entries newest-first source
 *  order (i.e., as they appear in the file — caller can reverse if desired).
 *  Malformed lines are silently skipped to keep the tool resilient. */
async function tailLines(filePath: string, n: number): Promise<z.infer<typeof AuditEntry>[]> {
  if (n === 0) return [];
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return [];
    throw err;
  }
  // Drop trailing newline so split doesn't produce a phantom empty entry.
  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  const start = Math.max(0, lines.length - n);
  const out: z.infer<typeof AuditEntry>[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      const validated = AuditEntry.safeParse(parsed);
      if (validated.success) out.push(validated.data);
    } catch {
      // Drop malformed lines silently — the goal is self-recovery, not strict validation.
    }
  }
  return out;
}

export async function auditTailImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<AuditTailResult>> {
  if (!isAuditLogPathLegitimate(config.resolvedAuditLogPath)) {
    return buildError(
      "EPERM_ROOT",
      "configured auditLogPath does not match the expected mcp-winfs audit log shape",
      {
        details: { resolved: config.resolvedAuditLogPath },
        hint: "Audit log path must end with .jsonl and live in a folder named 'mcp-winfs'.",
      },
    );
  }

  const n = args.n ?? DEFAULT_N;
  let entries: z.infer<typeof AuditEntry>[];
  try {
    entries = await tailLines(config.resolvedAuditLogPath, n);
  } catch (err) {
    return buildError("EIO", `failed to read audit log: ${(err as Error).message}`);
  }

  // Self-deduplication: spec §2 §4.8 — drop the most recent record if it is
  // this very audit_tail call. The wrapper writes the record AFTER this impl
  // returns, so in practice no `audit_tail` entry exists yet for the current
  // call. But a previous tail call may have just landed, so trim it to avoid
  // surfacing it in the response.
  while (entries.length > 0 && entries[entries.length - 1]!.tool === "audit_tail") {
    entries.pop();
  }
  return ok({ entries, total: entries.length });
}

export function registerAuditTailTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "audit_tail",
    {
      title: "Tail the mcp-winfs audit log",
      description: `Return the last N entries from the structured audit log written by every tool call.
Use this to recover from chat context loss: the log records tool name, sanitized args,
status, error code (if any) and duration.

This tool reads from \`config.resolvedAuditLogPath\` which is OUTSIDE allowedRoots by design
(\`%LOCALAPPDATA%\\mcp-winfs\\audit.jsonl\` on Windows). It refuses to read paths that don't
match the mcp-winfs audit log convention (\`.jsonl\` inside a folder named \`mcp-winfs\`).

Args:
  - n (number, optional): entries to return. Default ${DEFAULT_N}, hard cap ${HARD_CAP}.

Returns: { entries: Array<{ts, tool, args_summary, result_status, error_code?, duration_ms}>, total }
Errors: EPERM_ROOT (auditLogPath not recognised as mcp-winfs log), EIO.`,
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
      runTool({ tool: "audit_tail", config }, args, (a) =>
        auditTailImpl(a as Input, config),
      ),
  );
}

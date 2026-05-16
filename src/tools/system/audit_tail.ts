import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";

const HARD_CAP = 500;
const DEFAULT_N = 50;

/** Reverse-read chunk size — bounded memory, bounded I/O. */
const READ_CHUNK_BYTES = 256 * 1024;
/** Absolute cap on total bytes read from the audit log per call. Prevents a
 *  large log + small `n` from loading everything into memory. */
const MAX_TOTAL_READ_BYTES = 64 * 1024 * 1024;

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
 * file (config injection / malicious override). Lexical-only check: filename
 * ends with `.jsonl` AND parent directory basename is `mcp-winfs`.
 *
 * The lexical check is necessary but not sufficient — a symlink at a
 * legitimate-shape path can still resolve to an arbitrary file. Callers MUST
 * additionally `fs.realpath()` the path and re-validate the resolved target
 * with this same function. See `resolveAuditLogPath` below.
 */
export function isAuditLogPathLegitimate(resolvedAuditLogPath: string): boolean {
  const norm = path.normalize(resolvedAuditLogPath);
  if (!norm.toLowerCase().endsWith(".jsonl")) return false;
  const parent = path.basename(path.dirname(norm));
  return parent.toLowerCase() === "mcp-winfs";
}

/**
 * Lexical shape check + realpath round-trip. The realpath step catches
 * symlinks / NTFS junctions placed at a legitimate-shape path that resolve
 * to an arbitrary file outside the audit log convention. Codex review P1.
 */
async function resolveAuditLogPath(
  configuredPath: string,
): Promise<{ realPath: string } | { error: ReturnType<typeof buildError> }> {
  if (!isAuditLogPathLegitimate(configuredPath)) {
    return {
      error: buildError(
        "EPERM_ROOT",
        "configured auditLogPath does not match the expected mcp-winfs audit log shape",
        {
          details: { configured: configuredPath },
          hint: "Audit log path must end with .jsonl and live in a folder named 'mcp-winfs'.",
        },
      ),
    };
  }
  let real: string;
  try {
    real = await fs.realpath(configuredPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      // File not present yet — tail will return [] downstream. There is no
      // symlink to follow so the lexical check is sufficient here.
      return { realPath: configuredPath };
    }
    return {
      error: buildError("EIO", `audit log realpath failed: ${e?.message ?? String(err)}`, {
        details: { configured: configuredPath },
      }),
    };
  }
  if (!isAuditLogPathLegitimate(real)) {
    return {
      error: buildError(
        "EPERM_ROOT",
        "configured auditLogPath resolves (via symlink/junction) to a path that does not match the expected mcp-winfs audit log shape",
        {
          details: { configured: configuredPath, resolved: real },
          hint: "Audit log path (after realpath) must end with .jsonl and live in a folder named 'mcp-winfs'.",
        },
      ),
    };
  }
  return { realPath: real };
}

export interface TailLinesOptions {
  /** Test hook — invoked for each disk read with the byte count. Production
   *  code passes nothing; the bounded-read invariant test uses it to verify
   *  the read footprint instead of relying on wall-clock alone. */
  onRead?: (bytes: number) => void;
}

/**
 * Reverse-read the last `n` valid, non-`audit_tail` records from a JSONL
 * file. Bounded: at most `READ_CHUNK_BYTES` per disk read, at most
 * `MAX_TOTAL_READ_BYTES` total. Carries a partial-line buffer between
 * iterations so a JSONL entry split across chunks is reassembled.
 *
 * `audit_tail` records are skipped during the backward scan so the result
 * always contains up to `n` *other* tools' records. This both implements
 * the self-deduplication invariant from spec §4.8 AND defends against the
 * "fill the log with audit_tail calls" attack where post-filtering would
 * yield an empty response (codex review P2 / 'self-dedup drain').
 *
 * Output is oldest-first within the returned slice, matching the v0.3.0
 * contract.
 */
export async function tailLines(
  filePath: string,
  n: number,
  opts: TailLinesOptions = {},
): Promise<z.infer<typeof AuditEntry>[]> {
  if (n === 0) return [];

  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await fs.open(filePath, "r");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return [];
    throw err;
  }

  // collected stores entries newest-first as we scan backward. Reversed at end.
  const collected: z.infer<typeof AuditEntry>[] = [];

  const consume = (lineBuf: Buffer): boolean => {
    if (lineBuf.length === 0) return true;
    const line = lineBuf.toString("utf8");
    try {
      const parsed = JSON.parse(line);
      const validated = AuditEntry.safeParse(parsed);
      if (!validated.success) return true;
      if (validated.data.tool === "audit_tail") return true; // scan-time self-dedup
      collected.push(validated.data);
      return collected.length < n;
    } catch {
      return true; // skip malformed
    }
  };

  try {
    const stat = await fh.stat();
    let pos = stat.size;
    // Bytes from the current iteration that fall BEFORE the first `\n` we
    // saw — they belong to a line that continues into an earlier (not-yet-
    // read) chunk. Stored as raw bytes to keep multi-byte UTF-8 sequences
    // intact across the chunk boundary.
    let partialEnd: Buffer = Buffer.alloc(0);
    let totalRead = 0;
    let keepGoing = true;

    while (keepGoing && pos > 0 && totalRead < MAX_TOTAL_READ_BYTES) {
      const remaining = MAX_TOTAL_READ_BYTES - totalRead;
      const readSize = Math.min(READ_CHUNK_BYTES, pos, remaining);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      const { bytesRead } = await fh.read(buf, 0, readSize, pos);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      opts.onRead?.(bytesRead);

      // File-order: newBytes (earlier) | partialEnd (later, awaiting start).
      const combined =
        bytesRead === readSize
          ? Buffer.concat([buf, partialEnd])
          : Buffer.concat([buf.subarray(0, bytesRead), partialEnd]);

      // Locate every \n.
      const lfIndices: number[] = [];
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === 0x0a) lfIndices.push(i);
      }

      if (lfIndices.length === 0) {
        // No newline in this combined chunk. The whole thing is a continuation
        // of the line we're trying to demarcate; keep it for the next iteration.
        partialEnd = combined;
        continue;
      }

      // Bytes BEFORE the first \n need an earlier chunk to confirm their start.
      const firstLF = lfIndices[0]!;
      partialEnd = combined.subarray(0, firstLF);

      // Bytes between consecutive \n's plus the trailing segment after the
      // last \n are all complete lines. Process newest-first (rightmost first).
      const trailing = combined.subarray(lfIndices[lfIndices.length - 1]! + 1);
      if (!consume(trailing)) {
        keepGoing = false;
        break;
      }
      for (let i = lfIndices.length - 1; i >= 1; i--) {
        const start = lfIndices[i - 1]! + 1;
        const end = lfIndices[i]!;
        if (!consume(combined.subarray(start, end))) {
          keepGoing = false;
          break;
        }
      }
    }

    // If we reached the start of the file, partialEnd holds the file's very
    // first line. It IS a complete line (delimited by file-start on the left,
    // by the first \n on the right which we already processed earlier).
    if (keepGoing && pos === 0 && partialEnd.length > 0) {
      consume(partialEnd);
    }
  } finally {
    await fh.close();
  }

  collected.reverse(); // oldest-first
  return collected;
}

export async function auditTailImpl(
  args: Input,
  config: ResolvedConfig,
): Promise<Result<AuditTailResult>> {
  const resolved = await resolveAuditLogPath(config.resolvedAuditLogPath);
  if ("error" in resolved) return resolved.error;

  const n = args.n ?? DEFAULT_N;
  let entries: z.infer<typeof AuditEntry>[];
  try {
    entries = await tailLines(resolved.realPath, n);
  } catch (err) {
    return buildError("EIO", `failed to read audit log: ${(err as Error).message}`);
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
(\`%LOCALAPPDATA%\\mcp-winfs\\audit.jsonl\` on Windows). The configured path is checked both
lexically (must end with \`.jsonl\` and live in a folder named \`mcp-winfs\`) AND after
\`fs.realpath\` — a symlink/junction at a legit-shape path pointing elsewhere returns
EPERM_ROOT with both the configured and resolved paths in details.

Reads are bounded: 256 KB chunks scanned backward from EOF, 64 MB total ceiling. Trailing
\`audit_tail\` records are filtered out during the scan (not post-drained) so a flood of
self-calls cannot wash legitimate entries out of the response.

Args:
  - n (number, optional): entries to return. Default ${DEFAULT_N}, hard cap ${HARD_CAP}.

Returns: { entries: Array<{ts, tool, args_summary, result_status, error_code?, duration_ms}>, total }
Errors: EPERM_ROOT (auditLogPath not recognised as mcp-winfs log, lexically or after realpath), EIO.`,
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

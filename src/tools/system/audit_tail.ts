import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result, type StructuredError } from "../../core/errors.js";

const HARD_CAP = 500;
const DEFAULT_N = 50;
const READ_CHUNK_BYTES = 256 * 1024;
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
  entries_seen_total: z.number().int().nonnegative(),
} as const;

interface AuditTailResult extends Record<string, unknown> {
  entries: z.infer<typeof AuditEntry>[];
  total: number;
  entries_seen_total: number;
}

/**
 * Audit log path validation. After v0.3.2 (kimi P1.3) the check is JUST a
 * `.jsonl` extension match — the v0.3.0/v0.3.1 parent-directory-name layer
 * was removed.
 *
 * Threat model:
 *   - `InputSchema` has no `path` argument. A user cannot inject a target.
 *   - The configured `resolvedAuditLogPath` comes from operator config (or
 *     the %LOCALAPPDATA%\mcp-winfs\ default). The only attack surface is
 *     config injection + filesystem-level TOCTOU.
 *
 * Defenses, in layered order:
 *   0. `path.isAbsolute` check — rejects relative paths that would be
 *      resolved against `process.cwd()`, an out-of-band variable.
 *   1. Lexical `.jsonl` extension check on the configured path (config
 *      injection can't point at /etc/passwd or system.ini).
 *   2. `fs.realpath` round-trip to canonicalise away symlinks/junctions.
 *   3. Re-check the `.jsonl` extension on the resolved path (pre-resolve
 *      junction swap to a non-`.jsonl` target is caught here).
 *   4. `fs.open` the RESOLVED path — file descriptor is bound to an inode
 *      at this moment; any subsequent junction swap of the configured
 *      path cannot redirect reads (kimi P1.2 TOCTOU close).
 *   5. `fileHandle.stat()` — confirms the bound inode is a regular file.
 *
 * The parent-directory name was defense-in-depth, not primary. Removing it
 * frees the project name from being baked into a security invariant and
 * eliminates the future-rename failure mode the kimi review flagged.
 */
export function isAuditLogPathLegitimate(p: string): boolean {
  return path.normalize(p).toLowerCase().endsWith(".jsonl");
}

/**
 * Race an unsignalled fs op against an AbortSignal. On abort, rejects with
 * an AbortError; the underlying op continues, and if it eventually succeeds
 * `onAbortCleanup` is invoked so leaked resources (FileHandles) can be
 * released. Without this wrapper, `fs.open` / `fs.realpath` on a slow disk
 * (OneDrive-synced %LOCALAPPDATA%, network mount) can hang past the tool
 * wrapper's deadline before it can react — kimi P2.2.
 */
async function abortable<T>(
  op: Promise<T>,
  signal: AbortSignal | undefined,
  onAbortCleanup?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (!signal) return op;
  if (signal.aborted) {
    op.then((v) => onAbortCleanup?.(v)).catch(() => {});
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      op.then((v) => onAbortCleanup?.(v)).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    op.then((v) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    }).catch((e) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(e);
    });
  });
}

function isAbortError(err: unknown): boolean {
  return (err as Error)?.name === "AbortError";
}

type OpenAuditLog =
  | { kind: "open"; handle: import("node:fs/promises").FileHandle; resolved: string }
  | { kind: "missing" }
  | { kind: "error"; error: StructuredError };

/**
 * Lexical check → realpath → re-check → open RESOLVED → fstat.
 * Returns a file handle bound to the inode at open time, plus the canonical
 * resolved path. Caller is responsible for closing the handle.
 *
 * On `ENOENT` (audit log not written yet) returns `{ kind: "missing" }` —
 * downstream treats this as an empty tail.
 */
async function openAuditLog(
  configuredPath: string,
  signal: AbortSignal | undefined,
): Promise<OpenAuditLog> {
  // P3 (deepseek): assert absolute path before any filesystem op. A relative
  // path here would be resolved against `process.cwd()`, which is operator-
  // controlled but not part of the configured contract; rejecting up-front
  // makes the rule explicit and uncacheable.
  if (!path.isAbsolute(configuredPath)) {
    return {
      kind: "error",
      error: buildError(
        "EPERM_ROOT",
        "configured auditLogPath must be absolute",
        {
          details: { configured: configuredPath },
          hint: "Set auditLogPath to an absolute filesystem path; relative paths are rejected because they resolve against process.cwd().",
        },
      ),
    };
  }
  if (!isAuditLogPathLegitimate(configuredPath)) {
    return {
      kind: "error",
      error: buildError(
        "EPERM_ROOT",
        "configured auditLogPath does not end in .jsonl",
        {
          details: { configured: configuredPath },
          hint: "Audit log path must end in .jsonl.",
        },
      ),
    };
  }
  let resolved: string;
  try {
    resolved = await abortable(fs.realpath(configuredPath), signal);
  } catch (err) {
    if (isAbortError(err)) {
      return {
        kind: "error",
        error: buildError("ETIMEDOUT", "audit log realpath aborted", {
          details: { configured: configuredPath },
        }),
      };
    }
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return { kind: "missing" };
    return {
      kind: "error",
      error: buildError("EIO", "audit log realpath failed", {
        details: {
          configured: configuredPath,
          cause: e?.message ?? String(err),
          errno: e?.code,
        },
      }),
    };
  }
  if (!isAuditLogPathLegitimate(resolved)) {
    return {
      kind: "error",
      error: buildError(
        "EPERM_ROOT",
        "configured auditLogPath resolves (via symlink/junction) to a path that does not end in .jsonl",
        {
          details: { configured: configuredPath, resolved },
        },
      ),
    };
  }
  // P1.2: open the RESOLVED path, not the configured one. fs.open binds the
  // file descriptor to an inode at this moment; a junction swap of
  // `configuredPath` after this line is moot because we never traverse it
  // again.
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await abortable(
      fs.open(resolved, "r"),
      signal,
      (h) => h.close().catch(() => {}),
    );
  } catch (err) {
    if (isAbortError(err)) {
      return {
        kind: "error",
        error: buildError("ETIMEDOUT", "audit log open aborted", {
          details: { configured: configuredPath, resolved },
        }),
      };
    }
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return { kind: "missing" };
    return {
      kind: "error",
      error: buildError("EIO", "audit log open failed", {
        details: {
          configured: configuredPath,
          resolved,
          cause: e?.message ?? String(err),
          errno: e?.code,
        },
      }),
    };
  }
  // fstat the bound handle. Asserts the inode is a regular file (not a
  // directory, FIFO, device, etc.) before we start reading.
  let stat: import("node:fs").Stats;
  try {
    stat = await abortable(handle.stat(), signal);
  } catch (err) {
    await handle.close().catch(() => {});
    if (isAbortError(err)) {
      return {
        kind: "error",
        error: buildError("ETIMEDOUT", "audit log fstat aborted", {
          details: { configured: configuredPath, resolved },
        }),
      };
    }
    return {
      kind: "error",
      error: buildError("EIO", "audit log fstat failed", {
        details: {
          configured: configuredPath,
          resolved,
          cause: (err as Error).message,
        },
      }),
    };
  }
  if (!stat.isFile()) {
    await handle.close().catch(() => {});
    return {
      kind: "error",
      error: buildError("EPERM_ROOT", "audit log path does not resolve to a regular file", {
        details: { configured: configuredPath, resolved },
      }),
    };
  }
  return { kind: "open", handle, resolved };
}

export interface TailLinesOptions {
  /** Test hook — invoked for each disk read with the byte count. */
  onRead?: (bytes: number) => void;
  /** Abort signal forwarded to each fh.read. Aborts surface as AbortError. */
  signal?: AbortSignal;
}

interface ScanCounters {
  seen: number;
}

function consumeLine(
  lineBuf: Buffer,
  collected: z.infer<typeof AuditEntry>[],
  n: number,
  counters: ScanCounters,
): boolean {
  if (lineBuf.length === 0) return true;
  let line = lineBuf.toString("utf8");
  // kimi P3 / codex deferred: strip UTF-8 BOM. It only legitimately appears
  // on the very first line of the file (file byte 0). Cheap unconditional
  // strip is harmless on every other line — JSON.stringify never emits a
  // leading ﻿, so the only way an inner line starts with one is if
  // someone hand-edited the log, in which case the strip is still correct.
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  if (line.length === 0) return true;
  try {
    const parsed = JSON.parse(line);
    const validated = AuditEntry.safeParse(parsed);
    if (!validated.success) return true;
    // §M: any structurally-valid AuditEntry counts toward entries_seen_total,
    // even if scan-time self-dedup or n-cap filters it out of the response.
    // This is the diagnostic the field exists for.
    counters.seen++;
    if (validated.data.tool === "audit_tail") return true; // scan-time self-dedup
    collected.push(validated.data);
    return collected.length < n;
  } catch {
    return true;
  }
}

export interface TailLinesResult {
  entries: z.infer<typeof AuditEntry>[];
  /** §M: count of structurally-valid AuditEntry records walked during the
   *  backward scan. Includes the records that were filtered by self-dedup or
   *  passed over after the n cap was hit mid-chunk. Diagnostic only — does
   *  not reflect total file contents past the read ceiling / n cap. */
  scanned: number;
}

/**
 * Reverse-read up to n non-audit_tail entries from an open file handle.
 * The caller is responsible for closing the handle. UTF-8 BOM on the first
 * line is stripped before JSON.parse.
 *
 * Returns both the entries (oldest-first within the returned slice) and a
 * `scanned` count of every structurally-valid AuditEntry observed during
 * the backward scan — see TailLinesResult / spec §M.
 */
export async function tailLinesFromHandle(
  handle: import("node:fs/promises").FileHandle,
  n: number,
  opts: TailLinesOptions = {},
): Promise<TailLinesResult> {
  if (n === 0) return { entries: [], scanned: 0 };
  const collected: z.infer<typeof AuditEntry>[] = [];
  const counters: ScanCounters = { seen: 0 };
  const stat = await handle.stat();
  let pos = stat.size;
  let partialEnd: Buffer = Buffer.alloc(0);
  let totalRead = 0;
  let keepGoing = true;

  while (keepGoing && pos > 0 && totalRead < MAX_TOTAL_READ_BYTES) {
    if (opts.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const remaining = MAX_TOTAL_READ_BYTES - totalRead;
    const readSize = Math.min(READ_CHUNK_BYTES, pos, remaining);
    pos -= readSize;
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await abortable(
      handle.read(buf, 0, readSize, pos),
      opts.signal,
    );
    if (bytesRead === 0) break;
    totalRead += bytesRead;
    opts.onRead?.(bytesRead);

    const combined =
      bytesRead === readSize
        ? Buffer.concat([buf, partialEnd])
        : Buffer.concat([buf.subarray(0, bytesRead), partialEnd]);

    const lfIndices: number[] = [];
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 0x0a) lfIndices.push(i);
    }
    if (lfIndices.length === 0) {
      partialEnd = combined;
      continue;
    }
    const firstLF = lfIndices[0]!;
    partialEnd = combined.subarray(0, firstLF);

    const trailing = combined.subarray(lfIndices[lfIndices.length - 1]! + 1);
    if (!consumeLine(trailing, collected, n, counters)) {
      keepGoing = false;
      break;
    }
    for (let i = lfIndices.length - 1; i >= 1; i--) {
      const start = lfIndices[i - 1]! + 1;
      const end = lfIndices[i]!;
      if (!consumeLine(combined.subarray(start, end), collected, n, counters)) {
        keepGoing = false;
        break;
      }
    }
  }

  if (keepGoing && pos === 0 && partialEnd.length > 0) {
    consumeLine(partialEnd, collected, n, counters);
  }
  collected.reverse(); // oldest-first
  return { entries: collected, scanned: counters.seen };
}

/**
 * Path-based convenience wrapper. Opens the file directly and delegates to
 * tailLinesFromHandle. Used by tests; production callers go through
 * `auditTailImpl` which uses `openAuditLog` for the full P1.2 + P1.3
 * defense (TOCTOU-safe open, fstat sanity).
 *
 * Returns only the entries array for back-compat with existing tests; the
 * `scanned` count is reachable via `tailLinesFromHandle` directly when
 * needed (production path uses it for `entries_seen_total`).
 */
export async function tailLines(
  filePath: string,
  n: number,
  opts: TailLinesOptions = {},
): Promise<z.infer<typeof AuditEntry>[]> {
  if (n === 0) return [];
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await abortable(
      fs.open(filePath, "r"),
      opts.signal,
      (h) => h.close().catch(() => {}),
    );
  } catch (err) {
    if (isAbortError(err)) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") return [];
    throw err;
  }
  try {
    const { entries } = await tailLinesFromHandle(handle, n, opts);
    return entries;
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function auditTailImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<Result<AuditTailResult>> {
  const opened = await openAuditLog(config.resolvedAuditLogPath, signal);
  if (opened.kind === "error") return opened.error;
  if (opened.kind === "missing") return ok({ entries: [], total: 0, entries_seen_total: 0 });

  const n = args.n ?? DEFAULT_N;
  let entries: z.infer<typeof AuditEntry>[];
  let scanned: number;
  try {
    ({ entries, scanned } = await tailLinesFromHandle(opened.handle, n, { signal }));
  } catch (err) {
    if (isAbortError(err)) {
      return buildError("ETIMEDOUT", "audit log tail aborted", {
        details: { resolved: opened.resolved },
      });
    }
    return buildError("EIO", "failed to read audit log", {
      details: { resolved: opened.resolved, cause: (err as Error).message },
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
  return ok({ entries, total: entries.length, entries_seen_total: scanned });
}

export function registerAuditTailTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "audit_tail",
    {
      title: "Tail the mcp-winfs audit log",
      description: `Return the last N entries from the structured audit log written by every tool call.
Use this to recover from chat context loss: the log records tool name, sanitized args,
status, error code (if any) and duration.

The audit log lives OUTSIDE allowedRoots by design (\`%LOCALAPPDATA%\\mcp-winfs\\audit.jsonl\`
on Windows). The configured path must be absolute and end in \`.jsonl\` (lexical check), then
\`fs.realpath\` resolves any symlinks/junctions, the resolved path is re-validated, and
\`fs.open\` is invoked on the RESOLVED path so the file descriptor is bound to an inode at
open time — subsequent junction swaps of the configured path cannot redirect reads.
\`fileHandle.stat\` confirms the inode is a regular file.

Reads are bounded: 256 KB chunks scanned backward from EOF, 64 MB total ceiling. UTF-8 BOM
on the first line is stripped before JSON.parse. Trailing \`audit_tail\` records are
filtered during the scan (not post-drained) so a flood of self-calls cannot wash legitimate
entries out of the response. All I/O honors the wrapper AbortSignal so a slow disk
(roaming %LOCALAPPDATA% via OneDrive sync) surfaces as ETIMEDOUT, not a hang.

Args:
  - n (number, optional): entries to return. Default ${DEFAULT_N}, hard cap ${HARD_CAP}.

Returns: { entries: Array<{ts, tool, args_summary, result_status, error_code?, duration_ms}>, total, entries_seen_total }
  - \`total\` is always \`entries.length\` per the envelope convention in spec §F.
  - \`entries_seen_total\` (spec §M, v0.5) counts every structurally-valid record walked
    during the backward scan, including those filtered by self-dedup (\`audit_tail\` entries)
    or skipped after the n-cap was hit mid-chunk. Diagnostic only — when
    \`entries_seen_total > total\` the gap is filtered \`audit_tail\` records.

Errors: EPERM_ROOT (non-absolute path, missing/wrong extension before or after realpath, non-regular file), ETIMEDOUT (I/O aborted by wrapper), EIO (filesystem failure — raw cause in \`error.details.cause\`).`,
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
      runTool({ tool: "audit_tail", config }, args, (a, signal) =>
        auditTailImpl(a as Input, config, signal),
      ),
  );
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";

export interface AuditRecord {
  ts: string;
  tool: string;
  args_summary: Record<string, unknown>;
  result_status: "ok" | "error";
  error_code?: string;
  duration_ms: number;
}

const SENSITIVE_ARG_KEYS = new Set(["content"]);

/**
 * Sanitize an args object for audit logging:
 *   - Replace any `content` field with `<redacted: N bytes>`
 *   - Truncate any other string field longer than 256 chars
 *   - Leave numbers, booleans, arrays and shallow objects intact
 *
 * Spec §2.11: write/append bodies and env values must never reach the log.
 */
export function sanitizeArgs(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object") return { value: args as unknown };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_ARG_KEYS.has(k) && typeof v === "string") {
      const bytes = Buffer.byteLength(v, "utf8");
      out[k] = `<redacted: ${bytes} bytes>`;
      continue;
    }
    if (typeof v === "string" && v.length > 256) {
      out[k] = `${v.slice(0, 256)}…<truncated ${v.length - 256} chars>`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

let writeQueue: Promise<void> = Promise.resolve();

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
}

async function rotateIfNeeded(logPath: string, maxBytes: number): Promise<void> {
  try {
    const stat = await fs.stat(logPath);
    if (stat.size <= maxBytes) return;
    const rotated = `${logPath}.1`;
    try {
      await fs.unlink(rotated);
    } catch {
      /* ignore */
    }
    await fs.rename(logPath, rotated);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") {
      // Don't propagate rotation errors — audit must never block tool calls.
      process.stderr.write(`audit: rotation failed: ${e?.message ?? String(err)}\n`);
    }
  }
}

/**
 * Append a single record to the JSONL audit log. Writes are serialized via a
 * promise chain so concurrent tool calls cannot interleave bytes in the file.
 * Failures are logged to stderr but never re-thrown — audit failure must
 * not turn into tool failure.
 */
export function appendAudit(config: ResolvedConfig, record: AuditRecord): void {
  const line = JSON.stringify(record) + "\n";
  writeQueue = writeQueue.then(async () => {
    try {
      await ensureDir(config.resolvedAuditLogPath);
      await rotateIfNeeded(config.resolvedAuditLogPath, config.auditLogMaxBytes);
      await fs.appendFile(config.resolvedAuditLogPath, line, { encoding: "utf8" });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      process.stderr.write(`audit: write failed: ${e?.message ?? String(err)}\n`);
    }
  });
}

/** Await any in-flight audit writes. Useful in tests. */
export async function flushAudit(): Promise<void> {
  await writeQueue;
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";

export interface AuditRecord {
  ts: string;
  /** Tool name. By convention, names beginning with `_` are RESERVED for
   *  system events emitted by the audit subsystem itself (e.g.
   *  `_server_start`), NOT real registered tools. audit_tail surfaces these
   *  alongside regular tool entries; consumers that filter by tool name
   *  should treat the `_` prefix as the discriminator. */
  tool: string;
  args_summary: Record<string, unknown>;
  result_status: "ok" | "error";
  error_code?: string;
  duration_ms: number;
  /** v0.6 §U / invariant #30: present on mutation-tool entries (write,
   *  append, mkdir, move, copy, edit_file, write_chunk, execute_command,
   *  run_python, run_pytest). Read-only tools omit it. */
  mode?: "strict" | "unrestricted";
}

/**
 * v0.6 invariant #30: mutation tools whose audit entries get the `mode` field.
 * Read-only tools (read, list, stat, grep, glob, etc.) don't get it — keeps
 * the audit log lean and makes post-hoc filtering trivial (`mode === "unrestricted"`
 * pulls every entry that was actually allowed to mutate outside allowedRoots).
 */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "append",
  "mkdir",
  "move",
  "copy",
  "edit_file",
  "write_chunk",
  "execute_command",
  "run_python",
  "run_pytest",
  // v0.7 wave 1
  "write_json",
  "ssh_exec",
  // v0.7 wave 2b — process control mutations
  "start_process",
  "interact",
  "kill_process",
]);

const SENSITIVE_ARG_KEYS = new Set([
  "content",
  "edits",
  "a_inline",
  "b_inline",
  // v0.5 — exec / network surface
  "command", // execute_command: raw PowerShell expression (may contain secrets)
  "script", // run_python: -c script body
  "url", // fetch_url: query string may carry tokens; tool's auditExtras gives a smarter view
  // v0.7 wave 1
  "value", // write_json: arbitrary JSON-serialisable payload (may carry secrets)
]);

/**
 * Sanitize an args object for audit logging:
 *   - String at a sensitive key → `<redacted: N bytes>`
 *   - Array at a sensitive key → `<redacted: N items>` (covers edit_file's
 *     `edits: [{old_str, new_str}, ...]` whose content is just as sensitive
 *     as a write body)
 *   - Truncate any other string field longer than 256 chars
 *   - Leave numbers, booleans, non-sensitive arrays and shallow objects intact
 *
 * Spec §2.11 + v0.4 §I: write/append bodies, env values, AND edit payloads
 * must never reach the log.
 */
export function sanitizeArgs(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object") return { value: args as unknown };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_ARG_KEYS.has(k)) {
      if (typeof v === "string") {
        out[k] = `<redacted: ${Buffer.byteLength(v, "utf8")} bytes>`;
        continue;
      }
      if (Array.isArray(v)) {
        out[k] = `<redacted: ${v.length} items>`;
        continue;
      }
      // v0.7: extend to plain objects so `write_json`'s `value` (free-form
      // JSON) gets a key-count summary instead of leaking content into audit.
      if (v !== null && typeof v === "object") {
        out[k] = `<redacted: ${Object.keys(v as Record<string, unknown>).length} keys>`;
        continue;
      }
      // Primitives (number / boolean / null) at sensitive keys pass through —
      // they're tiny and unlikely to carry meaningful secrets on their own.
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

/**
 * v0.6 §U / invariant #29: write the `_server_start` sentinel record at server
 * boot, capturing the serverMode + version + pid. Uses the standard
 * AuditRecord shape with `tool: "_server_start"` so audit_tail can surface it
 * without schema gymnastics. Failures are non-fatal (same policy as appendAudit).
 */
export function appendServerStartAudit(config: ResolvedConfig): void {
  appendAudit(config, {
    ts: new Date().toISOString(),
    tool: "_server_start",
    args_summary: {
      server_mode: config.serverMode,
      version: config.version,
      pid: process.pid,
    },
    result_status: "ok",
    duration_ms: 0,
    mode: config.serverMode,
  });
}

/** Await any in-flight audit writes. Useful in tests. */
export async function flushAudit(): Promise<void> {
  await writeQueue;
}

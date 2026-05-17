# External code review — winfs `audit_tail.ts` — 2026-05-16

## Context

winfs is a Model Context Protocol (MCP) server providing a sandboxed Windows filesystem surface. Hard invariants from spec §2 (always enforced):

1. **Realpath → allowed_roots check.** Every path is canonicalized before the prefix check. Paths outside `allowedRoots` get `EPERM_ROOT` regardless of whether the file exists — no existence-leak channel.
2. **Bounded timeouts.** Default 10s, max 60s.
3. **Atomic writes.** All writes via temp + fsync + rename.
4. **Structured errors as content.** Tool handlers never throw — every error comes back as `{ok:false, error:{code, message, hint?}}`.
5. **Audit log.** Every call appends a JSONL record to `auditLogPath`. Content field on write/append is replaced with `<redacted: N bytes>`.

**`audit_tail` is a deliberate exception to allowed_roots invariant #1.** It reads the server's own audit log, which lives in `%LOCALAPPDATA%\mcp-winfs\` — OUTSIDE the sandbox by design. The privileged read is meant to enable self-recovery after context loss: a freshly-started Claude session can reconstruct what happened previously.

## Your task

Review `src/tools/system/audit_tail.ts` (full source below) for security issues, race conditions, and edge cases. Treat the file as security-critical: this is the only tool with a path outside allowed_roots, so a successful attack here is a sandbox escape.

## Targeted questions

**Q1 (security).** Can a user, by any combination of tool arguments OR config-file manipulation, cause `audit_tail` to read an arbitrary file outside the intended audit log path? Consider:
- Symlinks at the auditLogPath
- Junction points or reparse points on Windows
- Path normalization differences between `path.normalize`, `path.basename`, and the OS-level open
- Race between `isAuditLogPathLegitimate` check and `fs.readFile`
- The hardcoded `"mcp-winfs"` parent-name check — what if the project is renamed and `auditLogPath` is updated accordingly?

**Q2 (DoS / resource).** With `n: 0` returning empty array, and `n` capped at 500, can the tool be made to:
- Allocate excessive memory (audit log file size unbounded; `fs.readFile` loads entire file into RAM)
- Block for unbounded time (no timeout in `tailLines`)
- Cause backpressure that affects other tools

**Q3 (correctness).** Edge cases in `tailLines`:
- Audit log file rotated/truncated between `fs.readFile` and processing
- Last line is incomplete (mid-write JSONL record without trailing `\n`)
- File contains BOM (someone manually edited the audit log)
- Self-deduplication while-loop: what if EVERY recent entry is `audit_tail`? (e.g., user runs `audit_tail` in a loop) — would the loop drain all legitimate entries?
- Audit log contains entries from a DIFFERENT mcp-winfs install (multi-install systems) — silent merging or error?

**Q4 (composition).** This tool uses `runTool` wrapper which writes its own audit record AFTER the impl returns. Is there any way for `audit_tail` to race with the wrapper's audit write and surface its own current call in the response? (Subtle: the wrapper writes via `appendAudit` which is presumably asynchronous.)

## Output format

Group findings by severity:
- **P1** (critical: security bypass, sandbox escape, data corruption)
- **P2** (important: incorrect behavior, race condition with non-trivial consequences, missing input validation)
- **P3** (nice-to-have: code smell, defensive coding, documentation gap)

For each finding: title, line number(s), concrete reproduction or attack scenario, suggested fix.

If you find nothing in a severity tier, say "P1: none" explicitly so we know you considered it.

## File content

```typescript
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
      // Drop malformed lines silently
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

  // Self-deduplication
  while (entries.length > 0 && entries[entries.length - 1]!.tool === "audit_tail") {
    entries.pop();
  }
  return ok({ entries, total: entries.length });
}
```

## Known context (don't re-derive)

- The project was renamed mid-development: local dir `winfs`, npm package `winfs-mcp`, but default `auditLogPath` is still `%LOCALAPPDATA%\mcp-winfs\` (legacy). The shape check on `parent.toLowerCase() === "mcp-winfs"` passes only because the default wasn't updated. This is acknowledged technical debt; we want OTHER findings.
- We already audited the `runTool` wrapper separately — assume the wrapper contract holds. Focus on `audit_tail.ts` internal logic and FS interaction.

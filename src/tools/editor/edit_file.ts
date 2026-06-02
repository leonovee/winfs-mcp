import { promises as fs } from "node:fs";
import { z } from "zod";
import { createPatch } from "diff";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, fromNodeError, type Result } from "../../core/errors.js";
import { tryDecodeUtf8Strict, looksBinary } from "../../core/utf8.js";
import { atomicWriteFile } from "../../core/atomic_write.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const MAX_EDITS = 50;
const DEFAULT_CONTEXT = 3;
const DIFF_BODY_CAP_BYTES = 16 * 1024;

/**
 * v0.9.1 P2.2 — UTF-8 codepoint-boundary-safe byte truncation. Cutting
 * a UTF-8 buffer mid-sequence emits trailing U+FFFD replacement chars
 * when decoded. Walk back at most 3 bytes from the cut point to the
 * last non-continuation byte (start of a sequence). If that sequence
 * extends past the cut, truncate before it instead — losing one whole
 * codepoint at the boundary, never a partial one.
 */
function safeUtf8Cut(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let s = maxBytes - 1;
  for (let i = 0; i < 4 && s >= 0; i++) {
    const b = buf[s]!;
    if ((b & 0xc0) !== 0x80) {
      // s is a sequence start byte. Sequence length per UTF-8 spec:
      //   0xxxxxxx → 1, 110xxxxx → 2, 1110xxxx → 3, 11110xxx → 4.
      const seqLen =
        (b & 0x80) === 0 ? 1 :
        (b & 0xe0) === 0xc0 ? 2 :
        (b & 0xf0) === 0xe0 ? 3 :
        (b & 0xf8) === 0xf0 ? 4 : 1;
      if (s + seqLen <= maxBytes) {
        return buf.subarray(0, maxBytes);
      }
      return buf.subarray(0, s);
    }
    s--;
  }
  // Malformed UTF-8 (4+ continuation bytes in a row at the tail): cut
  // at maxBytes and let Node emit U+FFFD per its standard contract.
  return buf.subarray(0, maxBytes);
}

const InputShape = {
  path: AbsolutePath,
  edits: z
    .array(
      z
        .object({
          old_str: z.string().min(1, "old_str must be non-empty"),
          new_str: z.string(),
          /**
           * v0.6 §W invariant #34: expected occurrence count for this edit.
           * Default 1 preserves v0.5 contract. 0 = assertion-only (verify
           * absent, no replacement performed). >=2 = replace ALL occurrences
           * atomically. Count must match exactly, else EUNIQUE.
           */
          expected_count: z.number().int().nonnegative().default(1),
        })
        .strict(),
    )
    .min(1, "at least one edit required")
    .max(MAX_EDITS, `at most ${MAX_EDITS} edits per call`),
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, validate + compute diff but do not write to disk."),
  with_diff: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), the response carries the unified diff body. Pass `false` to suppress the diff on large edits where only success/replacements_made matter.",
    ),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  path: z.string(),
  replacements_made: z.number().int().nonnegative(),
  atomic: z.boolean(),
  dry_run: z.boolean(),
  diff: z.string(),
  truncated_diff: z.boolean().optional(),
} as const;

interface EditFileResult extends Record<string, unknown> {
  path: string;
  replacements_made: number;
  atomic: boolean;
  dry_run: boolean;
  diff: string;
  truncated_diff?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

interface EditFileAuditExtras {
  bytes_before: number;
  bytes_after: number;
}

/**
 * v0.9.1 P2.3 convention: audit extras flow from impl → runTool by
 * sharing the SAME `result.value` object instance via this WeakMap.
 * If a future wrapping layer clones/destructures `result.value`
 * between impl return and `auditExtras` callback, the lookup will
 * miss and the audit entry will lose the extras. Spec §AB sets the
 * "do not clone result.value across the impl/runTool boundary" rule;
 * this comment is the local enforcement reminder.
 */
const auditByResult = new WeakMap<object, EditFileAuditExtras>();

export function getEditFileAuditExtras(value: EditFileResult): EditFileAuditExtras | undefined {
  return auditByResult.get(value);
}

export async function editFileImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<Result<EditFileResult>> {
  const check = await checkAllowed(args.path, config);
  if ("ok" in check && check.ok === false) return check;
  const realPath = (check as { realPath: string }).realPath;

  let stat: import("node:fs").Stats;
  try {
    // P1.1: thread signal through fs.stat / fs.readFile / atomicWriteFile so
    // the wall-clock deadline from withTimeout actually aborts in-flight I/O
    // instead of leaving an orphan running past ETIMEDOUT.
    stat = await fs.stat(realPath);
  } catch (err) {
    return fromNodeError(err, "stat failed");
  }
  if (stat.isDirectory()) {
    return buildError("EISDIR", "Expected a file, got a directory", {
      details: { path: realPath },
    });
  }
  if (stat.size > config.readMaxBytes) {
    return buildError("ETOOLARGE", "file exceeds readMaxBytes", {
      details: { path: realPath, size: stat.size, max_bytes: config.readMaxBytes },
    });
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(realPath, { signal });
  } catch (err) {
    return fromNodeError(err, "read failed");
  }
  if (looksBinary(buf)) {
    return buildError("EENCODING", "file appears to be binary", {
      details: { path: realPath },
    });
  }
  const original = tryDecodeUtf8Strict(buf);
  if (original === undefined) {
    return buildError("EENCODING", "file is not valid UTF-8", {
      details: { path: realPath },
    });
  }

  let buffer = original;
  // v0.6 §W invariant #34: replacements_made is the SUM of actual replacements
  // performed across all edits. expected_count: 0 (assertion-only) contributes
  // 0 to this total even though the edit "passed".
  let replacementsMade = 0;
  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i]!;
    const occ = countOccurrences(buffer, e.old_str);
    // Default expected_count to 1 at the consumer layer (preserves v0.5
    // back-compat for direct impl callers that bypass Zod validation, e.g.
    // unit tests). Zod's .default(1) handles the registered-tool path.
    const expected = e.expected_count ?? 1;
    if (occ !== expected) {
      // v0.6 §W: error message reflects expected count.
      let message: string;
      let hint: string;
      if (expected === 1 && occ === 0) {
        message = `edit[${i}].old_str not found in current buffer`;
        // P2.1: the "earlier edit may have removed" hint is only meaningful
        // when i > 0. For edit[0] the substring is simply absent; suggesting
        // a phantom earlier edit is misleading.
        hint = i > 0
          ? "An earlier edit may have removed the target. Edits apply sequentially to the in-memory buffer."
          : "The substring was not found in the file. Check spelling and surrounding whitespace.";
      } else if (expected === 1 && occ > 1) {
        message = `edit[${i}].old_str appears ${occ} times; must be exactly 1`;
        hint = "Provide more surrounding context in old_str to make it unique, or pass expected_count to assert a specific count.";
      } else if (expected === 0) {
        message = `edit[${i}].old_str found ${occ} time(s) but expected_count was 0 (assertion failed: substring must be absent)`;
        hint = "expected_count: 0 asserts the substring is absent. To allow occurrences and replace them, raise expected_count.";
      } else {
        message = `edit[${i}].old_str found ${occ} time(s) but expected_count was ${expected}`;
        hint = "Adjust expected_count to match the actual occurrence count, or modify old_str to disambiguate.";
      }
      return buildError("EUNIQUE", message, {
        details: {
          edit_index: i,
          occurrences_found: occ,
          expected_count: expected,
          path: realPath,
        },
        hint,
      });
    }
    if (expected === 0) {
      // Assertion-only mode: count matched (0), no replacement performed.
      continue;
    }
    if (expected === 1) {
      // Single-replace path preserves v0.5 semantics + diff cleanliness.
      buffer = buffer.replace(e.old_str, e.new_str);
      replacementsMade += 1;
    } else {
      // Multi-replace path: split+join replaces ALL occurrences atomically
      // within the edit (string.replace without /g replaces only the first).
      buffer = buffer.split(e.old_str).join(e.new_str);
      replacementsMade += expected;
    }
  }

  const afterBytes = Buffer.byteLength(buffer, "utf8");
  if (afterBytes > config.readMaxBytes) {
    return buildError("ETOOLARGE", "post-edit content exceeds readMaxBytes", {
      details: { path: realPath, bytes_after: afterBytes, max_bytes: config.readMaxBytes },
    });
  }

  // v0.7 wave 2a: opt-out of diff body via `with_diff: false` to keep response
  // size bounded on large edits. When enabled, cap the body at DIFF_BODY_CAP_BYTES
  // and surface a `truncated_diff: true` flag rather than returning a multi-MB
  // payload an agent will mostly ignore.
  // Default true at the impl layer (preserves v0.4 §I "diff field always populated"
  // for back-compat with direct impl callers that bypass Zod validation, e.g.
  // unit tests). Zod's .default(true) handles the registered-tool path.
  const withDiff = args.with_diff ?? true;
  let diff = "";
  let truncatedDiff = false;
  if (withDiff) {
    diff = createPatch(
      realPath,
      original,
      buffer,
      "before",
      "after",
      { context: DEFAULT_CONTEXT },
    );
    const diffBuf = Buffer.from(diff, "utf8");
    if (diffBuf.length > DIFF_BODY_CAP_BYTES) {
      const head = safeUtf8Cut(diffBuf, DIFF_BODY_CAP_BYTES).toString("utf8");
      const dropped = diffBuf.length - Buffer.byteLength(head, "utf8");
      diff = `${head}... [${dropped} more bytes truncated]\n`;
      truncatedDiff = true;
    }
  }

  if (!args.dry_run) {
    try {
      await atomicWriteFile(realPath, buffer, { signal });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EBUSY" || e?.code === "EACCES" || e?.code === "EPERM") {
        return buildError("EBUSY", "destination is locked or not writable", {
          details: { path: realPath, errno: e.code },
        });
      }
      return fromNodeError(err, "atomic write failed");
    }
  }

  const value: EditFileResult = {
    path: realPath,
    replacements_made: replacementsMade,
    atomic: true,
    dry_run: args.dry_run,
    diff,
    ...(truncatedDiff ? { truncated_diff: true } : {}),
  };
  auditByResult.set(value, {
    bytes_before: stat.size,
    bytes_after: afterBytes,
  });
  return ok(value);
}

export function registerEditFileTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "edit_file",
    {
      title: "Atomic find-and-replace with dry_run and occurrence-count assertions",
      description: `Apply 1..${MAX_EDITS} {old_str, new_str, expected_count?} replacements to a file, atomically.

Occurrence-count invariant (v0.6 §W): each \`old_str\` MUST appear exactly \`expected_count\`
times (default 1) in the current in-memory buffer.

  - \`expected_count: 1\` (default, preserves v0.5 contract): replace the single occurrence.
    0 or 2+ matches → EUNIQUE.
  - \`expected_count: 0\`: ASSERTION-ONLY. Verify substring is absent; no replacement
    performed. Any occurrence → EUNIQUE. Useful for "ensure this code is removed" checks.
  - \`expected_count: N (N >= 2)\`: Replace ALL occurrences atomically (within the edit).
    Count must match exactly; mismatch → EUNIQUE.

Edits apply sequentially — edit K is checked against the buffer AFTER edits 0..K-1. Error
details on EUNIQUE include \`{edit_index, occurrences_found, expected_count}\`.

\`dry_run: true\` validates all edits and returns the unified diff without touching disk
(no temp file is created). \`dry_run: false\` (default) writes atomically via temp+fsync+rename.

\`edit_file\` does NOT create files — use \`write\` for that. ENOENT on missing path.

Args:
  - path (string): absolute path inside allowedRoots
  - edits ({old_str, new_str, expected_count?}[]): 1..${MAX_EDITS} edits. Empty old_str → EINVAL.
  - dry_run (boolean, default false)
  - with_diff (boolean, default true): when false, response \`diff\` is empty and \`truncated_diff\`
    is absent. Use for large edits where only success/replacements_made is needed.

Returns: { path, replacements_made, atomic, dry_run, diff, truncated_diff? }
  - \`replacements_made\` is the sum of actual replacements across all edits.
    expected_count:0 edits contribute 0 (assertion-only). expected_count:N edits
    contribute N each.
  - \`diff\` is capped at ${DIFF_BODY_CAP_BYTES} bytes; overflow truncates with a trailing
    \`... [N more bytes truncated]\\n\` marker and sets \`truncated_diff: true\`.

Errors: EPERM_ROOT, ENOENT, EISDIR, EUNIQUE (occurrence-count mismatch), EENCODING (binary/non-UTF-8), ETOOLARGE, EBUSY (locked destination), ETIMEDOUT.

Audit log records { path, edits_count, dry_run, bytes_before, bytes_after } — old_str and
new_str content are NEVER persisted (continuation of write/append content redaction).`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(
        {
          tool: "edit_file",
          config,
          auditExtras: (result) => {
            if (!result.ok) {
              return {
                edits_count: (args as Input).edits?.length ?? 0,
                dry_run: (args as Input).dry_run ?? false,
              };
            }
            const extras = getEditFileAuditExtras(result.value as EditFileResult);
            return {
              edits_count: (args as Input).edits.length,
              dry_run: (args as Input).dry_run,
              ...(extras ?? {}),
            };
          },
        },
        args,
        (a, sig) => editFileImpl(a as Input, config, sig),
      ),
  );
}

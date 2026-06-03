import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { spawnSubprocess, resolvePython } from "../../core/exec_safety.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  cwd: AbsolutePath.describe("Directory pytest runs in (must be inside allowedRoots)."),
  test_filter: z
    .string()
    .max(1024)
    .optional()
    .describe("Passed verbatim to pytest as a node-id / keyword expression."),
  count_only: z
    .boolean()
    .default(false)
    .describe("If true, invokes `pytest --collect-only` (no test execution)."),
  timeout_ms: z.number().int().positive().optional(),
} as const;

// Inner spawn deadline sits this far below runTool's outer withTimeout so the
// graceful inner timeout fires first (see grep / execute_command).
const OUTER_TIMEOUT_BUFFER_MS = 2000;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  exit_code: z.number().int().nullable(),
  raw_output: z.string(),
  collect_only: z.boolean(),
  truncated: z.boolean(),
  timed_out: z.boolean(),
} as const;

interface RunPytestResult extends Record<string, unknown> {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  duration_ms: number;
  exit_code: number | null;
  raw_output: string;
  collect_only: boolean;
  truncated: boolean;
  timed_out: boolean;
}

/**
 * Parse the pytest summary line. Examples:
 *   "=========== 5 passed in 0.12s ============"
 *   "==== 2 failed, 3 passed, 1 skipped in 1.5s ===="
 *   "=== 1 passed, 2 errors in 0.3s ==="
 *   "=== no tests ran in 0.02s ==="
 * Returns counts; missing categories default to 0.
 */
function parseSummary(raw: string): { passed: number; failed: number; skipped: number; errors: number } | undefined {
  // The summary line is the LAST line that starts and ends with one or more "=".
  const lines = raw.split("\n");
  let summary: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!.trim();
    if (/^=+\s.*\s=+$/.test(ln)) {
      summary = ln;
      break;
    }
  }
  if (!summary) return undefined;
  // Strip leading/trailing = and whitespace.
  const inner = summary.replace(/^=+\s*/, "").replace(/\s*=+$/, "");
  if (/^no tests ran/.test(inner)) {
    return { passed: 0, failed: 0, skipped: 0, errors: 0 };
  }
  const passed = parseInt(inner.match(/(\d+)\s+passed/)?.[1] ?? "0", 10);
  const failed = parseInt(inner.match(/(\d+)\s+failed/)?.[1] ?? "0", 10);
  const skipped = parseInt(inner.match(/(\d+)\s+skipped/)?.[1] ?? "0", 10);
  const errors = parseInt(inner.match(/(\d+)\s+error/)?.[1] ?? "0", 10);
  return { passed, failed, skipped, errors };
}

/** Parse `pytest --collect-only` output: lines starting with "collected" tell the count. */
function parseCollectOnly(raw: string): { passed: number; failed: number; skipped: number; errors: number } | undefined {
  const m = raw.match(/collected (\d+) item/);
  if (!m) return undefined;
  return { passed: 0, failed: 0, skipped: 0, errors: 0 };
}

export async function runPytestImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
  /** Inner spawn deadline (registered tool passes outer − BUFFER); derived
   *  from the general timeout pair when omitted. */
  deadlineMsOverride?: number,
): Promise<Result<RunPytestResult>> {
  const cwdCheck = await checkAllowed(args.cwd, config);
  if ("ok" in cwdCheck && cwdCheck.ok === false) return cwdCheck;
  const cwd = (cwdCheck as { realPath: string }).realPath;

  const pythonBin = resolvePython(config);
  const pyArgs: string[] = ["-m", "pytest"];
  if (args.count_only) {
    pyArgs.push("--collect-only", "-q");
  } else {
    pyArgs.push("-v", "--tb=line");
  }
  if (args.test_filter !== undefined) {
    pyArgs.push(args.test_filter);
  }

  const deadline =
    deadlineMsOverride ??
    resolveTimeoutMs(args.timeout_ms, config.defaultTimeoutMs, config.maxTimeoutMs);

  const spawnRes = await spawnSubprocess({
    bin: pythonBin,
    args: pyArgs,
    cwd,
    deadlineMs: deadline,
    maxOutputBytes: config.execMaxOutputBytes,
    config,
    signal,
  });

  if (spawnRes.spawnFailed) {
    if (spawnRes.spawnErrorCode === "ENOENT") {
      return buildError("EPYTHONNOTFOUND", "python binary not found", {
        details: { python_bin: pythonBin, cause: spawnRes.spawnErrorMessage },
      });
    }
    return buildError("EIO", "run_pytest failed to spawn", {
      details: { python_bin: pythonBin, errno: spawnRes.spawnErrorCode, cause: spawnRes.spawnErrorMessage },
    });
  }

  const combinedOutput = spawnRes.stdout + (spawnRes.stderr ? `\n[stderr]\n${spawnRes.stderr}` : "");

  let summary: { passed: number; failed: number; skipped: number; errors: number } | undefined;
  if (args.count_only) {
    summary = parseCollectOnly(spawnRes.stdout);
  } else {
    summary = parseSummary(spawnRes.stdout);
  }

  if (!summary) {
    return buildError("EPARSE", "could not parse pytest output", {
      details: {
        cwd,
        exit_code: spawnRes.exitCode,
        output_prefix: combinedOutput.slice(0, 512),
      },
      hint: "Verify pytest is installed in the resolved python environment.",
    });
  }

  return ok({
    ...summary,
    duration_ms: spawnRes.durationMs,
    exit_code: spawnRes.exitCode,
    raw_output: combinedOutput,
    collect_only: args.count_only,
    truncated: spawnRes.truncatedStdout || spawnRes.truncatedStderr,
    timed_out: spawnRes.timedOut,
  });
}

export function registerRunPytestTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "run_pytest",
    {
      title: "Run pytest in a directory; parse summary into structured counts",
      description: `Run \`python -m pytest\` in \`cwd\` and return parsed test counts.

\`count_only: true\` invokes \`pytest --collect-only -q\` (no test execution); returns the
collected count in \`passed\` (other counters 0).

The summary line is parsed via regex against pytest's standard \`=== N passed, M failed,
K skipped in Xs ===\` format. Unrecognized output → EPARSE with a 512-char prefix in
details for diagnosis.

raw_output contains the full pytest stdout (and stderr appended after a [stderr] marker
if non-empty), capped at \`config.execMaxOutputBytes\` per stream — truncated:true if hit.

Args:
  - cwd (string): pytest working directory (inside allowedRoots)
  - test_filter (string, optional): pytest -k expression or node-id
  - count_only (boolean, default false)
  - timeout_ms (number, optional)

Returns: { passed, failed, skipped, errors, duration_ms, exit_code, raw_output, collect_only, truncated, timed_out }

Errors: EPERM_ROOT, EPYTHONNOTFOUND, EPARSE (unrecognized output), EIO.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const outerDeadline = resolveTimeoutMs(
        (args as Input).timeout_ms,
        config.defaultTimeoutMs,
        config.maxTimeoutMs,
      );
      const innerDeadline = Math.max(1, outerDeadline - OUTER_TIMEOUT_BUFFER_MS);
      return runTool({ tool: "run_pytest", config, timeoutMs: outerDeadline }, args, (a, sig) =>
        runPytestImpl(a as Input, config, sig, innerDeadline),
      );
    },
  );
}

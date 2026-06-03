import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { auditContentFields } from "../../core/audit.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { spawnSubprocess, resolvePython } from "../../core/exec_safety.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";
import { AbsolutePath } from "../../schemas/common.js";
import type { ToolContext } from "../../core/tool_context.js";

const InputShape = {
  mode: z
    .union([z.literal("inline"), z.literal("file")])
    .describe("inline: run `python -c <script>`. file: run `python <path>`."),
  script: z
    .string()
    .min(1)
    .max(64 * 1024)
    .optional()
    .describe("Inline script body (mode='inline' only)."),
  path: AbsolutePath.optional().describe("Script file path (mode='file' only)."),
  args: z.array(z.string().max(2048)).max(64).default([]),
  cwd: AbsolutePath.optional(),
  timeout_ms: z.number().int().positive().optional(),
} as const;

// Inner spawn deadline sits this far below runTool's outer withTimeout so the
// graceful inner timeout fires first (see grep / execute_command).
const OUTER_TIMEOUT_BUFFER_MS = 2000;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nonnegative(),
  truncated_stdout: z.boolean(),
  truncated_stderr: z.boolean(),
  timed_out: z.boolean(),
} as const;

interface RunPythonResult extends Record<string, unknown> {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  timed_out: boolean;
}

const auditByResult = new WeakMap<object, Record<string, unknown>>();
const AUDIT_PREFIX_CAP = 4 * 1024;
const SCRIPT_PREFIX_CAP = 256;

export function getRunPythonAuditExtras(value: RunPythonResult): Record<string, unknown> | undefined {
  return auditByResult.get(value);
}

export async function runPythonImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
  /** Inner spawn deadline (registered tool passes outer − BUFFER); derived
   *  from the general timeout pair when omitted. */
  deadlineMsOverride?: number,
): Promise<Result<RunPythonResult>> {
  // Validate the mode-specific input combination.
  if (args.mode === "inline" && args.script === undefined) {
    return buildError("EINVAL", "mode='inline' requires script", {});
  }
  if (args.mode === "file" && args.path === undefined) {
    return buildError("EINVAL", "mode='file' requires path", {});
  }
  if (args.mode === "inline" && args.path !== undefined) {
    return buildError("EINVAL", "path not allowed with mode='inline'", {});
  }
  if (args.mode === "file" && args.script !== undefined) {
    return buildError("EINVAL", "script not allowed with mode='file'", {});
  }

  // Resolve cwd.
  let cwd: string;
  if (args.cwd !== undefined) {
    const cwdCheck = await checkAllowed(args.cwd, config);
    if ("ok" in cwdCheck && cwdCheck.ok === false) return cwdCheck;
    cwd = (cwdCheck as { realPath: string }).realPath;
  } else {
    if (config.resolvedAllowedRoots.length === 0) {
      return buildError("EPERM_ROOT", "no allowedRoots configured; cwd is required", {});
    }
    cwd = config.resolvedAllowedRoots[0]!;
  }

  // Resolve file path if mode='file'.
  let scriptPath: string | undefined;
  if (args.mode === "file") {
    const pCheck = await checkAllowed(args.path!, config);
    if ("ok" in pCheck && pCheck.ok === false) return pCheck;
    scriptPath = (pCheck as { realPath: string }).realPath;
    try {
      const st = await fs.stat(scriptPath);
      if (!st.isFile()) {
        return buildError("EISDIR", "path is a directory", { details: { path: scriptPath } });
      }
    } catch (err) {
      return buildError("ENOENT", "script file not found", {
        details: { path: scriptPath, cause: (err as Error).message },
      });
    }
  }

  const pythonBin = resolvePython(config);
  // Sanity-check the python binary exists if a pythonHome is configured.
  if (config.pythonHome) {
    try {
      await fs.stat(pythonBin);
    } catch {
      return buildError("EPYTHONNOTFOUND", "python binary not found at config.pythonHome", {
        details: { python_bin: pythonBin, hint: "Verify config.pythonHome points at a Python install root." },
      });
    }
  }

  const pyArgs: string[] =
    args.mode === "inline"
      ? ["-c", args.script!, ...args.args]
      : [scriptPath!, ...args.args];

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
      return buildError("EPYTHONNOTFOUND", "python binary not found on sanitized PATH", {
        details: { python_bin: pythonBin, cause: spawnRes.spawnErrorMessage },
        hint: "Set config.pythonHome to the directory containing python.exe.",
      });
    }
    return buildError("EIO", "run_python failed to spawn", {
      details: { python_bin: pythonBin, errno: spawnRes.spawnErrorCode, cause: spawnRes.spawnErrorMessage },
    });
  }

  const value: RunPythonResult = {
    stdout: spawnRes.stdout,
    stderr: spawnRes.stderr,
    exit_code: spawnRes.exitCode,
    duration_ms: spawnRes.durationMs,
    truncated_stdout: spawnRes.truncatedStdout,
    truncated_stderr: spawnRes.truncatedStderr,
    timed_out: spawnRes.timedOut,
  };
  // GPT-review #3: store sha256 + byte length by default; content prefixes only
  // when config.auditVerbose. A prefix can leak a secret printed on line 1.
  const verbose = config.auditVerbose;
  const extras: Record<string, unknown> = {
    mode: args.mode,
    ...auditContentFields("stdout", spawnRes.stdout, verbose, AUDIT_PREFIX_CAP),
    ...auditContentFields("stderr", spawnRes.stderr, verbose, AUDIT_PREFIX_CAP),
  };
  if (args.mode === "inline" && args.script !== undefined) {
    Object.assign(extras, auditContentFields("script", args.script, verbose, SCRIPT_PREFIX_CAP));
  }
  if (scriptPath) extras.path = scriptPath;
  auditByResult.set(value, extras);
  return ok(value);
}

export function registerRunPythonTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "run_python",
    {
      title: "Run a Python script (inline or file)",
      description: `Run Python with one of two modes:
- mode: "inline" + script: "<src>" → invokes \`python -c "<src>" <args...>\`
- mode: "file" + path: "<path>" → invokes \`python <path> <args...>\`

The python binary is resolved via \`config.pythonHome\` (if set) — never via shell PATH
discovery; closes Python-shim attack vectors. Without pythonHome, falls back to "python"
in the sanitized PATH (same defenses as execute_command).

Audit log: SHA-256 digest + byte length of the inline script and of stdout/stderr —
never the content itself (a prefix can leak a secret on line 1). File path is
recorded. Set config.auditVerbose=true to ALSO record 256-char / 4 KB prefixes
for debugging.

Args:
  - mode ("inline"|"file")
  - script (string, inline only): max 64 KB
  - path (string, file only): inside allowedRoots
  - args (string[], default [])
  - cwd (string, optional)
  - timeout_ms (number, optional)

Returns: { stdout, stderr, exit_code, duration_ms, truncated_stdout, truncated_stderr, timed_out }

Errors: EINVAL (mode/arg mismatch), EPERM_ROOT (cwd or path outside roots), ENOENT (script file), EISDIR (path is dir), EPYTHONNOTFOUND, EIO.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
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
      return runTool(
        {
          tool: "run_python",
          config,
          timeoutMs: outerDeadline,
          auditExtras: (result) => {
            if (!result.ok) {
              return { mode: (args as Input).mode };
            }
            const extras = getRunPythonAuditExtras(result.value as RunPythonResult);
            return extras ? { ...extras } : {};
          },
        },
        args,
        (a, sig) => runPythonImpl(a as Input, config, sig, innerDeadline),
      );
    },
  );
}

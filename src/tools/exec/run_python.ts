import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { checkAllowed } from "../../core/allowed_roots.js";
import { spawnSubprocess, resolvePython } from "../../core/exec_safety.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";
import { AbsolutePath } from "../../schemas/common.js";

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

interface PythonAuditExtras {
  mode: "inline" | "file";
  script_bytes?: number;
  script_prefix?: string;
  path?: string;
  stdout_prefix: string;
  stderr_prefix: string;
}

const auditByResult = new WeakMap<object, PythonAuditExtras>();
const AUDIT_PREFIX_CAP = 4 * 1024;
const SCRIPT_PREFIX_CAP = 256;

export function getRunPythonAuditExtras(value: RunPythonResult): PythonAuditExtras | undefined {
  return auditByResult.get(value);
}

export async function runPythonImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
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

  const deadline = resolveTimeoutMs(
    args.timeout_ms,
    config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );

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
  auditByResult.set(value, {
    mode: args.mode,
    ...(args.mode === "inline" && args.script !== undefined
      ? {
          script_bytes: Buffer.byteLength(args.script, "utf8"),
          script_prefix: args.script.slice(0, SCRIPT_PREFIX_CAP),
        }
      : {}),
    ...(scriptPath ? { path: scriptPath } : {}),
    stdout_prefix: spawnRes.stdout.slice(0, AUDIT_PREFIX_CAP),
    stderr_prefix: spawnRes.stderr.slice(0, AUDIT_PREFIX_CAP),
  });
  return ok(value);
}

export function registerRunPythonTool(server: McpServer, config: ResolvedConfig): void {
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

Audit log: inline script PREFIX (first 256 chars) + full script_bytes count; never full
source. File path is recorded. stdout/stderr first 4 KB.

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
    async (args) =>
      runTool(
        {
          tool: "run_python",
          config,
          auditExtras: (result) => {
            if (!result.ok) {
              return { mode: (args as Input).mode };
            }
            const extras = getRunPythonAuditExtras(result.value as RunPythonResult);
            return extras ? { ...extras } : {};
          },
        },
        args,
        (a, sig) => runPythonImpl(a as Input, config, sig),
      ),
  );
}

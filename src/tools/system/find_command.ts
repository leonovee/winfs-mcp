import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import { spawnSubprocess } from "../../core/exec_safety.js";
import { resolveTimeoutMs } from "../../core/timeouts.js";

const InputShape = {
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._-]+$/, "name must be alphanumeric (with . _ -)"),
  with_version: z
    .boolean()
    .default(false)
    .describe("If true, invokes the binary with `--version` to capture its version string. Default false (path lookup only — reduces attack surface)."),
  timeout_ms: z.number().int().positive().optional(),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  found: z.boolean(),
  name: z.string(),
  path: z.string().optional(),
  version: z.string().optional(),
} as const;

interface FindCommandResult extends Record<string, unknown> {
  found: boolean;
  name: string;
  path?: string;
  version?: string;
}

export async function findCommandImpl(
  args: Input,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<Result<FindCommandResult>> {
  const deadline = resolveTimeoutMs(
    args.timeout_ms,
    config.defaultTimeoutMs,
    config.maxTimeoutMs,
  );

  // PowerShell `Get-Command -ErrorAction SilentlyContinue` returns one line
  // per resolved binary with `Source` filtering. We use Source/Definition
  // to avoid noisy fields.
  const ps =
    `$c = Get-Command -Name '${args.name}' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($null -eq $c) { exit 1 } ` +
    `if ($c.Source) { Write-Output $c.Source } ` +
    `elseif ($c.Definition) { Write-Output $c.Definition } ` +
    `else { Write-Output $c.Name }`;

  const lookup = await spawnSubprocess({
    bin: process.platform === "win32" ? "powershell.exe" : "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-Command", ps],
    cwd: config.resolvedAllowedRoots[0] ?? process.cwd(),
    deadlineMs: deadline,
    maxOutputBytes: 16 * 1024,
    config,
    signal,
  });

  if (lookup.spawnFailed) {
    return buildError("EIO", "find_command failed to spawn PowerShell", {
      details: { errno: lookup.spawnErrorCode, cause: lookup.spawnErrorMessage },
    });
  }
  if (lookup.timedOut) {
    return buildError("ETIMEDOUT", "find_command exceeded deadline", {
      details: { name: args.name, timeout_ms: deadline },
    });
  }
  if (lookup.exitCode !== 0) {
    return ok({ found: false, name: args.name });
  }
  const path = lookup.stdout.trim().split(/\r?\n/)[0]!.trim();
  if (!path) {
    return ok({ found: false, name: args.name });
  }

  if (!args.with_version) {
    return ok({ found: true, name: args.name, path });
  }

  // Version probe — invoke the binary with --version.
  const versionRes = await spawnSubprocess({
    bin: path,
    args: ["--version"],
    cwd: config.resolvedAllowedRoots[0] ?? process.cwd(),
    deadlineMs: Math.min(deadline, 5000),
    maxOutputBytes: 16 * 1024,
    config,
    signal,
  });
  let version: string | undefined;
  if (!versionRes.spawnFailed && !versionRes.timedOut) {
    const combined = (versionRes.stdout + versionRes.stderr).trim();
    if (combined.length > 0) {
      version = combined.split(/\r?\n/)[0]!.trim().slice(0, 256);
    }
  }
  return {
    ok: true,
    value: { found: true, name: args.name, path, ...(version ? { version } : {}) },
  };
}

export function registerFindCommandTool(server: McpServer, config: ResolvedConfig): void {
  server.registerTool(
    "find_command",
    {
      title: "Resolve a command name in the sanitized PATH",
      description: `Look up an executable name via PowerShell \`Get-Command\` and return its
absolute path (or \`{found: false}\` if not present).

\`with_version: true\` additionally invokes \`<path> --version\` to capture the version
string. Default \`false\` because invocation adds attack surface — version probe is opt-in.

\`name\` is strictly alphanumeric (\`.\` \`_\` \`-\` allowed). No spaces, no glob chars.

Args:
  - name (string): executable to look up
  - with_version (boolean, default false)
  - timeout_ms (number, optional)

Returns: { found, name, path?, version? }
Errors: EIO (PowerShell spawn failure), ETIMEDOUT.`,
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
      runTool({ tool: "find_command", config }, args, (a, sig) =>
        findCommandImpl(a as Input, config, sig),
      ),
  );
}

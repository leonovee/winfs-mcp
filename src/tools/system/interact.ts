import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import type { ProcessRegistry } from "../../core/process_registry.js";
import { runTool } from "../../core/tool_wrapper.js";
import { buildError, ok, type Result } from "../../core/errors.js";
import type { ToolContext } from "../../core/tool_context.js";

const MAX_WAIT_MS = 60_000;
const DEFAULT_WAIT_MS = 5_000;
const OUTER_TIMEOUT_BUFFER_MS = 2_000;
const MAX_INPUT_BYTES = 64 * 1024;

const InputShape = {
  session_id: z.string().min(1),
  input: z
    .string()
    .max(MAX_INPUT_BYTES)
    .optional()
    .describe("Bytes to write to child stdin before the long-poll read."),
  stdout_since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Byte offset to start slicing stdout from. Use `stdout_offset` from the prior interact response."),
  stderr_since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Byte offset to start slicing stderr from. Use `stderr_offset` from the prior interact response."),
  max_wait_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_MS)
    .optional()
    .describe(`Long-poll deadline. Default ${DEFAULT_WAIT_MS} ms, max ${MAX_WAIT_MS} ms.`),
  finalize: z
    .boolean()
    .optional()
    .describe("If true, close child stdin after writing `input`. No further writes allowed afterwards (EPIPE_CLOSED)."),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  session_id: z.string(),
  status: z.union([
    z.literal("running"),
    z.literal("exited"),
    z.literal("killed"),
    z.literal("timed_out"),
    z.literal("spawn_failed"),
  ]),
  exit_code: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdout_offset: z.number().int().nonnegative(),
  stderr_offset: z.number().int().nonnegative(),
  truncated_stdout: z.boolean(),
  truncated_stderr: z.boolean(),
  settled_at: z.string().nullable(),
} as const;

interface InteractResult extends Record<string, unknown> {
  session_id: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_offset: number;
  stderr_offset: number;
  truncated_stdout: boolean;
  truncated_stderr: boolean;
  settled_at: string | null;
}

export async function interactImpl(
  args: Input,
  registry: ProcessRegistry,
): Promise<Result<InteractResult>> {
  const session = registry.get(args.session_id);
  if (!session) {
    return buildError("ENOSESSION", `session_id not found in registry: ${args.session_id}`, {
      details: { session_id: args.session_id },
      hint: "Sessions are retained for processSessionTtlMs after settle (default 60 s). Past that, the id is gone.",
    });
  }

  // Writes are only valid when the session is alive AND stdin is still open.
  if (args.input !== undefined) {
    if (session.stdin_closed) {
      return buildError("EPIPE_CLOSED", "session stdin was closed by a prior finalize:true call", {
        details: { session_id: session.session_id, status: session.status },
      });
    }
    if (session.status !== "running") {
      return buildError("EPIPE_CLOSED", `session is not running (status=${session.status})`, {
        details: { session_id: session.session_id, status: session.status },
      });
    }
    const wrote = session.writeStdin(args.input);
    if (!wrote) {
      return buildError("EPIPE_CLOSED", "stdin write failed (pipe closed or child detached)", {
        details: { session_id: session.session_id },
      });
    }
  }

  if (args.finalize === true) {
    session.closeStdin();
  }

  const maxWaitMs = args.max_wait_ms ?? DEFAULT_WAIT_MS;
  const snap = await session.waitForOutput(
    args.stdout_since ?? 0,
    args.stderr_since ?? 0,
    maxWaitMs,
  );

  return ok({
    session_id: snap.session_id,
    status: snap.status,
    exit_code: snap.exit_code,
    stdout: snap.stdout,
    stderr: snap.stderr,
    stdout_offset: snap.stdout_offset,
    stderr_offset: snap.stderr_offset,
    truncated_stdout: snap.truncated_stdout,
    truncated_stderr: snap.truncated_stderr,
    settled_at: snap.settled_at,
  });
}

export function registerInteractTool(server: McpServer, ctx: ToolContext): void {
  const { config, registry } = ctx;
  server.registerTool(
    "interact",
    {
      title: "Long-poll read and optional stdin write to a process session",
      description: `Read accumulated stdout/stderr from a session (starting at byte offset
\`stdout_since\` / \`stderr_since\`), optionally writing \`input\` to the child's
stdin first. Long-polls up to \`max_wait_ms\` for new output or session settle.

Calling pattern: loop on this tool with each response's \`stdout_offset\` and
\`stderr_offset\` fed back as the next call's \`*_since\`, until \`status\` is no
longer \`running\` or you decide to stop.

Args:
  - session_id (string): from a prior start_process response
  - input (string, optional): bytes to write to stdin BEFORE the read
  - stdout_since (number, optional): default 0
  - stderr_since (number, optional): default 0
  - max_wait_ms (number, optional): default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}
  - finalize (boolean, optional): if true, close stdin AFTER writing \`input\`.
    Further writes will return EPIPE_CLOSED.

Returns: { session_id, status, exit_code, stdout, stderr, stdout_offset,
stderr_offset, truncated_stdout, truncated_stderr, settled_at }

Errors:
  - ENOSESSION (session_id not in registry — either never existed or GC'd past
    processSessionTtlMs after settle).
  - EPIPE_CLOSED (input was provided but stdin is closed or session settled).

Audit (mutation): session_id, input_bytes (or 'none'), max_wait_ms, finalize,
returned_stdout_bytes, returned_stderr_bytes. Carries \`mode\`. Input body is
NEVER persisted (could carry passwords / interactive secrets).`,
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
      const innerMax = (args as Input).max_wait_ms ?? DEFAULT_WAIT_MS;
      // Outer wrapper timeout must exceed the long-poll deadline so the
      // wrapper doesn't synthesise an ETIMEDOUT before interact returns.
      const outerTimeout = Math.min(
        innerMax + OUTER_TIMEOUT_BUFFER_MS,
        Math.max(config.maxTimeoutMs, MAX_WAIT_MS + OUTER_TIMEOUT_BUFFER_MS),
      );
      return runTool(
        {
          tool: "interact",
          config,
          timeoutMs: outerTimeout,
          auditExtras: (result) => {
            const input = (args as Input).input;
            const base: Record<string, unknown> = {
              session_id: (args as Input).session_id,
              input_bytes: input === undefined ? "none" : Buffer.byteLength(input, "utf8"),
              max_wait_ms: innerMax,
              finalize: (args as Input).finalize === true,
            };
            if (result.ok) {
              const v = result.value as InteractResult;
              base.returned_stdout_bytes = Buffer.byteLength(v.stdout, "utf8");
              base.returned_stderr_bytes = Buffer.byteLength(v.stderr, "utf8");
              base.session_status = v.status;
            }
            return base;
          },
        },
        args,
        (a) => interactImpl(a as Input, registry),
      );
    },
  );
}

import type { ResolvedConfig } from "./config.js";
import { appendAudit, sanitizeArgs, MUTATION_TOOLS } from "./audit.js";
import { withTimeout, resolveTimeoutMs } from "./timeouts.js";
import {
  buildError,
  type ErrorCode,
  type Result,
  type StructuredError,
} from "./errors.js";

/**
 * Shape of the value an MCP tool handler returns to the SDK.
 *
 * MCP convention (v0.1.1): `structuredContent` must mirror the declared
 * `outputSchema` exactly — pure payload, no service envelope. Errors omit
 * `structuredContent` entirely and rely on `isError: true` plus a text
 * `content` block carrying the error JSON.
 *
 * The previous shape (`{ok, tool, ...payload}`) caused Claude Desktop to
 * surface every successful call as failed because the extra keys violated
 * `additionalProperties: false` in the per-tool output schemas. See
 * docs/v0.2-backlog.md #1.
 */
export interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolContext {
  tool: string;
  config: ResolvedConfig;
  /** Per-call timeout override (max). Defaults to config.defaultTimeoutMs. */
  timeoutMs?: number;
  /**
   * Per-call ceiling override for `timeoutMs`. Defaults to
   * `config.maxTimeoutMs`. Long-running exec tools (execute_command,
   * run_python, run_pytest, ssh_exec) raise this to their own max
   * (e.g. shellMaxTimeoutMs) so the OUTER withTimeout doesn't clamp a
   * legitimately-long call down to the general 60 s ceiling — which would
   * fire before the tool's inner deadline and surface a misleading
   * "exceeded <default>ms" error.
   */
  maxTimeoutMs?: number;
  /**
   * Optional hook that returns extra audit-only metadata after the impl
   * resolves. Merged into `args_summary` on the audit record so tools can
   * surface totals (e.g., full files_skipped_total before response capping)
   * without leaking them into the user-facing payload.
   */
  auditExtras?: (result: Result<Record<string, unknown>>) => Record<string, unknown>;
}

/**
 * Error path: omit structuredContent so the per-tool outputSchema is not
 * validated against an error envelope (MCP spec: outputSchema only applies
 * when isError is false / unset). The text content carries the structured
 * error so model clients can still parse it.
 */
function errorResponse(err: StructuredError): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(err.error, null, 2) }],
    isError: true,
  };
}

/**
 * Success path: structuredContent is the pure payload — matches the tool's
 * declared outputSchema field-for-field, no `ok` / `tool` wrapper.
 */
function successResponse<T extends Record<string, unknown>>(value: T): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

/**
 * Wrap a tool implementation with timeout + audit + structured-error
 * envelope. Handlers return either an `ok({...})` value (becomes
 * `{ok: true, tool, ...value}`) or a `StructuredError` (becomes
 * `{ok: false, tool, error}` with isError:true).
 *
 * The wrapper guarantees:
 *   - No exception escapes (spec §2.4)
 *   - Audit record written for every call
 *   - Bounded execution time (spec §2.3)
 */
export async function runTool<TArgs extends Record<string, unknown>, TValue extends Record<string, unknown>>(
  ctx: ToolContext,
  args: TArgs,
  impl: (args: TArgs, signal: AbortSignal) => Promise<Result<TValue>>,
): Promise<ToolResponse> {
  const started = Date.now();
  const timeoutMs = resolveTimeoutMs(
    ctx.timeoutMs,
    ctx.config.defaultTimeoutMs,
    ctx.maxTimeoutMs ?? ctx.config.maxTimeoutMs,
  );

  let result: Result<TValue>;
  try {
    const raced = await withTimeout(
      (signal) => impl(args, signal),
      timeoutMs,
      { tool: ctx.tool },
    );
    // withTimeout returns Result<TValue> | StructuredError. StructuredError IS
    // a valid Result so this is just a widening cast.
    result = raced as Result<TValue>;
  } catch (err) {
    result = buildError(
      "EIO",
      `unhandled exception in ${ctx.tool}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const duration = Date.now() - started;
  const baseArgsSummary = sanitizeArgs(args);
  const extraArgs = ctx.auditExtras
    ? ctx.auditExtras(result as Result<Record<string, unknown>>)
    : undefined;
  const argsSummary = extraArgs ? { ...baseArgsSummary, ...extraArgs } : baseArgsSummary;

  // v0.6 §U / invariant #30: mutation-tool audit entries carry the serverMode
  // explicitly. Read-only tools omit the field for log brevity.
  const modeField = MUTATION_TOOLS.has(ctx.tool)
    ? { mode: ctx.config.serverMode }
    : undefined;

  if (result.ok) {
    appendAudit(ctx.config, {
      ts: new Date().toISOString(),
      tool: ctx.tool,
      args_summary: argsSummary,
      result_status: "ok",
      duration_ms: duration,
      ...(modeField ?? {}),
    });
    return successResponse(result.value);
  }
  appendAudit(ctx.config, {
    ts: new Date().toISOString(),
    tool: ctx.tool,
    args_summary: argsSummary,
    result_status: "error",
    error_code: result.error.code as ErrorCode,
    duration_ms: duration,
    ...(modeField ?? {}),
  });
  return errorResponse(result);
}

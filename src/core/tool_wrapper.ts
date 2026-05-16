import type { ResolvedConfig } from "./config.js";
import { appendAudit, sanitizeArgs } from "./audit.js";
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
    ctx.config.maxTimeoutMs,
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
  if (result.ok) {
    appendAudit(ctx.config, {
      ts: new Date().toISOString(),
      tool: ctx.tool,
      args_summary: sanitizeArgs(args),
      result_status: "ok",
      duration_ms: duration,
    });
    return successResponse(result.value);
  }
  appendAudit(ctx.config, {
    ts: new Date().toISOString(),
    tool: ctx.tool,
    args_summary: sanitizeArgs(args),
    result_status: "error",
    error_code: result.error.code as ErrorCode,
    duration_ms: duration,
  });
  return errorResponse(result);
}

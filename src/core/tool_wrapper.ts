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
 * `structuredContent` is the modern V1 SDK feature that lets clients consume
 * JSON without re-parsing the textual representation.
 */
export interface ToolResponse {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolContext {
  tool: string;
  config: ResolvedConfig;
  /** Per-call timeout override (max). Defaults to config.defaultTimeoutMs. */
  timeoutMs?: number;
}

/** Build a uniform error response shape (no thrown exceptions for handlers). */
function errorResponse(err: StructuredError, tool: string): ToolResponse {
  const payload = {
    ok: false as const,
    tool,
    error: err.error,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function successResponse<T extends Record<string, unknown>>(
  value: T,
  tool: string,
): ToolResponse {
  const payload = { ok: true as const, tool, ...value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
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

  let result: Result<TValue> | StructuredError;
  try {
    const raced = await withTimeout(
      (signal) => impl(args, signal),
      timeoutMs,
      { tool: ctx.tool },
    );
    if (raced && typeof raced === "object" && "ok" in raced) {
      result = raced as Result<TValue>;
    } else {
      // withTimeout returns either the awaited value or a StructuredError.
      // Type narrowing helper:
      result = raced as Result<TValue>;
    }
  } catch (err) {
    result = buildError(
      "EIO",
      `unhandled exception in ${ctx.tool}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const duration = Date.now() - started;
  const isOk = result.ok === true;
  appendAudit(ctx.config, {
    ts: new Date().toISOString(),
    tool: ctx.tool,
    args_summary: sanitizeArgs(args),
    result_status: isOk ? "ok" : "error",
    ...(isOk ? {} : { error_code: result.error.code as ErrorCode }),
    duration_ms: duration,
  });

  if (isOk) {
    return successResponse(result.value, ctx.tool);
  }
  return errorResponse(result, ctx.tool);
}

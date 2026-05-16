import { buildError, type StructuredError } from "./errors.js";

/**
 * Run `task` with a hard deadline. Resolves to either the task's value or a
 * structured ETIMEDOUT error. The caller is expected to abort whatever I/O
 * the task was doing via `signal` if it surfaces a cooperative cancellation
 * point (Node fs.promises only does so on ≥ 18 for streams; for our file
 * operations the task simply continues in the background and we discard its
 * result).
 *
 * Spec §2.3: "Never hangs." Even if the underlying I/O ignores AbortSignal
 * we still resolve at the deadline.
 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  context: { tool: string },
): Promise<T | StructuredError> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<StructuredError>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(
        buildError("ETIMEDOUT", `${context.tool} exceeded ${timeoutMs}ms`, {
          hint: `Configured timeout was ${timeoutMs} ms`,
          details: { tool: context.tool, timeout_ms: timeoutMs },
        }),
      );
    }, timeoutMs);
    // Don't keep the event loop alive solely for the timeout.
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    const result = await Promise.race([task(controller.signal), timeoutPromise]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Clamp a user-requested timeout to [1, maxTimeoutMs], defaulting to
 * `defaultTimeoutMs` when undefined. Negative or non-finite values fall back
 * to the default.
 */
export function resolveTimeoutMs(
  requested: number | undefined,
  defaultMs: number,
  maxMs: number,
): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(defaultMs, maxMs);
  }
  return Math.min(Math.max(1, Math.floor(requested)), maxMs);
}

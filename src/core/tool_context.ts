import type { ResolvedConfig } from "./config.js";
import type { ProcessRegistry } from "./process_registry.js";

/**
 * Shared per-server context passed to every `register*Tool` registration.
 *
 * Stateful subsystems live here; tool implementations receive the whole
 * context and destructure what they need. Extending the context (e.g.
 * adding a FileWatchRegistry for a future notification surface, or a
 * JobQueue for long-poll subscriptions) adds a field to this interface,
 * not a positional parameter to every register*Tool call.
 *
 * Spec amendment §AB.2 (wave 2c) documents the extension rule:
 *   1. Add the field to `ToolContext` + `createToolContext`'s `parts`.
 *   2. Construct the subsystem in `createServer` and pass it through.
 *   3. Tools that need the subsystem destructure it from `ctx`.
 *   4. Apply invariant #41 to the subsystem's settle semantics.
 *
 * Audit is intentionally NOT in the context — it's accessed via the
 * module-level `appendAudit(config, record)` API in `src/core/audit.ts`.
 * Threading it through context would change a stable single-module
 * surface for no benefit. The wave-2c prompt suggested an `audit` field;
 * we deviate per the project's existing convention.
 */
export interface ToolContext {
  readonly config: ResolvedConfig;
  readonly registry: ProcessRegistry;
}

/**
 * Construct a `ToolContext` from already-initialised components. Used by
 * `createServer` and by tests that need to inject mocked subsystems.
 */
export function createToolContext(parts: {
  config: ResolvedConfig;
  registry: ProcessRegistry;
}): ToolContext {
  return {
    config: parts.config,
    registry: parts.registry,
  };
}

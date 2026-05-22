import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "../../core/config.js";
import { runTool } from "../../core/tool_wrapper.js";
import { ok, type Result } from "../../core/errors.js";
import type { ToolContext } from "../../core/tool_context.js";

/**
 * SAFE_PREFIX_LEN is the spec §2 invariant #8 mathematical bound: the
 * exposed prefix MUST never exceed 4 chars regardless of value length.
 *
 * This is hardcoded (NOT config-driven) per spec invariant #12 (no runtime
 * config mutation of security-relevant bounds). Changing this requires a
 * source edit + a spec amendment.
 */
const SAFE_PREFIX_LEN = 4;

const InputShape = {
  name: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var name must match [A-Za-z_][A-Za-z0-9_]*"),
} as const;

export const InputSchema = z.object(InputShape).strict();
export type Input = z.infer<typeof InputSchema>;

const OutputShape = {
  present: z.boolean(),
  length: z.number().int().nonnegative(),
  prefix: z.string(),
} as const;

interface CheckEnvResult extends Record<string, unknown> {
  present: boolean;
  length: number;
  prefix: string;
}

/**
 * Reads an environment variable and returns a safe-prefix view ONLY.
 *
 * Invariant (spec §2 #8, ABSOLUTE): the returned `prefix` is the first
 * SAFE_PREFIX_LEN (= 4) characters of the value, or `""` if the value is
 * shorter than SAFE_PREFIX_LEN. The full value MUST NEVER be returned, and
 * `prefix.length` MUST be 0 or SAFE_PREFIX_LEN — no other values.
 *
 * The audit log records only `name` (no value, no prefix). Even the safe
 * prefix is response-only; audit redaction goes further and drops it.
 */
export async function checkEnvImpl(
  args: Input,
  _config: ResolvedConfig,
): Promise<Result<CheckEnvResult>> {
  const value = process.env[args.name];
  if (value === undefined) {
    return ok({ present: false, length: 0, prefix: "" });
  }
  // Mathematical bound: prefix is exactly first 4 chars iff length >= 4,
  // else empty. Never more.
  const prefix = value.length >= SAFE_PREFIX_LEN ? value.slice(0, SAFE_PREFIX_LEN) : "";
  return ok({
    present: true,
    length: value.length,
    prefix,
  });
}

export function registerCheckEnvTool(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.registerTool(
    "check_env",
    {
      title: "Safe-prefix probe of an environment variable",
      description: `Return only \`{present, length, prefix}\` for an environment variable.

Safe-prefix invariant (spec §2 #8, ABSOLUTE): \`prefix\` is the first ${SAFE_PREFIX_LEN}
characters of the value when the value is at least ${SAFE_PREFIX_LEN} chars long, else
\`""\`. The full value is NEVER returned. \`prefix.length\` is mathematically bounded to
0 or ${SAFE_PREFIX_LEN}.

The audit log records only the name; the safe-prefix view is response-only.

Args:
  - name (string): env var name (must match [A-Za-z_][A-Za-z0-9_]*)

Returns: { present, length, prefix }
Errors: none in normal operation (an undefined var returns { present: false, length: 0, prefix: "" }).`,
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
      runTool({ tool: "check_env", config }, args, (a) =>
        checkEnvImpl(a as Input, config),
      ),
  );
}

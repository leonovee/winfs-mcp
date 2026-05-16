import { z } from "zod";

/**
 * An absolute Windows or POSIX path inside one of the configured allowed
 * roots. Validated for non-emptiness only at the schema level — the
 * realpath + allowed-root check happens in `core/allowed_roots.ts` and
 * returns a structured EPERM_ROOT error instead of a Zod failure.
 */
export const AbsolutePath = z
  .string()
  .min(1, "path must be non-empty")
  .describe("Absolute filesystem path inside one of the configured allowedRoots");

export const LineRange = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([a, b]) => a <= b, { message: "range start must be <= end" })
  .describe("[start_line, end_line], 1-based, inclusive");

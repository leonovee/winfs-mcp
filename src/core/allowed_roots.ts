import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";
import { buildError, type StructuredError } from "./errors.js";

/**
 * Determines whether `child` is the same path as, or strictly inside, `parent`.
 * Both inputs must already be canonical absolute paths normalized with
 * `path.normalize`. Comparison is case-insensitive on Windows.
 */
function isSameOrInside(parent: string, child: string): boolean {
  if (process.platform === "win32") {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

export interface AllowCheckOptions {
  /** Permit the path to not exist yet (for write/mkdir targets). */
  allowMissing?: boolean;
}

/**
 * Canonicalize the supplied path via fs.realpath, then verify it lies inside
 * one of the configured allowed roots. Returns the resolved real path on
 * success or a structured EPERM_ROOT / ENOENT error.
 *
 * Hard invariant (spec §2.2): realpath FIRST, allowed-root check SECOND.
 * Skipping realpath enables junction/symlink escape.
 *
 * `allowMissing: true` falls back to realpath of the deepest existing
 * ancestor + appending the missing tail. This lets `write` target a new file
 * inside an allowed root without false-positive ENOENT, while still
 * defeating `..`-escape and junction shenanigans on the ancestor.
 */
export async function checkAllowed(
  inputPath: string,
  config: ResolvedConfig,
  opts: AllowCheckOptions = {},
): Promise<{ realPath: string } | StructuredError> {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return buildError("EINVAL", "path must be a non-empty string");
  }
  if (!path.isAbsolute(inputPath)) {
    return buildError("EINVAL", "path must be absolute", {
      details: { received: inputPath },
    });
  }

  const absolute = path.resolve(inputPath);

  let realPath: string;
  try {
    realPath = await fs.realpath(absolute);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT" || !opts.allowMissing) {
      if (e?.code === "ENOENT") {
        return buildError("ENOENT", `Path does not exist: ${absolute}`);
      }
      return buildError("EIO", `realpath failed: ${e?.message ?? String(err)}`);
    }
    // allowMissing: walk up to deepest existing ancestor, realpath it, then
    // re-append the missing tail so the allowed-roots check still applies
    // to a canonicalized ancestor.
    let ancestor = absolute;
    let tail = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        // Hit filesystem root without finding any existing ancestor; treat
        // the original path as unresolvable and reject.
        return buildError("ENOENT", `No existing ancestor for: ${absolute}`);
      }
      tail = tail ? path.join(path.basename(ancestor), tail) : path.basename(ancestor);
      ancestor = parent;
      try {
        const realAncestor = await fs.realpath(ancestor);
        realPath = path.join(realAncestor, tail);
        break;
      } catch (innerErr) {
        const ie = innerErr as NodeJS.ErrnoException;
        if (ie?.code === "ENOENT") continue;
        return buildError("EIO", `realpath ancestor failed: ${ie?.message ?? String(innerErr)}`);
      }
    }
  }

  const normReal = path.normalize(realPath);
  for (const root of config.resolvedAllowedRoots) {
    if (isSameOrInside(root, normReal)) {
      return { realPath: normReal };
    }
  }

  return buildError("EPERM_ROOT", `Path is outside allowedRoots`, {
    details: { resolved: normReal, attempted: absolute },
    hint:
      config.resolvedAllowedRoots.length === 0
        ? "No allowedRoots configured. Edit config.json to add one."
        : `allowedRoots: ${config.resolvedAllowedRoots.join(", ")}`,
  });
}

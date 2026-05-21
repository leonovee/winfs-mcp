import { promises as fs } from "node:fs";
import * as path from "node:path";
import { defaultConfigPath, type ResolvedConfig } from "./config.js";
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
 *
 * v0.6 §U: when `config.serverMode === "unrestricted"`, the allowed-roots
 * prefix check is SKIPPED. The path is still canonicalised via realpath
 * (handles symlinks, `..`, relative-to-absolute) and `allowMissing` semantics
 * still apply, but no EPERM_ROOT is ever returned. All other security
 * defenses (exec blocklist, SSRF, audit log, atomic writes) remain in force.
 * The mode is set at server start from `config.unrestrictedFilesystem` +
 * magic-string confirm.
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

  // v0.6 §U short-circuit: unrestricted mode bypasses the allowedRoots prefix
  // check. We still walk realpath (deepest-existing-ancestor pattern) so
  // symlinks resolve consistently and `allowMissing` callers still get a
  // canonical path. ENOENT semantics preserved when `!allowMissing`.
  if (config.serverMode === "unrestricted") {
    let realPath: string;
    let targetExists = true;
    try {
      realPath = await fs.realpath(absolute);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ENOENT") {
        return buildError("EIO", `realpath failed: ${e?.message ?? String(err)}`);
      }
      targetExists = false;
      realPath = absolute;
    }
    if (!targetExists && !opts.allowMissing) {
      return buildError("ENOENT", `Path does not exist: ${absolute}`);
    }
    return { realPath: path.normalize(realPath) };
  }

  // Always walk realpath on the deepest existing ancestor so allowed-roots
  // can be checked even when the target itself is missing. Doing the
  // allowed-roots check BEFORE returning ENOENT prevents existence leaks
  // for paths outside the sandbox (spec §2.2).
  let realPath: string;
  let targetExists = true;
  try {
    realPath = await fs.realpath(absolute);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "ENOENT") {
      return buildError("EIO", `realpath failed: ${e?.message ?? String(err)}`);
    }
    targetExists = false;
    let ancestor = absolute;
    let tail = "";
    let resolvedAncestor: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break; // hit filesystem root
      tail = tail ? path.join(path.basename(ancestor), tail) : path.basename(ancestor);
      ancestor = parent;
      try {
        resolvedAncestor = await fs.realpath(ancestor);
        break;
      } catch (innerErr) {
        const ie = innerErr as NodeJS.ErrnoException;
        if (ie?.code === "ENOENT") continue;
        return buildError("EIO", `realpath ancestor failed: ${ie?.message ?? String(innerErr)}`);
      }
    }
    if (resolvedAncestor === undefined) {
      // No existing ancestor at all: synthesise a normalised absolute path
      // so we can still answer the allowed-roots question deterministically.
      realPath = absolute;
    } else {
      realPath = path.join(resolvedAncestor, tail);
    }
  }

  const normReal = path.normalize(realPath);
  let insideAllowed = false;
  for (const root of config.resolvedAllowedRoots) {
    if (isSameOrInside(root, normReal)) {
      insideAllowed = true;
      break;
    }
  }
  if (!insideAllowed) {
    return buildError("EPERM_ROOT", `Path is outside allowedRoots`, {
      details: { resolved: normReal, attempted: absolute },
      hint:
        config.resolvedAllowedRoots.length === 0
          ? `No allowedRoots configured. Edit ${defaultConfigPath()} to add one. See README §Configuration.`
          : `allowedRoots: ${config.resolvedAllowedRoots.join(", ")}`,
    });
  }
  if (!targetExists && !opts.allowMissing) {
    return buildError("ENOENT", `Path does not exist: ${absolute}`);
  }
  return { realPath: normReal };
}

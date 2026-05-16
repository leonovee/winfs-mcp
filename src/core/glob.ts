import * as path from "node:path";

/**
 * Minimal path-glob matcher used by `glob` and `grep`.
 *
 * Supported syntax (picomatch-flavoured subset):
 *   `*`        — any chars except a path separator
 *   `?`        — exactly one char except a path separator
 *   `[...]`    — character class (forwarded to RegExp verbatim)
 *   `**`       — zero or more path segments (only meaningful as a full segment)
 *
 * Brace expansion (`{a,b}`) is NOT supported in v0.3 — the spec amendment
 * documents this. Users who need alternation can issue two glob calls.
 *
 * Path separators are normalised: both `/` and `\` are treated as segment
 * splitters regardless of host platform, which keeps Windows-friendly patterns
 * working in tests on POSIX runners.
 */

export interface CompiledGlob {
  /** Absolute literal prefix that contains no glob meta characters. Used as
   *  the walk root so we don't scan the whole drive. Always absolute. */
  base: string;
  /** Compiled regex matched against the full absolute path. */
  regex: RegExp;
  /** True if the pattern contains `**`, controlling recursion depth. */
  recursive: boolean;
  /** Normalised input pattern (kept for error messages). */
  pattern: string;
}

/** Splits a pattern on either separator without keeping empties. */
function splitSegments(pattern: string): string[] {
  return pattern.split(/[\\/]+/).filter((s) => s.length > 0);
}

function hasGlobMeta(segment: string): boolean {
  return /[*?[\]]/.test(segment);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

/**
 * Translate a single path segment glob into a regex fragment. Caller is
 * responsible for wrapping it with separators / anchors.
 */
function segmentToRegex(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "*") out += "[^/\\\\]*";
    else if (ch === "?") out += "[^/\\\\]";
    else if (ch === "[") {
      const end = segment.indexOf("]", i);
      if (end === -1) {
        out += "\\[";
      } else {
        // Preserve the class body literally. Users wanting `]` inside must
        // escape it themselves; the regex engine handles the rest.
        out += segment.slice(i, end + 1);
        i = end;
      }
    } else {
      out += escapeRe(ch);
    }
  }
  return out;
}

export class GlobCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobCompileError";
  }
}

/**
 * Compile an absolute glob pattern into a structure suitable for walking the
 * filesystem and matching entries.
 *
 * The pattern MUST be absolute (Windows drive letter or POSIX root). Relative
 * patterns are rejected with `GlobCompileError` so the caller can map it to
 * EINVAL — there is no implicit CWD inside an MCP tool, and the allowed-roots
 * check requires absolute paths anyway.
 */
export function compileGlob(pattern: string): CompiledGlob {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new GlobCompileError("pattern must be a non-empty string");
  }
  if (!path.isAbsolute(pattern)) {
    throw new GlobCompileError(
      `pattern must be absolute; received: ${pattern}`,
    );
  }

  const segments = splitSegments(pattern);
  // Extract the leading literal prefix (no glob meta). On Windows, the first
  // segment is typically the drive letter `C:` which we re-attach with `\`.
  let baseSegments: string[] = [];
  let i = 0;
  for (; i < segments.length; i++) {
    if (hasGlobMeta(segments[i]!)) break;
    baseSegments.push(segments[i]!);
  }
  const remainingSegments = segments.slice(i);

  let base: string;
  if (process.platform === "win32") {
    if (baseSegments.length === 0) {
      // Edge case: pattern starts with a glob (`\**\foo`). Use drive root.
      base = path.parse(pattern).root;
    } else if (/^[A-Za-z]:$/.test(baseSegments[0]!)) {
      base = baseSegments[0]! + path.sep + baseSegments.slice(1).join(path.sep);
    } else {
      base = path.sep + baseSegments.join(path.sep);
    }
  } else {
    base = "/" + baseSegments.join("/");
  }
  base = path.normalize(base);

  const recursive = remainingSegments.includes("**");

  // Build the regex against the FULL absolute path. The base is escaped
  // literally; remaining segments contribute glob-translated fragments
  // separated by either `\` or `/`.
  const sep = "[\\\\/]";
  const baseRe = escapeRe(base.replace(/[\\/]+$/, ""));

  let tailRe = "";
  for (let j = 0; j < remainingSegments.length; j++) {
    const seg = remainingSegments[j]!;
    if (seg === "**") {
      // `**` matches zero or more segments. Consume an optional trailing sep
      // so `a/**/b` matches `a/b` as well as `a/x/y/b`.
      tailRe += `(?:${sep}.*)?`;
    } else {
      tailRe += sep + segmentToRegex(seg);
    }
  }

  const fullRe = "^" + baseRe + tailRe + "$";
  let regex: RegExp;
  try {
    regex = new RegExp(fullRe, process.platform === "win32" ? "i" : "");
  } catch (err) {
    throw new GlobCompileError(
      `failed to compile pattern '${pattern}': ${(err as Error).message}`,
    );
  }

  return { base, regex, recursive, pattern };
}

/** True if a normalised absolute path matches the compiled glob. */
export function matchGlob(compiled: CompiledGlob, absolutePath: string): boolean {
  const norm = path.normalize(absolutePath);
  return compiled.regex.test(norm);
}

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";

/**
 * Recursively walk `start` and yield absolute paths of regular files only.
 * Each entry is realpath-checked and skipped if it resolves outside
 * `config.resolvedAllowedRoots` (junction / symlink escape) — same guard as
 * `copy`'s recursive walker. Dangling links are skipped silently.
 *
 * `visit` returns `false` to stop the walk early (used for `max_results`
 * truncation and timeout cancellation). The walker also bails when
 * `signal.aborted` is true between filesystem operations, so a parent
 * `withTimeout` can cooperatively cancel.
 *
 * Files outside the sandbox are not yielded — the caller may still surface
 * the count separately if it wants to report skips (none of the v0.3 tools
 * do; `copy` does and is unaffected).
 */
export async function walkFiles(
  start: string,
  config: ResolvedConfig,
  visit: (absPath: string) => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const stack: string[] = [start];

  while (stack.length > 0) {
    if (signal?.aborted) return;
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (signal?.aborted) return;
      const full = path.join(dir, ent.name);

      // realpath each entry so symlinks / junctions that escape the sandbox
      // get skipped (spec §2.2 + amendment 2026-05-16 §B).
      let real: string;
      try {
        real = await fs.realpath(full);
      } catch {
        continue;
      }
      if (!isInsideAllowed(real, config)) continue;

      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(real);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        stack.push(real);
        continue;
      }
      if (stat.isFile()) {
        const keepGoing = await visit(real);
        if (keepGoing === false) return;
      }
    }
  }
}

function isInsideAllowed(realPath: string, config: ResolvedConfig): boolean {
  const norm = path.normalize(realPath);
  const cmp = process.platform === "win32" ? norm.toLowerCase() : norm;
  for (const root of config.resolvedAllowedRoots) {
    const r = process.platform === "win32" ? root.toLowerCase() : root;
    if (cmp === r) return true;
    const withSep = r.endsWith(path.sep) ? r : r + path.sep;
    if (cmp.startsWith(withSep)) return true;
  }
  return false;
}

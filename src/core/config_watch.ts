/**
 * Phase G — runtime config hot-reload (child-spawn hardening wave).
 *
 * Watches the authoritative runtime config file (the `--config <path>` the
 * server was launched with, else %LOCALAPPDATA%\mcp-winfs\config.json) and, on
 * change, reloads ONLY `allowedRoots` without a full server restart. Other
 * fields remain restart-required (documented in README).
 *
 * Two invariants drive the design:
 *   1. VALIDATE-BEFORE-APPLY — a malformed edit (bad JSON, unknown strict key,
 *      failed cross-field validation) must NOT brick the running server. We
 *      reload via `loadConfig`, which throws on any invalid config; on throw we
 *      keep the previous config and log the error.
 *   2. RootsResolver is the SOLE owner of `config.resolvedAllowedRoots`
 *      (invariant #42). We update roots ONLY through `setConfigRoots`, never by
 *      reassigning the config field — this preserves the client-root union and
 *      the array identity the ~17 read sites depend on.
 */
import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";

/** Minimal surface of RootsResolver this module needs (keeps it testable). */
interface ConfigRootsSink {
  setConfigRoots(roots: readonly string[]): void;
}

export type ReloadResult =
  | { ok: true; rootCount: number }
  | { ok: false; error: string };

/**
 * Re-read the config from `configPath` and, if it validates, apply its
 * allowedRoots through the resolver. Returns a structured result; never throws
 * (a failed reload leaves the previous config in force).
 */
export async function reloadConfigRoots(
  configPath: string,
  resolver: ConfigRootsSink,
): Promise<ReloadResult> {
  try {
    // loadConfig performs the full schema + cross-field validation and throws
    // on any problem — this IS the validate-before-apply gate.
    const fresh = await loadConfig(configPath);
    resolver.setConfigRoots(fresh.resolvedAllowedRoots);
    return { ok: true, rootCount: fresh.resolvedAllowedRoots.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ConfigWatchHandle {
  close(): void;
}

/**
 * Watch `configPath` for changes and invoke `onChange` (debounced) after each
 * write. Returns a handle to stop watching.
 *
 * We watch the PARENT DIRECTORY and filter on basename rather than watching the
 * file directly: atomic-replace writes (temp-file + rename — which winfs itself
 * uses, and many editors do) replace the inode and silently break a single-file
 * `fs.watch` on Windows. A directory watch survives the replace. The debounce
 * coalesces the rename+change burst editors emit.
 */
export function watchConfigFile(
  configPath: string,
  onChange: () => void,
  opts?: { debounceMs?: number },
): ConfigWatchHandle {
  const debounceMs = opts?.debounceMs ?? 250;
  const dir = path.dirname(configPath);
  const base = path.basename(configPath).toLowerCase();
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        onChange();
      } catch {
        /* a reload-callback failure must not crash the watcher */
      }
    }, debounceMs);
    timer.unref?.();
  };

  try {
    // persistent:false → the watcher never keeps the process alive on its own.
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // filename can be null on some platforms — fire conservatively then.
      if (filename == null || path.basename(filename.toString()).toLowerCase() === base) {
        fire();
      }
    });
    watcher.on("error", () => {
      /* swallow — watching is best-effort; a broken watch must not crash us */
    });
  } catch {
    // Directory not watchable (permissions / transient) — degrade to no-op.
    watcher = undefined;
  }

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

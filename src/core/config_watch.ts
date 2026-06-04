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
import { watchFile, unwatchFile, type Stats } from "node:fs";
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

/**
 * Wrap an async task so at most ONE invocation runs at a time, with a
 * trailing-edge re-run: calls that arrive while a run is in flight are
 * coalesced into a single run that fires after the current one settles.
 *
 * Used to serialize config hot-reloads (review fix): without this, two edits
 * close together spawn two concurrent `reloadConfigRoots` calls whose
 * `loadConfig` (which awaits `fs.realpath` per root) can resolve out of
 * chronological order, leaving a STALE allowedRoots set in effect. Serializing
 * guarantees the last reload reads the freshest file and wins.
 */
export function createSerializedRunner(task: () => Promise<void>): () => void {
  let running = false;
  let pending = false;
  const run = (): void => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void task().finally(() => {
      running = false;
      if (pending) {
        pending = false;
        run();
      }
    });
  };
  return run;
}

export interface ConfigWatchHandle {
  close(): void;
}

/**
 * Watch `configPath` for changes and invoke `onChange` (debounced) after each
 * write. Returns a handle to stop watching.
 *
 * Implemented with `fs.watchFile` (stat-based POLLING), deliberately NOT the
 * event-based `fs.watch`. On Windows under the newer Node 24.x bundled libuv,
 * `fs.watch` (file OR directory) can trip a NATIVE libuv assertion in
 * `src/win/fs-event.c` (`!_wcsnicmp(filename, dir, dirlen)`), which aborts the
 * process — uncatchable from JS (it crashed the vitest fork pool in CI on
 * Node 24). `fs.watchFile` polls `stat` on a timer and never touches
 * `fs-event.c`, so it is immune.
 *
 * Polling also survives atomic-replace writes (temp-file + rename — which winfs
 * itself and many editors use) for free: `watchFile` follows the PATH, not the
 * inode, so the next poll stats the freshly-renamed file. We react only on an
 * actual change (mtime / size / inode), and the debounce coalesces the
 * rename+write burst. The interval (default 1 s) is fine for a single config
 * file; tests pass a short interval.
 */
export function watchConfigFile(
  configPath: string,
  onChange: () => void,
  opts?: { debounceMs?: number; intervalMs?: number },
): ConfigWatchHandle {
  const debounceMs = opts?.debounceMs ?? 250;
  const intervalMs = opts?.intervalMs ?? 1000;
  let timer: NodeJS.Timeout | undefined;
  let watching = false;

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

  const listener = (curr: Stats, prev: Stats): void => {
    // watchFile fires the listener each poll; react only on a real change —
    // mtime/size for an in-place edit, or inode for an atomic-replace (and the
    // zeroed-stat case when the file is removed, which flips mtime/ino too).
    if (
      curr.mtimeMs !== prev.mtimeMs ||
      curr.size !== prev.size ||
      curr.ino !== prev.ino
    ) {
      fire();
    }
  };

  try {
    // persistent:false → the poll timer never keeps the process alive on its own.
    watchFile(configPath, { persistent: false, interval: intervalMs }, listener);
    watching = true;
  } catch (err) {
    // Path not watchable (permissions / transient). Degrade to hot-reload-OFF:
    // the server keeps running on its current config; never crash on watch setup.
    process.stderr.write(
      `mcp-winfs config watcher disabled (hot-reload off): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    watching = false;
  }

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      if (watching) {
        try {
          unwatchFile(configPath, listener);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

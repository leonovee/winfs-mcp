import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ResolvedConfig } from "./config.js";
import { buildError, type StructuredError } from "./errors.js";

/**
 * Hardcoded execute_command blocklist (spec invariant #7). Patterns are
 * matched against the COMPOSED command string (command + args joined) before
 * spawn. Each pattern is a string compiled to a case-insensitive RegExp.
 *
 * Extensibility: callers may ADD to this list via `config.execExtraBlocklist`
 * — never remove. The base list is the spec's minimum guarantee.
 */
export const DEFAULT_EXEC_BLOCKLIST: readonly string[] = [
  // Filesystem destruction
  "Remove-Item\\s.*-Recurse",
  "Remove-Item\\s.*-rf",
  "rm\\s.*-rf",
  // P1.2 (v0.7 pre-tag bug-fix): rm aliases for Remove-Item accept short
  // recursive flags. Pre-fix only the combined `-rf` matched; `rm -r`,
  // `rm -R`, and `rm -Recurse` all bypassed.
  "rm\\s.*-[rR]\\b",
  "rm\\s.*-Recurse\\b",
  "rmdir\\s.*\\/[Ss]",
  "del\\s.*\\/[Ss]",
  // P1.1 (v0.7 pre-tag bug-fix): -EncodedCommand smuggles a base64-encoded
  // PowerShell payload past every other blocklist pattern (the destructive
  // verbs are encoded in base64; the literal patterns never match). Block
  // every prefix PowerShell accepts: `-e`, `-en`, `-enc`, …, `-EncodedCommand`.
  //
  // The pattern uses a lookahead to require `powershell` or `pwsh`
  // (optionally `.exe`) to appear ANYWHERE in the composed string. Anchoring
  // on the PowerShell context is essential: without it, the pattern would
  // over-block legitimate `node -e "..."`, `python -e ...`, etc. that share
  // the same short-flag spelling but are not the encoded-command attack
  // path. The composed string for execute_command is
  // `command + args.join(" ")`, so a caller targeting PowerShell will
  // always have `powershell` / `pwsh` in the string somewhere.
  //
  // Pattern compiled case-insensitive (i flag), so PowerShell / POWERSHELL /
  // pwsh all match.
  "(?=.*\\b(?:powershell|pwsh)(?:\\.exe)?\\b).*\\s-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?:\\s|$)",
  // Disk / partition operations
  "format\\s+[A-Za-z]:",
  "Format-Volume",
  "Initialize-Disk",
  "Clear-Disk",
  "Reset-PhysicalDisk",
  "cipher\\s+\\/w",
  "Optimize-Volume\\s.*ReTrim",
  // Boot / system tampering
  "bcdedit",
  "bcdboot",
  "reg\\s+delete\\s+HK(LM|EY_LOCAL_MACHINE)",
  "Remove-ItemProperty\\s.*HKLM:",
  "shutdown",
  "Restart-Computer",
  "Stop-Computer",
  // Forceful process termination
  "Stop-Process\\s.*-Force",
  // P2.7: narrow `taskkill /F` to require both /F AND /T (tree-force-kill
  // is the destructive case; a single-PID `/F` is legitimate for callers
  // who already located the right pid via `tasklist`). Match either flag
  // order. Bare `/T` (tree-WM_CLOSE) and bare `/F` (single-PID force) stay
  // unblocked.
  "taskkill\\s(?:.*\\/F.*\\/T|.*\\/T.*\\/F)",
  // Service / network manipulation
  "net\\s+user\\s+.*\\/add",
  "Add-LocalUser",
  "New-LocalUser",
  // Curl-bash pipe (download-and-execute)
  "Invoke-WebRequest.*\\|\\s*Invoke-Expression",
  "Invoke-Expression\\s+\\(.*Invoke-WebRequest",
  "iex\\s+\\(.*iwr",
  "curl\\s.*\\|\\s*(bash|sh|pwsh|powershell)",
  "wget\\s.*\\|\\s*(bash|sh|pwsh|powershell)",
];

/**
 * Standard Windows PATHEXT, set explicitly on every spawn env (Phase C,
 * child-spawn hardening). Under Claude Desktop on Windows the inherited
 * PATHEXT was observed mangled to `.CPL`, which makes libuv's bare-name
 * executable resolution fail (`git`/`node`/`where`/`taskkill` →
 * CommandNotFoundException / spawn ENOENT) even though the directory is on
 * PATH. We NEVER forward the inherited PATHEXT; we pin this standard list so
 * bare-name resolution is deterministic regardless of the parent env. The
 * value matches the Windows default PATHEXT.
 */
export const STANDARD_WINDOWS_PATHEXT =
  ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

interface CompiledBlocklist {
  patterns: { source: string; regex: RegExp }[];
}

let _compiled: CompiledBlocklist | null = null;
let _compiledKey: string = "";

// P2.3: hash DEFAULT_EXEC_BLOCKLIST into the cache key so a future change
// that mutated DEFAULT at runtime (or a test that monkey-patches it) won't
// silently serve a stale compiled list. The key embeds the DEFAULT joined
// + the extra joined, separated by a delimiter that no pattern uses.
const DEFAULT_KEY = DEFAULT_EXEC_BLOCKLIST.join("|||");

function compileBlocklist(extra: readonly string[]): CompiledBlocklist {
  const key = `${DEFAULT_KEY}###${[...extra].join("|||")}`;
  if (_compiled && _compiledKey === key) return _compiled;
  const patterns: { source: string; regex: RegExp }[] = [];
  for (const p of DEFAULT_EXEC_BLOCKLIST) {
    patterns.push({ source: p, regex: new RegExp(p, "i") });
  }
  for (const p of extra) {
    try {
      patterns.push({ source: p, regex: new RegExp(p, "i") });
    } catch {
      // Malformed user-supplied regex: skip silently. Surfaces as
      // configuration warning via stderr in a later config-load improvement.
    }
  }
  _compiled = { patterns };
  _compiledKey = key;
  return _compiled;
}

/**
 * Pre-spawn blocklist check. The full command (with args joined by single
 * spaces) is matched against each compiled pattern. First match returns
 * EBLOCKED with the offending pattern in details.
 */
export function checkExecBlocklist(
  composed: string,
  config: ResolvedConfig,
): StructuredError | undefined {
  const { patterns } = compileBlocklist(config.execExtraBlocklist);
  for (const { source, regex } of patterns) {
    const m = composed.match(regex);
    if (m) {
      return buildError("EBLOCKED", `execute_command rejected by blocklist`, {
        details: {
          pattern: source,
          matched: m[0],
          position: m.index ?? -1,
        },
        hint: "Adjust the command, or remove the matched pattern. The default blocklist is hardcoded; extensions are additive via config.execExtraBlocklist.",
      });
    }
  }
  return undefined;
}

/**
 * Returns the sanitized PATH directories that subprocess inherits, as an array
 * in resolution order. Single source of truth — `sanitizedPath` joins this with
 * `;` and `list_path_dirs` surfaces it directly. User's $PATH is NOT inherited.
 *
 * Spec invariant Step 1 #10. Includes Windows system, Git CLI, Node, and
 * optionally Python via `config.pythonHome`.
 */
export function sanitizedPathDirs(config: ResolvedConfig): string[] {
  const parts: string[] = [
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "C:\\Windows",
    "C:\\Program Files\\PowerShell\\7",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\Git\\bin",
    "C:\\Program Files\\nodejs",
  ];
  if (config.pythonHome) parts.push(config.pythonHome);
  // P2.4: operator-supplied extra dirs for non-standard tool installs.
  if (config.execExtraPathDirs?.length) parts.push(...config.execExtraPathDirs);
  return parts;
}

/** PATH string (`;`-joined sanitizedPathDirs). Subprocess-env builder uses
 *  this; `list_path_dirs` uses the array form. */
export function sanitizedPath(config: ResolvedConfig): string {
  return sanitizedPathDirs(config).join(";");
}

/** Build the env object subprocesses inherit. With execSanitizeEnv: true,
 *  only PATH + USERPROFILE + LOCALAPPDATA survive. Default false → inherits
 *  most env but overrides PATH. */
export function buildExecEnv(config: ResolvedConfig): NodeJS.ProcessEnv {
  const sanitizedPathVar = sanitizedPath(config);
  if (config.execSanitizeEnv) {
    const env: NodeJS.ProcessEnv = {
      PATH: sanitizedPathVar,
      Path: sanitizedPathVar, // Windows case-insensitive variant
      // Phase C: pin PATHEXT (sanitize mode previously dropped it entirely,
      // which also breaks bare-name resolution).
      PATHEXT: STANDARD_WINDOWS_PATHEXT,
      // Phase E: a git invoked via execute_command must never block on a
      // credential prompt waiting on a terminal that isn't there.
      GIT_TERMINAL_PROMPT: "0",
    };
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.LOCALAPPDATA) env.LOCALAPPDATA = process.env.LOCALAPPDATA;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    return env;
  }
  // Phase C: override the inherited PATHEXT (observed mangled to `.CPL` under
  // Claude Desktop) so bare-name executable resolution is deterministic.
  return {
    ...process.env,
    PATH: sanitizedPathVar,
    Path: sanitizedPathVar,
    PATHEXT: STANDARD_WINDOWS_PATHEXT,
    // Phase E: disable git's interactive credential prompt (see above).
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Build the env for a ProcessRegistry SESSION spawn (start_process): the
 * sanitized base env from {@link buildExecEnv} plus the caller's `extraEnv`,
 * with the hardening-critical keys RE-PINNED *after* the caller's vars. A
 * caller may add arbitrary environment variables, but cannot clobber the
 * sanitized PATH or the standard PATHEXT — otherwise a session spawn could
 * reinstate the mangled `.CPL` PATHEXT that Phase C exists to fix (the prompt
 * mandates the hardening on "every spawn — one-shot AND session"). The
 * one-shot path already had this guarantee because execute_command exposes no
 * env arg; this gives the session path the same guarantee.
 *
 * GIT_TERMINAL_PROMPT defaults to "0" but a caller MAY override it (a session
 * is interactive by nature; unlike PATH/PATHEXT it is not a determinism or
 * resolution invariant).
 */
export function buildSessionEnv(
  config: ResolvedConfig,
  extraEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitizedPathVar = sanitizedPath(config);
  return {
    ...buildExecEnv(config),
    ...extraEnv,
    PATH: sanitizedPathVar,
    Path: sanitizedPathVar,
    PATHEXT: STANDARD_WINDOWS_PATHEXT,
    GIT_TERMINAL_PROMPT: extraEnv.GIT_TERMINAL_PROMPT ?? "0",
  };
}

export interface SpawnSubprocessOptions {
  /** Process binary to spawn (resolved absolute path or name in sanitized PATH). */
  bin: string;
  /** Args array, passed verbatim — no shell interpolation. */
  args: string[];
  /** Working directory. Caller is responsible for allowedRoots validation. */
  cwd: string;
  /** Hard deadline. SIGTERM at deadline, SIGKILL 2 s later. */
  deadlineMs: number;
  /** Per-stream output cap. Excess bytes are dropped + flag surfaced. */
  maxOutputBytes: number;
  /** Resolved config for env construction. */
  config: ResolvedConfig;
  /** External abort signal (typically from runTool wrapper). */
  signal?: AbortSignal;
}

export interface SpawnSubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  durationMs: number;
  spawnFailed: boolean;
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
  /** v0.7 pre-tag bug-fix wave (P1.3): true iff an external AbortSignal
   *  caused the child to be killed. Lets callers distinguish a clean
   *  no-output exit (exit_code: null, aborted: false) from an
   *  external-cancellation (exit_code: null, aborted: true) — pre-fix
   *  the two were indistinguishable. */
  aborted: boolean;
}

/**
 * Spawns a subprocess with the v0.5 exec defenses applied:
 * - PATH sanitized via buildExecEnv (spec Step 1 #10)
 * - Hard deadline with two-stage kill (SIGTERM → SIGKILL after 2s grace)
 * - Per-stream output cap (drop excess, set truncated flag)
 * - Optional process-tree kill on Windows via `taskkill /F /T /PID`
 *
 * Caller is responsible for the blocklist check (this helper trusts the args).
 */
export async function spawnSubprocess(
  opts: SpawnSubprocessOptions,
): Promise<SpawnSubprocessResult> {
  const started = Date.now();
  return new Promise<SpawnSubprocessResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncatedStdout = false;
    let truncatedStderr = false;
    let timedOut = false;
    let aborted = false;
    /** P1.3: latched the moment an external abort fires, even if child.pid
     *  is still undefined (spawn-in-progress). The `spawn` event handler
     *  checks this and kills the child as soon as pid materialises. */
    let abortRequested = false;
    let settled = false;
    let killedByCap = false;
    // v0.5.x bug surfaced by v0.6 smoke: when `spawn()` succeeds synchronously
    // but the OS fails to start the process (typical case: executable not on
    // sanitized PATH), Node emits an asynchronous "error" event. Without
    // capturing that error here, onSettle resolved with `spawnFailed: false`
    // + `exitCode: null` + empty stdout/stderr — which the caller couldn't
    // distinguish from a clean-exit + no-output process. We now capture the
    // async error and pass it to onSettle so the spawnFailed path is surfaced
    // consistently with the synchronous-throw path above.
    let asyncSpawnError: NodeJS.ErrnoException | null = null;

    const env = buildExecEnv(opts.config);

    let child;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        truncatedStdout: false,
        truncatedStderr: false,
        durationMs: Date.now() - started,
        spawnFailed: true,
        spawnErrorCode: e?.code,
        spawnErrorMessage: e?.message ?? String(err),
        aborted: false,
      });
      return;
    }

    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        try {
          // Force-kill the process tree. swallow output.
          const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
            windowsHide: true,
            stdio: "ignore",
            // Phase C: pin PATHEXT so bare-name `taskkill` still resolves even
            // when the inherited PATHEXT is mangled (.CPL) — otherwise the
            // kill itself would fail and the child would wedge.
            env: { ...process.env, PATHEXT: STANDARD_WINDOWS_PATHEXT },
          });
          killer.on("error", () => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          });
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    };

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!settled) killTree();
      }, 2000).unref();
    }, opts.deadlineMs);
    deadlineTimer.unref?.();

    const onAbort = (): void => {
      aborted = true;
      abortRequested = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!settled) killTree();
      }, 2000).unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // P1.3 race fix: if abort fires BEFORE the child's pid is assigned, the
    // initial kill attempt is a no-op (kill on undefined pid). The `spawn`
    // event fires once the OS has actually launched the process and pid is
    // valid — check abortRequested then and finish the kill.
    child.on("spawn", () => {
      if (abortRequested && !settled) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          if (!settled) killTree();
        }, 2000).unref();
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length <= opts.maxOutputBytes) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        const remaining = opts.maxOutputBytes - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = opts.maxOutputBytes;
        }
        truncatedStdout = true;
        if (!killedByCap) {
          killedByCap = true;
          killTree();
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length <= opts.maxOutputBytes) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        const remaining = opts.maxOutputBytes - stderrBytes;
        if (remaining > 0) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes = opts.maxOutputBytes;
        }
        truncatedStderr = true;
        if (!killedByCap) {
          killedByCap = true;
          killTree();
        }
      }
    });

    const onSettle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      const base = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
        aborted,
        truncatedStdout,
        truncatedStderr,
        durationMs: Date.now() - started,
      };
      if (asyncSpawnError) {
        resolve({
          ...base,
          spawnFailed: true,
          spawnErrorCode: asyncSpawnError.code,
          spawnErrorMessage: asyncSpawnError.message ?? String(asyncSpawnError),
        });
      } else {
        resolve({ ...base, spawnFailed: false });
      }
    };

    child.on("error", (err) => {
      asyncSpawnError = err as NodeJS.ErrnoException;
      onSettle(null);
    });
    child.on("close", (code) => onSettle(code));
  });
}

/** Locate python binary. If config.pythonHome is set, prefers
 *  `<pythonHome>/python.exe` (Windows) / `<pythonHome>/python` (POSIX);
 *  falls back to "python" name in sanitized PATH. */
export function resolvePython(config: ResolvedConfig): string {
  if (config.pythonHome) {
    return process.platform === "win32"
      ? path.join(config.pythonHome, "python.exe")
      : path.join(config.pythonHome, "python");
  }
  return process.platform === "win32" ? "python.exe" : "python";
}

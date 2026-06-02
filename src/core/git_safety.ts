import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ResolvedConfig } from "./config.js";
import { checkAllowed } from "./allowed_roots.js";
import { buildError, type StructuredError } from "./errors.js";
import { STANDARD_WINDOWS_PATHEXT } from "./exec_safety.js";

/**
 * Hardcoded mutation-flag denylist for git read-only tools. Spec invariant
 * #12 (no runtime config mutation) — this list is compile-time, NOT
 * config-driven. Adding a new mutation flag requires a source edit + a
 * spec amendment.
 *
 * Each entry is matched as a complete argument (string equality OR prefix
 * for `--*=value` shapes). If ANY arg in the spawn list matches, the call
 * returns EGITMUTATION before the spawn happens.
 */
export const GIT_MUTATION_FLAGS: readonly string[] = [
  // Index / worktree mutations
  "add", "rm", "mv", "restore", "reset", "checkout", "switch", "clean",
  "stash", "apply", "am", "commit", "merge", "rebase", "cherry-pick", "revert",
  "branch", "tag", "notes", "update-ref", "update-index", "symbolic-ref",
  // Remote mutations
  "push", "fetch", "pull", "remote", "submodule", "clone",
  // Hook / config writes
  "config", "init", "gc", "prune", "repack", "fsck", "reflog",
  "filter-branch", "filter-repo", "replace",
  // Long-flag forms
  "--write", "--write-tree", "--write-object",
];

/**
 * Verifies no arg in the spawn list matches a known mutation flag. Returns
 * undefined on success, or a StructuredError to short-circuit the caller.
 * The first matched flag is surfaced in `details.flag`.
 */
export function checkGitArgsReadOnly(args: readonly string[]): StructuredError | undefined {
  const denyset = new Set(GIT_MUTATION_FLAGS);
  for (const arg of args) {
    if (denyset.has(arg)) {
      return buildError("EGITMUTATION", `mutation git subcommand/flag rejected: ${arg}`, {
        details: { flag: arg },
        hint: "git tools are hard read-only by invariant; this build does not expose mutations.",
      });
    }
    // Long-flag with value form: --write-tree=foo
    for (const denied of GIT_MUTATION_FLAGS) {
      if (denied.startsWith("--") && arg.startsWith(`${denied}=`)) {
        return buildError("EGITMUTATION", `mutation git flag rejected: ${arg}`, {
          details: { flag: arg },
          hint: "git tools are hard read-only by invariant.",
        });
      }
    }
  }
  return undefined;
}

/**
 * Validates a user-supplied path_filter. Rejects NUL bytes and ASCII control
 * chars (0x00-0x1F, 0x7F). Returns the sanitized filter on success or a
 * StructuredError on rejection. Returned filter MUST be passed to git AFTER
 * a `--` separator so git treats it as pathspec, not as a rev.
 */
export function checkPathFilter(filter: string): { filter: string } | StructuredError {
  for (let i = 0; i < filter.length; i++) {
    const code = filter.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return buildError("EINVAL", "path_filter contains a control character", {
        details: { char_code: code, position: i },
      });
    }
  }
  return { filter };
}

/**
 * Resolves `repo_path` via the standard allowedRoots check, then asserts
 * `<repo>/.git` exists (directory for normal repos, file for worktrees).
 * Returns the realpath of the repo on success or a StructuredError.
 */
export async function resolveGitRepo(
  repoPath: string,
  config: ResolvedConfig,
): Promise<{ repoRoot: string } | StructuredError> {
  const check = await checkAllowed(repoPath, config);
  if ("ok" in check && check.ok === false) return check;
  const realRoot = (check as { realPath: string }).realPath;
  const dotGit = path.join(realRoot, ".git");
  try {
    await fs.stat(dotGit);
  } catch {
    return buildError("ENOTREPO", "path does not contain a .git entry", {
      details: { repo_path: realRoot },
      hint: "Pass the root of a git repository (the directory that contains .git).",
    });
  }
  return { repoRoot: realRoot };
}

/**
 * Spawn `git` with the given args inside `cwd`. Captures stdout/stderr,
 * enforces the deadline, returns a normalized result. Mutation-flag check
 * MUST be performed by the caller before invoking — this helper does NOT
 * re-validate (the caller knows which args are user-supplied vs hardcoded).
 *
 * Output is buffered in memory; total cap = stdoutMaxBytes + stderrMaxBytes
 * (default 4 MB each — git output can be large for log/diff).
 */
export interface GitSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Env for git spawns (Phase C+E). Pins PATHEXT so bare-name `git` resolves
 * under a mangled inherited .CPL, and sets GIT_TERMINAL_PROMPT=0 so an
 * authenticated op can't hang waiting on a credential prompt (git tools are
 * also hard read-only via GIT_MUTATION_FLAGS). PATH is left inherited — git
 * tools do not use the sanitized PATH (switching them is a separate change).
 */
export function gitSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATHEXT: STANDARD_WINDOWS_PATHEXT,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function spawnGit(
  args: readonly string[],
  cwd: string,
  deadlineMs: number,
  maxBytesPerStream: number = 4 * 1024 * 1024,
): Promise<GitSpawnResult> {
  return new Promise<GitSpawnResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const child = spawn("git", [...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Phase C+E: pinned PATHEXT + GIT_TERMINAL_PROMPT=0 (see gitSpawnEnv).
      env: gitSpawnEnv(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Hard kill 2s grace, then force.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000).unref();
    }, deadlineMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length <= maxBytesPerStream) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        const remaining = maxBytesPerStream - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = maxBytesPerStream;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length <= maxBytesPerStream) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        const remaining = maxBytesPerStream - stderrBytes;
        if (remaining > 0) {
          stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes = maxBytesPerStream;
        }
      }
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: null,
        timedOut,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
        timedOut,
      });
    });
  });
}

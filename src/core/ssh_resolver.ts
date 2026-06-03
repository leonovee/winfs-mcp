import { existsSync } from "node:fs";
import type { ResolvedConfig } from "./config.js";

/**
 * Item 6 — central ssh binary resolution for ssh_exec.
 *
 * The System32 OpenSSH client (`C:\Windows\System32\OpenSSH\ssh.exe`) exists on
 * Windows 10/11 but is broken on some hosts (exits 255). The Git-for-Windows
 * bundled OpenSSH (`C:\Program Files\Git\usr\bin\ssh.exe`) is a reliable
 * alternative. Resolution order:
 *
 *   1. `config.sshExePath` — explicit operator override. Returned verbatim
 *      (existence is checked by the caller, which surfaces ESSHNOTFOUND if the
 *      configured path is missing — strict, preserves the v0.7 contract).
 *   2. Git-bundled ssh — PREFERRED over System32 (works where System32 fails).
 *   3. System32 OpenSSH ssh.exe.
 *   4. bare `ssh.exe` — PATH fallback (caller's existence check yields
 *      ESSHNOTFOUND if even this can't be stat'd as an absolute path).
 *
 * Not cached: resolution is only `existsSync` probes (cheap), unlike the
 * PowerShell resolver's `where` spawn — so per-call resolution stays correct
 * even when `config.sshExePath` differs between calls (e.g. across tests).
 */
export const GIT_BUNDLED_SSH = "C:\\Program Files\\Git\\usr\\bin\\ssh.exe";
export const SYSTEM32_SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";

export function resolveSshBin(
  config: ResolvedConfig,
  // Injectable for tests; defaults to the real filesystem probe.
  existsFn: (p: string) => boolean = existsSync,
): string {
  // 1. Explicit override — honored strictly (caller's stat → ESSHNOTFOUND).
  if (config.sshExePath) return config.sshExePath;

  // POSIX: rely on PATH (winfs is Windows-only, but keep this total).
  if (process.platform !== "win32") return "ssh";

  // 2 & 3. Auto-detect: prefer Git-bundled over System32.
  for (const candidate of [GIT_BUNDLED_SSH, SYSTEM32_SSH]) {
    if (existsFn(candidate)) return candidate;
  }

  // 4. PATH fallback.
  return "ssh.exe";
}

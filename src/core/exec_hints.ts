/**
 * v0.7 wave 2a: diagnostic hints attached to execute_command responses when
 * child stderr contains a known cryptic-failure signature.
 *
 * Design goals:
 *  - Substring match, case-insensitive, no regex creativity. Fast and easy to
 *    extend.
 *  - Hints are *additive* to the response envelope (new field `hints: string[]`).
 *    Raw stderr is NEVER mutated.
 *  - Hints are NOT persisted to the audit log (noise reduction; the underlying
 *    stderr_prefix already captures the verbatim failure).
 *
 * Add a new entry by pushing into HINT_REGISTRY. Each entry is one short
 * paragraph that explains what likely went wrong and what to try.
 */

export interface HintEntry {
  /** Case-insensitive substring searched in stderr. */
  marker: string;
  /** Hint to attach when the marker is found. One short paragraph. */
  hint: string;
}

export const HINT_REGISTRY: readonly HintEntry[] = [
  {
    marker: "Cannot run a document in the middle of a pipeline",
    // P2.6 (v0.7 pre-tag bug-fix): the prior hint suggested "try cmd",
    // but execute_command runs PowerShell only — `cmd` is not an available
    // dispatch route from this tool. Rewrite to actionable advice that
    // works inside this server's contract.
    hint:
      "PowerShell refused to execute a file via the call operator (`&`). The file's " +
      "extension is registered with a non-PowerShell-runnable handler (e.g. a document " +
      "extension). Inside this tool the workable paths are: (1) invoke the binary " +
      "directly without `&` — `C:\\full\\path\\to\\binary.exe args`; (2) wrap in " +
      "`Start-Process -FilePath ... -Wait` if you need the side-effect; (3) for " +
      "ssh.exe specifically, use the `ssh_exec` tool which spawns ssh outside the " +
      "PowerShell pipeline.",
  },
];

/**
 * Return the list of hints that apply to the given stderr buffer. Empty array
 * if none match. Caller decides whether to attach (e.g., omit field entirely
 * when empty for envelope cleanliness).
 */
export function diagnoseHints(stderr: string): string[] {
  if (!stderr) return [];
  const lower = stderr.toLowerCase();
  const matched: string[] = [];
  for (const entry of HINT_REGISTRY) {
    if (lower.includes(entry.marker.toLowerCase())) {
      matched.push(entry.hint);
    }
  }
  return matched;
}

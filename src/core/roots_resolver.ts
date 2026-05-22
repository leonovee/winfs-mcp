import { promises as fs } from "node:fs";
import * as path from "node:path";
import { appendAudit } from "./audit.js";
import type { ResolvedConfig } from "./config.js";

/**
 * Owner of the effective `allowedRoots` set during the server's lifetime.
 *
 * Pre-v0.9 winfs treated `config.resolvedAllowedRoots` as a static
 * snapshot loaded from `%LOCALAPPDATA%\mcp-winfs\config.json`. v0.9
 * adds MCP Roots support: the client (Claude Desktop / VS Code /
 * Cursor) may signal its current project roots at connection time
 * AND via `notifications/roots/list_changed` during the session.
 *
 * Spec §AC (invariant #42) — union mode, not replace:
 *   effectiveAllowedRoots = union(config.allowedRoots, clientRoots)
 *
 * Rationale: winfs's safety posture is "narrow by default". Client
 * roots can only WIDEN access, never silently remove paths the
 * operator explicitly trusted via config. Empty client roots →
 * config-only access (no regression vs pre-v0.9 behavior).
 *
 * ## Implementation note: in-place mutation of config.resolvedAllowedRoots
 *
 * This resolver is the SOLE OWNER of writes to
 * `config.resolvedAllowedRoots`. Every readers in `src/` (the 17 call
 * sites of `config.resolvedAllowedRoots` as of v0.9) continues to
 * read the field unchanged; they automatically pick up the latest
 * effective set because the resolver mutates the array in place via
 * `.length = 0; .push(...union)`. Single-threaded JS guarantees no
 * concurrent reader sees a half-updated array.
 *
 * The previous "config is immutable post-loadConfig" convention
 * becomes "config is read-only EXCEPT for resolvedAllowedRoots, which
 * is owned by RootsResolver". Spec §AC documents the exception.
 */
export class RootsResolver {
  private readonly config: ResolvedConfig;
  /** Immutable snapshot of the config-supplied roots, captured at
   *  construction. The union starts here and grows when client roots
   *  arrive; it never shrinks below this set. */
  private readonly configRoots: readonly string[];
  /** Last validated client-roots array. Replaced atomically per
   *  setClientRoots call; never mutated in place. */
  private currentClientRoots: readonly string[] = [];

  constructor(config: ResolvedConfig) {
    this.config = config;
    // Snapshot the config roots BEFORE we ever mutate the live array.
    this.configRoots = [...config.resolvedAllowedRoots];
    // Initial state: client roots empty → effective == config roots.
    // No-op recompute call to confirm the field is in sync.
    this.recompute();
  }

  /** Read-only view of the original config-supplied roots. */
  readonly getConfigRoots = (): readonly string[] => this.configRoots;

  /** Current set of accepted client-supplied roots (after validation). */
  readonly clientRoots = (): readonly string[] => this.currentClientRoots;

  /** Effective union of config + client roots — the live set
   *  `checkAllowed` consults via `config.resolvedAllowedRoots`. */
  readonly effective = (): readonly string[] =>
    [...this.config.resolvedAllowedRoots];

  /**
   * Replace the client-supplied roots set. Validates each path:
   *   - must be absolute
   *   - must exist
   *   - must be a directory
   *   - realpath-resolved to defeat symlink-escape
   *
   * Invalid roots are SKIPPED with a stderr warning (per the
   * Filesystem-MCP reference's partial-success semantics — one bad
   * client root does not poison the rest of the set).
   *
   * Successful update emits a `_client_roots_updated` audit record
   * with COUNT ONLY, NEVER PATHS. The path contents would leak
   * client-side directory structure into the audit trail; that's
   * out-of-scope for the audit's "what did the server do" remit.
   */
  async setClientRoots(roots: readonly string[]): Promise<void> {
    const validated: string[] = [];
    const rejected: string[] = [];

    for (const raw of roots) {
      if (typeof raw !== "string" || raw.length === 0) {
        rejected.push("<empty>");
        continue;
      }
      if (!path.isAbsolute(raw)) {
        process.stderr.write(
          `RootsResolver: rejecting non-absolute client root: ${raw}\n`,
        );
        rejected.push(raw);
        continue;
      }
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(raw);
      } catch {
        process.stderr.write(
          `RootsResolver: rejecting non-existent client root: ${raw}\n`,
        );
        rejected.push(raw);
        continue;
      }
      if (!stat.isDirectory()) {
        process.stderr.write(
          `RootsResolver: rejecting non-directory client root: ${raw}\n`,
        );
        rejected.push(raw);
        continue;
      }
      let real: string;
      try {
        real = await fs.realpath(raw);
      } catch {
        // Permission or transient FS error: keep the literal absolute
        // form (matches checkAllowed's deepest-existing-ancestor fallback).
        real = raw;
      }
      const norm = path.normalize(real);
      // Per reference filesystem-MCP, store BOTH the user-supplied
      // absolute form AND the realpath-resolved form. Some clients
      // pass canonicalised paths; others pass paths with symlink
      // segments. We accept both to avoid false-EPERM_ROOT on either.
      validated.push(norm);
      const literal = path.normalize(raw);
      if (literal.toLowerCase() !== norm.toLowerCase()) {
        validated.push(literal);
      }
    }

    this.currentClientRoots = validated;
    this.recompute();

    appendAudit(this.config, {
      ts: new Date().toISOString(),
      tool: "_client_roots_updated",
      args_summary: {
        accepted_count: validated.length,
        rejected_count: rejected.length,
        config_roots_count: this.configRoots.length,
        effective_count: this.config.resolvedAllowedRoots.length,
        // NEVER include path strings — these would leak the caller's
        // directory layout into the audit trail.
      },
      result_status: "ok",
      duration_ms: 0,
      mode: this.config.serverMode,
    });
  }

  /** Recompute effective = dedupe(configRoots ∪ clientRoots), mutate
   *  the live config array in place. Case-insensitive dedup on
   *  Windows (matches checkAllowed's case-insensitive prefix
   *  comparison). */
  private recompute(): void {
    const seen = new Set<string>();
    const union: string[] = [];
    const isWin = process.platform === "win32";
    for (const r of [...this.configRoots, ...this.currentClientRoots]) {
      const key = isWin ? r.toLowerCase() : r;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(r);
    }
    // Single-threaded JS: no reader sees a half-updated array, but be
    // explicit about the contract: this mutates in place via
    // length=0 + push so the field's array identity is stable.
    this.config.resolvedAllowedRoots.length = 0;
    this.config.resolvedAllowedRoots.push(...union);
  }
}

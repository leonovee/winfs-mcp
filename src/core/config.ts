import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

const CONFIG_SCHEMA = z
  .object({
    allowedRoots: z.array(z.string()).default([]),
    allowedUrlHosts: z.array(z.string()).default([]),
    deniedUrlPatterns: z.array(z.string()).default([]),
    shellBlocklist: z.array(z.string()).default([]),
    defaultTimeoutMs: z.number().int().positive().default(10_000),
    maxTimeoutMs: z.number().int().positive().default(60_000),
    shellTimeoutMs: z.number().int().positive().default(30_000),
    shellMaxTimeoutMs: z.number().int().positive().default(300_000),
    fetchUrlMaxBytes: z.number().int().positive().default(5 * 1024 * 1024),
    fetchUrlTimeoutMs: z.number().int().positive().default(15_000),
    readMaxBytes: z.number().int().positive().default(10 * 1024 * 1024),
    maxDiffBytes: z.number().int().positive().default(256 * 1024),
    // v0.5: execute_command / run_python / run_pytest output cap (per stream)
    execMaxOutputBytes: z.number().int().positive().default(1 * 1024 * 1024),
    // v0.5: additive-only extension of the hardcoded exec blocklist
    execExtraBlocklist: z.array(z.string()).default([]),
    // v0.5: python binary lookup root; if set, <pythonHome>/python.exe used
    pythonHome: z.string().optional(),
    // v0.5: sanitize subprocess env (drop user $PATH and everything outside USERPROFILE/LOCALAPPDATA)
    execSanitizeEnv: z.boolean().default(false),
    // v0.6: configurable filesystem scope. When true (and the magic-string
    // confirm field matches), checkAllowed short-circuits and accepts paths
    // outside allowedRoots. All other security defenses stay in force. See
    // spec §U for rationale + threat model.
    unrestrictedFilesystem: z.boolean().default(false),
    // v0.6: magic-string confirm required when unrestrictedFilesystem === true.
    // Must equal exactly `"I-UNDERSTAND-THE-RISK"`. Mismatch → startup fails
    // with a structured config error. Prevents accidental enable.
    unrestrictedFilesystemConfirm: z.string().optional(),
    // v0.7 wave 1: ssh_exec binary path. Default OpenSSH location on
    // Windows 10/11 (System32\OpenSSH\ssh.exe). Resolved once at startup;
    // if the path doesn't exist, the tool still registers but every call
    // returns ESSHNOTFOUND.
    sshExePath: z.string().default("C:\\Windows\\System32\\OpenSSH\\ssh.exe"),
    // v0.7 wave 2b — process control registry tunables. Sessions stay
    // in the in-memory registry for `processSessionTtlMs` after they
    // settle so late `interact` calls can still fetch final output.
    processMaxConcurrent: z.number().int().positive().default(16),
    processBufferCap: z.number().int().positive().default(1 * 1024 * 1024),
    processSessionTtlMs: z.number().int().positive().default(60_000),
    processGcIntervalMs: z.number().int().positive().default(10_000),
    auditLogPath: z.string().optional(),
    auditLogMaxBytes: z.number().int().positive().default(10 * 1024 * 1024),
  })
  .strict();

export type RawConfig = z.infer<typeof CONFIG_SCHEMA>;

/** v0.6 §U: derived from `unrestrictedFilesystem`. "strict" is the default
 *  (allowedRoots enforced); "unrestricted" is the opt-in mode. */
export type ServerMode = "strict" | "unrestricted";

export interface ResolvedConfig extends RawConfig {
  /** The path the config was loaded from, or "<defaults>" if synthesised. */
  configPath: string;
  /** Absolute canonical allowed roots after realpath resolution. */
  resolvedAllowedRoots: string[];
  /** Absolute audit log path, %ENV% expanded. */
  resolvedAuditLogPath: string;
  /** Server version string baked at startup. */
  version: string;
  /** v0.6 §U: derived from `unrestrictedFilesystem`. */
  serverMode: ServerMode;
}

const VERSION = "0.6.0";

/** v0.6 §U: exact magic string required as `unrestrictedFilesystemConfirm`
 *  when `unrestrictedFilesystem` is true. Hardcoded; never configurable. */
const UNRESTRICTED_CONFIRM_MAGIC = "I-UNDERSTAND-THE-RISK";

/**
 * Expand %ENVVAR% sequences (Windows-style) in a path string.
 * Unknown variables are left as-is so the user can spot misconfiguration.
 */
export function expandEnv(input: string): string {
  return input.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);
}

export function defaultConfigPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "mcp-winfs", "config.json");
}

function defaultAuditPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "mcp-winfs", "audit.jsonl");
}

async function readFileUtf8NoBom(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  // Strip UTF-8 BOM if present.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  return buf.toString("utf8");
}

/**
 * Load and validate config. If `explicitPath` is undefined falls back to
 * %LOCALAPPDATA%\mcp-winfs\config.json. If that file is absent, returns
 * a minimal default config with no allowed roots (server still starts but
 * every path call returns EPERM_ROOT).
 */
export async function loadConfig(explicitPath?: string): Promise<ResolvedConfig> {
  const configPath = explicitPath ? path.resolve(explicitPath) : defaultConfigPath();

  let raw: RawConfig;
  let actualPath = configPath;

  try {
    const text = await readFileUtf8NoBom(configPath);
    const parsed: unknown = JSON.parse(text);
    raw = CONFIG_SCHEMA.parse(parsed);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT" && !explicitPath) {
      raw = CONFIG_SCHEMA.parse({});
      actualPath = "<defaults>";
    } else {
      throw new Error(
        `Failed to load config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (raw.maxTimeoutMs < raw.defaultTimeoutMs) {
    throw new Error(
      `config.maxTimeoutMs (${raw.maxTimeoutMs}) must be >= defaultTimeoutMs (${raw.defaultTimeoutMs})`,
    );
  }

  // v0.6 §U / invariant #28: unrestricted mode requires explicit magic-string
  // confirm. Without it, accidental enable would silently disable allowedRoots —
  // the worst possible failure mode. Reject at startup before any tool can run.
  if (
    raw.unrestrictedFilesystem &&
    raw.unrestrictedFilesystemConfirm !== UNRESTRICTED_CONFIRM_MAGIC
  ) {
    throw new Error(
      `Config validation error: unrestrictedFilesystem requires unrestrictedFilesystemConfirm = '${UNRESTRICTED_CONFIRM_MAGIC}' (current value: ${
        raw.unrestrictedFilesystemConfirm === undefined
          ? "(unset)"
          : `'${raw.unrestrictedFilesystemConfirm}'`
      })`,
    );
  }
  const serverMode: ServerMode = raw.unrestrictedFilesystem ? "unrestricted" : "strict";

  const resolvedAllowedRoots: string[] = [];
  for (const root of raw.allowedRoots) {
    const expanded = expandEnv(root);
    const absolute = path.resolve(expanded);
    try {
      const real = await fs.realpath(absolute);
      resolvedAllowedRoots.push(path.normalize(real));
    } catch {
      // Allowed root not present on disk yet — keep absolute form so spec
      // §2.2 still rejects everything; bootstrap can create it later.
      resolvedAllowedRoots.push(path.normalize(absolute));
    }
  }

  const resolvedAuditLogPath = path.resolve(
    expandEnv(raw.auditLogPath ?? defaultAuditPath()),
  );

  return {
    ...raw,
    configPath: actualPath,
    resolvedAllowedRoots,
    resolvedAuditLogPath,
    version: VERSION,
    serverMode,
  };
}

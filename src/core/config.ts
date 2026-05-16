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
    auditLogPath: z.string().optional(),
    auditLogMaxBytes: z.number().int().positive().default(10 * 1024 * 1024),
  })
  .strict();

export type RawConfig = z.infer<typeof CONFIG_SCHEMA>;

export interface ResolvedConfig extends RawConfig {
  /** The path the config was loaded from, or "<defaults>" if synthesised. */
  configPath: string;
  /** Absolute canonical allowed roots after realpath resolution. */
  resolvedAllowedRoots: string[];
  /** Absolute audit log path, %ENV% expanded. */
  resolvedAuditLogPath: string;
  /** Server version string baked at startup. */
  version: string;
}

const VERSION = "0.3.2";

/**
 * Expand %ENVVAR% sequences (Windows-style) in a path string.
 * Unknown variables are left as-is so the user can spot misconfiguration.
 */
export function expandEnv(input: string): string {
  return input.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);
}

function defaultConfigPath(): string {
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
  };
}

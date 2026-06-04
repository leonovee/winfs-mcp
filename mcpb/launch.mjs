#!/usr/bin/env node
// MCPB launcher shim for winfs-mcp.
//
// Claude Desktop spawns THIS file (per manifest.json `server.mcp_config`),
// passing the install-time `user_config` values as argv flags (arrays) and
// env vars (scalars). winfs's own server reads its configuration from a JSON
// file (`--config <path>`, else %LOCALAPPDATA%\mcp-winfs\config.json). This
// shim bridges the two worlds:
//
//   1. Collect user_config from argv + env (defensive: an unsubstituted
//      `${user_config.x}` token, or an empty string, counts as "not set").
//   2. Layer those values on top of the bundled safety baseline
//      (configs/default.json — shellBlocklist + SSRF deniedUrlPatterns +
//      allowedUrlHosts), producing a config object containing ONLY keys the
//      server's strict Zod schema accepts.
//   3. Write it atomically (temp + rename) to a DEDICATED path
//      %LOCALAPPDATA%\mcp-winfs\mcpb-config.json — never the user's manual
//      config.json, so the two install methods never clobber each other.
//   4. Re-point process.argv at the real server and import it in-process
//      (no extra node spawn; stdin/stdout stay wired to the MCP transport).
//
// Enforcement is NOT bypassed here. allowedRoots is passed through verbatim
// and enforced by the server exactly as with a manual config. Unrestricted
// mode still requires the operator to TYPE the magic confirm string into the
// Configure UI — this shim only forwards it; loadConfig() refuses to start if
// the box is checked without the exact string (spec §U / invariant #28).
//
// stdio rule: this shim writes ONLY to stderr. A single byte on stdout would
// corrupt the JSON-RPC framing the host expects.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(HERE, "dist", "index.js");
const BASELINE = path.join(HERE, "configs", "default.json");

/** A value the host left unset, or never substituted, counts as absent. */
function unset(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  if (s === "") return true;
  // `${user_config.foo}` left verbatim → the host had no value to substitute.
  return /^\$\{.*\}$/.test(s);
}

/**
 * Collect the values following a `--flag` until the next `--flag`. MCPB expands
 * a `multiple` user_config array into separate argv tokens in place (the same
 * mechanism the official filesystem server relies on). As a belt-and-braces
 * fallback we also split any single token on newlines, which never occur in a
 * Windows path, in case a host joins the array instead of expanding it.
 */
function listFlag(argv, flag) {
  const out = [];
  const start = argv.indexOf(flag);
  if (start === -1) return out;
  for (let i = start + 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) break;
    if (unset(tok)) continue;
    for (const part of String(tok).split(/\r?\n/)) {
      const t = part.trim();
      if (t && !unset(t)) out.push(t);
    }
  }
  return out;
}

function envOrUndefined(name) {
  const v = process.env[name];
  return unset(v) ? undefined : String(v).trim();
}

function localAppData() {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
}

async function readBaseline() {
  try {
    const buf = await fs.readFile(BASELINE);
    const text =
      buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.subarray(3).toString("utf8")
        : buf.toString("utf8");
    return JSON.parse(text);
  } catch {
    // No baseline bundled — fall back to a bare object. The server's own
    // schema defaults still apply; we just won't pre-seed the blocklists.
    return {};
  }
}

async function atomicWriteJson(absPath, obj) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.tmp`;
  const text = JSON.stringify(obj, null, 2) + "\n";
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, absPath);
}

async function main() {
  const argv = process.argv.slice(2);

  const allowedRoots = listFlag(argv, "--roots");
  const execExtraPathDirs = listFlag(argv, "--extra-path-dirs");

  const sshExePath = envOrUndefined("WINFS_SSH_EXE_PATH");
  const powershellExePath = envOrUndefined("WINFS_POWERSHELL_EXE_PATH");
  const pythonHome = envOrUndefined("WINFS_PYTHON_HOME");
  const unrestricted = envOrUndefined("WINFS_UNRESTRICTED") === "true";
  const unrestrictedConfirm = envOrUndefined("WINFS_UNRESTRICTED_CONFIRM");

  const baseline = await readBaseline();

  // Build only keys the strict server schema accepts. Start from the bundled
  // safety baseline, then overlay user_config. Omit optional scalars when the
  // operator left them blank so the server's own auto-detection kicks in.
  const config = {
    ...baseline,
    allowedRoots,
  };
  if (execExtraPathDirs.length > 0) config.execExtraPathDirs = execExtraPathDirs;
  if (sshExePath) config.sshExePath = sshExePath;
  if (powershellExePath) config.powershellExePath = powershellExePath;
  if (pythonHome) config.pythonHome = pythonHome;

  // Unrestricted is opt-in and gated by the magic confirm string. We forward
  // the operator's choices verbatim; we never synthesise the confirm string.
  // If the box is checked without it, loadConfig() throws on purpose.
  if (unrestricted) {
    config.unrestrictedFilesystem = true;
    if (unrestrictedConfirm) config.unrestrictedFilesystemConfirm = unrestrictedConfirm;
  }

  const cfgPath = path.join(localAppData(), "mcp-winfs", "mcpb-config.json");
  await atomicWriteJson(cfgPath, config);
  process.stderr.write(
    `winfs-mcp (mcpb): wrote ${allowedRoots.length} allowedRoots to ${cfgPath}\n`,
  );

  // Hand off to the real server in-process. It reads --config and owns the
  // stdio transport from here. file:// URL is required to import an absolute
  // Windows path under ESM.
  process.argv = [process.argv[0], DIST_INDEX, "--config", cfgPath];
  await import(pathToFileURL(DIST_INDEX).href);
}

main().catch((err) => {
  process.stderr.write(
    `winfs-mcp (mcpb) launcher fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});

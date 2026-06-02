#!/usr/bin/env node
import { createServer } from "./server.js";
import { loadConfig } from "./core/config.js";
import { appendServerStartAudit } from "./core/audit.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTransportLogger, instrumentTransport } from "./core/transport_log.js";
import {
  watchConfigFile,
  reloadConfigRoots,
  createSerializedRunner,
  type ConfigWatchHandle,
} from "./core/config_watch.js";

function parseArgs(argv: string[]): { configPath: string | undefined } {
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i++;
    }
  }
  return { configPath };
}

async function main(): Promise<void> {
  const { configPath } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);

  // v0.6 §U / invariant #29: prominent 3-line stderr banner when unrestricted.
  // Printed BEFORE server connect so an operator watching stderr at boot sees
  // the warning even if the server otherwise starts cleanly.
  if (config.serverMode === "unrestricted") {
    process.stderr.write(
      "⚠️ ⚠️ ⚠️  UNRESTRICTED FILESYSTEM MODE — all paths accessible\n" +
        "⚠️ ⚠️ ⚠️  Confirm: \"I-UNDERSTAND-THE-RISK\"\n" +
        "⚠️ ⚠️ ⚠️  See docs/design/mcp-winfs-spec.md §U\n",
    );
  }

  const { server, ctx } = createServer(config);

  // v0.7 wave 2b: SIGINT/SIGTERM handler drains the process registry so any
  // children we spawned via start_process are SIGKILL'd before the server
  // exits. 10 s hard deadline inside registry.shutdown(). Wave 2c moved
  // registry behind ctx so future stateful subsystems plug into the same
  // shutdown hook from `ctx.<subsystem>.shutdown()`.
  let shuttingDown = false;
  let configWatcher: ConfigWatchHandle | undefined;
  const onShutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`mcp-winfs received ${signal}, shutting down…\n`);
    configWatcher?.close();
    ctx.registry
      .shutdown()
      .catch(() => {
        /* swallow: best-effort drain */
      })
      .then(() => process.exit(0));
  };
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  const transport = new StdioServerTransport();

  // #3 transport-hang investigation: opt-in request/response METADATA logging,
  // gated on WINFS_TRANSPORT_LOG (a file path). Instrument BEFORE connect() so
  // the inbound `onmessage` trap is in place before the SDK assigns its
  // handler. Unset → createTransportLogger returns null → transport runs
  // un-instrumented with zero overhead. Metadata only — never bodies.
  const transportLogger = createTransportLogger(process.env.WINFS_TRANSPORT_LOG);
  if (transportLogger) {
    instrumentTransport(transport, transportLogger);
    process.stderr.write(
      `mcp-winfs transport logging ON → ${process.env.WINFS_TRANSPORT_LOG}\n`,
    );
  }

  await server.connect(transport);
  // stdio MUST NOT log to stdout — use stderr.
  process.stderr.write(
    `mcp-winfs v${config.version} ready (allowedRoots=${config.allowedRoots.length}, mode=${config.serverMode})\n`,
  );

  // Phase G (child-spawn hardening wave): hot-reload allowedRoots when the
  // runtime config file changes, without a full restart. Watches the
  // authoritative path (the --config file, else %LOCALAPPDATA%\mcp-winfs\
  // config.json). Skipped when running on synthesised defaults (no file on
  // disk). Validate-before-apply: a malformed edit keeps the previous config
  // (loadConfig throws → reloadConfigRoots returns {ok:false}); roots update
  // ONLY through RootsResolver (invariant #42).
  if (config.configPath !== "<defaults>") {
    // Serialize reloads so overlapping edits never run loadConfig concurrently
    // (which could otherwise resolve out of order and leave a stale root set);
    // the trailing re-run guarantees the latest edit wins.
    const runReload = createSerializedRunner(async () => {
      const r = await reloadConfigRoots(config.configPath, ctx.rootsResolver);
      if (r.ok) {
        process.stderr.write(
          `mcp-winfs config reloaded: ${r.rootCount} allowedRoots now in effect\n`,
        );
      } else {
        process.stderr.write(
          `mcp-winfs config reload FAILED, keeping previous config: ${r.error}\n`,
        );
      }
    });
    configWatcher = watchConfigFile(config.configPath, runReload);
  }

  // v0.6 §U / invariant #29: record server_mode in the first audit log entry
  // so forensic readers see the mode even if stderr is lost.
  appendServerStartAudit(config);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

#!/usr/bin/env node
import { createServer } from "./server.js";
import { loadConfig } from "./core/config.js";
import { appendServerStartAudit } from "./core/audit.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTransportLogger, instrumentTransport } from "./core/transport_log.js";

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
  const onShutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`mcp-winfs received ${signal}, shutting down…\n`);
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

  // v0.6 §U / invariant #29: record server_mode in the first audit log entry
  // so forensic readers see the mode even if stderr is lost.
  appendServerStartAudit(config);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

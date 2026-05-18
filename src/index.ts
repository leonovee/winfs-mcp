#!/usr/bin/env node
import { createServer } from "./server.js";
import { loadConfig } from "./core/config.js";
import { appendServerStartAudit } from "./core/audit.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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

  const server = createServer(config);

  const transport = new StdioServerTransport();
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

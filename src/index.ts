#!/usr/bin/env node
import { createServer } from "./server.js";
import { loadConfig } from "./core/config.js";
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
  const server = createServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio MUST NOT log to stdout — use stderr.
  process.stderr.write(
    `mcp-winfs v${config.version} ready (allowedRoots=${config.allowedRoots.length})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

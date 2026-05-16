import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "./core/config.js";
import { registerReadTool } from "./tools/fs/read.js";
import { registerWriteTool } from "./tools/fs/write.js";
import { registerAppendTool } from "./tools/fs/append.js";
import { registerListTool } from "./tools/fs/list.js";
import { registerStatTool } from "./tools/fs/stat.js";

export function createServer(config: ResolvedConfig): McpServer {
  const server = new McpServer({
    name: "mcp-winfs",
    version: config.version,
  });

  registerReadTool(server, config);
  registerWriteTool(server, config);
  registerAppendTool(server, config);
  registerListTool(server, config);
  registerStatTool(server, config);

  return server;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "./core/config.js";
import { registerReadTool } from "./tools/fs/read.js";
import { registerWriteTool } from "./tools/fs/write.js";
import { registerAppendTool } from "./tools/fs/append.js";
import { registerListTool } from "./tools/fs/list.js";
import { registerStatTool } from "./tools/fs/stat.js";
import { registerListAllowedDirectoriesTool } from "./tools/fs/list_allowed_directories.js";
import { registerMkdirTool } from "./tools/fs/mkdir.js";
import { registerMoveTool } from "./tools/fs/move.js";
import { registerCopyTool } from "./tools/fs/copy.js";
import { registerReadMultipleFilesTool } from "./tools/fs/read_multiple_files.js";

export function createServer(config: ResolvedConfig): McpServer {
  const server = new McpServer({
    name: "mcp-winfs",
    version: config.version,
  });

  // v0.1 core
  registerReadTool(server, config);
  registerWriteTool(server, config);
  registerAppendTool(server, config);
  registerListTool(server, config);
  registerStatTool(server, config);

  // v0.2 mutations + batch + introspection
  registerListAllowedDirectoriesTool(server, config);
  registerMkdirTool(server, config);
  registerMoveTool(server, config);
  registerCopyTool(server, config);
  registerReadMultipleFilesTool(server, config);

  return server;
}

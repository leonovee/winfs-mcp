import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResolvedConfig } from "./core/config.js";
import { ProcessRegistry } from "./core/process_registry.js";
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
import { registerGlobTool } from "./tools/search/glob.js";
import { registerReadJsonTool } from "./tools/search/read_json.js";
import { registerGrepTool } from "./tools/search/grep.js";
import { registerAuditTailTool } from "./tools/system/audit_tail.js";
import { registerReadSectionTool } from "./tools/slicing/read_section.js";
import { registerDiffFilesTool } from "./tools/slicing/diff_files.js";
import { registerReadSinceTool } from "./tools/slicing/read_since.js";
import { registerEditFileTool } from "./tools/editor/edit_file.js";
import { registerGitStatusTool } from "./tools/git/git_status.js";
import { registerGitLogTool } from "./tools/git/git_log.js";
import { registerGitShowTool } from "./tools/git/git_show.js";
import { registerGitDiffTool } from "./tools/git/git_diff.js";
import { registerGitBlameTool } from "./tools/git/git_blame.js";
import { registerExecuteCommandTool } from "./tools/exec/execute_command.js";
import { registerRunPythonTool } from "./tools/exec/run_python.js";
import { registerRunPytestTool } from "./tools/exec/run_pytest.js";
import { registerFindCommandTool } from "./tools/system/find_command.js";
import { registerCheckEnvTool } from "./tools/system/check_env.js";
import { registerFetchUrlTool } from "./tools/network/fetch_url.js";
import { registerWriteChunkTool } from "./tools/file/write_chunk.js";
import { registerListPathDirsTool } from "./tools/system/list_path_dirs.js";
import { registerWriteJsonTool } from "./tools/file/write_json.js";
import { registerSshExecTool } from "./tools/system/ssh_exec.js";
import { registerListProcessTool } from "./tools/system/list_process.js";
import { registerStartProcessTool } from "./tools/system/start_process.js";
import { registerInteractTool } from "./tools/system/interact.js";

export interface CreatedServer {
  server: McpServer;
  registry: ProcessRegistry;
}

export function createServer(config: ResolvedConfig): CreatedServer {
  const server = new McpServer({
    name: "mcp-winfs",
    version: config.version,
  });
  // v0.7 wave 2b: ProcessRegistry is the first long-lived shared mutable
  // state. Construction starts the GC sweep; shutdown() must be called on
  // SIGINT/SIGTERM (wired in src/index.ts).
  const registry = new ProcessRegistry(config);

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

  // v0.3 search + self-recovery
  registerGlobTool(server, config);
  registerReadJsonTool(server, config);
  registerGrepTool(server, config);
  registerAuditTailTool(server, config);

  // v0.4 editor + slicing
  registerReadSectionTool(server, config);
  registerDiffFilesTool(server, config);
  registerReadSinceTool(server, config);
  registerEditFileTool(server, config);

  // v0.5 git read-only
  registerGitStatusTool(server, config);
  registerGitLogTool(server, config);
  registerGitShowTool(server, config);
  registerGitDiffTool(server, config);
  registerGitBlameTool(server, config);

  // v0.5 exec
  registerExecuteCommandTool(server, config);
  registerRunPythonTool(server, config);
  registerRunPytestTool(server, config);

  // v0.5 system + network
  registerFindCommandTool(server, config);
  registerCheckEnvTool(server, config);
  registerFetchUrlTool(server, config);

  // v0.6 file — byte-offset surgical writes (NOT atomic)
  registerWriteChunkTool(server, config);

  // v0.7 wave 1 — consumer-agent feedback adds
  registerListPathDirsTool(server, config);
  registerWriteJsonTool(server, config);
  registerSshExecTool(server, config);

  // v0.7 wave 2b — process control suite
  registerListProcessTool(server, config, registry);
  registerStartProcessTool(server, config, registry);
  registerInteractTool(server, config, registry);

  return { server, registry };
}

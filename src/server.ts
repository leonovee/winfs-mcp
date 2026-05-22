import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "./core/config.js";
import { ProcessRegistry } from "./core/process_registry.js";
import { RootsResolver } from "./core/roots_resolver.js";
import { createToolContext, type ToolContext } from "./core/tool_context.js";
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
import { registerKillProcessTool } from "./tools/system/kill_process.js";
import { registerDirectoryTreeTool } from "./tools/fs/directory_tree.js";
import { registerReadMediaFileTool } from "./tools/file/read_media_file.js";

/**
 * v0.7 wave 2c: `createServer` returns the McpServer plus the `ToolContext`
 * that holds every stateful subsystem (config, ProcessRegistry, …).
 * Callers reach the registry via `result.ctx.registry`.
 *
 * Prior shape `{ server, registry }` is gone — every subsystem accessor goes
 * through `ctx` so future state additions don't churn the return type.
 */
export interface CreatedServer {
  server: McpServer;
  ctx: ToolContext;
}

export function createServer(config: ResolvedConfig): CreatedServer {
  const server = new McpServer(
    {
      name: "mcp-winfs",
      version: config.version,
    },
    {
      // v0.9 §AC: announce that this server can subscribe to MCP Roots
      // (the client capability we care about is `roots.listChanged`).
      // The capability key here is what we OFFER as a server; the
      // listRoots() / roots.list_changed subscriber are what we CONSUME.
      // The SDK auto-fills any server-side capabilities our registered
      // tools imply; we don't need to declare them explicitly here.
      capabilities: {},
    },
  );
  // ProcessRegistry is the first long-lived shared mutable state (invariant
  // #36). Construction starts the GC sweep; shutdown() must be called on
  // SIGINT/SIGTERM (wired in src/index.ts via ctx.registry.shutdown()).
  const registry = new ProcessRegistry(config);

  // v0.9 §AC: RootsResolver owns the effective allowedRoots set during
  // the server's lifetime — config roots ∪ client roots from MCP Roots.
  // Construction snapshots config.resolvedAllowedRoots; later
  // setClientRoots calls (from the oninitialized + list_changed
  // handlers below) mutate the live config field via the resolver's
  // in-place push pattern. checkAllowed continues to read
  // config.resolvedAllowedRoots — automatically picks up the union.
  const rootsResolver = new RootsResolver(config);

  // ToolContext consolidates per-server state. Every register*Tool accepts
  // the whole context — extending it (e.g. FileWatchRegistry, JobQueue) adds
  // a field, not a positional parameter. See spec §AB.2 and the extension
  // rule there.
  const ctx = createToolContext({ config, registry, rootsResolver });

  // v0.9 §AC: MCP Roots wiring.
  //
  // (a) `oninitialized` fires once after `initialize` exchange completes.
  //     If the client advertised the `roots` capability, fetch their
  //     initial list via listRoots() and feed into the resolver.
  // (b) `roots/list_changed` notifications during the session refresh
  //     the resolver via the same path. Either handler failure logs
  //     to stderr but never throws past the wrapper — we degrade to
  //     config-only roots, never crash the server.
  //
  // Only `file://` URIs are accepted; other schemes logged + skipped.
  const refreshRootsFromClient = async (source: string): Promise<void> => {
    try {
      const response = await server.server.listRoots();
      if (!response || !("roots" in response) || !Array.isArray(response.roots)) {
        process.stderr.write(`MCP Roots ${source}: empty / malformed response\n`);
        return;
      }
      const fileRoots: string[] = [];
      const skipped: string[] = [];
      for (const r of response.roots) {
        const uri = r?.uri;
        if (typeof uri !== "string") continue;
        if (uri.startsWith("file://")) {
          try {
            fileRoots.push(fileURLToPath(uri));
          } catch (e) {
            skipped.push(`${uri} (parse failed: ${(e as Error).message})`);
          }
        } else {
          skipped.push(uri);
        }
      }
      if (skipped.length > 0) {
        process.stderr.write(
          `MCP Roots ${source}: skipping ${skipped.length} non-file URI(s)\n`,
        );
      }
      await rootsResolver.setClientRoots(fileRoots);
      process.stderr.write(
        `MCP Roots ${source}: ${fileRoots.length} root(s) accepted, ${skipped.length} skipped\n`,
      );
    } catch (err) {
      process.stderr.write(
        `MCP Roots ${source} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  server.server.oninitialized = (): void => {
    const caps = server.server.getClientCapabilities();
    if (caps?.roots) {
      // Fire-and-forget; refreshRootsFromClient handles its own errors.
      void refreshRootsFromClient("initial fetch");
    } else {
      process.stderr.write(
        "MCP Roots: client did not advertise `roots` capability — config-only allowedRoots\n",
      );
    }
  };

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      await refreshRootsFromClient("list_changed");
    },
  );

  // v0.1 core
  registerReadTool(server, ctx);
  registerWriteTool(server, ctx);
  registerAppendTool(server, ctx);
  registerListTool(server, ctx);
  registerStatTool(server, ctx);

  // v0.2 mutations + batch + introspection
  registerListAllowedDirectoriesTool(server, ctx);
  registerMkdirTool(server, ctx);
  registerMoveTool(server, ctx);
  registerCopyTool(server, ctx);
  registerReadMultipleFilesTool(server, ctx);

  // v0.3 search + self-recovery
  registerGlobTool(server, ctx);
  registerReadJsonTool(server, ctx);
  registerGrepTool(server, ctx);
  registerAuditTailTool(server, ctx);

  // v0.4 editor + slicing
  registerReadSectionTool(server, ctx);
  registerDiffFilesTool(server, ctx);
  registerReadSinceTool(server, ctx);
  registerEditFileTool(server, ctx);

  // v0.5 git read-only
  registerGitStatusTool(server, ctx);
  registerGitLogTool(server, ctx);
  registerGitShowTool(server, ctx);
  registerGitDiffTool(server, ctx);
  registerGitBlameTool(server, ctx);

  // v0.5 exec
  registerExecuteCommandTool(server, ctx);
  registerRunPythonTool(server, ctx);
  registerRunPytestTool(server, ctx);

  // v0.5 system + network
  registerFindCommandTool(server, ctx);
  registerCheckEnvTool(server, ctx);
  registerFetchUrlTool(server, ctx);

  // v0.6 file — byte-offset surgical writes (NOT atomic)
  registerWriteChunkTool(server, ctx);

  // v0.7 wave 1 — consumer-agent feedback adds
  registerListPathDirsTool(server, ctx);
  registerWriteJsonTool(server, ctx);
  registerSshExecTool(server, ctx);

  // v0.7 wave 2b — process control suite (uses ctx.registry)
  registerListProcessTool(server, ctx);
  registerStartProcessTool(server, ctx);
  registerInteractTool(server, ctx);
  registerKillProcessTool(server, ctx);

  // v0.8 wave: filesystem-MCP parity (+2 tools)
  //   directory_tree: tree-shaped output companion to flat `list`
  //   read_media_file: base64 binary reader companion to UTF-8-only `read`
  registerDirectoryTreeTool(server, ctx);
  registerReadMediaFileTool(server, ctx);

  return { server, ctx };
}

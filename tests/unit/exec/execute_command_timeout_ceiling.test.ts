import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecuteCommandTool } from "../../../src/tools/exec/execute_command.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ToolContext } from "../../../src/core/tool_context.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

// End-to-end ceiling test (item 5): drive the REAL registered execute_command
// handler — which goes through runTool's OUTER withTimeout — with a command
// that runs ~12s and a timeout_ms of 16000. Pre-fix, runTool clamped the outer
// timeout to config.defaultTimeoutMs (10s) regardless of timeout_ms, so this
// would have surfaced "execute_command exceeded 10000ms". Post-fix the outer
// ceiling honors timeout_ms up to shellMaxTimeoutMs.

describe("execute_command timeout ceiling — end-to-end through runTool (item 5)", { timeout: 60_000 }, () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("honors timeout_ms=20000 for a ~12s command (no premature 10s ETIMEDOUT)", async () => {
    // Pin the timeout config so the reproduction is deterministic regardless of
    // makeTempConfig's (fast-test) defaults. The general pair = 10s is the OLD
    // outer ceiling that produced "exceeded 10000ms"; the shell pair = 30s is
    // what execute_command now uses, with the per-call ceiling override.
    config.defaultTimeoutMs = 10_000;
    config.maxTimeoutMs = 10_000;
    config.shellTimeoutMs = 30_000;
    config.shellMaxTimeoutMs = 30_000;

    let handler: ((args: unknown) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }>) | undefined;
    const fakeServer = {
      registerTool: (_name: string, _schema: unknown, h: typeof handler) => {
        handler = h;
      },
    } as unknown as McpServer;

    registerExecuteCommandTool(fakeServer, { config } as ToolContext);
    expect(handler).toBeDefined();

    const res = await handler!({
      command: "Start-Sleep -Seconds 12; Write-Output done",
      args: [],
      cwd: root,
      timeout_ms: 20_000,
    });

    expect(res.isError).toBeFalsy();
    expect(String(res.structuredContent?.stdout ?? "")).toContain("done");
    expect(res.structuredContent?.timed_out).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { runTool } from "../../../src/core/tool_wrapper.js";
import { ok } from "../../../src/core/errors.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

// runTool wraps every impl in an OUTER withTimeout. Pre-fix, the outer ceiling
// was always clamped to config.maxTimeoutMs even when a tool needed longer
// (execute_command builds up to shellMaxTimeoutMs). ctx.maxTimeoutMs lets a
// tool raise that ceiling per-call.

const cfg = (o: Partial<ResolvedConfig>): ResolvedConfig =>
  ({ defaultTimeoutMs: 10, maxTimeoutMs: 20, serverMode: "strict", ...o }) as unknown as ResolvedConfig;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("core/tool_wrapper outer timeout ceiling", () => {
  it("ctx.maxTimeoutMs raises the outer ceiling above config.maxTimeoutMs", async () => {
    // impl needs ~80ms. config.maxTimeoutMs=20, so without the override
    // ctx.timeoutMs=300 would clamp to 20 and time out. With maxTimeoutMs=500
    // the 300ms outer is honored → impl completes.
    const res = await runTool(
      { tool: "t", config: cfg({}), timeoutMs: 300, maxTimeoutMs: 500 },
      {},
      async () => {
        await sleep(80);
        return ok({ done: true });
      },
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.done).toBe(true);
  });

  it("without ctx.maxTimeoutMs, ctx.timeoutMs is still clamped to config.maxTimeoutMs", async () => {
    const res = await runTool(
      { tool: "t", config: cfg({}), timeoutMs: 300 }, // clamps to config.maxTimeoutMs=20
      {},
      async () => {
        await sleep(80);
        return ok({ done: true });
      },
    );
    expect(res.isError).toBe(true); // timed out at 20ms — guards the default clamp
  });
});

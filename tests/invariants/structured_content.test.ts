import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runTool } from "../../src/core/tool_wrapper.js";
import { ok, buildError, type Result } from "../../src/core/errors.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

describe("invariant: structuredContent matches outputSchema (v0.1.1 #1)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("success response: structuredContent is the pure payload (no ok/tool envelope)", async () => {
    const res = await runTool<{ x: number }, { value: string; count: number }>(
      { tool: "test_ok", config },
      { x: 1 },
      async (): Promise<Result<{ value: string; count: number }>> =>
        ok({ value: "hello", count: 42 }),
    );

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ value: "hello", count: 42 });
    expect(res.structuredContent).not.toHaveProperty("ok");
    expect(res.structuredContent).not.toHaveProperty("tool");
    expect(res.structuredContent).not.toHaveProperty("error");
    expect(JSON.parse(res.content[0]!.text)).toEqual({ value: "hello", count: 42 });
  });

  it("error response: omits structuredContent, sets isError, carries error JSON in text content", async () => {
    const res = await runTool<{ x: number }, never>(
      { tool: "test_err", config },
      { x: 1 },
      async (): Promise<Result<never>> =>
        buildError("EPERM_ROOT", "out of sandbox", {
          hint: "allowedRoots: …",
          details: { resolved: "C:\\Windows" },
        }),
    );

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.code).toBe("EPERM_ROOT");
    expect(parsed.message).toBe("out of sandbox");
    expect(parsed.hint).toMatch(/allowedRoots/);
    // No envelope keys leaking into the error payload either.
    expect(parsed).not.toHaveProperty("ok");
    expect(parsed).not.toHaveProperty("tool");
  });

  it("timeout response is shaped like an error (no structuredContent, isError:true)", async () => {
    const tightCfg = { ...config, defaultTimeoutMs: 50, maxTimeoutMs: 50 };
    const res = await runTool<{}, { done: true }>(
      { tool: "test_timeout", config: tightCfg },
      {},
      () => new Promise((resolve) => setTimeout(() => resolve(ok({ done: true })), 1000)),
    );

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.code).toBe("ETIMEDOUT");
  });

  it("end-to-end: real tool (write) emits pure payload as structuredContent", async () => {
    // Drive through the actual registered tool path by invoking writeImpl
    // via runTool the same way the registration does it.
    const { writeImpl } = await import("../../src/tools/fs/write.js");
    const target = path.join(root, "smoke.txt");
    const res = await runTool(
      { tool: "write", config },
      { path: target, content: "Привет", overwrite: true, mkdirParents: false },
      (a) =>
        writeImpl(
          a as {
            path: string;
            content: string;
            overwrite: boolean;
            mkdirParents: boolean;
          },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["bytes_written", "created", "lines_written"]);
    expect(sc).not.toHaveProperty("ok");
    expect(sc).not.toHaveProperty("tool");
    // Sanity: the actual file was written.
    const got = await fs.readFile(target, "utf8");
    expect(got).toBe("Привет");
  });
});

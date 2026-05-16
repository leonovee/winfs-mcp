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

  // ── v0.2 new tools ────────────────────────────────────────────────────

  it("list_allowed_directories: pure payload, no envelope", async () => {
    const { listAllowedDirectoriesImpl } = await import(
      "../../src/tools/fs/list_allowed_directories.js"
    );
    const res = await runTool(
      { tool: "list_allowed_directories", config },
      {},
      (a) => listAllowedDirectoriesImpl(a as Record<string, never>, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["allowed_roots", "allowed_url_hosts"].sort());
  });

  it("mkdir: pure payload, only declared fields", async () => {
    const { mkdirImpl } = await import("../../src/tools/fs/mkdir.js");
    const target = path.join(root, "new-dir");
    const res = await runTool(
      { tool: "mkdir", config },
      { path: target, recursive: true },
      (a) =>
        mkdirImpl(a as { path: string; recursive: boolean }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["created", "path"]);
  });

  it("move: pure payload {moved, src, dst, atomic}", async () => {
    const { moveImpl } = await import("../../src/tools/fs/move.js");
    const src = path.join(root, "from.txt");
    const dst = path.join(root, "to.txt");
    await fs.writeFile(src, "x", "utf8");
    const res = await runTool(
      { tool: "move", config },
      { src, dst, overwrite: false, allow_cross_volume: false },
      (a) =>
        moveImpl(
          a as {
            src: string;
            dst: string;
            overwrite: boolean;
            allow_cross_volume: boolean;
          },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["atomic", "dst", "moved", "src"]);
  });

  it("copy: pure payload (no envelope) with counters", async () => {
    const { copyImpl } = await import("../../src/tools/fs/copy.js");
    const src = path.join(root, "from.txt");
    const dst = path.join(root, "copy.txt");
    await fs.writeFile(src, "x", "utf8");
    const res = await runTool(
      { tool: "copy", config },
      { src, dst, overwrite: false, recursive: true },
      (a) =>
        copyImpl(
          a as { src: string; dst: string; overwrite: boolean; recursive: boolean },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(
      ["bytes_copied", "copied", "files_copied", "files_skipped", "skipped_paths"].sort(),
    );
    expect(sc).not.toHaveProperty("ok");
  });

  // ── v0.3 new tools ────────────────────────────────────────────────────

  it("glob: pure payload {matches, total, truncated}", async () => {
    const { globImpl } = await import("../../src/tools/search/glob.js");
    await fs.writeFile(path.join(root, "a.txt"), "x", "utf8");
    const res = await runTool(
      { tool: "glob", config },
      { pattern: path.join(root, "*.txt") },
      (a) => globImpl(a as { pattern: string }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["matches", "total", "truncated"]);
  });

  it("read_json: pure payload {data, size_bytes}", async () => {
    const { readJsonImpl } = await import("../../src/tools/search/read_json.js");
    const p = path.join(root, "ok.json");
    await fs.writeFile(p, '{"a":1}', "utf8");
    const res = await runTool(
      { tool: "read_json", config },
      { path: p },
      (a) => readJsonImpl(a as { path: string }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["data", "size_bytes"]);
  });

  it("grep: pure payload {matches, total, truncated} (no reason on clean run)", async () => {
    const { grepImpl } = await import("../../src/tools/search/grep.js");
    await fs.writeFile(path.join(root, "a.txt"), "alpha\nbeta\n", "utf8");
    const res = await runTool(
      { tool: "grep", config },
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "alpha",
        case_sensitive: false,
        context_lines: 0,
      },
      (a) =>
        grepImpl(
          a as {
            path_glob: string;
            pattern: string;
            case_sensitive: boolean;
            context_lines: number;
          },
          config,
          5000,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["matches", "total", "truncated"]);
  });

  it("audit_tail: pure payload {entries, total}", async () => {
    const { auditTailImpl } = await import("../../src/tools/system/audit_tail.js");
    const res = await runTool(
      { tool: "audit_tail", config },
      { n: 5 },
      (a) => auditTailImpl(a as { n?: number }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["entries", "total"]);
  });

  it("read_multiple_files: pure payload {files, total, ok_count, error_count}", async () => {
    const { readMultipleFilesImpl } = await import(
      "../../src/tools/fs/read_multiple_files.js"
    );
    const a = path.join(root, "a.txt");
    await fs.writeFile(a, "abc", "utf8");
    const res = await runTool(
      { tool: "read_multiple_files", config },
      { paths: [a] },
      (a2) =>
        readMultipleFilesImpl(a2 as { paths: string[] }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(
      ["error_count", "files", "ok_count", "total"].sort(),
    );
  });
});

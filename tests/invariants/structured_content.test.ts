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

  it("grep: pure payload {matches, total, total_matches, truncated} (no reason on clean run)", async () => {
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
    expect(Object.keys(sc).sort()).toEqual(["matches", "total", "total_matches", "truncated"]);
  });

  it("audit_tail: pure payload {entries, total, entries_seen_total}", async () => {
    const { auditTailImpl } = await import("../../src/tools/system/audit_tail.js");
    const res = await runTool(
      { tool: "audit_tail", config },
      { n: 5 },
      (a) => auditTailImpl(a as { n?: number }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["entries", "entries_seen_total", "total"]);
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

  // ── v0.4 new tools ────────────────────────────────────────────────────

  it("read_section: pure payload {content, range, total_bytes, encoding} (+ optional total_lines)", async () => {
    const { readSectionImpl } = await import("../../src/tools/slicing/read_section.js");
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "L1\nL2\nL3\n", "utf8");
    const res = await runTool(
      { tool: "read_section", config },
      { path: p, line_range: [1, 2], encoding: "utf8" },
      (a) =>
        readSectionImpl(
          a as {
            path: string;
            line_range?: [number, number];
            byte_range?: [number, number];
            encoding: "utf8" | "raw";
          },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    // line_range path includes total_lines.
    expect(Object.keys(sc).sort()).toEqual(
      ["content", "encoding", "range", "total_bytes", "total_lines"].sort(),
    );
  });

  it("diff_files: pure payload {diff, identical, lines_added, lines_removed, format, a_label, b_label, truncated}", async () => {
    const { diffFilesImpl } = await import("../../src/tools/slicing/diff_files.js");
    const res = await runTool(
      { tool: "diff_files", config },
      { a_inline: "x\n", b_inline: "y\n", context_lines: 3, format: "unified" },
      (a) =>
        diffFilesImpl(
          a as {
            a?: string;
            a_inline?: string;
            b?: string;
            b_inline?: string;
            context_lines: number;
            format: "unified" | "minimal";
          },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(
      [
        "a_label",
        "b_label",
        "diff",
        "format",
        "identical",
        "lines_added",
        "lines_removed",
        "truncated",
      ].sort(),
    );
  });

  it("edit_file: pure payload {path, replacements_made, atomic, dry_run, diff}", async () => {
    const { editFileImpl } = await import("../../src/tools/editor/edit_file.js");
    const p = path.join(root, "f.txt");
    await fs.writeFile(p, "alpha\n", "utf8");
    const res = await runTool(
      { tool: "edit_file", config },
      { path: p, edits: [{ old_str: "alpha", new_str: "ALPHA" }], dry_run: true },
      (a) =>
        editFileImpl(
          a as {
            path: string;
            edits: { old_str: string; new_str: string }[];
            dry_run: boolean;
          },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(
      ["atomic", "diff", "dry_run", "path", "replacements_made"].sort(),
    );
  });

  it("read_since: pure payload {content, new_offset, total_bytes, mtime, truncated, file_rotated}", async () => {
    const { readSinceImpl } = await import("../../src/tools/slicing/read_since.js");
    const p = path.join(root, "log.txt");
    await fs.writeFile(p, "hello\n", "utf8");
    const res = await runTool(
      { tool: "read_since", config },
      { path: p, since_offset: 0 },
      (a) =>
        readSinceImpl(
          a as { path: string; since_offset: number; max_bytes?: number },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(
      ["content", "file_rotated", "mtime", "new_offset", "total_bytes", "truncated"].sort(),
    );
  });

  // ── v0.5 new tools ────────────────────────────────────────────────────

  it("check_env: pure payload {present, length, prefix}", async () => {
    const { checkEnvImpl } = await import("../../src/tools/system/check_env.js");
    const res = await runTool(
      { tool: "check_env", config },
      { name: "PATH" },
      (a) => checkEnvImpl(a as { name: string }, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["length", "prefix", "present"]);
  });

  // Note: git / exec / fetch_url envelopes have non-trivial setup requirements
  // (real repo, subprocess, HTTP server). Their per-tool test files exercise
  // the impl directly; this invariant suite checks only the envelope shape via
  // the impl signatures, which is statically guaranteed by Zod outputSchema +
  // structuredContent contract.
  // The runtime probes here would duplicate the per-tool suites without
  // adding contract coverage; the structuredContent invariant is upheld by
  // the v0.1.1 wrapper for every registered tool. We add a single end-to-end
  // smoke test (git_status against a tmp non-repo) to confirm the wrapper
  // surfaces v0.5 tool errors in the expected shape.

  // ── v0.7 wave 1 ───────────────────────────────────────────────────────

  it("list_path_dirs: pure payload {path_dirs, total}", async () => {
    const { listPathDirsImpl } = await import("../../src/tools/system/list_path_dirs.js");
    const res = await runTool(
      { tool: "list_path_dirs", config },
      {},
      (a) => listPathDirsImpl(a as Record<string, never>, config),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["path_dirs", "total"]);
  });

  it("write_json: pure payload {bytes_written, lines_written, created}", async () => {
    const { writeJsonImpl } = await import("../../src/tools/file/write_json.js");
    const p = path.join(root, "out.json");
    const res = await runTool(
      { tool: "write_json", config },
      { path: p, value: { ok: 1 }, indent: 2, overwrite: false, mkdirParents: false },
      (a) =>
        writeJsonImpl(
          a as {
            path: string;
            value: unknown;
            indent: number;
            overwrite: boolean;
            mkdirParents: boolean;
          },
          config,
        ),
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["bytes_written", "created", "lines_written"]);
  });

  // ssh_exec envelope is exercised by tests/unit/system/ssh_exec.test.ts
  // (full mocked-spawn coverage). Adding it here would duplicate the mocking
  // boilerplate without adding contract coverage.

  it("git_status error envelope: ENOTREPO surfaces in content[0].text, no structuredContent", async () => {
    const { gitStatusImpl } = await import("../../src/tools/git/git_status.js");
    const res = await runTool(
      { tool: "git_status", config },
      { repo_path: root },
      (a) => gitStatusImpl(a as { repo_path: string }, config),
    );
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.code).toBe("ENOTREPO");
  });
});

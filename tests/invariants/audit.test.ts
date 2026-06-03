import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { appendAudit, flushAudit, sanitizeArgs, auditContentFields } from "../../src/core/audit.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

describe("invariant: audit log (spec §2.11)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("redacts the `content` field with byte length", () => {
    const sanitized = sanitizeArgs({
      path: "C:\\some\\file.txt",
      content: "Привет, мир — секретный текст",
    });
    expect(sanitized.path).toBe("C:\\some\\file.txt");
    expect(typeof sanitized.content).toBe("string");
    expect(sanitized.content).toMatch(/^<redacted: \d+ bytes>$/);
  });

  it("truncates long string args at 256 chars", () => {
    const long = "x".repeat(500);
    const sanitized = sanitizeArgs({ glob: long });
    expect(typeof sanitized.glob).toBe("string");
    expect((sanitized.glob as string).startsWith("x".repeat(256))).toBe(true);
    expect(sanitized.glob).toMatch(/truncated/);
  });

  it("auditContentFields: digest-only by default, never the content prefix", () => {
    const secret = "line1-SECRET-API-KEY\nline2\nline3";
    const fields = auditContentFields("stdout", secret, false, 4096);
    const expectedSha = createHash("sha256").update(secret, "utf8").digest("hex");
    expect(fields.stdout_sha256).toBe(expectedSha);
    expect(fields.stdout_bytes).toBe(Buffer.byteLength(secret, "utf8"));
    expect(fields.stdout_prefix).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain("SECRET-API-KEY");
  });

  it("auditContentFields: includes the prefix only when verbose=true", () => {
    const text = "abcdefgh";
    const fields = auditContentFields("script", text, true, 4);
    expect(fields.script_prefix).toBe("abcd");
    expect(fields.script_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fields.script_bytes).toBe(8);
  });

  it("writes JSONL records to the configured audit path", async () => {
    appendAudit(config, {
      ts: new Date().toISOString(),
      tool: "read",
      args_summary: { path: "test" },
      result_status: "ok",
      duration_ms: 5,
    });
    appendAudit(config, {
      ts: new Date().toISOString(),
      tool: "write",
      args_summary: { path: "test" },
      result_status: "error",
      error_code: "EPERM_ROOT",
      duration_ms: 3,
    });
    await flushAudit();

    const text = await fs.readFile(config.resolvedAuditLogPath, "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].tool).toBe("read");
    expect(parsed[0].result_status).toBe("ok");
    expect(parsed[1].tool).toBe("write");
    expect(parsed[1].error_code).toBe("EPERM_ROOT");
  });
});

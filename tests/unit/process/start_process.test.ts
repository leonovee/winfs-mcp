import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { startProcessImpl, getStartProcessAuditExtras } from "../../../src/tools/system/start_process.js";
import { ProcessRegistry } from "../../../src/core/process_registry.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

const isWin = process.platform === "win32";
const echoArgv = (s: string): string[] =>
  isWin ? ["cmd.exe", "/c", `echo ${s}`] : ["sh", "-c", `echo ${s}`];
const sleepArgv = (sec: number): string[] =>
  isWin
    ? ["powershell.exe", "-NoProfile", "-Command", `Start-Sleep -Seconds ${sec}`]
    : ["sleep", String(sec)];

describe("tools/system/start_process", { timeout: 30_000 }, () => {
  let config: ResolvedConfig;
  let root: string;
  let registry: ProcessRegistry;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    registry = new ProcessRegistry(config);
  });

  afterEach(async () => {
    await registry.shutdown();
    await cleanupTempConfig(root);
  });

  it("happy: spawn echo, session goes from running to exited(0) with stdout", async () => {
    const res = await startProcessImpl(
      { command: echoArgv("hi"), cwd: root },
      config,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.session_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.value.status).toBe("running");
    expect(res.value.command_prefix).toMatch(/echo hi/);

    const snap = await registry.get(res.value.session_id)!.waitForSettle(5000);
    expect(snap.status).toBe("exited");
    expect(snap.exit_code).toBe(0);
    expect(snap.stdout).toMatch(/hi/);
  });

  it("audit extras: command stored as sha256 + byte length, NEVER a prefix (output field unchanged)", async () => {
    const secret = "SECRET-TOKEN-xyz";
    const res = await startProcessImpl(
      { command: echoArgv(secret), cwd: root },
      config,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // The caller-facing OUTPUT field is intentionally unchanged.
    expect(res.value.command_prefix).toContain(secret);
    // The AUDIT extras must NOT carry the command text by default.
    const extras = getStartProcessAuditExtras(res.value);
    expect(extras).toBeDefined();
    expect(JSON.stringify(extras)).not.toContain(secret);
    expect(extras!.command_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof extras!.command_bytes).toBe("number");
    expect(extras!.command_prefix).toBeUndefined();
    await registry.get(res.value.session_id)!.waitForSettle(5000);
  });

  it("audit extras: command_prefix restored when config.auditVerbose=true", async () => {
    const verbose: ResolvedConfig = { ...config, auditVerbose: true };
    const res = await startProcessImpl(
      { command: echoArgv("hello-v"), cwd: root },
      verbose,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const extras = getStartProcessAuditExtras(res.value);
    expect(typeof extras!.command_prefix).toBe("string");
    expect(extras!.command_sha256).toMatch(/^[0-9a-f]{64}$/);
    await registry.get(res.value.session_id)!.waitForSettle(5000);
  });

  it("cwd outside allowedRoots → EPERM_ROOT", async () => {
    const outside = isWin ? "C:\\Windows" : "/etc";
    const res = await startProcessImpl(
      { command: echoArgv("hi"), cwd: outside },
      config,
      registry,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("command argv composed string in blocklist → EBLOCKED", async () => {
    const res = await startProcessImpl(
      { command: ["powershell.exe", "-Command", "Remove-Item -Recurse C:\\important"], cwd: root },
      config,
      registry,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EBLOCKED");
  });

  it("EBUSY when processMaxConcurrent reached", async () => {
    // Use a low cap config for this test.
    const lowConfig: ResolvedConfig = { ...config, processMaxConcurrent: 2 };
    const r2 = new ProcessRegistry(lowConfig);
    try {
      const r1 = await startProcessImpl({ command: sleepArgv(10), cwd: root }, lowConfig, r2);
      const r2_ = await startProcessImpl({ command: sleepArgv(10), cwd: root }, lowConfig, r2);
      expect(r1.ok).toBe(true);
      expect(r2_.ok).toBe(true);
      // Third hits the cap.
      const r3 = await startProcessImpl({ command: sleepArgv(10), cwd: root }, lowConfig, r2);
      expect(r3.ok).toBe(false);
      if (r3.ok) throw new Error("expected error");
      expect(r3.error.code).toBe("EBUSY");
    } finally {
      await r2.shutdown();
    }
  });

  it("bogus binary → status=spawn_failed in registry (start returns ok with that status)", async () => {
    const res = await startProcessImpl(
      { command: ["this-binary-9999-not-on-path"], cwd: root },
      config,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const snap = await registry.get(res.value.session_id)!.waitForSettle(5000);
    expect(snap.status).toBe("spawn_failed");
  });

  it("timeout_seconds=1 on hang transitions to timed_out", async () => {
    const res = await startProcessImpl(
      { command: sleepArgv(30), cwd: root, timeout_seconds: 1 },
      config,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const snap = await registry.get(res.value.session_id)!.waitForSettle(10_000);
    expect(snap.status).toBe("timed_out");
  });

  it("cwd as subdirectory inside allowedRoots resolves and works", async () => {
    const { promises: fs } = await import("node:fs");
    const sub = path.join(root, "sub");
    await fs.mkdir(sub);
    const res = await startProcessImpl(
      { command: echoArgv("ok"), cwd: sub },
      config,
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const snap = await registry.get(res.value.session_id)!.waitForSettle(5000);
    expect(snap.status).toBe("exited");
    expect(snap.stdout).toMatch(/ok/);
  });
});

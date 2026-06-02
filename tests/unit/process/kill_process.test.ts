import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { killProcessImpl } from "../../../src/tools/system/kill_process.js";
import { startProcessImpl } from "../../../src/tools/system/start_process.js";
import { ProcessRegistry } from "../../../src/core/process_registry.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

const isWin = process.platform === "win32";
const sleepArgv = (sec: number): string[] =>
  isWin
    ? ["powershell.exe", "-NoProfile", "-Command", `Start-Sleep -Seconds ${sec}`]
    : ["sleep", String(sec)];
const echoArgv = (s: string): string[] =>
  isWin ? ["cmd.exe", "/c", `echo ${s}`] : ["sh", "-c", `echo ${s}`];

describe("tools/system/kill_process", { timeout: 60_000 }, () => {
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

  it("kill running session with force=true → killed:true, status='killed'", async () => {
    const start = await startProcessImpl(
      { command: sleepArgv(30), cwd: root, timeout_seconds: 60 },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    await new Promise((res) => setTimeout(res, 100));

    const res = await killProcessImpl(
      { session_id: start.value.session_id, force: true },
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.killed).toBe(true);
    expect(res.value.was_already_settled).toBe(false);
    expect(res.value.status).toBe("killed");
  });

  it("kill already-settled session → killed:false, was_already_settled:true, exit_code preserved", async () => {
    const start = await startProcessImpl(
      { command: echoArgv("bye"), cwd: root },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    await registry.get(start.value.session_id)!.waitForSettle(5000);

    const res = await killProcessImpl(
      { session_id: start.value.session_id, force: true },
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.killed).toBe(false);
    expect(res.value.was_already_settled).toBe(true);
    expect(res.value.status).toBe("exited");
    expect(res.value.exit_code).toBe(0);
  });

  it("ENOSESSION for unknown session_id", async () => {
    const res = await killProcessImpl(
      { session_id: "11111111-1111-1111-1111-111111111111" },
      registry,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOSESSION");
  });

  it("idempotent: second kill returns was_already_settled:true", async () => {
    const start = await startProcessImpl(
      { command: sleepArgv(30), cwd: root, timeout_seconds: 60 },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    await new Promise((res) => setTimeout(res, 100));

    const first = await killProcessImpl(
      { session_id: start.value.session_id, force: true },
      registry,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");
    expect(first.value.killed).toBe(true);

    const second = await killProcessImpl(
      { session_id: start.value.session_id, force: true },
      registry,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok");
    expect(second.value.killed).toBe(false);
    expect(second.value.was_already_settled).toBe(true);
    expect(second.value.status).toBe("killed");
  });

  it("graceful kill (force=false default) eventually transitions to killed", async () => {
    const start = await startProcessImpl(
      { command: sleepArgv(30), cwd: root, timeout_seconds: 60 },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    await new Promise((res) => setTimeout(res, 100));

    const res = await killProcessImpl(
      { session_id: start.value.session_id },
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.killed).toBe(true);
    // Status must be killed by the time kill returns (registry.kill awaits
    // either close or the 5+2 s combined grace).
    expect(res.value.status).toBe("killed");
  });
});

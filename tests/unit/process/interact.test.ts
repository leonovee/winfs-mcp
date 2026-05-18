import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { interactImpl } from "../../../src/tools/system/interact.js";
import { startProcessImpl } from "../../../src/tools/system/start_process.js";
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

describe("tools/system/interact", () => {
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

  it("echo: interact reads stdout, sees status=exited and exit_code=0", async () => {
    const start = await startProcessImpl(
      { command: echoArgv("hello"), cwd: root },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    // Wait for natural settle so the stdout is fully buffered.
    await registry.get(start.value.session_id)!.waitForSettle(5000);

    const res = await interactImpl(
      { session_id: start.value.session_id, max_wait_ms: 500 },
      registry,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.status).toBe("exited");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toMatch(/hello/);
    expect(res.value.stdout_offset).toBeGreaterThan(0);
    expect(res.value.settled_at).not.toBeNull();
  });

  it("ENOSESSION for unknown session_id", async () => {
    const res = await interactImpl(
      { session_id: "00000000-0000-0000-0000-000000000000", max_wait_ms: 100 },
      registry,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOSESSION");
  });

  it("long-poll deadline returns empty stdout on silent process within budget", async () => {
    const start = await startProcessImpl(
      { command: sleepArgv(10), cwd: root, timeout_seconds: 30 },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");

    const t0 = Date.now();
    const res = await interactImpl(
      { session_id: start.value.session_id, max_wait_ms: 200 },
      registry,
    );
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.status).toBe("running");
    expect(res.value.stdout).toBe("");
    // Long-poll should honour ~200 ms budget, give some slop for CI.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
  });

  it("EPIPE_CLOSED when writing after finalize", async () => {
    const start = await startProcessImpl(
      { command: sleepArgv(10), cwd: root, timeout_seconds: 30 },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    // Empty input + finalize closes stdin.
    const r1 = await interactImpl(
      { session_id: start.value.session_id, finalize: true, max_wait_ms: 100 },
      registry,
    );
    expect(r1.ok).toBe(true);
    // Second call with input now hits EPIPE_CLOSED.
    const r2 = await interactImpl(
      { session_id: start.value.session_id, input: "should-fail", max_wait_ms: 100 },
      registry,
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error("expected error");
    expect(r2.error.code).toBe("EPIPE_CLOSED");
  });

  it("EPIPE_CLOSED when writing after session settled", async () => {
    const start = await startProcessImpl(
      { command: echoArgv("done"), cwd: root },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    await registry.get(start.value.session_id)!.waitForSettle(5000);

    const res = await interactImpl(
      { session_id: start.value.session_id, input: "post-mortem", max_wait_ms: 100 },
      registry,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPIPE_CLOSED");
  });

  it("paginated reads: stdout_since slices correctly", async () => {
    // Generate ~3 lines of output.
    const cmd = isWin
      ? ["cmd.exe", "/c", "echo a & echo b & echo c"]
      : ["sh", "-c", "printf 'a\\nb\\nc\\n'"];
    const start = await startProcessImpl(
      { command: cmd, cwd: root },
      config,
      registry,
    );
    if (!start.ok) throw new Error("start failed");
    await registry.get(start.value.session_id)!.waitForSettle(5000);

    const r1 = await interactImpl(
      { session_id: start.value.session_id, max_wait_ms: 100 },
      registry,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("expected ok");
    const firstOffset = r1.value.stdout_offset;
    expect(firstOffset).toBeGreaterThan(0);

    // Second call from end of first → empty slice.
    const r2 = await interactImpl(
      {
        session_id: start.value.session_id,
        stdout_since: firstOffset,
        max_wait_ms: 100,
      },
      registry,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.value.stdout).toBe("");
    expect(r2.value.stdout_offset).toBe(firstOffset);
  });
}, { timeout: 30_000 });

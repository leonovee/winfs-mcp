import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProcessRegistry } from "../../../src/core/process_registry.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 wave 2b: ProcessRegistry is the first long-lived shared mutable state
 * in the server. Each test must get a fresh registry to avoid cross-test
 * leakage; `afterEach` calls `shutdown()` to SIGKILL any straggler children
 * and clear the GC interval.
 */
describe("core/process_registry", () => {
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

  it("list() is empty before any spawn", () => {
    expect(registry.list()).toEqual([]);
  });

  it("spawn() returns a session with running status and unique id", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
      : ["sleep", "5"];
    const session = await registry.spawn(cmd, root, {}, 30);
    expect(session.session_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session.status).toBe("running");
    expect(session.exit_code).toBeNull();
    expect(session.started_at).toMatch(/^\d{4}-/);
    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.session_id).toBe(session.session_id);
  });

  it("settled session has exit_code and settled_at; remains in list during TTL", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["cmd.exe", "/c", "echo hi"]
      : ["sh", "-c", "echo hi"];
    const session = await registry.spawn(cmd, root, {}, 30);
    const snap = await registry.get(session.session_id)!.waitForSettle(5000);
    expect(snap.status).toBe("exited");
    expect(snap.exit_code).toBe(0);
    expect(snap.stdout).toMatch(/hi/);
    expect(snap.settled_at).not.toBeNull();
  });

  it("GC removes settled sessions older than sessionTtlMs", async () => {
    const isWin = process.platform === "win32";
    // Construct a fresh registry with a short TTL + interval so GC fires fast.
    const r = new ProcessRegistry({
      ...config,
      processSessionTtlMs: 50,
      processGcIntervalMs: 25,
    });
    try {
      const cmd = isWin ? ["cmd.exe", "/c", "echo bye"] : ["sh", "-c", "echo bye"];
      const session = await r.spawn(cmd, root, {}, 30);
      await r.get(session.session_id)!.waitForSettle(5000);
      // Wait for at least one GC cycle past TTL.
      await new Promise((res) => setTimeout(res, 200));
      expect(r.get(session.session_id)).toBeUndefined();
    } finally {
      await r.shutdown();
    }
  });

  it("buffer cap truncates stdout beyond processBufferCap", async () => {
    const isWin = process.platform === "win32";
    const r = new ProcessRegistry({ ...config, processBufferCap: 64 });
    try {
      // Generate ~200 bytes of stdout.
      const cmd = isWin
        ? ["powershell.exe", "-NoProfile", "-Command", "1..200 | ForEach-Object { 'x' }"]
        : ["sh", "-c", "for i in $(seq 1 200); do echo x; done"];
      const session = await r.spawn(cmd, root, {}, 30);
      const snap = await r.get(session.session_id)!.waitForSettle(10_000);
      expect(snap.status).toBe("exited");
      expect(snap.truncated_stdout).toBe(true);
      // Capped at 64 bytes.
      expect(Buffer.byteLength(snap.stdout, "utf8")).toBeLessThanOrEqual(64);
    } finally {
      await r.shutdown();
    }
  });

  it("waitForOutput resolves on output chunk", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Milliseconds 50; Write-Output 'chunk'"]
      : ["sh", "-c", "sleep 0.05; echo chunk"];
    const session = await registry.spawn(cmd, root, {}, 30);
    const t0 = Date.now();
    const snap = await registry.get(session.session_id)!.waitForOutput(0, 0, 5000);
    const elapsed = Date.now() - t0;
    expect(snap.stdout).toMatch(/chunk/);
    // Should resolve well before the 5s long-poll deadline.
    expect(elapsed).toBeLessThan(3000);
  });

  it("waitForOutput resolves on deadline when no output", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 5"]
      : ["sleep", "5"];
    const session = await registry.spawn(cmd, root, {}, 30);
    const t0 = Date.now();
    const snap = await registry.get(session.session_id)!.waitForOutput(0, 0, 150);
    const elapsed = Date.now() - t0;
    expect(snap.status).toBe("running");
    expect(snap.stdout).toBe("");
    // Long-poll honoured the deadline (~150 ms, allow slop).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1500);
  });

  it("timeout_seconds expiry transitions to timed_out", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"]
      : ["sleep", "30"];
    // timeoutSeconds=1
    const session = await registry.spawn(cmd, root, {}, 1);
    const snap = await registry.get(session.session_id)!.waitForSettle(10_000);
    expect(snap.status).toBe("timed_out");
    expect(snap.settled_at).not.toBeNull();
  });

  it("spawn error (bogus binary) yields status='spawn_failed'", async () => {
    const session = await registry.spawn(
      ["this-binary-definitely-does-not-exist-9999"],
      root,
      {},
      30,
    );
    const snap = await registry.get(session.session_id)!.waitForSettle(5000);
    expect(snap.status).toBe("spawn_failed");
    expect(snap.settled_at).not.toBeNull();
  });

  it("kill() force=true transitions to killed", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 30"]
      : ["sleep", "30"];
    const session = await registry.spawn(cmd, root, {}, 60);
    await new Promise((res) => setTimeout(res, 100)); // let it start
    await registry.kill(session.session_id, true);
    const snap = await registry.get(session.session_id)!.waitForSettle(5000);
    expect(snap.status).toBe("killed");
  });
}, { timeout: 30_000 });

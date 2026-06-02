import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listProcessImpl } from "../../../src/tools/system/list_process.js";
import { ProcessRegistry } from "../../../src/core/process_registry.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/system/list_process", { timeout: 30_000 }, () => {
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

  it("empty registry returns empty sessions array and total=0", async () => {
    const res = await listProcessImpl({}, registry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.sessions).toEqual([]);
    expect(res.value.total).toBe(0);
  });

  it("two spawned sessions appear in list sorted by started_at asc", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? ["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 10"]
      : ["sleep", "10"];
    const s1 = await registry.spawn(cmd, root, {}, 60);
    // Force a measurable started_at gap.
    await new Promise((res) => setTimeout(res, 25));
    const s2 = await registry.spawn(cmd, root, {}, 60);

    const res = await listProcessImpl({}, registry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(2);
    expect(res.value.sessions[0]!.session_id).toBe(s1.session_id);
    expect(res.value.sessions[1]!.session_id).toBe(s2.session_id);
    expect(res.value.sessions[0]!.status).toBe("running");
    expect(res.value.sessions[0]!.exit_code).toBeNull();
    expect(res.value.sessions[0]!.settled_at).toBeNull();
  });

  it("settled session's summary carries exit_code + settled_at", async () => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? ["cmd.exe", "/c", "echo hi"] : ["sh", "-c", "echo hi"];
    const session = await registry.spawn(cmd, root, {}, 30);
    await registry.get(session.session_id)!.waitForSettle(5000);

    const res = await listProcessImpl({}, registry);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const entry = res.value.sessions.find((s) => s.session_id === session.session_id);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("exited");
    expect(entry!.exit_code).toBe(0);
    expect(entry!.settled_at).not.toBeNull();
    expect(entry!.command_prefix).toMatch(/echo hi/);
  });
});

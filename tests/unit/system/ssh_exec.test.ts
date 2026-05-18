import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// Mock the exec_safety module so we can drive spawnSubprocess outcomes
// without an actual ssh.exe on the test host. The vi.mock call is hoisted
// above any import of `src/core/exec_safety.js` at the module level.
vi.mock("../../../src/core/exec_safety.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/exec_safety.js")>();
  return {
    ...actual,
    spawnSubprocess: vi.fn(),
  };
});

import { spawnSubprocess, type SpawnSubprocessResult } from "../../../src/core/exec_safety.js";
import { sshExecImpl, _resetSshHostCache } from "../../../src/tools/system/ssh_exec.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

const mockedSpawn = vi.mocked(spawnSubprocess);

function makeSpawnResult(overrides: Partial<SpawnSubprocessResult>): SpawnSubprocessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: 0,
    spawnFailed: false,
    ...overrides,
  };
}

async function makeFakeSshExe(root: string): Promise<string> {
  const p = path.join(root, "fake-ssh.exe");
  await fs.writeFile(p, "stub", "utf8");
  return p;
}

describe("tools/system/ssh_exec", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
    _resetSshHostCache();
    mockedSpawn.mockReset();
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("ESSHNOTFOUND when sshExePath does not exist on disk", async () => {
    config = { ...config, sshExePath: path.join(root, "does-not-exist.exe") };
    const res = await sshExecImpl(
      { host: "alias", command: "echo hi", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ESSHNOTFOUND");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("EHOST_UNKNOWN rejects raw user@host without spawning anything", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    const res = await sshExecImpl(
      { host: "user@example.com", command: "ls", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOST_UNKNOWN");
    expect(res.error.message).toContain("@");
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("EHOST_UNKNOWN when ssh -G exits non-zero", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 1, stderr: "no such host\n" }),
    );
    const res = await sshExecImpl(
      { host: "nope", command: "ls", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOST_UNKNOWN");
    // Only one spawn call (validation); no follow-up exec.
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const firstCallArgs = mockedSpawn.mock.calls[0]![0].args;
    expect(firstCallArgs).toEqual(["-G", "nope"]);
  });

  it("EHOST_UNKNOWN when ssh -G stdout has no hostname line", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 0, stdout: "user me\nport 22\n" }),
    );
    const res = await sshExecImpl(
      { host: "weird", command: "ls", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EHOST_UNKNOWN");
  });

  it("EIO when ssh.exe spawn fails asynchronously (v0.6 exec_safety fix)", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    // 1st call: validateHost succeeds.
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 0, stdout: "hostname example.com\n" }),
    );
    // 2nd call: exec spawn fails async — spawnFailed: true.
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({
        spawnFailed: true,
        spawnErrorCode: "ENOENT",
        spawnErrorMessage: "ssh.exe not found",
        exitCode: null,
      }),
    );
    const res = await sshExecImpl(
      { host: "host1", command: "ls", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EIO");
    expect(res.error.details).toMatchObject({ spawnFailed: true, errno: "ENOENT" });
  });

  it("ETIMEDOUT surfaces timed_out from spawnSubprocess with partial output", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 0, stdout: "hostname x\n" }),
    );
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({
        timedOut: true,
        exitCode: null,
        stdout: "partial\n",
        stderr: "",
        durationMs: 10000,
      }),
    );
    const res = await sshExecImpl(
      { host: "slow", command: "sleep 60", timeout_seconds: 1 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ETIMEDOUT");
    expect(res.error.details).toMatchObject({
      host: "slow",
      timeout_seconds: 1,
      partial_stdout: "partial\n",
    });
  });

  it("happy path: spawn called with [host, command]; envelope passes through", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 0, stdout: "hostname server\n" }),
    );
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
        durationMs: 42,
      }),
    );
    const res = await sshExecImpl(
      { host: "myserver", command: "echo hello", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.host).toBe("myserver");
    expect(res.value.stdout).toBe("hello\n");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.timed_out).toBe(false);
    expect(res.value.duration_ms).toBe(42);
    expect(res.value.truncated_stdout).toBeUndefined();

    // The 2nd spawn was called with [host, command] verbatim, against the
    // configured ssh.exe path, with NO shell wrapper.
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    const execCall = mockedSpawn.mock.calls[1]![0];
    expect(execCall.bin).toBe(fakeSsh);
    expect(execCall.args).toEqual(["myserver", "echo hello"]);
    expect(execCall.maxOutputBytes).toBe(4 * 1024);
  });

  it("truncated_stdout: true when >4KB stdout cap hit", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 0, stdout: "hostname x\n" }),
    );
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({
        exitCode: 0,
        stdout: "x".repeat(4096),
        truncatedStdout: true,
        durationMs: 100,
      }),
    );
    const res = await sshExecImpl(
      { host: "big", command: "cat /huge.log", timeout_seconds: 10 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.truncated_stdout).toBe(true);
    expect(res.value.stdout.length).toBe(4096);
  });

  it("host validation cached for repeated calls (only one ssh -G per alias)", async () => {
    const fakeSsh = await makeFakeSshExe(root);
    config = { ...config, sshExePath: fakeSsh };
    mockedSpawn.mockResolvedValueOnce(
      makeSpawnResult({ exitCode: 0, stdout: "hostname x\n" }),
    );
    mockedSpawn.mockResolvedValueOnce(makeSpawnResult({ exitCode: 0, stdout: "first\n" }));
    mockedSpawn.mockResolvedValueOnce(makeSpawnResult({ exitCode: 0, stdout: "second\n" }));

    const r1 = await sshExecImpl({ host: "cached", command: "a", timeout_seconds: 10 }, config);
    const r2 = await sshExecImpl({ host: "cached", command: "b", timeout_seconds: 10 }, config);
    expect(r1.ok && r2.ok).toBe(true);
    // 1 validation + 2 exec calls = 3.
    expect(mockedSpawn).toHaveBeenCalledTimes(3);
    expect(mockedSpawn.mock.calls[0]![0].args).toEqual(["-G", "cached"]);
    expect(mockedSpawn.mock.calls[1]![0].args).toEqual(["cached", "a"]);
    expect(mockedSpawn.mock.calls[2]![0].args).toEqual(["cached", "b"]);
  });
});

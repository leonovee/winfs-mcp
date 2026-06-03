import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runPythonImpl, getRunPythonAuditExtras } from "../../../src/tools/exec/run_python.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/exec/run_python", { timeout: 60_000 }, () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("inline mode: -c 'print(1+2)' yields stdout '3' and exit 0", async () => {
    const res = await runPythonImpl(
      { mode: "inline", script: "print(1+2)", args: [], cwd: root, timeout_ms: 15000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout.trim()).toBe("3");
  });

  it("file mode: runs an arbitrary .py file", async () => {
    const script = path.join(root, "hello.py");
    await fs.writeFile(script, 'print("HELLO_FROM_FILE")\n', "utf8");
    const res = await runPythonImpl(
      { mode: "file", path: script, args: [], cwd: root, timeout_ms: 15000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(0);
    expect(res.value.stdout).toMatch(/HELLO_FROM_FILE/);
  });

  it("non-zero exit_code captured (sys.exit(3))", async () => {
    const res = await runPythonImpl(
      {
        mode: "inline",
        script: "import sys; sys.exit(3)",
        args: [],
        cwd: root,
        timeout_ms: 10000,
      },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.exit_code).toBe(3);
  });

  it("EINVAL on mode/arg mismatch (mode: inline without script)", async () => {
    const res = await runPythonImpl(
      { mode: "inline", args: [], cwd: root, timeout_ms: 5000 },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("audit (default): script + stdout + stderr stored as sha256 + byte length, NEVER content prefix", async () => {
    // GPT-review #3: a token/key in the first lines of the script or its output
    // must not land in the audit log. Default auditVerbose=false → digest only.
    const secret = "SECRET_TOKEN_abc123_never_log_me";
    const res = await runPythonImpl(
      { mode: "inline", script: `print("${secret}")`, args: [], cwd: root, timeout_ms: 15000 },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.stdout).toContain(secret); // the RESULT still carries it...
    const extras = getRunPythonAuditExtras(res.value);
    expect(extras).toBeDefined();
    // ...but the AUDIT extras must not — neither the script body nor the output.
    expect(JSON.stringify(extras)).not.toContain(secret);
    expect(extras!.script_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof extras!.script_bytes).toBe("number");
    expect(extras!.script_prefix).toBeUndefined();
    expect(extras!.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extras!.stdout_prefix).toBeUndefined();
    expect(extras!.stderr_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extras!.stderr_prefix).toBeUndefined();
  });

  it("audit (auditVerbose=true): adds debugging prefixes alongside the sha256 digests", async () => {
    const verbose: ResolvedConfig = { ...config, auditVerbose: true };
    const res = await runPythonImpl(
      { mode: "inline", script: "print('hello-verbose')", args: [], cwd: root, timeout_ms: 15000 },
      verbose,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const extras = getRunPythonAuditExtras(res.value);
    expect(extras!.script_prefix).toBe("print('hello-verbose')");
    expect(typeof extras!.stdout_prefix).toBe("string");
    // Digests are present in verbose mode too.
    expect(extras!.script_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extras!.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("EPYTHONNOTFOUND when config.pythonHome is set but binary missing", async () => {
    const badCfg = { ...config, pythonHome: path.join(root, "no-such-python") };
    const res = await runPythonImpl(
      { mode: "inline", script: "print(1)", args: [], cwd: root, timeout_ms: 5000 },
      badCfg,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPYTHONNOTFOUND");
  });
});

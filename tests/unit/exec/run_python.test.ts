import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runPythonImpl } from "../../../src/tools/exec/run_python.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/exec/run_python", () => {
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
}, { timeout: 60_000 });

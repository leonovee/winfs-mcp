import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listPathDirsImpl } from "../../../src/tools/system/list_path_dirs.js";
import { sanitizedPathDirs, sanitizedPath } from "../../../src/core/exec_safety.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/system/list_path_dirs", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns sanitized PATH dirs as a non-empty array", async () => {
    const res = await listPathDirsImpl({}, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(Array.isArray(res.value.path_dirs)).toBe(true);
    expect(res.value.path_dirs.length).toBeGreaterThan(0);
    expect(res.value.total).toBe(res.value.path_dirs.length);
    // Spec invariant: System32 must always be present.
    expect(res.value.path_dirs).toContain("C:\\Windows\\System32");
  });

  it("path_dirs joined by ';' equals sanitizedPath(config) — single source of truth", async () => {
    const res = await listPathDirsImpl({}, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.path_dirs.join(";")).toBe(sanitizedPath(config));
    // And matches the raw helper directly:
    expect(res.value.path_dirs).toEqual(sanitizedPathDirs(config));
  });

  it("pythonHome appears in path_dirs when configured", async () => {
    const withPython: ResolvedConfig = { ...config, pythonHome: "D:\\Python311" };
    const res = await listPathDirsImpl({}, withPython);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.path_dirs).toContain("D:\\Python311");
  });

  it("pythonHome omitted from path_dirs when not configured", async () => {
    const noPython: ResolvedConfig = { ...config, pythonHome: undefined };
    const res = await listPathDirsImpl({}, noPython);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // No path entry should look like a pythonHome value the test config carried.
    for (const dir of res.value.path_dirs) {
      expect(dir.toLowerCase()).not.toContain("python");
    }
  });
});

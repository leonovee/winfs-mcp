import { describe, it, expect, afterEach } from "vitest";
import {
  buildExecEnv,
  STANDARD_WINDOWS_PATHEXT,
} from "../../../src/core/exec_safety.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

// Minimal config stub — buildExecEnv only reads execSanitizeEnv + pythonHome.
function cfg(over: Partial<ResolvedConfig>): ResolvedConfig {
  return { execSanitizeEnv: false, pythonHome: undefined, ...over } as unknown as ResolvedConfig;
}

describe("core/exec_safety PATHEXT hardening (Phase C)", () => {
  const orig = process.env.PATHEXT;
  afterEach(() => {
    if (orig === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = orig;
  });

  it("STANDARD_WINDOWS_PATHEXT carries the standard executable extensions", () => {
    for (const ext of [".COM", ".EXE", ".BAT", ".CMD", ".VBS", ".JS", ".WSF", ".MSC"]) {
      expect(STANDARD_WINDOWS_PATHEXT.toUpperCase()).toContain(ext);
    }
  });

  it("corrects a mangled inherited PATHEXT (.CPL) in default mode", () => {
    process.env.PATHEXT = ".CPL";
    const env = buildExecEnv(cfg({ execSanitizeEnv: false }));
    expect(env.PATHEXT).toBe(STANDARD_WINDOWS_PATHEXT);
    expect(env.PATHEXT).toContain(".EXE");
  });

  it("sets PATHEXT in sanitize mode (previously dropped entirely)", () => {
    process.env.PATHEXT = ".CPL";
    const env = buildExecEnv(cfg({ execSanitizeEnv: true }));
    expect(env.PATHEXT).toBe(STANDARD_WINDOWS_PATHEXT);
    expect(env.PATHEXT).toContain(".EXE");
  });

  it("sets GIT_TERMINAL_PROMPT=0 in both modes (Phase E — git never hangs on a credential prompt)", () => {
    expect(buildExecEnv(cfg({ execSanitizeEnv: false })).GIT_TERMINAL_PROMPT).toBe("0");
    expect(buildExecEnv(cfg({ execSanitizeEnv: true })).GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("still overrides PATH/Path with the sanitized path in both modes (no regression)", () => {
    const def = buildExecEnv(cfg({ execSanitizeEnv: false }));
    expect(def.PATH).toContain("System32");
    expect(def.Path).toBe(def.PATH);
    const san = buildExecEnv(cfg({ execSanitizeEnv: true }));
    expect(san.PATH).toContain("System32");
    expect(san.Path).toBe(san.PATH);
  });
});

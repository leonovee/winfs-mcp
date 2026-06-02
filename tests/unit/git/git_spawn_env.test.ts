import { describe, it, expect } from "vitest";
import { gitSpawnEnv } from "../../../src/core/git_safety.js";
import { STANDARD_WINDOWS_PATHEXT } from "../../../src/core/exec_safety.js";

describe("core/git_safety gitSpawnEnv (Phase C+E)", () => {
  it("pins PATHEXT and disables the git terminal credential prompt", () => {
    const env = gitSpawnEnv();
    expect(env.PATHEXT).toBe(STANDARD_WINDOWS_PATHEXT);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("spreads the inherited environment (git PATH is left intact, read-only tools)", () => {
    // Set a sentinel on process.env and confirm gitSpawnEnv carries it through.
    const KEY = "WINFS_GIT_ENV_SENTINEL";
    const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    const prev = process.env[KEY];
    process.env[KEY] = "carried";
    try {
      expect(gitSpawnEnv()[KEY]).toBe("carried");
    } finally {
      if (had) process.env[KEY] = prev;
      else delete process.env[KEY];
    }
  });
});

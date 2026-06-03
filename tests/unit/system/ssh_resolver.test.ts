import { describe, it, expect } from "vitest";
import { resolveSshBin, GIT_BUNDLED_SSH, SYSTEM32_SSH } from "../../../src/core/ssh_resolver.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

const cfg = (sshExePath?: string): ResolvedConfig =>
  ({ sshExePath }) as unknown as ResolvedConfig;

describe("core/ssh_resolver resolveSshBin (item 6)", () => {
  it("honors an explicitly configured sshExePath strictly (existence checked by caller)", () => {
    // Even if it doesn't exist, an explicit config path is returned verbatim so
    // the caller can surface ESSHNOTFOUND — matches the existing contract.
    expect(resolveSshBin(cfg("C:\\custom\\ssh.exe"), () => false)).toBe("C:\\custom\\ssh.exe");
  });

  it("prefers Git-bundled ssh over System32 when sshExePath is unset", () => {
    expect(resolveSshBin(cfg(undefined), () => true)).toBe(GIT_BUNDLED_SSH);
  });

  it("falls back to System32 OpenSSH when only it exists", () => {
    const exists = (p: string): boolean => p.toLowerCase().includes("system32");
    expect(resolveSshBin(cfg(undefined), exists)).toBe(SYSTEM32_SSH);
  });

  it("falls back to bare ssh.exe when neither bundled ssh exists", () => {
    expect(resolveSshBin(cfg(undefined), () => false)).toBe("ssh.exe");
  });
});

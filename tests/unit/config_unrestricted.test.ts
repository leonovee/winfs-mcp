import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../../src/core/config.js";

describe("config: unrestrictedFilesystem + magic-confirm validation (v0.6 §U invariant #28)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-cfg-unrestricted-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(content: Record<string, unknown>): Promise<string> {
    const p = path.join(tmpDir, "config.json");
    await fs.writeFile(p, JSON.stringify(content), "utf8");
    return p;
  }

  it("strict by default (no field set) → serverMode === 'strict'", async () => {
    const p = await writeConfig({ allowedRoots: [tmpDir] });
    const cfg = await loadConfig(p);
    expect(cfg.serverMode).toBe("strict");
    expect(cfg.unrestrictedFilesystem).toBe(false);
  });

  it("unrestrictedFilesystem:true + correct confirm → serverMode === 'unrestricted'", async () => {
    const p = await writeConfig({
      allowedRoots: [tmpDir],
      unrestrictedFilesystem: true,
      unrestrictedFilesystemConfirm: "I-UNDERSTAND-THE-RISK",
    });
    const cfg = await loadConfig(p);
    expect(cfg.serverMode).toBe("unrestricted");
    expect(cfg.unrestrictedFilesystem).toBe(true);
  });

  it("unrestrictedFilesystem:true WITHOUT confirm → loadConfig throws", async () => {
    const p = await writeConfig({
      allowedRoots: [tmpDir],
      unrestrictedFilesystem: true,
    });
    await expect(loadConfig(p)).rejects.toThrow(
      /unrestrictedFilesystem requires unrestrictedFilesystemConfirm/,
    );
  });

  it("unrestrictedFilesystem:true with WRONG confirm string → loadConfig throws", async () => {
    const p = await writeConfig({
      allowedRoots: [tmpDir],
      unrestrictedFilesystem: true,
      unrestrictedFilesystemConfirm: "i-understand-the-risk", // wrong case
    });
    await expect(loadConfig(p)).rejects.toThrow(
      /unrestrictedFilesystem requires unrestrictedFilesystemConfirm/,
    );
  });

  it("confirm set without unrestrictedFilesystem:true → no-op (still strict, no throw)", async () => {
    const p = await writeConfig({
      allowedRoots: [tmpDir],
      unrestrictedFilesystemConfirm: "I-UNDERSTAND-THE-RISK",
    });
    const cfg = await loadConfig(p);
    expect(cfg.serverMode).toBe("strict");
    expect(cfg.unrestrictedFilesystem).toBe(false);
    expect(cfg.unrestrictedFilesystemConfirm).toBe("I-UNDERSTAND-THE-RISK");
  });
});

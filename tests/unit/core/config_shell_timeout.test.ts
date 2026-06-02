import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../../../src/core/config.js";

describe("config: shell timeout pair validation (Phase B)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-cfg-shelltimeout-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeConfig(content: Record<string, unknown>): Promise<string> {
    const p = path.join(tmpDir, "config.json");
    await fs.writeFile(p, JSON.stringify(content), "utf8");
    return p;
  }

  it("rejects shellMaxTimeoutMs < shellTimeoutMs", async () => {
    const p = await writeConfig({
      allowedRoots: [tmpDir],
      shellTimeoutMs: 120_000,
      shellMaxTimeoutMs: 60_000,
    });
    await expect(loadConfig(p)).rejects.toThrow(
      /shellMaxTimeoutMs.*must be >=.*shellTimeoutMs/,
    );
  });

  it("accepts shellMaxTimeoutMs >= shellTimeoutMs", async () => {
    const p = await writeConfig({
      allowedRoots: [tmpDir],
      shellTimeoutMs: 30_000,
      shellMaxTimeoutMs: 300_000,
    });
    const cfg = await loadConfig(p);
    expect(cfg.shellTimeoutMs).toBe(30_000);
    expect(cfg.shellMaxTimeoutMs).toBe(300_000);
  });
});

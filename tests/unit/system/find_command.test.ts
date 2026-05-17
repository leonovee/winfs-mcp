import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findCommandImpl } from "../../../src/tools/system/find_command.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/system/find_command", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("found:true for git (present on test host)", async () => {
    const res = await findCommandImpl({ name: "git", with_version: false }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.found).toBe(true);
    expect(res.value.path).toMatch(/git/i);
  });

  it("found:false for a definitely-missing command name", async () => {
    const res = await findCommandImpl(
      { name: "definitely-not-a-real-command-987654", with_version: false },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.found).toBe(false);
    expect(res.value.path).toBeUndefined();
    expect(res.value.version).toBeUndefined();
  });

  it("with_version:true populates version for git", async () => {
    const res = await findCommandImpl({ name: "git", with_version: true }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.found).toBe(true);
    expect(res.value.version).toMatch(/git version/i);
  });
}, { timeout: 60_000 });

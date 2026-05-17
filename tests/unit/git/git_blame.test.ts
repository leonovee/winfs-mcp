import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import { gitBlameImpl } from "../../../src/tools/git/git_blame.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { initRepo, commitFile } from "../../git_helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/git/git_blame", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("happy: returns blame entries for each line", async () => {
    await initRepo(root);
    await commitFile(root, "src.txt", "L1\nL2\nL3\n", "add src");
    const res = await gitBlameImpl(
      { repo_path: root, path: path.join(root, "src.txt") },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(3);
    expect(res.value.blame.length).toBe(3);
    expect(res.value.blame[0]!.line).toBe(1);
    expect(res.value.blame[0]!.content).toBe("L1");
    expect(res.value.blame[0]!.author).toBe("Test Author");
    expect(res.value.blame[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("range subset returns only those lines", async () => {
    await initRepo(root);
    await commitFile(root, "src.txt", "L1\nL2\nL3\nL4\nL5\n", "add src");
    const res = await gitBlameImpl(
      { repo_path: root, path: path.join(root, "src.txt"), range: "2:4" },
      config,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.total).toBe(3);
    expect(res.value.blame.map((b) => b.line)).toEqual([2, 3, 4]);
  });

  it("ENOMATCH on non-tracked path", async () => {
    await initRepo(root);
    const res = await gitBlameImpl(
      { repo_path: root, path: path.join(root, "never-existed.txt") },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    // git emits its own error here; allowedRoots also catches the missing file
    // before git is invoked, surfacing as ENOENT/EPERM_ROOT depending on
    // realpath behavior. Either way it's not ok.
    expect(["ENOMATCH", "ENOENT", "EPERM_ROOT"]).toContain(res.error.code);
  });

  it("EINVAL when range span exceeds the cap", async () => {
    await initRepo(root);
    await commitFile(root, "x.txt", "L\n", "x");
    const res = await gitBlameImpl(
      { repo_path: root, path: path.join(root, "x.txt"), range: "1:50000" },
      config,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });
});

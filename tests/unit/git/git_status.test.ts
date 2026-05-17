import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gitStatusImpl } from "../../../src/tools/git/git_status.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { initRepo, runGit } from "../../git_helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/git/git_status", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("clean repo on main branch", async () => {
    await initRepo(root);
    const res = await gitStatusImpl({ repo_path: root }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.branch).toBe("main");
    expect(res.value.detached).toBe(false);
    expect(res.value.staged).toEqual([]);
    expect(res.value.modified).toEqual([]);
    expect(res.value.untracked).toEqual([]);
    expect(res.value.conflicted).toEqual([]);
  });

  it("dirty repo: staged + modified + untracked surfaced", async () => {
    await initRepo(root);
    // Untracked file
    await fs.writeFile(path.join(root, "untracked.txt"), "x", "utf8");
    // Staged new file
    await fs.writeFile(path.join(root, "staged.txt"), "y", "utf8");
    await runGit(root, ["add", "staged.txt"]);
    // Modified tracked file
    await fs.writeFile(path.join(root, "README.md"), "# Test\n\nchanged\n", "utf8");
    const res = await gitStatusImpl({ repo_path: root }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.untracked).toContain("untracked.txt");
    expect(res.value.staged).toContain("staged.txt");
    expect(res.value.modified).toContain("README.md");
  });

  it("detached HEAD flagged", async () => {
    const sha = await initRepo(root);
    await runGit(root, ["checkout", "-q", sha]);
    const res = await gitStatusImpl({ repo_path: root }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.detached).toBe(true);
  });

  it("ENOTREPO when no .git present", async () => {
    const res = await gitStatusImpl({ repo_path: root }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOTREPO");
  });

  it("EPERM_ROOT when repo_path outside allowedRoots", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    const res = await gitStatusImpl({ repo_path: outside }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EPERM_ROOT");
  });
});

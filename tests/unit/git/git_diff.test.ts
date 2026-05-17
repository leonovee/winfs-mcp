import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { gitDiffImpl } from "../../../src/tools/git/git_diff.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { initRepo, commitFile } from "../../git_helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/git/git_diff", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("uncommitted vs HEAD: returns worktree diff with stats", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "README.md"), "# Test\n\nadded line\n", "utf8");
    const res = await gitDiffImpl({ repo_path: root }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.diff).toMatch(/\+added line/);
    expect(res.value.files_changed).toContain("README.md");
    expect(res.value.stats.insertions).toBeGreaterThan(0);
  });

  it("rev_a..rev_b: returns commit-range diff", async () => {
    const sha1 = await initRepo(root);
    const sha2 = await commitFile(root, "new.txt", "hello\n", "add new.txt");
    const res = await gitDiffImpl({ repo_path: root, rev_a: sha1, rev_b: sha2 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.files_changed).toContain("new.txt");
    expect(res.value.stats.insertions).toBeGreaterThan(0);
  });

  it("ENOTREPO when no .git present", async () => {
    const res = await gitDiffImpl({ repo_path: root }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOTREPO");
  });
});

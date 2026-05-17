import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gitShowImpl } from "../../../src/tools/git/git_show.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { initRepo, commitFile } from "../../git_helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/git/git_show", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("returns metadata + diff + files_changed for a valid sha", async () => {
    await initRepo(root);
    const sha = await commitFile(root, "feature.txt", "alpha\nbeta\n", "add feature.txt");
    const res = await gitShowImpl({ repo_path: root, sha }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.sha).toBe(sha);
    expect(res.value.message).toBe("add feature.txt");
    expect(res.value.email).toBe("test@example.com");
    expect(res.value.files_changed).toContain("feature.txt");
    expect(res.value.diff).toMatch(/\+alpha/);
    expect(res.value.diff).toMatch(/\+beta/);
    expect(res.value.truncated).toBe(false);
  });

  it("ENOMATCH on unknown sha", async () => {
    await initRepo(root);
    const res = await gitShowImpl({ repo_path: root, sha: "deadbeefdeadbeef" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOMATCH");
  });
});

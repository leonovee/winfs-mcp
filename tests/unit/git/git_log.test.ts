import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gitLogImpl } from "../../../src/tools/git/git_log.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import { initRepo, commitFile } from "../../git_helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

describe("tools/git/git_log", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  it("happy: returns commits in newest-first order with envelope total", async () => {
    await initRepo(root);
    await commitFile(root, "a.txt", "A\n", "second commit");
    await commitFile(root, "b.txt", "B\n", "third commit");
    const res = await gitLogImpl({ repo_path: root }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.commits.length).toBe(3);
    expect(res.value.total).toBe(3);
    expect(res.value.commits[0]!.message).toBe("third commit");
    expect(res.value.commits[1]!.message).toBe("second commit");
    expect(res.value.commits[2]!.message).toBe("initial commit");
    expect(res.value.commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(res.value.commits[0]!.email).toBe("test@example.com");
    expect(res.value.commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("count caps the returned set", async () => {
    await initRepo(root);
    await commitFile(root, "a.txt", "A\n", "c2");
    await commitFile(root, "b.txt", "B\n", "c3");
    await commitFile(root, "c.txt", "C\n", "c4");
    const res = await gitLogImpl({ repo_path: root, count: 2 }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.commits.length).toBe(2);
    expect(res.value.total).toBe(2);
  });

  it("range filter limits commits", async () => {
    await initRepo(root);
    await commitFile(root, "a.txt", "A\n", "c2");
    const head = await commitFile(root, "b.txt", "B\n", "c3");
    const res = await gitLogImpl({ repo_path: root, range: `${head}~1..HEAD` }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.commits.length).toBe(1);
    expect(res.value.commits[0]!.message).toBe("c3");
  });

  it("path_filter limits to commits touching that path", async () => {
    await initRepo(root);
    await commitFile(root, "x.txt", "X\n", "touches x");
    await commitFile(root, "y.txt", "Y\n", "touches y");
    const res = await gitLogImpl({ repo_path: root, path_filter: "x.txt" }, config);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.commits.map((c) => c.message)).toEqual(["touches x"]);
  });

  it("ENOTREPO when no .git present", async () => {
    const res = await gitLogImpl({ repo_path: root }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("ENOTREPO");
  });

  it("EINVAL when range starts with '-'", async () => {
    await initRepo(root);
    const res = await gitLogImpl({ repo_path: root, range: "--exec=evil" }, config);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });
});

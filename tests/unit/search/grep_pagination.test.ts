import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { grepImpl } from "../../../src/tools/search/grep.js";
import { makeTempConfig, cleanupTempConfig } from "../../helpers.js";
import type { ResolvedConfig } from "../../../src/core/config.js";

/**
 * v0.7 wave 2a: explicit pagination over the match set.
 *
 *   - `offset` (default 0) / `limit` (default = MAX_MATCHES_DEFAULT) carve a
 *     half-open window [offset, offset+limit) over the match sequence.
 *   - `total_matches` reports the count across the entire search (capped at
 *     a hard ceiling — `total_matches_capped: true` when hit).
 *   - `next_offset` is present iff more results follow the current page.
 *   - Default call (no offset/limit) preserves first-page semantics.
 */
describe("tools/search/grep — pagination (v0.7 wave 2a)", () => {
  let config: ResolvedConfig;
  let root: string;

  beforeEach(async () => {
    ({ config, root } = await makeTempConfig());
  });

  afterEach(async () => {
    await cleanupTempConfig(root);
  });

  async function writeMatchesFile(name: string, count: number): Promise<string> {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) lines.push(`hit-${i.toString().padStart(4, "0")}`);
    const p = path.join(root, name);
    await fs.writeFile(p, lines.join("\n") + "\n", "utf8");
    return p;
  }

  it("default call (no offset/limit) returns first-page matches plus total_matches", async () => {
    await writeMatchesFile("a.txt", 5);
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(5);
    expect(res.value.total_matches).toBe(5);
    expect(res.value.next_offset).toBeUndefined();
  });

  it("offset/limit walk through a match set across pages", async () => {
    await writeMatchesFile("a.txt", 25);

    const page1 = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
        offset: 0,
        limit: 10,
      },
      config,
      5000,
    );
    expect(page1.ok).toBe(true);
    if (!page1.ok) throw new Error("expected ok");
    expect(page1.value.matches.length).toBe(10);
    expect(page1.value.total_matches).toBe(25);
    expect(page1.value.next_offset).toBe(10);
    expect(page1.value.matches[0]!.line).toBe(1);

    const page2 = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
        offset: 10,
        limit: 10,
      },
      config,
      5000,
    );
    expect(page2.ok).toBe(true);
    if (!page2.ok) throw new Error("expected ok");
    expect(page2.value.matches.length).toBe(10);
    expect(page2.value.total_matches).toBe(25);
    expect(page2.value.next_offset).toBe(20);
    expect(page2.value.matches[0]!.line).toBe(11);

    const page3 = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
        offset: 20,
        limit: 10,
      },
      config,
      5000,
    );
    expect(page3.ok).toBe(true);
    if (!page3.ok) throw new Error("expected ok");
    expect(page3.value.matches.length).toBe(5);
    expect(page3.value.total_matches).toBe(25);
    expect(page3.value.next_offset).toBeUndefined();
  });

  it("offset past the end returns empty matches and no next_offset", async () => {
    await writeMatchesFile("a.txt", 3);
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
        offset: 99,
        limit: 10,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches).toEqual([]);
    expect(res.value.total_matches).toBe(3);
    expect(res.value.next_offset).toBeUndefined();
  });

  it("negative offset is rejected with EINVAL", async () => {
    await writeMatchesFile("a.txt", 1);
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
        offset: -1,
        limit: 10,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("EINVAL");
  });

  it("max_matches still works as the legacy page-size alias", async () => {
    await writeMatchesFile("a.txt", 5);
    const res = await grepImpl(
      {
        path_glob: path.join(root, "*.txt"),
        pattern: "hit-",
        case_sensitive: false,
        context_lines: 0,
        max_matches: 2,
      },
      config,
      5000,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.matches.length).toBe(2);
    // total_matches reflects the full set, not the page.
    expect(res.value.total_matches).toBe(5);
    expect(res.value.next_offset).toBe(2);
  });
});

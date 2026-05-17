import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { checkAllowed } from "../../src/core/allowed_roots.js";
import { runTool } from "../../src/core/tool_wrapper.js";
import { writeImpl } from "../../src/tools/fs/write.js";
import { readImpl } from "../../src/tools/fs/read.js";
import { appendServerStartAudit, flushAudit } from "../../src/core/audit.js";
import { makeTempConfig, cleanupTempConfig } from "../helpers.js";
import type { ResolvedConfig } from "../../src/core/config.js";

/**
 * v0.6 §U invariants #28–#30:
 *
 * - Strict mode (default): paths outside allowedRoots return EPERM_ROOT.
 * - Unrestricted mode: paths outside allowedRoots are accepted (other
 *   defenses stay in force).
 * - Mutation-tool audit entries include `mode: "strict" | "unrestricted"`.
 * - Read-only audit entries omit the `mode` field.
 * - server_start sentinel record carries server_mode in args_summary.
 */
describe("invariant: serverMode === 'unrestricted' bypasses allowedRoots check", () => {
  let strict: ResolvedConfig;
  let root: string;
  let outsidePath: string;

  beforeEach(async () => {
    ({ config: strict, root } = await makeTempConfig());
    // Path outside allowedRoots: a sibling of the temp root.
    const sibling = await fs.mkdtemp(path.join(path.dirname(root), "winfs-outside-"));
    outsidePath = path.join(sibling, "out.txt");
    await fs.writeFile(outsidePath, "outside content", "utf8");
  });

  afterEach(async () => {
    try {
      const sibling = path.dirname(outsidePath);
      await fs.rm(sibling, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await cleanupTempConfig(root);
  });

  it("strict mode (default): out-of-roots path → EPERM_ROOT", async () => {
    const res = await checkAllowed(outsidePath, strict);
    expect("ok" in res && res.ok === false).toBe(true);
    if (!("ok" in res) || res.ok !== false) throw new Error("expected EPERM_ROOT");
    expect(res.error.code).toBe("EPERM_ROOT");
  });

  it("unrestricted mode: out-of-roots path is accepted (returns realPath)", async () => {
    const unrestricted: ResolvedConfig = { ...strict, serverMode: "unrestricted" };
    const res = await checkAllowed(outsidePath, unrestricted);
    expect("realPath" in res).toBe(true);
    if (!("realPath" in res)) throw new Error("expected realPath");
    expect(path.normalize(res.realPath)).toBe(path.normalize(outsidePath));
  });

  it("audit log: mutation tool entry includes `mode` field; read-only entry omits it", async () => {
    // Drive `write` (mutation) and `read` (read-only) through the wrapper to
    // exercise the actual audit-record construction path.
    const writeTarget = path.join(root, "wmode.txt");
    await runTool({ tool: "write", config: strict }, {
      path: writeTarget,
      content: "x",
      overwrite: true,
      mkdirParents: false,
    }, (a) => writeImpl(
      a as { path: string; content: string; overwrite: boolean; mkdirParents: boolean },
      strict,
    ));
    await runTool({ tool: "read", config: strict }, { path: writeTarget }, (a) =>
      readImpl(a as { path: string }, strict),
    );
    await flushAudit();

    const raw = await fs.readFile(strict.resolvedAuditLogPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const records = lines.map((l) => JSON.parse(l));
    const writeRec = records.find((r) => r.tool === "write");
    const readRec = records.find((r) => r.tool === "read");

    expect(writeRec).toBeDefined();
    expect(readRec).toBeDefined();
    expect(writeRec.mode).toBe("strict");
    expect(readRec.mode).toBeUndefined();
  });

  it("audit log: server_start sentinel record carries server_mode in args_summary", async () => {
    const unrestricted: ResolvedConfig = { ...strict, serverMode: "unrestricted" };
    appendServerStartAudit(unrestricted);
    await flushAudit();

    const raw = await fs.readFile(strict.resolvedAuditLogPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const records = lines.map((l) => JSON.parse(l));
    const startRec = records.find((r) => r.tool === "_server_start");
    expect(startRec).toBeDefined();
    expect(startRec.args_summary.server_mode).toBe("unrestricted");
    expect(startRec.args_summary.pid).toBeTypeOf("number");
    expect(startRec.mode).toBe("unrestricted");
  });
});

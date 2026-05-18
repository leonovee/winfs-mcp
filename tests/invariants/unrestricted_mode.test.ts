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
    // exercise the actual audit-record construction path. This case verifies
    // the WRITER side: the right bytes land on disk. Reader side is pinned by
    // the next case via auditTailImpl directly — both must pass or the field
    // is dead end-to-end.
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

  it("audit READER (audit_tail) surfaces `mode` field — regression for v0.6 smoke finding", async () => {
    // Phase 6a wrote `mode` on disk but audit_tail's AuditEntry Zod schema
    // didn't include `mode`. zod's safeParse stripped it during the backward
    // scan, so forensic queries via audit_tail returned entries with mode:
    // undefined even though the bytes on disk were correct. The previous
    // writer-side invariant test passed because it bypassed audit_tail and
    // read fs.readFile directly — exactly the gap this regression closes.
    const { auditTailImpl } = await import("../../src/tools/system/audit_tail.js");

    // Test BOTH modes in one shot.
    const unrestricted: ResolvedConfig = { ...strict, serverMode: "unrestricted" };

    const writeTargetStrict = path.join(root, "regression-write-strict.txt");
    await runTool({ tool: "write", config: strict }, {
      path: writeTargetStrict,
      content: "x",
      overwrite: true,
      mkdirParents: false,
    }, (a) => writeImpl(
      a as { path: string; content: string; overwrite: boolean; mkdirParents: boolean },
      strict,
    ));

    const writeTargetUnrestricted = path.join(root, "regression-write-unrestricted.txt");
    await runTool({ tool: "write", config: unrestricted }, {
      path: writeTargetUnrestricted,
      content: "y",
      overwrite: true,
      mkdirParents: false,
    }, (a) => writeImpl(
      a as { path: string; content: string; overwrite: boolean; mkdirParents: boolean },
      unrestricted,
    ));
    // One read-only call too, so the omitted-on-read-only contract is also
    // re-checked via audit_tail (not just fs.readFile).
    await runTool({ tool: "read", config: strict }, { path: writeTargetStrict }, (a) =>
      readImpl(a as { path: string }, strict),
    );
    await flushAudit();

    const res = await auditTailImpl({ n: 50 }, strict);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // Find the latest write entries via audit_tail (not raw fs).
    const writeEntries = res.value.entries.filter(
      (e) => e.tool === "write",
    );
    const readEntries = res.value.entries.filter((e) => e.tool === "read");
    expect(writeEntries.length).toBeGreaterThanOrEqual(2);

    // The strict write recorded mode:"strict" — must survive zod parse.
    const strictWrite = writeEntries.find(
      (e) => (e.args_summary as { path?: string })?.path === writeTargetStrict,
    );
    expect(strictWrite).toBeDefined();
    expect(strictWrite?.mode).toBe("strict");

    // The unrestricted write recorded mode:"unrestricted" — must survive.
    const unrestrictedWrite = writeEntries.find(
      (e) => (e.args_summary as { path?: string })?.path === writeTargetUnrestricted,
    );
    expect(unrestrictedWrite).toBeDefined();
    expect(unrestrictedWrite?.mode).toBe("unrestricted");

    // Read entry still omits mode end-to-end.
    expect(readEntries.length).toBeGreaterThanOrEqual(1);
    const readEntry = readEntries[readEntries.length - 1];
    expect(readEntry?.mode).toBeUndefined();
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

// v0.6 Inspector-smoke wire-level harness. Spawns the built server via stdio,
// drives JSON-RPC against the MCP transport, runs the probe sweep from
// prompts/cc-prompt-v0.6-inspector-smoke.md, prints a structured report.
//
// Replaces the Claude-in-Chrome UI flow for Path B (operator directive
// 2026-05-18). Schema-rendering visual checks are skipped here — that
// contract is pinned by tests/invariants/structured_content.test.ts.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const WINFS = "C:\\Users\\Expert\\Desktop\\AI\\tools\\winfs";
const SMOKE_TMP = path.join(WINFS, ".inspector_smoke_tmp.txt");
const SMOKE_DIR = path.join(WINFS, ".inspector_smoke_dir");

function spawnServer(configPath) {
  const child = spawn(
    process.platform === "win32" ? "node.exe" : "node",
    [path.join(WINFS, "dist", "index.js"), "--config", configPath],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const stderrLines = [];
  let stdoutBuf = "";
  const pending = new Map();
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrLines.push(chunk.toString("utf8"));
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 20000);
    });

  return {
    send,
    stderrText: () => stderrLines.join(""),
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    async stop() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };
}

async function handshake(srv) {
  const init = await srv.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "v0.6-smoke", version: "0.1.0" },
  });
  srv.notify("notifications/initialized", {});
  // Wait briefly for any ready-line stderr.
  await new Promise((r) => setTimeout(r, 300));
  return init.result;
}

function ok(name, val) {
  return { name, pass: true, detail: val };
}
function fail(name, expected, got) {
  return { name, pass: false, expected, got };
}

function isError(callResp) {
  return callResp?.result?.isError === true;
}

function parseErrorContent(callResp) {
  try {
    return JSON.parse(callResp.result.content[0].text);
  } catch {
    return null;
  }
}

function parseSuccessContent(callResp) {
  return callResp.result.structuredContent ?? null;
}

async function call(srv, name, args) {
  return srv.send("tools/call", { name, arguments: args });
}

async function setupSandbox() {
  // Create sandbox artifacts the methodology refers to.
  await fs.writeFile(SMOKE_TMP, "hello v0.6", "utf8");
  try {
    await fs.mkdir(SMOKE_DIR);
  } catch {
    /* exists */
  }
  // edit.txt for §4 R16/R17/R18
  await fs.writeFile(path.join(SMOKE_DIR, "edit.txt"), "foo and foo", "utf8");
  // chunk.txt for #30 + R19/R21
  await fs.writeFile(path.join(SMOKE_DIR, "chunk.txt"), "ABCDEFGHIJ", "utf8");
  // utf.txt for R20: ΠΠΠA = [CE A0 CE A0 CE A0 41]
  await fs.writeFile(path.join(SMOKE_DIR, "utf.txt"), "ΠΠΠA", "utf8");
}

async function cleanupSandbox() {
  try {
    await fs.rm(SMOKE_TMP, { force: true });
  } catch {
    /* ignore */
  }
  try {
    await fs.rm(SMOKE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function runStrictPass() {
  console.log("\n========== STRICT-MODE PASS ==========");
  const srv = spawnServer(path.join(WINFS, "configs", "local.json"));
  const results = [];
  try {
    // ── PRE-FLIGHT ────────────────────────────────────────────────
    const init = await handshake(srv);
    results.push(
      init.serverInfo?.version === "0.6.0"
        ? ok("Pre-flight: server version", init.serverInfo.version)
        : fail("Pre-flight: server version", "0.6.0", init.serverInfo?.version),
    );
    results.push(
      init.serverInfo?.name?.includes("winfs")
        ? ok("Pre-flight: server name", init.serverInfo.name)
        : fail("Pre-flight: server name", "contains 'winfs'", init.serverInfo?.name),
    );

    const stderr1 = srv.stderrText();
    const hasReady = /ready \(allowedRoots=\d+, mode=strict\)/.test(stderr1);
    results.push(
      hasReady
        ? ok("Pre-flight: ready line includes mode=strict", "matched")
        : fail("Pre-flight: ready line includes mode=strict", "match", stderr1.slice(0, 200)),
    );
    const hasBanner = stderr1.includes("UNRESTRICTED FILESYSTEM MODE");
    results.push(
      !hasBanner
        ? ok("Pre-flight: no ⚠️ banner in strict mode", "absent")
        : fail("Pre-flight: no ⚠️ banner in strict mode", "no banner", "banner present"),
    );

    const toolsList = await srv.send("tools/list", {});
    const toolNames = toolsList.result.tools.map((t) => t.name).sort();
    results.push(
      toolNames.length === 30
        ? ok("Pre-flight: 30 tools visible", `${toolNames.length}`)
        : fail("Pre-flight: 30 tools visible", "30", `${toolNames.length}: ${toolNames.join(", ")}`),
    );
    // Spot-check: write_chunk in list
    results.push(
      toolNames.includes("write_chunk")
        ? ok("Pre-flight: write_chunk present", "yes")
        : fail("Pre-flight: write_chunk present", "yes", "missing"),
    );

    await setupSandbox();

    // ── §2 HAPPY-PATH PROBES ───────────────────────────────────────
    // #1 read
    let r = await call(srv, "read", { path: path.join(WINFS, "package.json") });
    let sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.content?.includes('"name": "winfs-mcp"')
        ? ok("§2 #1 read", "package.json content w/ winfs-mcp name")
        : fail("§2 #1 read", "content w/ winfs-mcp", isError(r) ? parseErrorContent(r) : "no name match"),
    );

    // #2 write (target SMOKE_TMP already created by setup; overwrite)
    r = await call(srv, "write", {
      path: SMOKE_TMP,
      content: "hello v0.6",
      overwrite: true,
      mkdirParents: false,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && typeof sc?.bytes_written === "number" && sc.bytes_written > 0
        ? ok("§2 #2 write", `bytes_written=${sc.bytes_written}`)
        : fail("§2 #2 write", "bytes_written>0", isError(r) ? parseErrorContent(r) : sc),
    );

    // #3 append (field is `bytes_added` + `new_size`, not `bytes_written`)
    r = await call(srv, "append", {
      path: SMOKE_TMP,
      content: "\nappended",
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && typeof sc?.bytes_added === "number" && sc.bytes_added > 0 && sc?.new_size > 0
        ? ok("§2 #3 append", `bytes_added=${sc.bytes_added}, new_size=${sc.new_size}`)
        : fail("§2 #3 append", "bytes_added>0 + new_size>0", isError(r) ? parseErrorContent(r) : sc),
    );

    // #4 list
    r = await call(srv, "list", { path: WINFS, max_depth: 1 });
    sc = parseSuccessContent(r);
    const hasPkg = sc?.entries?.some((e) => e.name === "package.json");
    results.push(
      !isError(r) && hasPkg && sc.total > 0
        ? ok("§2 #4 list", `total=${sc.total}, contains package.json`)
        : fail("§2 #4 list", "total>0 + package.json", isError(r) ? parseErrorContent(r) : sc),
    );

    // #5 stat
    r = await call(srv, "stat", { path: path.join(WINFS, "package.json") });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.is_dir === false && sc?.size > 0
        ? ok("§2 #5 stat", `is_dir=false, size=${sc.size}`)
        : fail("§2 #5 stat", "is_dir:false, size>0", isError(r) ? parseErrorContent(r) : sc),
    );

    // #6 mkdir
    const mkdirTarget = path.join(SMOKE_DIR, "nested");
    r = await call(srv, "mkdir", { path: mkdirTarget, recursive: true });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.created === true
        ? ok("§2 #6 mkdir", "created:true")
        : fail("§2 #6 mkdir", "created:true", isError(r) ? parseErrorContent(r) : sc),
    );

    // #7 move
    const movedDst = path.join(SMOKE_DIR, "moved.txt");
    r = await call(srv, "move", {
      src: SMOKE_TMP,
      dst: movedDst,
      overwrite: false,
      allow_cross_volume: false,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.moved === true
        ? ok("§2 #7 move", "moved:true")
        : fail("§2 #7 move", "moved:true", isError(r) ? parseErrorContent(r) : sc),
    );

    // #8 copy
    const copiedDst = path.join(SMOKE_DIR, "copied.txt");
    r = await call(srv, "copy", {
      src: movedDst,
      dst: copiedDst,
      overwrite: false,
      recursive: true,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.copied === true
        ? ok("§2 #8 copy", "copied:true")
        : fail("§2 #8 copy", "copied:true", isError(r) ? parseErrorContent(r) : sc),
    );

    // #9 read_multiple_files
    r = await call(srv, "read_multiple_files", {
      paths: [path.join(WINFS, "package.json"), path.join(WINFS, "README.md")],
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.total === 2 && sc?.ok_count === 2
        ? ok("§2 #9 read_multiple_files", `total=2, ok_count=2`)
        : fail("§2 #9 read_multiple_files", "total=2, ok_count=2", isError(r) ? parseErrorContent(r) : sc),
    );

    // #10 list_allowed_directories
    r = await call(srv, "list_allowed_directories", {});
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && Array.isArray(sc?.allowed_roots) && sc.allowed_roots.length > 0
        ? ok("§2 #10 list_allowed_directories", `${sc.allowed_roots.length} roots`)
        : fail("§2 #10 list_allowed_directories", "non-empty roots", isError(r) ? parseErrorContent(r) : sc),
    );

    // #11 grep
    r = await call(srv, "grep", {
      pattern: "version",
      path_glob: path.join(WINFS, "*.json"),
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.total > 0
        ? ok("§2 #11 grep", `total=${sc.total}`)
        : fail("§2 #11 grep", "total>0", isError(r) ? parseErrorContent(r) : sc),
    );

    // #12 glob
    r = await call(srv, "glob", { pattern: path.join(WINFS, "src", "**", "*.ts") });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.total > 20
        ? ok("§2 #12 glob", `total=${sc.total}`)
        : fail("§2 #12 glob", "total>20", isError(r) ? parseErrorContent(r) : sc),
    );

    // #13 read_json — DRIFT-FIX: data field, not value
    r = await call(srv, "read_json", { path: path.join(WINFS, "package.json") });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.data?.name === "winfs-mcp" && sc?.size_bytes > 0
        ? ok("§2 #13 read_json (data field)", `data.name=${sc.data.name}, size_bytes=${sc.size_bytes}`)
        : fail("§2 #13 read_json", "data.name=winfs-mcp", isError(r) ? parseErrorContent(r) : sc),
    );

    // #14 audit_tail — use findLast to get THIS session's _server_start
    // (oldest-first ordering means earlier sessions' records appear first;
    // current session's record is the LAST occurrence).
    r = await call(srv, "audit_tail", { n: 50 });
    sc = parseSuccessContent(r);
    const auditEntries = sc?.entries ?? [];
    const startEntries = auditEntries.filter((e) => e.tool === "_server_start");
    const startEntry = startEntries[startEntries.length - 1];
    results.push(
      !isError(r) &&
        typeof sc?.total === "number" &&
        sc.total === sc.entries.length &&
        typeof sc?.entries_seen_total === "number"
        ? ok("§2 #14 audit_tail envelope", `total=${sc.total}, entries_seen_total=${sc.entries_seen_total}`)
        : fail("§2 #14 audit_tail envelope", "total === entries.length + entries_seen_total present", isError(r) ? parseErrorContent(r) : sc),
    );
    results.push(
      startEntry && startEntry.args_summary?.server_mode === "strict" && startEntry.mode === "strict"
        ? ok("§2 #14 audit_tail _server_start (current session)", `server_mode=strict + mode=strict + version=${startEntry.args_summary?.version}`)
        : fail(
            "§2 #14 audit_tail _server_start (current session)",
            "server_mode + mode both 'strict'",
            startEntry ?? "no _server_start in last 50",
          ),
    );

    // #15 edit_file dry_run (writes "edited" preview to moved.txt — does not touch disk)
    const mtimeBefore = (await fs.stat(movedDst)).mtimeMs;
    r = await call(srv, "edit_file", {
      path: movedDst,
      edits: [{ old_str: "hello v0.6", new_str: "edited" }],
      dry_run: true,
    });
    sc = parseSuccessContent(r);
    const mtimeAfter = (await fs.stat(movedDst)).mtimeMs;
    results.push(
      !isError(r) &&
        sc?.dry_run === true &&
        sc?.replacements_made === 1 &&
        sc?.diff?.length > 0 &&
        mtimeBefore === mtimeAfter
        ? ok("§2 #15 edit_file dry_run", `replacements_made=1, file untouched`)
        : fail(
            "§2 #15 edit_file dry_run",
            "dry_run:true + replacements_made:1 + file untouched",
            isError(r) ? parseErrorContent(r) : { sc, mtimeChanged: mtimeBefore !== mtimeAfter },
          ),
    );

    // #16 read_section — DRIFT-FIX: line_range, NOT marker fields
    r = await call(srv, "read_section", {
      path: path.join(WINFS, "README.md"),
      line_range: [1, 10],
      encoding: "utf8",
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.range?.kind === "line" && sc?.range?.start === 1 && sc?.content?.length > 0
        ? ok("§2 #16 read_section (line_range)", `range.kind=line, range.start=1`)
        : fail("§2 #16 read_section", "range.kind=line, start=1", isError(r) ? parseErrorContent(r) : sc),
    );

    // #17 read_since
    r = await call(srv, "read_since", {
      path: path.join(WINFS, "README.md"),
      since_offset: 0,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.new_offset > 0 && sc?.file_rotated === false
        ? ok("§2 #17 read_since", `new_offset=${sc.new_offset}, file_rotated=false`)
        : fail("§2 #17 read_since", "new_offset>0 + file_rotated:false", isError(r) ? parseErrorContent(r) : sc),
    );

    // #18 diff_files identical
    r = await call(srv, "diff_files", {
      a: path.join(WINFS, "package.json"),
      b: path.join(WINFS, "package.json"),
      context_lines: 3,
      format: "unified",
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.identical === true && sc?.diff === ""
        ? ok("§2 #18 diff_files identical", `identical:true, diff:''`)
        : fail("§2 #18 diff_files identical", "identical:true + empty diff", isError(r) ? parseErrorContent(r) : sc),
    );

    // #19 git_status
    r = await call(srv, "git_status", { repo_path: WINFS });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && typeof sc?.branch === "string"
        ? ok("§2 #19 git_status", `branch=${sc.branch}`)
        : fail("§2 #19 git_status", "branch present", isError(r) ? parseErrorContent(r) : sc),
    );

    // #20 git_log
    r = await call(srv, "git_log", { repo_path: WINFS, count: 5 });
    sc = parseSuccessContent(r);
    const topSha = sc?.commits?.[0]?.hash;
    results.push(
      !isError(r) && sc?.total === 5 && sc?.commits?.length === 5 && /^[0-9a-f]{40}$/.test(topSha)
        ? ok("§2 #20 git_log", `total=5, top sha valid`)
        : fail("§2 #20 git_log", "total=5 + valid hex sha", isError(r) ? parseErrorContent(r) : sc),
    );

    // #21 git_show — DRIFT-FIX: hex SHA, NOT HEAD
    if (topSha) {
      r = await call(srv, "git_show", { repo_path: WINFS, sha: topSha });
      sc = parseSuccessContent(r);
      results.push(
        !isError(r) && sc?.sha === topSha && Array.isArray(sc?.files_changed)
          ? ok("§2 #21 git_show (hex SHA)", `sha=${topSha.slice(0, 8)}…, files_changed array`)
          : fail("§2 #21 git_show", "sha + files_changed array", isError(r) ? parseErrorContent(r) : sc),
      );
    } else {
      results.push(fail("§2 #21 git_show", "valid hex SHA from #20", "no sha"));
    }

    // #22 git_diff
    r = await call(srv, "git_diff", { repo_path: WINFS, rev_a: "HEAD~1", rev_b: "HEAD" });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.diff?.length > 0 && typeof sc?.stats?.insertions === "number"
        ? ok("§2 #22 git_diff", `insertions=${sc.stats.insertions}`)
        : fail("§2 #22 git_diff", "non-empty diff + stats", isError(r) ? parseErrorContent(r) : sc),
    );

    // #23 git_blame — DRIFT-FIX: absolute path
    r = await call(srv, "git_blame", {
      repo_path: WINFS,
      path: path.join(WINFS, "package.json"),
      range: "1:10",
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.total === 10 && sc?.blame?.length === 10
        ? ok("§2 #23 git_blame (absolute path)", `total=10`)
        : fail("§2 #23 git_blame", "total=10", isError(r) ? parseErrorContent(r) : sc),
    );

    // #24 execute_command
    r = await call(srv, "execute_command", { command: "Get-Date", args: [] });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.exit_code === 0 && sc?.stdout?.length > 0
        ? ok("§2 #24 execute_command", `exit_code=0, stdout len=${sc.stdout.length}`)
        : fail("§2 #24 execute_command", "exit_code=0 + stdout", isError(r) ? parseErrorContent(r) : sc),
    );

    // #25 run_python — DRIFT-FIX: {mode, script}. Accept EPYTHONNOTFOUND when
    // pythonHome isn't configured (parallel to §2 #26 accepting same for pytest).
    r = await call(srv, "run_python", { mode: "inline", script: "print(1+1)", args: [] });
    sc = parseSuccessContent(r);
    const r25err = isError(r) ? parseErrorContent(r) : null;
    if (!isError(r) && sc?.exit_code === 0 && sc?.stdout?.trim() === "2") {
      results.push(ok("§2 #25 run_python ({mode, script})", `stdout='2'`));
    } else if (r25err?.code === "EPYTHONNOTFOUND") {
      results.push(
        ok(
          "§2 #25 run_python",
          `EPYTHONNOTFOUND (configs/local.json has no pythonHome; spawnFailed surfacing now correct per v0.5.x fix)`,
        ),
      );
    } else {
      results.push(fail("§2 #25 run_python", "exit_code=0 + stdout='2' OR EPYTHONNOTFOUND", r25err ?? sc));
    }

    // #26 run_pytest — count_only, accept EPARSE / EPYTHONNOTFOUND
    r = await call(srv, "run_pytest", {
      cwd: WINFS,
      count_only: true,
      timeout_ms: 30000,
    });
    sc = parseSuccessContent(r);
    const err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      (!isError(r) && sc?.collect_only === true) ||
        (err && (err.code === "EPARSE" || err.code === "EPYTHONNOTFOUND"))
        ? ok("§2 #26 run_pytest", err ? `${err.code} (acceptable)` : "collect_only success")
        : fail("§2 #26 run_pytest", "ok or EPARSE/EPYTHONNOTFOUND", err ?? sc),
    );

    // #27 find_command
    r = await call(srv, "find_command", { name: "git", with_version: false });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.found === true
        ? ok("§2 #27 find_command", `found:true, path=${sc.path}`)
        : fail("§2 #27 find_command", "found:true", isError(r) ? parseErrorContent(r) : sc),
    );

    // #28 check_env
    r = await call(srv, "check_env", { name: "PATH" });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.present === true && sc?.length > 100 && sc?.prefix?.length === 4
        ? ok("§2 #28 check_env", `length=${sc.length}, prefix='${sc.prefix}'`)
        : fail("§2 #28 check_env", "length>100 + prefix.length=4", isError(r) ? parseErrorContent(r) : sc),
    );

    // #29 fetch_url
    r = await call(srv, "fetch_url", {
      url: "https://raw.githubusercontent.com/leonovee/winfs-mcp/main/package.json",
    });
    sc = parseSuccessContent(r);
    const fetchErr = isError(r) ? parseErrorContent(r) : null;
    if (!isError(r) && sc?.status_code === 200) {
      results.push(ok("§2 #29 fetch_url", `status=200, body len=${sc.body.length}`));
    } else if (fetchErr?.code === "EHOSTNOTALLOWED") {
      results.push(fail("§2 #29 fetch_url", "200 OK (raw.githubusercontent.com whitelisted)", "EHOSTNOTALLOWED"));
    } else {
      results.push(fail("§2 #29 fetch_url", "status=200", fetchErr ?? sc));
    }

    // #30 write_chunk
    const chunkPath = path.join(SMOKE_DIR, "chunk.txt");
    r = await call(srv, "write_chunk", {
      path: chunkPath,
      offset: 3,
      content: "xy",
      encoding: "utf8",
      validate_byte_range: true,
    });
    sc = parseSuccessContent(r);
    const chunkPostContent = !isError(r) ? await fs.readFile(chunkPath, "utf8") : null;
    results.push(
      !isError(r) &&
        sc?.bytes_written === 2 &&
        sc?.total_bytes_after === 10 &&
        sc?.atomic === false &&
        chunkPostContent === "ABCxyFGHIJ"
        ? ok("§2 #30 write_chunk", `atomic:false, content='ABCxyFGHIJ'`)
        : fail("§2 #30 write_chunk", "atomic:false + content='ABCxyFGHIJ'", { sc, chunkPostContent, err: isError(r) ? parseErrorContent(r) : null }),
    );

    // ── §3 v0.5 RED-TEAM CARRYOVER ────────────────────────────────
    // R7 execute_command EBLOCKED
    r = await call(srv, "execute_command", {
      command: "Remove-Item",
      args: ["-Recurse", "-Force", "C:\\"],
    });
    const r7err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r7err?.code === "EBLOCKED"
        ? ok("§3 R7 execute_command EBLOCKED", `pattern=${r7err.details?.pattern}`)
        : fail("§3 R7 execute_command EBLOCKED", "EBLOCKED", r7err ?? "no error"),
    );

    // R8 execute_command EPERM_ROOT on cwd
    r = await call(srv, "execute_command", {
      command: "Get-Date",
      args: [],
      cwd: "C:\\Windows",
    });
    const r8err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r8err?.code === "EPERM_ROOT"
        ? ok("§3 R8 execute_command cwd EPERM_ROOT", "EPERM_ROOT")
        : fail("§3 R8 execute_command cwd EPERM_ROOT", "EPERM_ROOT", r8err ?? "no error"),
    );

    // R9 execute_command timeout
    r = await call(srv, "execute_command", {
      command: "Start-Sleep",
      args: ["-Seconds", "30"],
      timeout_ms: 1500,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.timed_out === true
        ? ok("§3 R9 execute_command timeout", `timed_out:true`)
        : fail("§3 R9 execute_command timeout", "timed_out:true", isError(r) ? parseErrorContent(r) : sc),
    );

    // R10 fetch_url 127.0.0.1 EHOSTNOTALLOWED
    r = await call(srv, "fetch_url", { url: "http://127.0.0.1/" });
    const r10err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r10err?.code === "EHOSTNOTALLOWED"
        ? ok("§3 R10 fetch_url 127.0.0.1", "EHOSTNOTALLOWED")
        : fail("§3 R10 fetch_url 127.0.0.1", "EHOSTNOTALLOWED", r10err ?? "no error"),
    );

    // R11 fetch_url localhost EHOSTNOTALLOWED
    r = await call(srv, "fetch_url", { url: "http://localhost/" });
    const r11err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r11err?.code === "EHOSTNOTALLOWED"
        ? ok("§3 R11 fetch_url localhost", "EHOSTNOTALLOWED")
        : fail("§3 R11 fetch_url localhost", "EHOSTNOTALLOWED", r11err ?? "no error"),
    );

    // R12 — skip (no httpbin in whitelist; covered by fetch_url_ssrf.test.ts)
    results.push(ok("§3 R12 fetch_url redirect-to-internal", "skipped (no httpbin in whitelist; covered by fetch_url_ssrf.test.ts mock)"));

    // R13 check_env safe-prefix on PATH
    r = await call(srv, "check_env", { name: "PATH" });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.prefix?.length === 4 && sc?.length > 100
        ? ok("§3 R13 check_env PATH safe-prefix", `prefix.length=4`)
        : fail("§3 R13 check_env PATH safe-prefix", "prefix.length=4", isError(r) ? parseErrorContent(r) : sc),
    );

    // R14 git_log on non-repo ENOTREPO
    r = await call(srv, "git_log", { repo_path: "C:\\Users\\Expert" });
    const r14err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r14err?.code === "ENOTREPO" || r14err?.code === "EPERM_ROOT"
        ? ok("§3 R14 git_log non-repo", r14err.code)
        : fail("§3 R14 git_log non-repo", "ENOTREPO or EPERM_ROOT", r14err ?? "no error"),
    );

    // R15 git_blame range cap
    r = await call(srv, "git_blame", {
      repo_path: WINFS,
      path: path.join(WINFS, "package.json"),
      range: "1:50000",
    });
    const r15err = isError(r) ? parseErrorContent(r) : null;
    sc = parseSuccessContent(r);
    results.push(
      r15err?.code === "EINVAL" || (!isError(r) && sc?.total <= 10000)
        ? ok("§3 R15 git_blame range cap", r15err?.code ?? `clamped to ${sc.total}`)
        : fail("§3 R15 git_blame range cap", "EINVAL or clamp <=10000", r15err ?? sc),
    );

    // ── §4 v0.6 RED-TEAM ──────────────────────────────────────────
    // R16 edit_file EUNIQUE rename verification (occurrences_found + expected_count)
    const editPath = path.join(SMOKE_DIR, "edit.txt"); // "foo and foo"
    r = await call(srv, "edit_file", {
      path: editPath,
      edits: [{ old_str: "foo", new_str: "BAR" }],
      dry_run: false,
    });
    const r16err = isError(r) ? parseErrorContent(r) : null;
    const editContentR16 = await fs.readFile(editPath, "utf8");
    results.push(
      r16err?.code === "EUNIQUE" &&
        r16err.details?.occurrences_found === 2 &&
        r16err.details?.expected_count === 1 &&
        r16err.details?.occurrences === undefined &&
        editContentR16 === "foo and foo"
        ? ok(
            "§4 R16 edit_file EUNIQUE rename + file untouched",
            "occurrences_found=2, expected_count=1, old `occurrences` field absent",
          )
        : fail(
            "§4 R16 edit_file EUNIQUE rename",
            "occurrences_found=2 + expected_count=1 + no `occurrences`",
            { r16err, editContent: editContentR16 },
          ),
    );

    // R17 expected_count: 0 assertion succeeds (substring absent)
    r = await call(srv, "edit_file", {
      path: editPath,
      edits: [{ old_str: "NEVER_PRESENT_xyz", new_str: "<ignored>", expected_count: 0 }],
      dry_run: false,
    });
    sc = parseSuccessContent(r);
    const editContentR17 = await fs.readFile(editPath, "utf8");
    results.push(
      !isError(r) && sc?.replacements_made === 0 && editContentR17 === "foo and foo"
        ? ok("§4 R17 expected_count: 0 assertion", `replacements_made=0, file untouched`)
        : fail(
            "§4 R17 expected_count: 0 assertion",
            "replacements_made=0 + file untouched",
            isError(r) ? parseErrorContent(r) : { sc, editContent: editContentR17 },
          ),
    );

    // R18 expected_count: 2 multi-replace
    r = await call(srv, "edit_file", {
      path: editPath,
      edits: [{ old_str: "foo", new_str: "BAR", expected_count: 2 }],
      dry_run: false,
    });
    sc = parseSuccessContent(r);
    const editContentR18 = await fs.readFile(editPath, "utf8");
    results.push(
      !isError(r) && sc?.replacements_made === 2 && editContentR18 === "BAR and BAR"
        ? ok("§4 R18 expected_count: 2 multi-replace", `replacements_made=2, content='BAR and BAR'`)
        : fail(
            "§4 R18 expected_count: 2 multi-replace",
            "replacements_made=2 + content='BAR and BAR'",
            isError(r) ? parseErrorContent(r) : { sc, editContent: editContentR18 },
          ),
    );

    // R19 write_chunk EOFFSET (offset > file_size)
    r = await call(srv, "write_chunk", {
      path: path.join(SMOKE_DIR, "chunk.txt"), // 10 bytes after #30
      offset: 100,
      content: "x",
      encoding: "utf8",
      validate_byte_range: true,
    });
    const r19err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r19err?.code === "EOFFSET" && r19err.details?.offset === 100
        ? ok("§4 R19 write_chunk EOFFSET", `EOFFSET, offset=100, file_size=${r19err.details?.file_size}`)
        : fail("§4 R19 write_chunk EOFFSET", "EOFFSET + details.offset=100", r19err ?? "no error"),
    );

    // R20 write_chunk EENCODING (UTF-8 boundary misalign in utf.txt)
    r = await call(srv, "write_chunk", {
      path: path.join(SMOKE_DIR, "utf.txt"),
      offset: 1, // mid-multibyte (Π is 2 bytes; offset 1 lands on continuation)
      content: "x",
      encoding: "utf8",
      validate_byte_range: true,
    });
    const r20err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r20err?.code === "EENCODING" && r20err.details?.offset === 1
        ? ok("§4 R20 write_chunk UTF-8 boundary", `EENCODING, offset=1`)
        : fail("§4 R20 write_chunk UTF-8 boundary", "EENCODING + details.offset=1", r20err ?? "no error"),
    );

    // R21 write_chunk atomic: false literal (re-do a small successful chunk)
    r = await call(srv, "write_chunk", {
      path: path.join(SMOKE_DIR, "chunk.txt"),
      offset: 0,
      content: "Z",
      encoding: "utf8",
      validate_byte_range: true,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.atomic === false
        ? ok("§4 R21 write_chunk atomic: false literal", "atomic === false")
        : fail("§4 R21 write_chunk atomic: false literal", "atomic === false", isError(r) ? parseErrorContent(r) : sc),
    );

    // R22 strict-mode out-of-roots read EPERM_ROOT
    r = await call(srv, "read", {
      path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
    });
    const r22err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      r22err?.code === "EPERM_ROOT"
        ? ok("§4 R22 strict out-of-roots read EPERM_ROOT", "EPERM_ROOT")
        : fail("§4 R22 strict out-of-roots read EPERM_ROOT", "EPERM_ROOT", r22err ?? "no error"),
    );
  } finally {
    await srv.stop();
  }
  return results;
}

async function runUnrestrictedPass() {
  console.log("\n========== UNRESTRICTED-MODE PASS ==========");
  // Build a temp config with unrestricted + magic confirm.
  const baseCfg = JSON.parse(await fs.readFile(path.join(WINFS, "configs", "local.json"), "utf8"));
  const unrestrictedCfg = {
    ...baseCfg,
    unrestrictedFilesystem: true,
    unrestrictedFilesystemConfirm: "I-UNDERSTAND-THE-RISK",
  };
  const cfgPath = path.join(WINFS, "configs", "local-unrestricted.json");
  await fs.writeFile(cfgPath, JSON.stringify(unrestrictedCfg, null, 2), "utf8");

  const srv = spawnServer(cfgPath);
  const results = [];
  try {
    const init = await handshake(srv);
    const stderr = srv.stderrText();
    results.push(
      stderr.includes("UNRESTRICTED FILESYSTEM MODE")
        ? ok("Pre-flight: ⚠️ banner present", "matched")
        : fail("Pre-flight: ⚠️ banner present", "match", stderr.slice(0, 300)),
    );
    results.push(
      /ready \(allowedRoots=\d+, mode=unrestricted\)/.test(stderr)
        ? ok("Pre-flight: ready line mode=unrestricted", "matched")
        : fail("Pre-flight: ready line mode=unrestricted", "match", stderr.slice(0, 300)),
    );
    const toolsList = await srv.send("tools/list", {});
    results.push(
      toolsList.result.tools.length === 30
        ? ok("Pre-flight: still 30 tools", "30")
        : fail("Pre-flight: still 30 tools", "30", `${toolsList.result.tools.length}`),
    );

    // U1 read outside roots succeeds
    let r = await call(srv, "read", {
      path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
    });
    let sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.content?.length > 0
        ? ok("§5 U1 read outside allowedRoots succeeds", `bytes=${sc.bytes_returned}`)
        : fail("§5 U1 read outside allowedRoots succeeds", "ok + non-empty content", isError(r) ? parseErrorContent(r) : sc),
    );

    // U2 audit_tail _server_start mode field — findLast for current session
    r = await call(srv, "audit_tail", { n: 20 });
    sc = parseSuccessContent(r);
    const u2starts = sc?.entries?.filter((e) => e.tool === "_server_start") ?? [];
    const startEntry = u2starts[u2starts.length - 1];
    results.push(
      startEntry?.args_summary?.server_mode === "unrestricted" && startEntry?.mode === "unrestricted"
        ? ok("§5 U2 _server_start mode=unrestricted", "matched")
        : fail("§5 U2 _server_start mode=unrestricted", "server_mode=unrestricted + mode=unrestricted", startEntry ?? "no _server_start"),
    );

    // U3 mutation tool gets mode field; read-only omits
    // Setup: write to a path inside allowedRoots first.
    const u3target = path.join(WINFS, ".inspector_u3.tmp");
    r = await call(srv, "write", { path: u3target, content: "u3", overwrite: true, mkdirParents: false });
    if (!isError(r)) {
      r = await call(srv, "read", { path: u3target });
    }
    r = await call(srv, "audit_tail", { n: 5 });
    sc = parseSuccessContent(r);
    const writeEntry = sc?.entries?.find((e) => e.tool === "write" && e.args_summary?.path?.includes(".inspector_u3.tmp"));
    const readEntry = sc?.entries?.find((e) => e.tool === "read" && e.args_summary?.path?.includes(".inspector_u3.tmp"));
    results.push(
      writeEntry?.mode === "unrestricted"
        ? ok("§5 U3 write entry has mode=unrestricted", "yes")
        : fail("§5 U3 write entry has mode=unrestricted", "mode=unrestricted", writeEntry ?? "no write entry"),
    );
    results.push(
      readEntry && readEntry.mode === undefined
        ? ok("§5 U3 read entry OMITS mode field", "absent")
        : fail("§5 U3 read entry OMITS mode field", "mode field absent", readEntry ?? "no read entry"),
    );
    try {
      await fs.rm(u3target);
    } catch {
      /* ignore */
    }

    // U4 exec blocklist STILL fires in unrestricted
    r = await call(srv, "execute_command", {
      command: "Remove-Item",
      args: ["-Recurse", "-Force", "C:\\"],
    });
    const u4err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      u4err?.code === "EBLOCKED"
        ? ok("§5 U4 exec blocklist still fires in unrestricted", "EBLOCKED")
        : fail("§5 U4 exec blocklist still fires in unrestricted", "EBLOCKED", u4err ?? "no error"),
    );

    // U5 SSRF still fires in unrestricted
    r = await call(srv, "fetch_url", { url: "http://127.0.0.1/" });
    const u5err = isError(r) ? parseErrorContent(r) : null;
    results.push(
      u5err?.code === "EHOSTNOTALLOWED"
        ? ok("§5 U5 SSRF still fires in unrestricted", "EHOSTNOTALLOWED")
        : fail("§5 U5 SSRF still fires in unrestricted", "EHOSTNOTALLOWED", u5err ?? "no error"),
    );

    // U6 safe-prefix still bounded
    r = await call(srv, "check_env", { name: "PATH" });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.prefix?.length === 4
        ? ok("§5 U6 safe-prefix still bounded in unrestricted", `prefix.length=4`)
        : fail("§5 U6 safe-prefix still bounded in unrestricted", "prefix.length=4", isError(r) ? parseErrorContent(r) : sc),
    );
  } finally {
    await srv.stop();
    try {
      await fs.rm(cfgPath);
    } catch {
      /* ignore */
    }
  }
  return results;
}

function printReport(label, results) {
  console.log(`\n--- ${label} ---`);
  let pass = 0;
  let fails = 0;
  for (const r of results) {
    if (r.pass) {
      console.log(`  ✓ ${r.name} — ${r.detail}`);
      pass++;
    } else {
      console.log(`  ✗ ${r.name}`);
      console.log(`      expected: ${typeof r.expected === "object" ? JSON.stringify(r.expected) : r.expected}`);
      console.log(`      got:      ${typeof r.got === "object" ? JSON.stringify(r.got) : r.got}`);
      fails++;
    }
  }
  console.log(`\nTotal: ${pass + fails}, passed: ${pass}, failed: ${fails}`);
  return { pass, fails };
}

async function main() {
  console.log("v0.6 Inspector-smoke wire-level harness");
  console.log(`Server build: ${path.join(WINFS, "dist", "index.js")}`);
  let strictResults, unrestrictedResults;
  try {
    strictResults = await runStrictPass();
  } catch (e) {
    console.error("STRICT pass crashed:", e);
    strictResults = [{ name: "STRICT pass", pass: false, expected: "complete", got: String(e) }];
  }
  try {
    unrestrictedResults = await runUnrestrictedPass();
  } catch (e) {
    console.error("UNRESTRICTED pass crashed:", e);
    unrestrictedResults = [{ name: "UNRESTRICTED pass", pass: false, expected: "complete", got: String(e) }];
  }
  await cleanupSandbox();

  const s = printReport("STRICT mode results", strictResults);
  const u = printReport("UNRESTRICTED mode results", unrestrictedResults);
  console.log(`\n=== OVERALL: ${s.pass + u.pass} passed / ${s.fails + u.fails} failed ===`);
  if (s.fails + u.fails > 0) process.exit(1);
}

main();

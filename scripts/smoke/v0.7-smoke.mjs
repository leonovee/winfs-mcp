// v0.7 wire-level smoke harness. Spawns the built server via stdio, drives
// JSON-RPC, runs a focused sweep over the v0.7 surfaces:
//   - wave 1 (ssh_exec, list_path_dirs, write_json)
//   - wave 2a (edit_file with_diff, grep pagination, execute_command hints)
//   - wave 2b (start_process / interact / list_process / kill_process)
//   - pre-tag bug-fix wave regressions (key P1 fixes wire-level confirm)
//
// Modeled on scripts/smoke/v0.6-smoke.mjs. Same exit-code semantics:
// process.exit(1) on any red. Strict + unrestricted passes (same as v0.6).
//
// Probes that test inner module state (e.g. AbortSignal listener counts) are
// out of scope for wire-level smoke — they're pinned by the unit tests in
// tests/unit/network/ + tests/unit/exec/. Smoke confirms the wire surface
// (correct error codes, correct response shape, correct registration).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const WINFS = "C:\\Users\\User\\Desktop\\ai\\tools\\winfs";
const SMOKE_DIR = path.join(WINFS, ".v07_smoke_dir");
const SMOKE_TMP = path.join(WINFS, ".v07_smoke_tmp.txt");
const EXPECTED_TOOL_COUNT = 37; // 30 (v0.6) + 3 (wave 1) + 4 (wave 2b)
const EXPECTED_VERSION = "0.7.2";

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

  const send = (method, params, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
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
    clientInfo: { name: "v0.7-smoke", version: "0.1.0" },
  });
  srv.notify("notifications/initialized", {});
  await new Promise((r) => setTimeout(r, 300));
  return init.result;
}

function ok(name, val) {
  return { name, pass: true, detail: val };
}
function fail(name, expected, got) {
  return { name, pass: false, expected, got };
}
function skip(name, reason) {
  return { name, pass: true, detail: `SKIPPED: ${reason}`, skipped: true };
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
async function call(srv, name, args, timeoutMs = 30000) {
  return srv.send("tools/call", { name, arguments: args }, timeoutMs);
}

async function setupSandbox() {
  try {
    await fs.mkdir(SMOKE_DIR, { recursive: true });
  } catch { /* ignore */ }
  await fs.writeFile(SMOKE_TMP, "hello v0.7", "utf8");
  await fs.writeFile(path.join(SMOKE_DIR, "edit.txt"), "first edit target\n", "utf8");
  await fs.writeFile(path.join(SMOKE_DIR, "page.txt"),
    Array.from({ length: 200 }, (_, i) => `line ${i + 1} match`).join("\n"), "utf8");
  await fs.writeFile(path.join(SMOKE_DIR, "data.json"), JSON.stringify({ from: "smoke" }), "utf8");
}

async function cleanupSandbox() {
  try {
    await fs.rm(SMOKE_TMP, { force: true });
  } catch { /* ignore */ }
  try {
    await fs.rm(SMOKE_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
  // Process registry cleanup tempfiles (start_process / interact tests
  // may leave .v07_proc_*.tmp in winfs root).
  try {
    const entries = await fs.readdir(WINFS);
    for (const e of entries) {
      if (e.startsWith(".v07_proc_")) {
        try { await fs.rm(path.join(WINFS, e), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ──────────────────────────────────────────────────────────────────────────
// PROBE GROUPS (each returns an array of result objects)
// ──────────────────────────────────────────────────────────────────────────

async function probesPreflight(srv) {
  const results = [];
  const init = await handshake(srv);
  results.push(
    init.serverInfo?.version === EXPECTED_VERSION
      ? ok("preflight: server version", init.serverInfo.version)
      : fail("preflight: server version", EXPECTED_VERSION, init.serverInfo?.version),
  );
  const tl = await srv.send("tools/list", {});
  const names = tl.result.tools.map((t) => t.name).sort();
  results.push(
    names.length === EXPECTED_TOOL_COUNT
      ? ok("preflight: tool count", `${names.length}`)
      : fail("preflight: tool count", `${EXPECTED_TOOL_COUNT}`, `${names.length}: ${names.join(", ")}`),
  );
  // Spot-check that wave-1 and wave-2b tools registered
  for (const want of ["ssh_exec", "list_path_dirs", "write_json", "start_process", "interact", "list_process", "kill_process"]) {
    results.push(
      names.includes(want)
        ? ok(`preflight: ${want} registered`, "yes")
        : fail(`preflight: ${want} registered`, "yes", "missing"),
    );
  }
  return results;
}

// ────── wave 1 ────────────────────────────────────────────────────────────

async function probesWave1(srv) {
  const results = [];

  // ssh_exec: EHOST_UNKNOWN for raw user@host (deterministic — ssh_exec
  // rejects that form up-front before invoking ssh -G). ssh -G actually
  // falls back to the literal alias when the host isn't in config, so
  // the unknown-host case isn't reliably triggerable through that path.
  let r = await call(srv, "ssh_exec", {
    host: "user@nonexistent.invalid",
    command: "echo hi",
    timeout_seconds: 5,
  });
  let e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EHOST_UNKNOWN" || e?.code === "ESSHNOTFOUND"
      ? ok("wave1: ssh_exec rejects user@host form", `${e.code}${e.code === "ESSHNOTFOUND" ? " (no ssh binary)" : ""}`)
      : fail("wave1: ssh_exec rejects user@host form", "EHOST_UNKNOWN or ESSHNOTFOUND", e ?? parseSuccessContent(r)),
  );

  // ssh_exec happy path → skipped (no real ssh host in smoke config)
  results.push(skip("wave1: ssh_exec happy", "no ssh host configured for smoke harness"));

  // list_path_dirs: non-empty array
  r = await call(srv, "list_path_dirs", {});
  let sc = parseSuccessContent(r);
  results.push(
    !isError(r) && Array.isArray(sc?.path_dirs) && sc.path_dirs.length > 0 && typeof sc?.total === "number"
      ? ok("wave1: list_path_dirs non-empty", `total=${sc.total}`)
      : fail("wave1: list_path_dirs non-empty", "non-empty array", isError(r) ? parseErrorContent(r) : sc),
  );

  // Consistency: every PATH dir from list_path_dirs should also be findable
  // via find_command for at least one known binary (git).
  r = await call(srv, "find_command", { name: "git", with_version: false });
  const findSc = parseSuccessContent(r);
  const gitDir = findSc?.found ? path.dirname(findSc.path) : null;
  results.push(
    gitDir && sc?.path_dirs?.some((p) => p.toLowerCase() === gitDir.toLowerCase())
      ? ok("wave1: list_path_dirs ⊇ find_command 'git' parent", `gitDir=${gitDir}`)
      : fail("wave1: list_path_dirs ⊇ find_command 'git' parent", "git dir present in path_dirs", { gitDir, path_dirs: sc?.path_dirs }),
  );

  // write_json: create new
  const jsonPath = path.join(SMOKE_DIR, "out.json");
  r = await call(srv, "write_json", {
    path: jsonPath,
    value: { hello: "world", n: 7 },
    overwrite: false,
    indent: 2,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.created === true && sc?.bytes_written > 0
      ? ok("wave1: write_json create", `bytes_written=${sc.bytes_written}, created=true`)
      : fail("wave1: write_json create", "created:true + bytes_written>0", isError(r) ? parseErrorContent(r) : sc),
  );

  // write_json: EEXIST when overwrite=false on existing
  r = await call(srv, "write_json", {
    path: jsonPath,
    value: { other: true },
    overwrite: false,
  });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EEXIST"
      ? ok("wave1: write_json EEXIST on existing", "EEXIST")
      : fail("wave1: write_json EEXIST on existing", "EEXIST", e ?? parseSuccessContent(r)),
  );

  // write_json: overwrite=true replaces
  r = await call(srv, "write_json", {
    path: jsonPath,
    value: { replaced: true },
    overwrite: true,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.created === false
      ? ok("wave1: write_json overwrite replaces", "created=false")
      : fail("wave1: write_json overwrite replaces", "ok + created:false", isError(r) ? parseErrorContent(r) : sc),
  );

  // write_json: EEXT_NOT_JSON on .txt path
  r = await call(srv, "write_json", {
    path: path.join(SMOKE_DIR, "not_json.txt"),
    value: { x: 1 },
    overwrite: true,
  });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EEXT_NOT_JSON"
      ? ok("wave1: write_json EEXT_NOT_JSON", "EEXT_NOT_JSON")
      : fail("wave1: write_json EEXT_NOT_JSON", "EEXT_NOT_JSON", e ?? parseSuccessContent(r)),
  );

  // write_json round-trip via read_json
  r = await call(srv, "read_json", { path: jsonPath });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.data?.replaced === true
      ? ok("wave1: write_json round-trip", "data.replaced=true")
      : fail("wave1: write_json round-trip", "data.replaced:true", isError(r) ? parseErrorContent(r) : sc),
  );

  return results;
}

// ────── wave 2a surface changes ───────────────────────────────────────────

async function probesWave2a(srv) {
  const results = [];

  // edit_file with_diff default true
  const editPath = path.join(SMOKE_DIR, "edit.txt");
  await fs.writeFile(editPath, "alpha beta gamma", "utf8");
  let r = await call(srv, "edit_file", {
    path: editPath,
    edits: [{ old_str: "alpha", new_str: "ALPHA" }],
    dry_run: true,
  });
  let sc = parseSuccessContent(r);
  results.push(
    !isError(r) && typeof sc?.diff === "string" && sc.diff.length > 0
      ? ok("wave2a: edit_file with_diff default", `diff len=${sc.diff.length}`)
      : fail("wave2a: edit_file with_diff default", "diff non-empty", isError(r) ? parseErrorContent(r) : sc),
  );

  // edit_file with_diff: false → diff empty
  r = await call(srv, "edit_file", {
    path: editPath,
    edits: [{ old_str: "alpha", new_str: "ALPHA" }],
    dry_run: true,
    with_diff: false,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.diff === ""
      ? ok("wave2a: edit_file with_diff=false suppresses", "diff=''")
      : fail("wave2a: edit_file with_diff=false suppresses", "diff:''", isError(r) ? parseErrorContent(r) : sc),
  );

  // grep pagination: default returns matches + total_matches
  r = await call(srv, "grep", {
    pattern: "match",
    path_glob: path.join(SMOKE_DIR, "*.txt"),
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && Array.isArray(sc?.matches) && typeof sc?.total_matches === "number" && sc.total_matches > 0
      ? ok("wave2a: grep default + total_matches", `total_matches=${sc.total_matches}`)
      : fail("wave2a: grep default + total_matches", "matches + total_matches>0", isError(r) ? parseErrorContent(r) : sc),
  );

  // grep pagination: explicit offset/limit (use *.txt glob — literal page.txt
  // path would set compileGlob base = file itself, which walkFiles can't enter)
  r = await call(srv, "grep", {
    pattern: "match",
    path_glob: path.join(SMOKE_DIR, "*.txt"),
    offset: 10,
    limit: 5,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.matches?.length === 5 && sc?.next_offset === 15 && sc?.total_matches === 200
      ? ok("wave2a: grep offset/limit slice", `5 matches, next_offset=15, total_matches=200`)
      : fail("wave2a: grep offset/limit slice", "5 matches + next_offset:15 + total_matches:200", isError(r) ? parseErrorContent(r) : sc),
  );

  // grep pagination: offset past end → empty + no next_offset
  r = await call(srv, "grep", {
    pattern: "match",
    path_glob: path.join(SMOKE_DIR, "*.txt"),
    offset: 9999,
    limit: 5,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.matches?.length === 0 && sc?.next_offset === undefined
      ? ok("wave2a: grep offset past end", "empty matches, no next_offset")
      : fail("wave2a: grep offset past end", "empty + next_offset absent", isError(r) ? parseErrorContent(r) : sc),
  );

  // execute_command hints: stderr without marker → hints absent
  r = await call(srv, "execute_command", {
    command: "Get-Date",
    args: [],
    cwd: WINFS,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.hints === undefined
      ? ok("wave2a: execute_command hints absent on clean stderr", "hints undefined")
      : fail("wave2a: execute_command hints absent on clean stderr", "hints absent", isError(r) ? parseErrorContent(r) : sc),
  );

  // execute_command hints: stderr with document-in-pipeline marker
  // Write-Error emits to stderr; we manually echo the marker through PowerShell.
  r = await call(srv, "execute_command", {
    command: "Write-Error 'Cannot run a document in the middle of a pipeline'; exit 0",
    args: [],
    cwd: WINFS,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && Array.isArray(sc?.hints) && sc.hints.length === 1
      ? ok("wave2a: execute_command hints fires on document-in-pipeline marker",
           `hints len=${sc.hints.length}, hint matches /Start-Process|ssh_exec/=${/Start-Process|ssh_exec|invoke the binary directly/.test(sc.hints[0])}`)
      : fail("wave2a: execute_command hints fires on document-in-pipeline marker",
             "hints.length=1 with new wording", isError(r) ? parseErrorContent(r) : sc),
  );

  return results;
}

// ────── wave 2b process control ───────────────────────────────────────────

async function probesWave2b(srv) {
  const results = [];

  // start_process happy: node -e prints 'hi' then exits 0
  let r = await call(srv, "start_process", {
    command: ["node", "-e", "console.log('hi'); process.exit(0)"],
    cwd: WINFS,
    timeout_seconds: 10,
  });
  let sc = parseSuccessContent(r);
  const happySid = sc?.session_id;
  results.push(
    !isError(r) && typeof happySid === "string" && happySid.length > 0
      ? ok("wave2b: start_process happy returns session_id", `sid=${happySid.slice(0, 8)}…`)
      : fail("wave2b: start_process happy returns session_id", "session_id present", isError(r) ? parseErrorContent(r) : sc),
  );

  // interact / poll for settle
  let settled = false;
  let exitCode = null;
  let stdoutSeen = "";
  let off = 0;
  for (let i = 0; i < 20 && !settled; i++) {
    r = await call(srv, "interact", {
      session_id: happySid,
      stdout_since: off,
      stderr_since: 0,
      max_wait_ms: 1000,
    });
    sc = parseSuccessContent(r);
    if (sc?.stdout) stdoutSeen += sc.stdout;
    if (typeof sc?.stdout_offset === "number") off = sc.stdout_offset;
    if (sc?.status && sc.status !== "running") {
      settled = true;
      exitCode = sc.exit_code;
      break;
    }
  }
  results.push(
    settled && exitCode === 0 && stdoutSeen.includes("hi")
      ? ok("wave2b: interact polls happy session to settle", `exit_code=0, saw 'hi'`)
      : fail("wave2b: interact polls happy session to settle", "settled exit_code=0 with 'hi' in stdout", { settled, exitCode, stdoutSeen }),
  );

  // list_process shows the settled session
  r = await call(srv, "list_process", {});
  sc = parseSuccessContent(r);
  const sessions = sc?.sessions ?? [];
  const happyInList = sessions.find((s) => s.session_id === happySid);
  results.push(
    happyInList && (happyInList.status === "exited" || happyInList.status === "killed") && typeof happyInList.exit_code === "number"
      ? ok("wave2b: list_process includes settled session with exit_code", `status=${happyInList.status}, exit_code=${happyInList.exit_code}`)
      : fail("wave2b: list_process includes settled session with exit_code", "settled + exit_code", happyInList ?? "missing"),
  );

  // start_process validation: cwd outside allowedRoots → EPERM_ROOT
  r = await call(srv, "start_process", {
    command: ["node", "-v"],
    cwd: "C:\\Windows",
    timeout_seconds: 5,
  });
  let e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EPERM_ROOT"
      ? ok("wave2b: start_process EPERM_ROOT on bad cwd", "EPERM_ROOT")
      : fail("wave2b: start_process EPERM_ROOT on bad cwd", "EPERM_ROOT", e ?? parseSuccessContent(r)),
  );

  // start_process: bogus binary → spawn_failed (via poll for status)
  r = await call(srv, "start_process", {
    command: ["this-binary-does-not-exist-zz"],
    cwd: WINFS,
    timeout_seconds: 5,
  });
  sc = parseSuccessContent(r);
  const bogusSid = sc?.session_id;
  if (bogusSid) {
    let bogusSettled = false;
    let bogusStatus = "running";
    for (let i = 0; i < 20 && !bogusSettled; i++) {
      r = await call(srv, "interact", {
        session_id: bogusSid,
        stdout_since: 0,
        stderr_since: 0,
        max_wait_ms: 200,
      });
      sc = parseSuccessContent(r);
      if (sc?.status && sc.status !== "running") {
        bogusSettled = true;
        bogusStatus = sc.status;
        break;
      }
    }
    results.push(
      bogusSettled && bogusStatus === "spawn_failed"
        ? ok("wave2b: start_process spawn_failed for bogus binary", `status=spawn_failed`)
        : fail("wave2b: start_process spawn_failed for bogus binary", "status=spawn_failed", { bogusSettled, bogusStatus }),
    );
  } else {
    results.push(fail("wave2b: start_process spawn_failed for bogus binary", "session_id present then poll", e ?? "no session_id"));
  }

  // interact: ENOSESSION for unknown id
  r = await call(srv, "interact", {
    session_id: "00000000-0000-4000-8000-000000000000",
    stdout_since: 0,
    stderr_since: 0,
    max_wait_ms: 100,
  });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "ENOSESSION"
      ? ok("wave2b: interact ENOSESSION on unknown id", "ENOSESSION")
      : fail("wave2b: interact ENOSESSION on unknown id", "ENOSESSION", e ?? parseSuccessContent(r)),
  );

  // kill_process: spawn long-running, kill, idempotent
  r = await call(srv, "start_process", {
    command: ["node", "-e", "setInterval(() => {}, 1000)"],
    cwd: WINFS,
    timeout_seconds: 30,
  });
  sc = parseSuccessContent(r);
  const longSid = sc?.session_id;
  if (longSid) {
    r = await call(srv, "kill_process", { session_id: longSid, force: true });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && (sc?.killed === true || sc?.was_already_settled === true)
        ? ok("wave2b: kill_process force=true on running", `killed=${sc?.killed}, was_already_settled=${sc?.was_already_settled}`)
        : fail("wave2b: kill_process force=true on running", "killed:true", isError(r) ? parseErrorContent(r) : sc),
    );

    // Idempotent: second kill returns was_already_settled
    r = await call(srv, "kill_process", { session_id: longSid, force: false });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.was_already_settled === true
        ? ok("wave2b: kill_process idempotent", "was_already_settled=true")
        : fail("wave2b: kill_process idempotent", "was_already_settled:true", isError(r) ? parseErrorContent(r) : sc),
    );
  } else {
    results.push(fail("wave2b: kill_process setup", "session_id from start_process", parseErrorContent(r)));
  }

  // Concurrency cap (16). Skip — would launch 16 real subprocesses;
  // expensive and Windows-flaky test territory. Pinned by unit tests.
  results.push(skip("wave2b: concurrency cap EBUSY at 17th", "pinned by unit test; smoke would spawn 16 real subprocesses"));

  return results;
}

// ────── bugfix wave regressions (wire-level) ──────────────────────────────

async function probesBugfix(srv) {
  const results = [];

  // v0.7.1 hotfix probe — execute_command stdout capture (bug #2 since
  // project start). Pre-v0.7.1 the operational note in CLAUDE.md said
  // `execute_command` returned empty stdout for external .exe invocations
  // via `& 'path' args`. This probe pins the actual server-side wire
  // contract: stdout MUST come back non-empty for a known external exe
  // (node --version → `v<major>.<minor>.<patch>`). If a future change
  // breaks the capture pipeline, this probe goes red.
  let r = await call(srv, "execute_command", {
    command: "node --version",
    args: [],
    cwd: WINFS,
  });
  let sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.exit_code === 0 && /^v\d+\.\d+\.\d+/.test(sc?.stdout ?? "")
      ? ok("bugfix v0.7.1: execute_command stdout capture for node --version",
           `stdout=${(sc.stdout ?? "").slice(0, 30).replace(/\n/g, "\\n")}…`)
      : fail("bugfix v0.7.1: execute_command stdout capture for node --version",
             "exit_code:0 + stdout matches /^v\\d+\\./",
             isError(r) ? parseErrorContent(r) : sc),
  );

  // Same probe via direct & 'path' invocation (the form that the historical
  // CLAUDE.md note specifically called out).
  r = await call(srv, "execute_command", {
    command: "& 'C:\\Program Files\\Git\\cmd\\git.exe' --version",
    args: [],
    cwd: WINFS,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.exit_code === 0 && /^git version /.test(sc?.stdout ?? "")
      ? ok("bugfix v0.7.1: execute_command stdout capture for direct git path",
           `stdout=${(sc.stdout ?? "").slice(0, 40).replace(/\n/g, "\\n")}…`)
      : fail("bugfix v0.7.1: execute_command stdout capture for direct git path",
             "exit_code:0 + stdout matches /^git version /",
             isError(r) ? parseErrorContent(r) : sc),
  );

  // exec_safety blocklist: -EncodedCommand bypass
  r = await call(srv, "execute_command", {
    command: "powershell -EncodedCommand RABhAHQAZQA=",
    args: [],
    cwd: WINFS,
  });
  let e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EBLOCKED"
      ? ok("bugfix: exec blocklist -EncodedCommand", `EBLOCKED (pattern=${e.details?.pattern?.slice(0, 60)}…)`)
      : fail("bugfix: exec blocklist -EncodedCommand", "EBLOCKED", e ?? parseSuccessContent(r)),
  );

  // exec_safety blocklist: rm -r
  r = await call(srv, "execute_command", {
    command: "rm -r C:\\foo",
    args: [],
    cwd: WINFS,
  });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EBLOCKED"
      ? ok("bugfix: exec blocklist rm -r", `EBLOCKED (pattern=${e.details?.pattern})`)
      : fail("bugfix: exec blocklist rm -r", "EBLOCKED", e ?? parseSuccessContent(r)),
  );

  // exec_safety aborted flag: spawn long-running via execute_command,
  // confirm timeout path uses `timed_out: true` (not `aborted: true`). The
  // dedicated aborted-vs-timed_out distinction is tested at the
  // spawnSubprocess unit level; wire-level we confirm timed_out surfaces.
  r = await call(srv, "execute_command", {
    command: "Start-Sleep -Seconds 30",
    args: [],
    cwd: WINFS,
    timeout_ms: 1500,
  });
  sc = parseSuccessContent(r);
  results.push(
    !isError(r) && sc?.timed_out === true
      ? ok("bugfix: execute_command timed_out wire-surface", "timed_out=true")
      : fail("bugfix: execute_command timed_out wire-surface", "timed_out:true", isError(r) ? parseErrorContent(r) : sc),
  );

  // edit_file EUNIQUE hint: i=0 with occ=0 → absence hint
  const ePath = path.join(SMOKE_DIR, "edit_hint.txt");
  await fs.writeFile(ePath, "hello world", "utf8");
  r = await call(srv, "edit_file", {
    path: ePath,
    edits: [{ old_str: "nonexistent", new_str: "x", expected_count: 1 }],
  });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EUNIQUE" && /spelling|whitespace/i.test(e.hint ?? "") && !/earlier edit/i.test(e.hint ?? "")
      ? ok("bugfix: edit_file EUNIQUE i=0 absence-hint", "hint matches /spelling|whitespace/ + no 'earlier edit'")
      : fail("bugfix: edit_file EUNIQUE i=0 absence-hint", "spelling/whitespace hint without 'earlier edit'", e ?? "no error"),
  );

  // grep deadline race: the post-fix property is that with timeout_ms ≥
  // OUTER_TIMEOUT_BUFFER_MS (2000), the inner deadline always fires
  // BUFFER_MS before the outer, returning the partial-result path. With a
  // small timeout (< BUFFER_MS) both deadlines still collapse — that's
  // documented behavior (the inner can't get a buffer larger than the
  // requested deadline). Pinned more carefully by the unit test in
  // tests/unit/search/grep_defensive_guards.test.ts.
  //
  // Wire-level smoke: confirm a small-but-buffer-aware timeout (3 s with
  // a moderate corpus) doesn't surface ETIMEDOUT.
  r = await call(srv, "grep", {
    pattern: "x",
    path_glob: path.join(WINFS, "src", "**", "*.ts"),
    timeout_ms: 3000,
  }, 10000);
  sc = parseSuccessContent(r);
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    !isError(r)
      ? ok("bugfix: grep deadline race — no ETIMEDOUT wrapper at timeout_ms=3000",
           sc?.truncated ? `truncated:true reason:${sc.reason}` : "completed in time")
      : fail("bugfix: grep deadline race — no ETIMEDOUT wrapper at timeout_ms=3000", "no ETIMEDOUT", e),
  );

  // grep negative context_lines (impl-level guard); Zod rejects at schema
  // boundary so wire-level returns a different error code. Send via
  // raw tool-call to confirm the validation fires.
  r = await call(srv, "grep", {
    pattern: "x",
    path_glob: path.join(SMOKE_DIR, "*.txt"),
    context_lines: -1,
  });
  // Zod errors come back as isError:true with content; the actual code may
  // be a Zod validation error rather than EINVAL on wire. Either path
  // counts as "rejected" — pre-fix would have wrapped the issue and proceeded.
  results.push(
    isError(r)
      ? ok("bugfix: grep negative context_lines rejected at wire surface", "isError:true")
      : fail("bugfix: grep negative context_lines rejected", "isError:true", parseSuccessContent(r)),
  );

  // grep wildcards-only base assert
  r = await call(srv, "grep", {
    pattern: "x",
    path_glob: "**/*.ts",
  });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EINVAL" || isError(r)
      ? ok("bugfix: grep wildcards-only base rejected", e?.code ?? "rejected")
      : fail("bugfix: grep wildcards-only base rejected", "EINVAL or rejected", parseSuccessContent(r)),
  );

  // fetch_url: protocol downgrade test would require an externally-controlled
  // HTTPS server returning a 302 to http://. Out of smoke scope; pinned by
  // unit test (tests/unit/network/fetch_url_redirect_downgrade.test.ts).
  results.push(skip("bugfix: fetch_url HTTPS→HTTP downgrade", "requires controlled HTTPS server; unit test covers"));

  // fetch_url: isInternalIP coverage — testable via IP-literal URL with
  // whitelist override (route blocked at internal-IP layer). We use
  // fe90::1 which the post-fix isInternalIP correctly catches.
  r = await call(srv, "fetch_url", { url: "http://[fe90::1]/" });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EHOSTNOTALLOWED"
      ? ok("bugfix: fetch_url fe90::1 blocked at SSRF layer", "EHOSTNOTALLOWED")
      : fail("bugfix: fetch_url fe90::1 blocked at SSRF layer", "EHOSTNOTALLOWED", e ?? parseSuccessContent(r)),
  );

  // fetch_url: ::ffff:c0a8:0101 IPv4-mapped IPv6 blocked
  r = await call(srv, "fetch_url", { url: "http://[::ffff:c0a8:0101]/" });
  e = isError(r) ? parseErrorContent(r) : null;
  results.push(
    e?.code === "EHOSTNOTALLOWED"
      ? ok("bugfix: fetch_url ::ffff:c0a8:0101 blocked at SSRF layer", "EHOSTNOTALLOWED")
      : fail("bugfix: fetch_url ::ffff:c0a8:0101 blocked at SSRF layer", "EHOSTNOTALLOWED", e ?? parseSuccessContent(r)),
  );

  // fetch_url: final_url redaction — fetch a real URL with a query string
  // (raw.githubusercontent.com is whitelisted). Confirm final_url does NOT
  // contain the query token.
  r = await call(srv, "fetch_url", {
    url: "https://raw.githubusercontent.com/leonovee/winfs-mcp/main/package.json?token=smoke-test-token",
  });
  sc = parseSuccessContent(r);
  if (!isError(r)) {
    results.push(
      sc?.final_url && !sc.final_url.includes("smoke-test-token")
        ? ok("bugfix: fetch_url final_url redacts query", `final_url=${sc.final_url}`)
        : fail("bugfix: fetch_url final_url redacts query", "no 'smoke-test-token' in final_url", sc?.final_url),
    );
  } else {
    // Network failures shouldn't fail the smoke run — log as skipped.
    results.push(skip("bugfix: fetch_url final_url redacts query", `fetch failed (network?): ${parseErrorContent(r)?.code}`));
  }

  // exec_hints text matches new wording (no "try cmd" advice)
  r = await call(srv, "execute_command", {
    command: "Write-Error 'Cannot run a document in the middle of a pipeline'; exit 0",
    args: [],
    cwd: WINFS,
  });
  sc = parseSuccessContent(r);
  const hintText = sc?.hints?.[0] ?? "";
  results.push(
    /Start-Process|ssh_exec|invoke the binary directly/i.test(hintText) && !/try.*cmd/i.test(hintText)
      ? ok("bugfix: exec_hints new wording", `matches Start-Process|ssh_exec; no 'try cmd'`)
      : fail("bugfix: exec_hints new wording", "Start-Process/ssh_exec wording, no 'try cmd'", hintText),
  );

  return results;
}

// ──────────────────────────────────────────────────────────────────────────

async function runStrictPass() {
  console.log("\n========== STRICT-MODE PASS ==========");
  const srv = spawnServer(path.join(WINFS, "configs", "local.json"));
  const allResults = [];
  try {
    allResults.push(...(await probesPreflight(srv)));
    await setupSandbox();
    allResults.push(...(await probesWave1(srv)));
    allResults.push(...(await probesWave2a(srv)));
    allResults.push(...(await probesWave2b(srv)));
    allResults.push(...(await probesBugfix(srv)));
  } finally {
    await srv.stop();
  }
  return allResults;
}

async function runUnrestrictedPass() {
  console.log("\n========== UNRESTRICTED-MODE PASS ==========");
  const baseCfg = JSON.parse(await fs.readFile(path.join(WINFS, "configs", "local.json"), "utf8"));
  const unrestrictedCfg = {
    ...baseCfg,
    unrestrictedFilesystem: true,
    unrestrictedFilesystemConfirm: "I-UNDERSTAND-THE-RISK",
  };
  const cfgPath = path.join(WINFS, "configs", "local-unrestricted-v07.json");
  await fs.writeFile(cfgPath, JSON.stringify(unrestrictedCfg, null, 2), "utf8");

  const srv = spawnServer(cfgPath);
  const results = [];
  try {
    const init = await handshake(srv);
    const stderr = srv.stderrText();
    results.push(
      stderr.includes("UNRESTRICTED FILESYSTEM MODE")
        ? ok("unrestricted: ⚠️ banner present", "matched")
        : fail("unrestricted: ⚠️ banner present", "banner in stderr", stderr.slice(0, 300)),
    );
    results.push(
      /ready \(allowedRoots=\d+, mode=unrestricted\)/.test(stderr)
        ? ok("unrestricted: ready line", "matched")
        : fail("unrestricted: ready line", "match", stderr.slice(0, 300)),
    );
    const tl = await srv.send("tools/list", {});
    results.push(
      tl.result.tools.length === EXPECTED_TOOL_COUNT
        ? ok("unrestricted: tool count", `${EXPECTED_TOOL_COUNT}`)
        : fail("unrestricted: tool count", `${EXPECTED_TOOL_COUNT}`, `${tl.result.tools.length}`),
    );

    // Read outside roots succeeds
    let r = await call(srv, "read", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" });
    let sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.content?.length > 0
        ? ok("unrestricted: read outside roots succeeds", `bytes=${sc.bytes_returned}`)
        : fail("unrestricted: read outside roots succeeds", "ok + non-empty", isError(r) ? parseErrorContent(r) : sc),
    );

    // Exec blocklist still fires
    r = await call(srv, "execute_command", {
      command: "rm -rf C:\\",
      args: [],
      cwd: WINFS,
    });
    let e = isError(r) ? parseErrorContent(r) : null;
    results.push(
      e?.code === "EBLOCKED"
        ? ok("unrestricted: exec blocklist still fires", "EBLOCKED")
        : fail("unrestricted: exec blocklist still fires", "EBLOCKED", e ?? parseSuccessContent(r)),
    );

    // SSRF still fires
    r = await call(srv, "fetch_url", { url: "http://127.0.0.1/" });
    e = isError(r) ? parseErrorContent(r) : null;
    results.push(
      e?.code === "EHOSTNOTALLOWED"
        ? ok("unrestricted: SSRF still fires", "EHOSTNOTALLOWED")
        : fail("unrestricted: SSRF still fires", "EHOSTNOTALLOWED", e ?? parseSuccessContent(r)),
    );

    // SSRF bugfix carries to unrestricted: fe90::1 still blocked
    r = await call(srv, "fetch_url", { url: "http://[fe90::1]/" });
    e = isError(r) ? parseErrorContent(r) : null;
    results.push(
      e?.code === "EHOSTNOTALLOWED"
        ? ok("unrestricted: fe90::1 still blocked", "EHOSTNOTALLOWED")
        : fail("unrestricted: fe90::1 still blocked", "EHOSTNOTALLOWED", e ?? parseSuccessContent(r)),
    );

    // wave-1 tool still works in unrestricted
    r = await call(srv, "list_path_dirs", {});
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && sc?.total > 0
        ? ok("unrestricted: list_path_dirs works", `total=${sc.total}`)
        : fail("unrestricted: list_path_dirs works", "total>0", isError(r) ? parseErrorContent(r) : sc),
    );

    // wave-2b: start_process works
    r = await call(srv, "start_process", {
      command: ["node", "-e", "console.log('u-mode'); process.exit(0)"],
      cwd: WINFS,
      timeout_seconds: 5,
    });
    sc = parseSuccessContent(r);
    results.push(
      !isError(r) && typeof sc?.session_id === "string"
        ? ok("unrestricted: start_process works", `sid=${sc.session_id.slice(0, 8)}…`)
        : fail("unrestricted: start_process works", "session_id present", isError(r) ? parseErrorContent(r) : sc),
    );
  } finally {
    await srv.stop();
    try { await fs.rm(cfgPath); } catch { /* ignore */ }
  }
  return results;
}

function printReport(label, results) {
  console.log(`\n--- ${label} ---`);
  let pass = 0, fails = 0, skipped = 0;
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⊘ ${r.name} — ${r.detail}`);
      skipped++;
      pass++; // skipped counts as pass for exit-code purposes
    } else if (r.pass) {
      console.log(`  ✓ ${r.name} — ${r.detail}`);
      pass++;
    } else {
      console.log(`  ✗ ${r.name}`);
      console.log(`      expected: ${typeof r.expected === "object" ? JSON.stringify(r.expected) : r.expected}`);
      console.log(`      got:      ${typeof r.got === "object" ? JSON.stringify(r.got) : r.got}`);
      fails++;
    }
  }
  console.log(`\nTotal: ${pass + fails}, passed: ${pass} (${skipped} skipped), failed: ${fails}`);
  return { pass, fails, skipped };
}

async function main() {
  const t0 = Date.now();
  console.log("v0.7 wire-level smoke harness");
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
  const totalPass = s.pass + u.pass;
  const totalFail = s.fails + u.fails;
  const totalSkip = s.skipped + u.skipped;
  const totalCount = totalPass + totalFail;
  const dur = Date.now() - t0;
  console.log(`\n=== OVERALL: ${totalPass}/${totalCount} probes green (strict ${s.pass}/${s.pass + s.fails}, unrestricted ${u.pass}/${u.pass + u.fails})`);
  console.log(`    skipped: ${totalSkip}`);
  console.log(`    duration: ${dur}ms`);
  if (totalFail > 0) process.exit(1);
}

main();

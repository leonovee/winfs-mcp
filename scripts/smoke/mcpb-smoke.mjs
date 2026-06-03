#!/usr/bin/env node
// MCPB bundle smoke. Extracts the ACTUAL packed dist-mcpb/winfs-<version>.mcpb
// to a clean temp dir and drives the bundled launcher exactly as Claude
// Desktop would: spawn `node server/launch.mjs` with the same argv/env the
// host substitutes from manifest user_config, then handshake + tools/list +
// real tool calls. This proves three things the manifest validator cannot:
//   1. the archive is intact (no over-aggressive .mcpbignore pruning of a dep);
//   2. the launcher maps install-time config → the server's --config correctly;
//   3. allowedRoots is enforced through the bundled path (refusal works).
//
// It also asserts the launcher's defensive handling of UNSUBSTITUTED optional
// fields: we pass `${user_config.sshExePath}` / `${user_config.execExtraPathDirs}`
// verbatim (what a host sends when the operator leaves an optional field blank)
// and confirm they are dropped, not written into the generated config.
//
// Exit 0 = all green; exit 1 = any red. Requires `npm run mcpb` first.

import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const MCPB = path.join(ROOT, "dist-mcpb", `winfs-${VERSION}.mcpb`);

const results = [];
const ok = (name, detail) => results.push({ name, pass: true, detail });
const fail = (name, expected, got) => results.push({ name, pass: false, expected, got });

function jsonRpcClient(child) {
  let buf = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id).resolve(msg);
          pending.delete(msg.id);
        }
      } catch { /* non-JSON stderr leak; ignore */ }
    }
  });
  return {
    send(method, params, timeoutMs = 20000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
        pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

async function main() {
  // 0. Locate the artifact.
  try { await fs.access(MCPB); }
  catch { fail("artifact present", MCPB, "missing — run `npm run mcpb` first"); return; }
  ok("artifact present", path.basename(MCPB));

  // 1. Extract the real archive with bundled bsdtar (handles zip on Win10).
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-mcpb-smoke-"));
  const unpack = path.join(work, "unpack");
  await fs.mkdir(unpack, { recursive: true });
  execFileSync("tar", ["-xf", MCPB, "-C", unpack], { stdio: "ignore" });
  const launcher = path.join(unpack, "server", "launch.mjs");
  try { await fs.access(launcher); ok("archive intact: server/launch.mjs", "found"); }
  catch { fail("archive intact: server/launch.mjs", "found", "missing in archive"); return; }
  // The SDK must have survived .mcpbignore pruning.
  try {
    await fs.access(path.join(unpack, "server", "node_modules", "@modelcontextprotocol", "sdk", "package.json"));
    ok("archive intact: bundled @modelcontextprotocol/sdk", "found");
  } catch { fail("archive intact: bundled @modelcontextprotocol/sdk", "found", "missing — .mcpbignore over-pruned"); return; }

  // 2. A real allowed root + an in-root file with a unique marker.
  const testRoot = path.join(work, "root");
  await fs.mkdir(testRoot, { recursive: true });
  const marker = `winfs-mcpb-ok-${VERSION}`;
  await fs.writeFile(path.join(testRoot, "in.txt"), marker, "utf8");

  // 3. Spawn the launcher the way Claude Desktop does. allowedRoots expands to
  //    a single argv token (one root). Optional fields the operator left blank
  //    arrive as the literal placeholder — the launcher must drop them.
  const child = spawn("node.exe", [
    launcher,
    "--roots", testRoot,
    "--extra-path-dirs", "${user_config.execExtraPathDirs}",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      LOCALAPPDATA: work, // sandbox the generated mcpb-config.json into temp
      WINFS_SSH_EXE_PATH: "${user_config.sshExePath}",
      WINFS_POWERSHELL_EXE_PATH: "${user_config.powershellExePath}",
      WINFS_PYTHON_HOME: "${user_config.pythonHome}",
      WINFS_UNRESTRICTED: "false",
      WINFS_UNRESTRICTED_CONFIRM: "${user_config.unrestrictedFilesystemConfirm}",
    },
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  const rpc = jsonRpcClient(child);

  try {
    // 4. Handshake.
    const init = await rpc.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcpb-smoke", version: "1.0.0" },
    });
    rpc.notify("notifications/initialized", {});
    const v = init.result?.serverInfo?.version;
    v === VERSION ? ok("server starts: version", v) : fail("server starts: version", VERSION, v);

    // 5. Tool surface intact.
    const tl = await rpc.send("tools/list", {});
    const names = (tl.result?.tools ?? []).map((t) => t.name);
    names.length === 39 ? ok("tools/list count", "39") : fail("tools/list count", "39", `${names.length}`);

    // 6. allowedRoots honored: the generated config exposes our temp root.
    const lad = await rpc.send("tools/call", { name: "list_allowed_directories", arguments: {} });
    let roots = lad.result?.structuredContent?.allowed_roots;
    if (!Array.isArray(roots)) {
      try { roots = JSON.parse(lad.result.content[0].text).allowed_roots; } catch { /* */ }
    }
    const rootSeen = Array.isArray(roots) && roots.some((p) => p === testRoot || p === testRoot.replace(/\\/g, "/"));
    rootSeen ? ok("allowedRoots wired from user_config", "root present")
             : fail("allowedRoots wired from user_config", testRoot, JSON.stringify(roots));

    // 7. Read inside root → success + marker.
    const rIn = await rpc.send("tools/call", { name: "read", arguments: { path: path.join(testRoot, "in.txt") } });
    const inOk = rIn.result?.isError !== true && (rIn.result?.structuredContent?.content ?? "").includes(marker);
    inOk ? ok("read inside root succeeds", "marker matched")
         : fail("read inside root succeeds", marker, JSON.stringify(rIn.result).slice(0, 200));

    // 8. Read outside root → EPERM_ROOT (enforcement NOT bypassed).
    const rOut = await rpc.send("tools/call", { name: "read", arguments: { path: "C:\\Windows\\win.ini" } });
    let code = null;
    try { code = JSON.parse(rOut.result.content[0].text).code; } catch { /* */ }
    code === "EPERM_ROOT" ? ok("read outside root refused", "EPERM_ROOT")
                          : fail("read outside root refused", "EPERM_ROOT", `${code} / ${JSON.stringify(rOut.result).slice(0,150)}`);
  } finally {
    try { child.kill(); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  // 9. Defensive config mapping: generated config has our root, NO sshExePath,
  //    NO execExtraPathDirs (both were unsubstituted placeholders), strict mode.
  try {
    const gen = JSON.parse(await fs.readFile(path.join(work, "mcp-winfs", "mcpb-config.json"), "utf8"));
    const clean =
      Array.isArray(gen.allowedRoots) && gen.allowedRoots.includes(testRoot) &&
      gen.sshExePath === undefined &&
      gen.execExtraPathDirs === undefined &&
      gen.unrestrictedFilesystem !== true;
    clean ? ok("launcher drops unsubstituted optionals", "config clean")
          : fail("launcher drops unsubstituted optionals", "no placeholder keys + root present", JSON.stringify(gen));
  } catch (e) {
    fail("generated mcpb-config.json present", "readable", String(e));
  }

  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
}

await main();

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  process.stdout.write(`${r.pass ? "  ✓" : "  ✗"} ${r.name}${r.pass ? ` — ${r.detail}` : ` — expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.got)}`}\n`);
}
process.stdout.write(`\n=== MCPB bundle smoke: ${passed}/${results.length} green ===\n`);
process.exit(failed.length === 0 ? 0 : 1);

// v0.9 #3 transport-hang correlation tool.
//
// Joins the winfs-side transport metadata log (WINFS_TRANSPORT_LOG) with Claude
// Desktop's own MCP log by JSON-RPC request id, and prints the 4-point timeline
//   t1 CD-dispatch -> t2 winfs-RECV -> t3 winfs-SEND -> t4 CD-receive
// with per-leg latency, flagging any leg above a threshold. This localizes
// which leg of the stdio transport carries a multi-second stall.
//
// Usage:
//   node scripts/analyze-transport-hang.mjs <winfs-transport.log> <cd-mcp-winfs.log> [thresholdMs]
//
// The CD log may be either the per-server file (mcp-server-winfs.log) or the
// combined mcp.log (lines are filtered to those mentioning winfs). Both logs
// share the same system clock (CD spawns winfs locally), so timestamps are
// directly comparable.

import { readFileSync } from "node:fs";

const [, , winfsPath, cdPath, thresholdArg] = process.argv;
if (!winfsPath || !cdPath) {
  console.error(
    "usage: node scripts/analyze-transport-hang.mjs <winfs-transport.log> <cd-mcp-winfs.log> [thresholdMs]",
  );
  process.exit(2);
}
const THRESHOLD_MS = Number(thresholdArg) || 5000;

const ms = (iso) => Date.parse(iso);

// ── parse the winfs-side metadata log ───────────────────────────────────────
// Lines: "<iso> RECV <id> <method> <bytes>" / "<iso> SEND <id> <status> <bytes> <dur>"
function parseWinfs(text) {
  const recv = new Map(); // id -> { ts, method, bytes }
  const send = new Map(); // id -> { ts, status, bytes, dur }
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const [ts, kind, id, a, b, c] = p;
    if (kind === "RECV") recv.set(id, { ts, method: a, bytes: Number(b) });
    else if (kind === "SEND") send.set(id, { ts, status: a, bytes: Number(b), dur: c });
  }
  return { recv, send };
}

// ── parse Claude Desktop's MCP log ──────────────────────────────────────────
// Lines: "<iso> ... Message from client|server: <json>"
function parseCd(text) {
  const client = new Map(); // id -> ts (CD dispatched the request)
  const server = new Map(); // id -> ts (CD received the response)
  const re = /^(\S+)\s.*Message from (client|server):\s*(\{.*\})\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const [, ts, dir, json] = m;
    let id;
    try {
      id = JSON.parse(json).id;
    } catch {
      continue; // truncated/garbled line — skip
    }
    if (id === undefined || id === null) continue; // notification — no id to join on
    (dir === "client" ? client : server).set(String(id), ts);
  }
  return { client, server };
}

const winfs = parseWinfs(readFileSync(winfsPath, "utf8"));
const cd = parseCd(readFileSync(cdPath, "utf8"));

// Union of every id seen anywhere, ordered by the earliest known timestamp.
const ids = new Set([
  ...winfs.recv.keys(),
  ...winfs.send.keys(),
  ...cd.client.keys(),
  ...cd.server.keys(),
]);

const rows = [];
for (const id of ids) {
  const t1 = cd.client.get(id); // CD-dispatch
  const t2 = winfs.recv.get(id)?.ts; // winfs-RECV
  const t3 = winfs.send.get(id)?.ts; // winfs-SEND
  const t4 = cd.server.get(id); // CD-receive
  const leg = (a, b) => (a && b ? ms(b) - ms(a) : null);
  rows.push({
    id,
    method: winfs.recv.get(id)?.method ?? "-",
    bytesOut: winfs.send.get(id)?.bytes ?? null,
    t1, t2, t3, t4,
    inbound: leg(t1, t2),
    process: leg(t2, t3),
    outbound: leg(t3, t4),
    procDur: winfs.send.get(id)?.dur ?? null,
  });
}
rows.sort((a, b) => {
  const ka = ms(a.t1 ?? a.t2 ?? a.t3 ?? a.t4 ?? "");
  const kb = ms(b.t1 ?? b.t2 ?? b.t3 ?? b.t4 ?? "");
  return (ka || 0) - (kb || 0);
});

const fmt = (v) => (v === null || v === undefined ? "    —" : String(v).padStart(7));
const flag = (v) => (typeof v === "number" && v >= THRESHOLD_MS ? " <== STALL" : "");

console.log(`# transport-hang correlation (threshold ${THRESHOLD_MS} ms)`);
console.log(`# winfs: ${winfsPath}`);
console.log(`# CD:    ${cdPath}\n`);
console.log(
  ["id", "method", "bytesOut", "inbound", "process", "outbound", "flags"].join("\t"),
);
let stalls = 0;
for (const r of rows) {
  const reached = r.t2 ? "" : " [never reached winfs]";
  const responded = r.t2 && !r.t3 ? " [winfs never SENT — contradicts P3]" : "";
  const f =
    flag(r.inbound).replace("STALL", "INBOUND-STALL") +
    flag(r.process).replace("STALL", "PROCESS-STALL") +
    flag(r.outbound).replace("STALL", "OUTBOUND-STALL") +
    reached +
    responded;
  if (f.includes("STALL") || reached || responded) stalls++;
  console.log(
    [
      r.id,
      r.method,
      fmt(r.bytesOut),
      fmt(r.inbound),
      fmt(r.process),
      fmt(r.outbound),
      f.trim(),
    ].join("\t"),
  );
}
console.log(
  `\n${rows.length} request(s) correlated; ${stalls} flagged at/over ${THRESHOLD_MS} ms (or anomalous).`,
);

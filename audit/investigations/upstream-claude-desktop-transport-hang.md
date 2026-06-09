# Upstream bug report — Claude Desktop: MCP tool calls intermittently die in the dispatch layer (silent 4-minute limbo, all servers at once)

**For filing with Anthropic.** Self-contained; evidence excerpts inline,
bodies redacted. Full logs available on request. Investigation history:
`audit/investigations/v0.9-transport-hang.md` in
<https://github.com/leonovee/winfs-mcp>.

---

## Summary

Claude Desktop intermittently stops delivering MCP `tools/call` requests to
local stdio servers. The call hangs client-side for exactly ~4 minutes, then
surfaces *"No result received from the Claude Desktop app after waiting 4
minutes."* Both-side logging (Claude Desktop's own MCP logs **and**
metadata-level wire logging inside the server) shows the hung call **never
reaches Claude Desktop's per-server MCP client layer** — there is no
`Message from client` line in CD's log and no read on the child's stdin. The
server is demonstrably alive and answering in single-digit milliseconds
minutes before the wedge. When it happens, **all enabled MCP servers and
Claude-in-Chrome wedge simultaneously**, and only a full app exit (tray →
Exit) recovers. The stall therefore lives **inside Claude Desktop, in the
shared dispatch layer above the per-server MCP clients** — before per-server
logging, before the stdio pipe, before the server.

## Environment

| Item | Value |
|---|---|
| Claude Desktop | 1.11847.5.0 x64, MSIX install (`Claude_1.11847.5.0_x64__pzs8sxrjxfjjc`) |
| OS | Windows 10 Pro, build 19045 |
| MCP client / protocol | `claude-ai 0.1.0`, protocol `2025-11-25` |
| Enabled MCP servers | 3 local stdio: `winfs` (winfs-mcp v1.0.1 on system Node v24.15.0), `Desktop Commander`, `pdf-viewer` (built-in Node) |
| Server-side logging | `WINFS_TRANSPORT_LOG` (metadata only: timestamp, id, method, bytes, duration — never bodies) |
| Capture date | 2026-06-09 → 2026-06-10 (timestamps below in UTC) |

## Symptom

- Intermittent: a `tools/call` from a chat session hangs ~4 minutes, then the
  client reports *"No result received from the Claude Desktop app after
  waiting 4 minutes."* Sometimes 2–3 such timeouts in a row on the same call.
- When it strikes, **every** MCP server wedges at once (winfs, Desktop
  Commander), and Claude-in-Chrome sessions stall in the same window.
- No in-app recovery: retries hang again. Only a full application exit via
  the system tray (Exit, not closing the window) clears it. First calls
  after relaunch succeed instantly.
- Tends to appear after sustained use (long sessions, multiple windows); a
  freshly restarted app works.

## Evidence — both-side logs for the captured hang

The server (winfs-mcp) writes a metadata-only wire log: `RECV <id> <method>
<bytes>` when a request is read off stdin, `SEND <id> <status> <bytes>
<duration-ms>` when the response is about to be written to stdout. Claude
Desktop's own `mcp-server-winfs.log` logs `Message from client` /
`Message from server` per delivery. Both processes share the system clock —
timestamps are directly comparable.

### The last thing that ever worked

Server wire log (verbatim, metadata only):

```
2026-06-09T23:18:51.932Z RECV 0 initialize 245
2026-06-09T23:18:51.934Z SEND 0 ok 164 2
2026-06-09T23:18:52.325Z RECV - notifications/initialized 54
2026-06-09T23:18:52.326Z RECV 1 tools/list 58
2026-06-09T23:18:52.335Z SEND 1 ok 92812 9
2026-06-09T23:23:34.468Z RECV 2 tools/call 5901
2026-06-09T23:23:34.473Z SEND 2 ok 229 5
<EOF — nothing further, ever>
```

Claude Desktop's own log agrees (bodies redacted):

```
2026-06-09T23:18:51.545Z [winfs] [info] Initializing server...
2026-06-09T23:18:51.574Z [winfs] [info] Server started and connected successfully
2026-06-09T23:18:51.656Z [winfs] [info] Message from client: {"method":"initialize",…,"id":0}
2026-06-09T23:18:51.934Z [winfs] [info] Message from server: {"id":0,…"serverInfo":{"name":"winfs-mcp","version":"1.0.1"}}
2026-06-09T23:18:52.323Z [winfs] [info] Message from client: {"method":"tools/list",…,"id":1}
2026-06-09T23:18:52.337Z [winfs] [info] Message from server: {"id":1,"result":{"tools":[…]}}
2026-06-09T23:23:34.467Z [winfs] [info] Message from client: {"method":"tools/call","params":{"name":"write",…},"id":2}
2026-06-09T23:23:34.473Z [winfs] [info] Message from server: {"id":2,"result":{…"bytes_written":5637…}}
<EOF>
```

After a full app restart at 23:18:51, the server answered `initialize` in
**2 ms**, `tools/list` (a 92 KB response) in **9 ms**, and one `tools/call`
(`write`, ~5.9 KB request) at 23:23:34 in **5 ms**. That `write` is the last
message either side ever logged.

### The hang

On 2026-06-10 (later the same night, local time UTC+3), the chat session
issued `winfs:read` tool calls (small, ~150–200 B requests), with retries.
Each hung ~4 minutes and surfaced the "No result received" error. For these
calls:

- **Claude Desktop's per-server log: nothing.** No `Message from client`, in
  fact **zero lines dated 2026-06-10 in any of CD's MCP logs** (combined
  `mcp.log` included).
- **Server wire log: nothing.** No `RECV`. The child's stdin never saw a
  byte.
- The server process was alive (it had answered in 5 ms at 23:23:34 and
  holds the wire-log file handle open throughout).

So the request died **before** CD's per-server MCP client logged dispatch —
i.e. above the MCP client, above the stdio pipe, in Claude Desktop's shared
dispatch layer. That placement is corroborated by the blast radius: winfs,
Desktop Commander and Claude-in-Chrome all wedge in the same window, and only
a full app restart recovers all of them at once.

### Earlier the same evening (context)

```
2026-06-09T19:22:29.987Z [winfs] [info] Server transport closed unexpectedly, this is likely due to the process exiting early. …
2026-06-09T19:22:29.987Z [winfs] [error] Server disconnected. …
2026-06-09T19:23:02.451Z [winfs] [info] Initializing server...
```

After that 19:23 respawn the server cleanly answered ids 2–13 over four hours
(every response 1–222 ms) until the operator's full restart at 23:18:48 — a
restart performed because of these recurring hangs.

## Why this is not the server's bug

We expect "have you checked your server?" — we have, three times across
separate investigations, and the capture above settles it:

- The wire log spans **2026-06-02 → 2026-06-09**: **523 id-bearing requests
  received, 523 responses sent.** Zero unanswered requests, ever.
- On the incident day, **every one of the 31 responses took 1–222 ms**,
  including a 92 KB `tools/list` in 9 ms and the final `write` in 5 ms.
- The only multi-second durations in the whole week are `execute_command`
  calls whose *child commands* legitimately ran that long (a `Start-Process`
  invocation at 60.0 s, a node probe script at 145.7 s) — both returned `ok`,
  both cross-checked by id+timestamp against Claude Desktop's own log.
- For the hung calls there is no server-side anything to debug: **the
  requests were never delivered**, by Claude Desktop's own log as much as by
  ours. winfs-mcp v1.0.1 internals are exonerated by both sides.

## Impact

- Each occurrence costs a **4-minute dead wait per attempt**, with 2–3
  attempts typical before the user gives up — tens of minutes lost per
  incident, plus a full app restart and the loss of in-flight context in
  other windows.
- It takes down **all** MCP-dependent work at once (every server, plus
  Claude-in-Chrome), not just one tool.
- It is **silent**: no error, no health indication, nothing in CD's own MCP
  logs — the user cannot distinguish "server is slow" from "app stopped
  dispatching" without instrumenting the server side, which is how this
  report came to exist.

## Reproduction

No deterministic trigger known. Pattern observed over weeks:

1. Long-running Claude Desktop instance, several chat windows, 3 local stdio
   MCP servers enabled; degradation appears after sustained use.
2. At some point a `tools/call` (any server, any size — the captured one was
   a small `read`) hangs 4 minutes → "No result received from the Claude
   Desktop app after waiting 4 minutes."
3. Concurrent calls to other MCP servers and Claude-in-Chrome hang in the
   same window.
4. Full exit via tray → relaunch: first calls succeed in milliseconds.

To capture it, we ran metadata-only wire logging inside the server
(`WINFS_TRANSPORT_LOG`) continuously for a week and correlated with
`%APPDATA%\Claude\logs\mcp-server-winfs.log` / `mcp.log` by request id and
timestamp (tooling: `scripts/analyze-transport-hang.mjs` in the winfs-mcp
repo). For the hung calls the correlation is the empty set on both sides —
that absence is the finding.

## Mitigations in use (workarounds, not fixes)

- Full app exit via tray + relaunch on first 4-minute timeout.
- Keeping the set of enabled MCP servers small.
- Server-side metadata wire-logging left on, so any recurrence is
  attributable immediately.

## Ask

1. **Fix the dispatch stall** — find why tool-call dispatch stops feeding
   per-server MCP clients after sustained use (the captured wedge survived a
   fresh server spawn that had just answered in 5 ms, so per-server state is
   not the trigger).
2. Failing an immediate fix, **make the failure loud and fast**:
   - a delivery timeout / watchdog on the dispatch path, so a call that
     never reaches the MCP client fails in seconds with a distinct error
     ("dispatch stalled") instead of 4 minutes of silence attributed to the
     server;
   - a health check that detects "no message has left dispatch in N seconds
     while calls are pending" and auto-recovers or prompts for restart;
   - log dispatch entry (before the per-server client) so stalls of this
     class are attributable from CD's own logs without server-side
     instrumentation.

---

*Prepared 2026-06-10 from live capture on the affected machine. Contact:
Vladimir Leonov (vladimir@leonov.ee), winfs-mcp maintainer
(<https://github.com/leonovee/winfs-mcp>).*

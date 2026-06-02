# CC prompt — #3: MCP transport hang investigation (traffic-log correlation)

## Origin

Third item in Vladimir's planned sequence. Throughout the 2026-05-22 session,
chat-Claude observed 4-minute MCP transport hangs on winfs tool calls
(`winfs:write` of large prompts, `winfs:read`, `execute_command`),
intermittently, with the "2-3 timeouts then it works" recovery pattern.

Three prior investigations (bug #1 EPERM_ROOT, bug #2 PATHEXT, P3 audit-IO)
all concluded the same: **winfs impl is not the cause; the hang lives in the
transport layer** between Claude Desktop and the spawned winfs process. This
investigation localizes WHERE in that transport the message is lost or
delayed.

**Honest framing up front:** this is unlikely to produce a winfs source fix.
The probable output is (a) diagnostic clarity on which leg of the transport
stalls, and (b) an upstream bug report for Anthropic if the fault is in
Claude Desktop's MCP transport. Setting expectations so the wave isn't judged
by "did winfs get patched" — it won't necessarily.

This is investigation + minimal opt-in instrumentation, NOT a feature wave.

## Scope boundary

- **In scope:** opt-in winfs-side request/response logging (env-gated, off by
  default, zero overhead when off); reading Claude Desktop's own MCP logs;
  correlating the two during a reproduced hang.
- **Out of scope:** changing winfs runtime behavior; "fixing" the hang in
  winfs (we've established it's not there); modifying Claude Desktop
  (not ours to touch).

## Phase A — locate Claude Desktop MCP logs

Claude Desktop writes MCP server logs. Typical location on Windows:
`%APPDATA%\Claude\logs\` — look for `mcp*.log` or `mcp-server-winfs.log`
or similar.

```
Get-ChildItem "$env:APPDATA\Claude\logs" -ErrorAction SilentlyContinue | Select Name, Length, LastWriteTime
```

(via execute_command full-path-no-pipeline if it cooperates; otherwise
read the directory listing via the filesystem tools.)

Identify which log file(s) capture winfs request/response traffic. Read a
recent slice. Determine the log format: does it record each JSON-RPC request
received and response sent, with timestamps? Note the schema.

Report what CD-side logging is available before building winfs-side
instrumentation — the correlation strategy depends on what CD already logs.

## Phase B — opt-in winfs-side transport logging

Add an env-gated request/response logger to winfs's transport entry point
(wherever the McpServer receives a request and sends a response — likely in
`src/index.ts` or `src/server.ts` around the transport wiring).

Requirements:
- Gated on env var `WINFS_TRANSPORT_LOG` (path to a log file). If unset,
  ZERO overhead — no logging, no perf change, no behavior change.
- When set, append one line per event to the file:
  - `<ISO timestamp> RECV <request-id> <method> <approx-bytes>`
  - `<ISO timestamp> SEND <request-id> <status> <approx-bytes> <duration-ms>`
- Must NOT log request/response BODIES (could contain file contents, secrets).
  Only metadata: timestamp, request id, method name, byte count, duration.
- Flush each line immediately (the whole point is to survive a hang — a
  buffered logger that loses the last line before a stall is useless).
- Use synchronous append (`fs.appendFileSync`) for this debug path
  specifically — durability over performance, and it's off by default.

This is the minimal instrumentation: it answers "did the request reach
winfs, and did winfs send a response, and how long did winfs take?" — which,
correlated with CD-side logs, localizes the stall.

Tests:
- env unset → no log file created, no overhead (assert logger is a no-op)
- env set → RECV/SEND lines written with expected schema
- no bodies in output (assert via writing a request with a known string in
  the body, confirm the string does NOT appear in the transport log)

Commit:
```
feat(transport): opt-in WINFS_TRANSPORT_LOG request/response metadata logging
```

## Phase C — reproduction protocol

Document a repeatable procedure (in `audit/investigations/v0.9-transport-hang.md`)
for capturing a hang with both logs running:

1. Set `WINFS_TRANSPORT_LOG=<path>` in the winfs launch env (Claude Desktop
   config `env` block for the winfs mcpServer entry).
2. Restart Claude Desktop (tray exit + relaunch) so winfs picks up the env.
3. From a chat-Claude session, issue the operation that hangs (large
   `winfs:write`, ~10 KB payload, was the most reliable trigger this session).
4. When the 4-minute timeout fires in chat-Claude, note the wall-clock time.
5. Capture: the winfs transport log, the CD MCP log, both around that
   timestamp.

CC can't trigger the chat-Claude-side hang itself (different process). This
phase is the operator (Vladimir / chat-Claude) procedure; CC documents it and
provides the analysis tooling for the captured logs.

## Phase D — correlation analysis

Once logs from a reproduced hang exist, correlate:

- **Request reached winfs?** Is there a `RECV <id>` line for the hung request
  in the winfs transport log? 
  - NO → the request never arrived; stall is on the CD→winfs leg (Claude
    Desktop didn't deliver, or stdio pipe stalled inbound).
  - YES → continue.
- **winfs sent a response?** Is there a matching `SEND <id>` line?
  - NO → winfs received but never responded; THIS would contradict the P3
    finding (impl is fast) — investigate that specific request.
  - YES, with small duration (<100ms) → winfs did its job fast; the stall is
    on the winfs→CD leg (outbound stdio pipe stalled, or CD didn't read the
    response). This is the most likely outcome given P3.
- **Timestamp gap:** compare winfs SEND timestamp vs when chat-Claude got the
  result (or timed out). A large gap with a fast winfs duration = transport
  delivery delay, not processing delay.

Write findings to `audit/investigations/v0.9-transport-hang.md`.

## Phase E — recommendation + upstream report

Based on Phase D, the report concludes with one of:

- **"CD→winfs inbound stall"** — request never reached winfs. Recommend
  upstream bug report to Anthropic with the correlated logs; winfs can do
  nothing.
- **"winfs→CD outbound stall"** — winfs responded fast, CD didn't pick it up
  in time. Same: upstream report, winfs blameless. Possibly note any
  large-response correlation (does it only happen above N bytes?).
- **"winfs processing stall"** — would contradict P3; if seen, re-open
  winfs-side investigation with the specific request that stalled.
- **"not reproducible with logging on"** — Heisenbug; the sync-flush logging
  changed timing enough to mask it. Document and note that the hang is
  timing-sensitive, consistent with a transport race.

If the conclusion is an upstream issue, draft the bug report content (env,
versions, correlated log excerpts with timestamps, repro steps) in the
investigation doc so Vladimir can file it with Anthropic. Redact any paths
that reveal project structure beyond what's needed.

Commit:
```
docs(investigation): v0.9 transport-hang correlation + upstream report draft
```

## Phase F — leave logging off by default

Confirm `WINFS_TRANSPORT_LOG` defaults to OFF and the no-op path has zero
overhead. The instrumentation ships (useful for any future recurrence) but
never runs unless explicitly enabled. Document the env var in README and
CLAUDE.md operational notes.

No version bump for this investigation wave unless the transport logger is
considered a shippable feature — if so, `[Unreleased]` entry under Added,
defer the bump to the next release cut.

## Constraints

- All work on `main`. No branches, no force-push.
- Transport logger gated, off by default, metadata-only (NEVER bodies — no
  file contents, no secrets in the log).
- Sync flush on the debug path is intentional (durability through a hang).
- This wave does not "fix the hang in winfs" — that's been ruled out 3x.
  Output is diagnosis + possible upstream report.
- git invocations full-path-no-pipeline (PATHEXT workaround).
- Tests green; smoke 72/72.

## Reporting

```
#3 transport-hang investigation done:
  CD-side logs: <found at path, format described | none found>
  winfs transport logger @ <sha> (env-gated, metadata-only, sync-flush)
  tests @ <sha>
  repro protocol documented: <yes>
  correlation analysis: <done with captured logs | pending operator repro>
  conclusion: <CD->winfs stall | winfs->CD stall | winfs processing | not-reproducible-with-logging>
  upstream report draft: <yes, in investigation doc | n/a>
  main @ <sha>, pushed
  tests: <N> passing
  smoke: <Y>/<Y> green

  Honest outcome: <winfs source unchanged behaviorally; diagnosis is X;
                   next step is Y (upstream report / operator repro / closed)>
```

On any failure: stop, report step, full output.

## After this wave

This completes Vladimir's planned 1→2→3 sequence. Remaining known backlog
(all minor, non-urgent):
- Deferred structural P2: execute_command P2.2/P2.4, grep P2.7, edit_file
  P2.3, fetch_url P2.1 (rename-only)
- 15% residual process-test flake (documented in _known-flaky.md)
- v0.8 backlog P4 leftovers if any
- Codex/Gemini CLI install for full 4-eyes review (Vladimir manual)

None are release-blocking. Natural point to pause or pick a minor item.

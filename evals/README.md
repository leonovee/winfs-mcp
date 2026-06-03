# mcp-winfs evals

This directory holds the Phase-4 evaluation harness described in spec
amendment `2026-05-16 — Phase 4 (Evaluations) + mandatory reference files`.

## Status — v0.1

Skeleton only. v0.1 ships:

- `connections.py` — vendored verbatim from the upstream
  `anthropics/skills/skills/mcp-builder/scripts/connections.py` (pulled
  2026-05-16). Provides `MCPConnectionStdio` for spawning the server as a
  subprocess and `list_tools` / `call_tool` for Anthropic SDK callers.
- `requirements.txt` — `anthropic>=0.39.0`, `mcp>=1.1.0`.
- `v1.0-evaluation.xml` — 2 placeholder questions in the canonical XML
  format. Real questions accumulate as new tools land in v0.3+.

There is **no runner script** yet (`run.py`) — added in v0.7 alongside the
final 10-question suite.

## Filling the suite

Each new tool family from spec §4 should contribute 1–2 questions that
exercise it through realistic exploration:

| Spec version | Tools added                                  | Eval questions to add |
|--------------|----------------------------------------------|------------------------|
| v0.3         | grep, glob, read_json, audit_tail            | 2                      |
| v0.4         | edit_file (dry-run only in evals), slicing   | 2                      |
| v0.5         | git_log, git_status, git_diff, git_show      | 2                      |
| v0.7         | execute_command (read-only), find_command    | 2                      |
| v1.0         | tighten and renumber to 10                   | —                      |

## Question constraints (spec amendment, Phase 4, section C)

- **Independent** — answer must not depend on prior questions.
- **Read-only** — questions must not require any tool that mutates state.
- **Complex** — ≥2 tool calls and real exploration; one-shot stat is too easy.
- **Realistic** — architect-level tasks against real project files.
- **Verifiable** — single string-comparable answer.
- **Stable** — answer must not depend on `mtime`, current git HEAD, or
  any time-varying state.

## Running (planned)

```powershell
cd evals
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py --eval v1.0-evaluation.xml --server "node ../dist/index.js --config ../configs/default.json"
```

## Status — post-1.0 backlog

This is a **post-1.0 backlog** item, **not** a v1.0.0 release gate. v1.0.0
shipped on the MCPB packaging + GPT-review hardening waves; the eval suite is
still a 2-question skeleton with no `run.py` runner. The remaining work — finalise
the 10-question suite and the runner, then execute it through MCP targeting
**≥ 8 / 10** — is tracked in spec §10 (Open Questions для v1.0+).

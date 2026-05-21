# configs/

This directory holds **development-time fixtures**, not runtime configuration.
The mcp-winfs server does NOT read these files when launched by Claude Desktop
or any other MCP host. They exist for tests, for the Inspector, and as a
schema reference for documentation.

## Files

### `default.json`

Baseline config bundled with the repository. Carries:

- `allowedRoots: []` — empty by design. This file ships in the repo and must
  never contain user-specific paths (an earlier revision did; it was cleaned
  up in the v0.7 tails wave).
- Sensible defaults for `shellBlocklist`, timeouts, `fetchUrlMaxBytes`, and
  audit-log placement. Matches spec §3.

Acts as a schema reference: the field set here mirrors what Zod accepts in
`src/core/config.ts`. Treat it as documentation; do not edit it expecting
runtime behaviour to change.

### `local.json` (gitignored)

Dev-time override for the Inspector workflow. The recommended dev loop is:

```powershell
Copy-Item configs/default.json configs/local.json
# edit configs/local.json with your real allowedRoots paths …
npx @modelcontextprotocol/inspector node dist/index.js -- --config configs/local.json
```

The `--` separator before `--config` is required so the Inspector doesn't
consume the flag itself (see README §Troubleshooting). `local.json` is in
`.gitignore` and stays per-machine.

## Runtime config

The MCP host (Claude Desktop, Claude.ai, etc.) loads config from:

```
%LOCALAPPDATA%\mcp-winfs\config.json
```

Typically `C:\Users\<USER>\AppData\Local\mcp-winfs\config.json`. The file is
NOT created automatically — until it exists, the server starts with empty
`allowedRoots` and every path-bound tool returns `EPERM_ROOT`. See README
§Configuration for the minimal example and field reference.

## Why not JSON comments?

`CONFIG_SCHEMA` in `src/core/config.ts` is `.strict()` — unknown fields fail
validation at startup. That rules out `_comment` keys inside `default.json`
itself. Per-field documentation lives in this README and in spec §3 instead.

# MIGRATION

## TODO — V1 → V2 SDK migration

**Target:** `@modelcontextprotocol/server` 2.x.x.

**Trigger:** when `npm view @modelcontextprotocol/server dist-tags` returns
`latest` pointing at a `2.x.x` release (i.e. V2 has shipped stable, not
`next`/`beta`/pre-alpha).

**Why this is parked for now (2026-05-16):**

- `modelcontextprotocol/typescript-sdk` `main` (V2) is marked
  "currently in development, pre-alpha" in its README.
- `@modelcontextprotocol/server` on npm has no stable `latest` tag.
- Latest stable across the family is `@modelcontextprotocol/sdk@1.29.0`
  (2026-03-30).
- The maintainers explicitly recommend v1.x for production.

The spec captures the decision in `docs/design/mcp-winfs-spec.md`
amendments dated 2026-05-16. The Appendix A in that file describes the
target V2 API and is preserved as reference for the migration.

## Migration scope estimate

For v0.1 (5 tools): ~1 day of work. The mechanical changes are:

| Aspect | V1 (current) | V2 (target) |
|---|---|---|
| Package | `@modelcontextprotocol/sdk` | `@modelcontextprotocol/server` |
| Server class | `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` | `McpServer` from `@modelcontextprotocol/server` |
| Transport | `@modelcontextprotocol/sdk/server/stdio.js` | `@modelcontextprotocol/server/stdio` |
| Zod import | `import { z } from "zod"` (v3) | `import * as z from "zod/v4"` |
| Tool registration | `server.registerTool(name, {...}, handler)` (compatible) | `server.registerTool(name, {...}, handler)` |

The registerTool signature is largely compatible. The Zod v3 → v4 change
is the most invasive part: schemas in `src/schemas/` and per-tool
`InputShape` declarations need a Zod v4 audit pass.

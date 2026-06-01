# CC prompt — v0.9 P1: MCP Roots protocol support

## Origin

Per `backlog/v0.8-filesystem-mcp-parity.md` P1. Solves the operational pain that v0.7 hit repeatedly: editing `%LOCALAPPDATA%\mcp-winfs\config.json` and restarting Claude Desktop every time a new project root needs access.

With MCP Roots, the client (Claude Desktop / VS Code / Cursor) signals its current project roots at connection time and via runtime notifications, and winfs auto-updates `allowedRoots` without restart.

Tag at the end: **v0.9.0**.

Reference implementation: `@modelcontextprotocol/server-filesystem` — specifically the `RootsListChangedNotificationSchema` subscription and `server.server.oninitialized` hook patterns.

## Design call (architect-decided, do not deviate)

**Union mode, not replace mode.**

The reference filesystem server *replaces* its `allowedDirectories` with client roots. winfs takes the safer union approach:

```
effectiveAllowedRoots = union(config.allowedRoots, clientRoots)
```

Rationale:
- winfs's safety posture is "narrow by default" — union widens only when both server-side config AND client-side roots trust a path.
- Replace mode can surprisingly *reduce* allowed access if client doesn't know the full config.
- Empty client roots = config-only access (no regression vs today).
- Client roots can only widen, never silently remove paths the operator explicitly trusted via config.

## Phase A — read current state

```
cat src/server.ts
cat src/core/config.ts
grep -rn 'allowedRoots\|checkAllowed' src/core/
grep -rn 'allowedRoots' src/tools/ | head
```

Identify:
1. Where `config.allowedRoots` is read at runtime.
2. The path-check function consuming it.
3. The `ToolContext` shape (wave 2c).
4. Where `createServer` connects to the McpServer transport.

Report findings before proceeding.

## Phase B — ToolContext extension

`ToolContext` currently holds `{ config, audit, registry }`. Add `rootsResolver`:

```typescript
export interface ToolContext {
  readonly config: Config;
  readonly audit: Audit;
  readonly registry: ProcessRegistry;
  readonly rootsResolver: RootsResolver;
}

export interface RootsResolver {
  effective(): readonly string[];
  clientRoots(): readonly string[];
  setClientRoots(roots: readonly string[]): void;
}
```

## Phase C — RootsResolver implementation

New file: `src/core/roots_resolver.ts`.

Behavior:
1. **Construction**: initialized with `config.allowedRoots` (immutable snapshot). Client roots start empty.
2. **`effective()`**: deduplicated union of config + client roots. Normalized paths (case-insensitive on Windows, trailing slashes stripped, both original AND `realpath`-resolved variants per Filesystem MCP's symlink pattern).
3. **`setClientRoots(roots)`**: validates each — absolute, exists, is directory, realpath resolved. Invalid roots SKIPPED with console.error warning; valid ones still applied (partial-success per reference filesystem).
4. **Atomicity**: replace entire clientRoots array per call, never mutate in place.
5. **Audit hook**: each `setClientRoots` emits `{ event: "client_roots_updated", count: N, source: "mcp_roots" }`. Count only, NOT paths (don't leak caller-side dir structure into audit trail).

Unit tests:
- Empty client + non-empty config → effective == config
- Non-empty client + empty config → effective == validated client
- Both populated → union, dedup, normalized
- Invalid client root → skipped + warning; valid still applied
- Symlinked root → both original + resolved present
- Replacement call cleanly replaces prior client roots

## Phase D — path-check rewire

Sweep: wherever `config.allowedRoots` is read for runtime path validation, replace with `ctx.rootsResolver.effective()`. ToolContext threaded through every tool handler (wave 2c), no signature changes needed.

Invariant comment at rewire site:
```typescript
// Invariant #42: path checks use effective roots (config ∪ client),
// never config.allowedRoots directly. See spec §AC.
```

## Phase E — MCP Roots wiring in server.ts

In `createServer`, after McpServer construction:

```typescript
server.server.oninitialized = async () => {
  const caps = server.server.getClientCapabilities();
  if (caps?.roots) {
    try {
      const response = await server.server.listRoots();
      if (response && 'roots' in response) {
        const rootPaths = response.roots
          .filter(r => r.uri.startsWith('file://'))
          .map(r => fileURLToPath(r.uri));
        ctx.rootsResolver.setClientRoots(rootPaths);
        console.error(`MCP Roots initial fetch: ${rootPaths.length} roots`);
      }
    } catch (err) {
      console.error("MCP Roots initial fetch failed:", err);
    }
  }
};

server.server.setNotificationHandler(
  RootsListChangedNotificationSchema,
  async () => {
    try {
      const response = await server.server.listRoots();
      if (response && 'roots' in response) {
        const rootPaths = response.roots
          .filter(r => r.uri.startsWith('file://'))
          .map(r => fileURLToPath(r.uri));
        ctx.rootsResolver.setClientRoots(rootPaths);
        console.error(`MCP Roots updated: ${rootPaths.length} roots`);
      }
    } catch (err) {
      console.error("MCP Roots update failed:", err);
    }
  }
);
```

Only `file://` URIs accepted. Use `fileURLToPath` from Node `url` module for Windows path handling.

## Phase F — spec amendments

### F1. Invariant #42 (next after #41 from wave 2c)

Title: **"Effective allowed roots are the union of config and client roots."**

Body (adjust to spec voice):

> Effective allowed roots = `union(config.allowedRoots, rootsResolver.clientRoots())`. Union chosen over replace for safety: client roots can only widen access, never silently remove paths the operator explicitly trusted via config. Empty client root set degrades to config-only access. Client roots validated at `setClientRoots` — absolute, existing directory, symlinks resolved per reference server's dual-path-storage pattern. Invalid roots skipped with warnings; valid ones still apply. Audit records `client_roots_updated` events with count only, never paths. Applies to all path-bound tools through `ctx.rootsResolver.effective()`.

### F2. New section §AC — MCP Roots integration

Document: capability discovery on init, initial `listRoots()` fetch, `roots/list_changed` subscription, file:// URI filter, resolver lifecycle, union semantics. Cross-reference to Invariant #42.

## Phase G — tests

### G1. Resolver unit tests (Phase C above).

### G2. Integration tests
- createServer with mock returning 0 roots → effective == config
- createServer with mock returning 2 roots → effective == config ∪ those
- `roots/list_changed` mid-session → resolver updates, path checks reflect
- Mixed URI schemes → only file:// land in resolver
- Validation rejects bogus roots → skipped, valid still applied

### G3. End-to-end
- `winfs:list` on path inside client-only root → success
- `winfs:list` on path inside config-only root → success (back-compat)
- `winfs:list` on path inside neither → EPERM_ROOT
- After `roots/list_changed` removes a root → subsequent calls → EPERM_ROOT (unless still covered by config)

## Phase H — smoke probe

Add to existing smoke harness:
- Client root grants access without restart
- Empty client roots → config-only

Same probes strict + unrestricted.

## Phase I — CHANGELOG + version bump + tag

`[Unreleased]` → `[0.9.0]`:
- Added: MCP Roots protocol support; RootsResolver in ToolContext; Invariant #42
- Changed: ToolContext gained rootsResolver field; path checks use effective roots
- Docs: spec §AC, Invariant #42

```
npm version 0.9.0 --no-git-tag-version
```

```
git push origin main
git tag -a v0.9.0 -m "v0.9.0: MCP Roots protocol support — client roots union with config; dynamic updates"
git push origin v0.9.0
```

## Commit decomposition

1. `feat(core): RootsResolver — config ∪ client roots, validated`
2. `refactor(core): ToolContext.rootsResolver; path checks use effective roots`
3. `feat(server): subscribe to MCP Roots protocol (initial + runtime updates)`
4. `test: RootsResolver unit + integration coverage`
5. `chore(smoke): MCP Roots probe in smoke harness`
6. `docs(spec): §AC MCP Roots integration; Invariant #42`
7. `docs: CHANGELOG [0.9.0] + tag`

7 commits, CC may fold/split.

## Constraints

- All work on `main`. No branches, no force-push.
- Tests green at every commit boundary. Baseline: 433 tests.
- Smoke must pass before tag.
- Union semantics non-negotiable — do NOT switch to replace mid-implementation.
- `file://` URI filtering only. Other schemes logged + skipped.
- Validation rejects malformed roots WITH warnings, doesn't fail entire `setClientRoots`.
- Audit records updates by COUNT, NOT path content.
- If MCP SDK doesn't export referenced types (`RootsListChangedNotificationSchema`, `listRoots()`, capabilities introspection), check SDK version — may need to bump `@modelcontextprotocol/sdk`. Report SDK version before/after if upgraded.

## Reporting

```
v0.9.0 P1 MCP Roots shipped:
  RootsResolver impl @ <sha>
  ToolContext + path-check rewire @ <sha>
  server.ts MCP Roots wiring @ <sha>
  tests @ <sha>
  smoke probe @ <sha>
  spec @ <sha>
  CHANGELOG + bump @ <sha>
  tag v0.9.0 -> <tag-sha> -> <commit>, pushed
  main @ <sha>

  tests: <N> passing (was 433)
  smoke: <Y>/<Y> green (added <K> MCP Roots probes)
  MCP SDK version: <before> -> <after | unchanged>

  Roots resolver verified:
    config ∪ client union — yes
    file:// URI filter — yes
    validation skip + warn on bad roots — yes
    audit count-only — yes
```

On any failure: stop, report step, full output. Phases A-H pushed = safe checkpoint; tag not yet created.

## After v0.9.0 tag

Stop after v0.9.0 tag. Two next items in Vladimir's planned sequence are separate prompts:
- v0.7.1 patch backlog (10 flaky tests + ~15 deferred P2 review findings)
- MCP traffic-log investigation (outside winfs source scope; operator work)

Do NOT begin those in this wave.

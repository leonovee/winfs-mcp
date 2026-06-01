# CC prompt — v0.7 wave 2c: architectural closure (ToolContext + invariant #38 + methodology notes)

## Origin

v0.7.0 shipped at `main @ 235a5e5`, tagged. Three architectural items have been accumulating that should land now while the codebase is fresh and no downstream consumers depend on internal signatures:

1. **`ToolContext` refactor** — CC flagged this in wave 2b reporting. Currently `register*Tool(server, config, audit, registry)` takes 4 positional arguments; the 4th (`registry`) was added in wave 2b. Any future stateful subsystem (FileWatchRegistry for notifications, JobQueue, etc.) means a 5th argument and another breaking signature change. Pre-emptive consolidation into a single `ToolContext { config, audit, registry, ... }` object stabilizes the internal API.

2. **Invariant #38 in spec** — Wave 2b implementation surfaced a class of race condition: stateful subsystems whose state transitions out of `running` based on intent-to-kill (deadline fires, kill signal sent) rather than actual `close`-event can settle the session while the underlying OS resource is still live. Wave 2b solved it with a `deadlineFired` flag and let the `close`-event drive the final state transition. This pattern should be codified as a spec-level invariant so future stateful subsystems (which the ToolContext refactor anticipates) inherit it correctly.

3. **Methodology note: blocklist-fix verify-then-smoke pattern** — Pre-tag smoke caught a real defect in the `-EncodedCommand` blocklist fix from bugfix wave (`2bb8a69`): the recommended regex was correct-in-style ("block all encoded variants") but missing context anchor, over-blocking legitimate `node -e`, `python -e`, `perl -e`. CC fixed with positive lookahead on `powershell|pwsh` in commit `7b7a41c`. Lesson: blocklist-pattern fixes from external review need BOTH pre-fix empirical verification (Phase 0 of bugfix wave already did this) AND post-fix smoke against legitimate use cases in the same category. Document so future review/fix cycles inherit.

None of these are user-facing bugs. All three are architectural / methodological hygiene that becomes harder to land the longer we wait.

## Phase A — invariant #38 in spec

### A1. Locate invariant table

```
grep -n 'invariant\|Invariant' docs/design/mcp-winfs-spec.md | head -20
```

Find the spec's invariants table (existing entries should be #1 through ~#37 based on accumulated history). Confirm next number.

### A2. Add invariant #38

Add a new entry. Title: **"Stateful sessions settle by close-event only."**

Body (adjust prose to match spec voice):

> Subsystems that manage long-lived OS resources (subprocess, file watcher, network connection, etc.) must NOT transition session state to a settled value (`exited`, `killed`, `timed_out`, `failed`) based on intent-to-terminate alone (deadline fires, kill signal sent, cleanup requested). The final state transition must be driven by the actual close-event from the underlying resource. Intent-to-terminate may set per-session flags (`deadlineFired`, `killRequested`, etc.) which influence the eventual settle-state classification, but the settle itself happens only when the resource confirms it has released.
>
> Rationale: a session marked `settled` while the OS resource is still live causes cleanup races. On Windows, the most visible symptom is `EBUSY` on rmdir during test cleanup, because the temp directory is still held open by the not-actually-dead subprocess. Wave 2b implementation surfaced this race in ProcessRegistry; the fix (`deadlineFired` flag + close-event-driven settle) is the reference pattern.
>
> Applies to: existing ProcessRegistry in `src/core/process_registry.ts`; future stateful subsystems by default.

### A3. Cross-reference

Find anywhere in spec that describes ProcessRegistry, lifecycle, or settle states; add a one-line cross-reference: "See Invariant #38."

Commit:

```
docs(spec): invariant #38 — stateful sessions settle by close-event only
```

## Phase B — ToolContext refactor

### B1. Read current state

```
cat src/server.ts
ls src/tools/system/
grep -rn 'export function register' src/tools/ | head
cat src/tools/system/start_process.ts
```

Report current signature of `register*Tool` functions across the surface. Expected uniform: `(server, config, audit, registry)`. If anything diverges (e.g. some tools have additional parameters), note them.

### B2. Define ToolContext

New file: `src/core/tool_context.ts`.

```typescript
import type { Config } from "./config.js";
import type { Audit } from "./audit.js";
import type { ProcessRegistry } from "./process_registry.js";

/**
 * Shared per-server context passed to every tool registration.
 * Stateful subsystems are stored here; tool implementations receive the
 * whole context and pluck what they need. Add new state fields here when
 * introducing a new stateful subsystem (Invariant #38 applies).
 */
export interface ToolContext {
  readonly config: Config;
  readonly audit: Audit;
  readonly registry: ProcessRegistry;
}

/**
 * Construct a ToolContext from already-initialized components. Used by
 * `createServer` and by tests that need to inject mocked subsystems.
 */
export function createToolContext(parts: {
  config: Config;
  audit: Audit;
  registry: ProcessRegistry;
}): ToolContext {
  return {
    config: parts.config,
    audit: parts.audit,
    registry: parts.registry,
  };
}
```

Adjust import paths and naming to match existing project style (e.g. if `Audit` is named differently, follow that).

### B3. Refactor register*Tool signatures

Mechanical refactor. Each `export function register<Name>Tool(server: McpServer, config: Config, audit: Audit, registry?: ProcessRegistry): void` becomes `export function register<Name>Tool(server: McpServer, ctx: ToolContext): void`. Inside the function, destructure as needed: `const { config, audit, registry } = ctx;`.

Apply to every tool registration file. Touch each:
- `src/tools/file/*.ts`
- `src/tools/search/*.ts`
- `src/tools/exec/*.ts`
- `src/tools/network/*.ts`
- `src/tools/editor/*.ts`
- `src/tools/system/*.ts`

If any tool's body currently doesn't use `registry`, remove the destructure. If any tool's body uses `config` or `audit` only, still pass `ctx` (uniform signature is the point).

### B4. Refactor createServer

`src/server.ts`'s `createServer` currently returns `{ server, registry }` and constructs the per-tool registrations passing 4 args each. Change to:

```typescript
export function createServer(config: Config): { server: McpServer; ctx: ToolContext } {
  const audit = createAudit(config);
  const registry = new ProcessRegistry(/* config-derived params */);
  const ctx = createToolContext({ config, audit, registry });

  const server = new McpServer(/* ... */);
  registerReadTool(server, ctx);
  registerWriteTool(server, ctx);
  // ... all other registers
  registerStartProcessTool(server, ctx);
  // ...

  return { server, ctx };
}
```

The returned value's shape changes from `{ server, registry }` to `{ server, ctx }`. Update `src/index.ts` (the consumer of `createServer`) to use `ctx.registry.shutdown()` instead of `registry.shutdown()` directly.

### B5. Test updates

Tests that previously instantiated a registry and passed it directly to `register*Tool` now must build a `ToolContext`. Provide a test helper (in `tests/_helpers/tool_context.ts` or wherever existing test helpers live):

```typescript
export function makeTestToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return createToolContext({
    config: overrides?.config ?? makeTestConfig(),
    audit: overrides?.audit ?? makeMemoryAudit(),
    registry: overrides?.registry ?? new ProcessRegistry({ /* fast TTL for tests */ }),
  });
}
```

Run full test suite after refactor — all tests must remain green.

Commit (suggested, may be split):

```
refactor(core): ToolContext consolidates per-server state; uniform register*Tool signature
```

### B6. Spec amendment for ToolContext

Add to `docs/design/mcp-winfs-spec.md` a short subsection describing the `ToolContext` pattern: definition, when to extend it (new stateful subsystem), the rule that every register*Tool accepts the whole context. Cross-link to Invariant #38.

Commit:

```
docs(spec): ToolContext interface and extension rule
```

## Phase C — methodology note: blocklist verify-then-smoke

### C1. Locate the right home

Two candidate locations: `CLAUDE.md` (operational notes for chat-Claude + CC sessions) or `docs/design/mcp-winfs-spec.md` (canonical reference). The note is procedural rather than architectural, so `CLAUDE.md` is the natural home. Confirm structure with:

```
grep -n '^## ' CLAUDE.md
```

Find existing "Operational notes" or similar section.

### C2. Add the note

Add subsection. Title: **"Blocklist-pattern fixes from external review require verify-then-smoke."**

Body:

> External review findings that propose blocklist pattern changes (e.g. `exec_safety.ts` regex additions) introduce a two-sided risk: under-block (the original finding — fix needed) and over-block (the fix matches legitimate use cases).
>
> Procedure:
>
> 1. **Pre-fix verify** (Phase 0 of any bug-fix wave). Write a failing test that demonstrates the under-block — pattern allows what reviewer claims it allows. If the test passes against current code, the finding is invalid; close it.
>
> 2. **Post-fix smoke** (within the same wave OR before tag). After applying the pattern fix, run the wire-level smoke harness or a targeted suite that exercises every legitimate use case in the same syntactic neighborhood. For `-EncodedCommand`, the over-block check is `node -e`, `python -e`, `perl -e`, `ruby -e`, etc. — short flags that share the same prefix path with the dangerous flag but on different binaries. The smoke must NOT trigger the blocklist.
>
> Reference: the `-EncodedCommand` greedy-pattern over-block in bug-fix wave (`2bb8a69`) was caught by pre-tag smoke first probe; fixed with positive-lookahead context anchor in `7b7a41c`. Without smoke, the over-block would have shipped.

Commit:

```
docs(claude.md): methodology — blocklist-fix verify-then-smoke pattern
```

## Phase D — CHANGELOG

Currently `[Unreleased]` is empty (we promoted all v0.7.0 content during tag wave). Add entries for this wave under `[Unreleased]`:

- `Changed`: `register*Tool` signature now takes `(server, ctx: ToolContext)`. Migration note for anyone with custom tool extensions.
- `Changed`: `createServer` return type now `{ server, ctx }` instead of `{ server, registry }`. Migration: `result.registry` → `result.ctx.registry`.
- `Docs`: spec invariant #38 (settle by close-event), ToolContext extension rule, CLAUDE.md methodology note for blocklist verify-then-smoke.

Commit:

```
docs: CHANGELOG entries for v0.7 wave 2c
```

Push to origin/main at end.

## Commit decomposition summary

Approximate commits in this wave:

1. `docs(spec): invariant #38 — stateful sessions settle by close-event only`
2. `feat(core): ToolContext + createToolContext helper`
3. `refactor(core): tools accept ToolContext; createServer returns { server, ctx }`
4. `refactor(tests): test helper for ToolContext`
5. `docs(spec): ToolContext interface and extension rule`
6. `docs(claude.md): methodology — blocklist-fix verify-then-smoke pattern`
7. `docs: CHANGELOG entries for v0.7 wave 2c`

7 commits, CC may fold/split with judgment. No force-pushes.

## Constraints

- All work on `main`. No branches, no force-push, no rebase.
- Tests green at every commit boundary.
- No version bump. `[Unreleased]` only in CHANGELOG.
- `register*Tool` signature change is the breaking change moment — if anything in tests or examples relied on the 4-arg form, it needs updating in the same commit that changes the signature.
- ProcessRegistry / shutdown semantics stay identical. Refactor is purely shape, not behavior.
- Smoke harness re-run after refactor (optional, judgment): if CC is uncertain whether ToolContext refactor preserved behavior, run `scripts/smoke/v0.7-smoke.mjs`; expected same 55/55 green plus 3 documented skips.

## Reporting

End of wave (single block):

```
v0.7 wave 2c done:
  invariant #38 @ <sha>
  ToolContext + createToolContext @ <sha>
  register*Tool refactor @ <sha>
  test helper @ <sha>
  spec ToolContext rule @ <sha>
  CLAUDE.md methodology @ <sha>
  CHANGELOG @ <sha>
  main @ <sha>, pushed
  tests: <N> passing (was <previous>)
  signature change: register*Tool(server, config, audit, registry) -> register*Tool(server, ctx)
  createServer return: { server, registry } -> { server, ctx }
  smoke re-run: <yes -> result | skipped>
```

On any failure: stop, report step, full output. Earlier phases pushed = safe.

# CC prompt — v0.9.2 security audit wave

## Origin

`npm install` during the Expert bootstrap reported **7 vulnerabilities
(1 low, 5 moderate, 1 critical)** in the dependency tree. This wave
investigates and remediates them, prioritizing the critical one — but
with disciplined exposure assessment, not reflexive `audit fix --force`.

**Framing:** an npm-audit severity is the CVE's severity in the abstract,
NOT winfs's actual exposure. A critical vuln in a transitive dependency
on a code path winfs never exercises is low real risk. The wave's job is
to (a) enumerate, (b) assess real exposure per vuln, (c) fix cleanly where
non-breaking, (d) document + decide where a fix requires a breaking bump.

Tag at end: **v0.9.2** (only if fixes land; if everything is deferred as
non-exposed, no bump — just a security note commit).

Baseline (verify first): `main @ 74e32c9` (or later), 490 tests, 72/72 smoke.

## Phase A — enumerate

```
npm audit --json > audit/security/npm-audit-2026-05-22.json
npm audit                                  # human-readable to console
```

(In an environment where bare `npm` doesn't resolve — PATHEXT quirk —
invoke via `node "<node>\node_modules\npm\bin\npm-cli.js" audit`. CC's
own terminal should be fine; this note is for the MCP-spawned case.)

For each of the 7 vulnerabilities, extract into
`audit/security/v0.9.2-triage.md`:
- Package name + version (vulnerable range)
- Direct or transitive? If transitive, the dependency path
  (`npm ls <package>` to see who pulls it in)
- CVE / advisory id + severity + one-line description
- Fix availability: is there a patched version? Does it require a major
  bump of the direct parent?

## Phase B — exposure assessment

For each vuln, answer: **does winfs actually exercise the vulnerable code
path?**

- **Critical first.** Identify the vulnerable package, what the CVE is
  (ReDoS? prototype pollution? path traversal? arbitrary code exec?), and
  whether winfs calls into that path. Examples:
  - If it's a ReDoS in a parser winfs only feeds trusted internal input
    to → low exposure.
  - If it's path traversal in a package winfs uses on user-supplied paths
    → HIGH exposure, fix urgently.
  - If it's in a dev-only dependency (build/test tooling, not shipped in
    `dist/`) → no runtime exposure.
- Classify each: **EXPOSED** (winfs runtime can hit it with attacker-
  influenced input), **LOW** (only trusted input / narrow conditions),
  **DEV-ONLY** (not in shipped runtime).

Record the classification + reasoning per vuln in the triage doc. This is
the load-bearing analysis — it drives what must be fixed vs what can be
documented and deferred.

## Phase C — non-breaking fixes

```
npm audit fix          # WITHOUT --force — applies only semver-compatible patches
```

Then re-run `npm audit` and `npm test`. Confirm:
- Vulnerability count dropped by however many had compatible patches.
- All 490 tests still green.
- `dist/` rebuilds cleanly (`npm run build`).

Commit:
```
fix(deps): npm audit fix — non-breaking security patches
```

(If audit fix changed package-lock.json + node_modules, the lock file is
committed; node_modules is gitignored.)

## Phase D — the critical vuln + any EXPOSED moderate

For each vuln still open after Phase C that is classified EXPOSED or is
the critical one:

1. Determine the fix: which direct dependency needs a major bump, and what
   breaks in winfs if bumped (read that dep's changelog / migration notes).
2. **If the bump is clean** (no winfs API usage affected, tests pass after
   bump): apply it.
   ```
   npm install <package>@<fixed-version>
   npm test && npm run build
   ```
   Commit: `fix(deps): bump <package> to <ver> — closes <CVE> (EXPOSED)`
3. **If the bump breaks winfs** (API changes require code edits): assess
   scope.
   - Small adaptation (a few call sites) → make the edits, fix, test.
   - Large adaptation (deep API change) → STOP and report. chat-Claude /
     Vladimir decides: do the migration now (its own wave) or accept the
     risk temporarily with a documented mitigation.
4. **If no fix exists upstream** → document the exposure and any in-winfs
   mitigation (input validation, disabling the affected feature, etc.).

The critical vuln must NOT be left silently unaddressed: either fixed, or
explicitly documented with an exposure verdict and a decision. If its real
exposure is NONE (dev-only or unreachable path), that's a valid resolution
— state it clearly with the reasoning.

## Phase E — verify

```
npm audit               # confirm new count
npm test                # 490 green
npm run build           # dist clean
node scripts/smoke/v0.7-smoke.mjs   # 72/72
```

## Phase F — security note + changelog

Create / update `audit/security/v0.9.2-triage.md` with final state:
- Each original vuln → resolved (how) / deferred (why, exposure verdict).
- Residual vulnerabilities after the wave, with explicit exposure
  rationale for each remaining one (so a future reader knows they were
  assessed, not ignored).

CHANGELOG `[Unreleased]` → `[0.9.2]` (only if fixes landed):
- `Security`: list CVEs closed + dependency bumps.
- If a residual critical/exposed vuln remains by necessity, note it under
  a "Known security considerations" line with the mitigation.

If NOTHING was fixable and everything was assessed as non-exposed
(dev-only / unreachable), do NOT bump — commit only the triage doc:
```
docs(security): v0.9.2 audit triage — exposure assessment, no runtime risk
```
and report that no release is warranted.

## Phase G — bump + tag (only if fixes landed)

```
npm version 0.9.2 --no-git-tag-version
git ... commit -m "chore(release): bump 0.9.1 -> 0.9.2"
git ... push origin main
git ... tag -a v0.9.2 -m "v0.9.2: security — <summary of CVEs closed>"
git ... push origin v0.9.2
```

(git via full-path-no-pipeline in the MCP env; CC's own terminal is fine.)

## Constraints

- `npm audit fix` WITHOUT `--force` first. `--force` is never run blanket;
  any breaking bump is evaluated individually in Phase D.
- Exposure assessment (Phase B) is mandatory before fixing — no reflexive
  upgrades that risk breaking winfs for a vuln it isn't exposed to.
- Tests green (490) and smoke green (72/72) at every commit boundary.
- If the critical vuln needs a deep breaking migration, STOP and report —
  don't undertake a large refactor inside a security wave without a
  decision.
- All work on `main`. No branches, no force-push.
- A documented "no real exposure" verdict is an acceptable resolution for
  a vuln — security isn't only about count-to-zero, it's about real risk.

## Reporting

```
v0.9.2 security audit done:
  enumerated: 7 vulns (1 low / 5 moderate / 1 critical)
  exposure: <N EXPOSED, M LOW, K DEV-ONLY>
  critical vuln: <package> / <CVE> — <fixed by bump X | no exposure: reason | mitigated: how>
  non-breaking fixes (Phase C): <count closed> @ <sha>
  breaking bumps applied (Phase D): <list> @ <sha>
  residual after wave: <count> — <each with exposure verdict>
  triage doc: audit/security/v0.9.2-triage.md @ <sha>
  tests: 490 green | smoke: 72/72 | build: clean
  release: <v0.9.2 tagged @ <sha> | no bump — triage-only, no runtime risk>
```

On any failure: stop, report step, full output. If a breaking bump is
needed for the critical vuln, do NOT proceed unilaterally — report the
options.

## After this wave

Remaining backlog (minor): #3 transport-hang investigation, deferred
structural P2 (execute_command P2.2/P2.4, grep P2.7, edit_file P2.3,
fetch_url P2.1). None release-blocking.

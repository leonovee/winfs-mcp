// v0.8 P3 audit-IO investigation benchmark.
//
// Compares 3 variants of the write path to localize where time is
// spent in winfs:write — atomicity overhead, audit overhead, or
// neither (transport / environmental).
//
// Variants:
//   A_full       — production winfs:write: checkAllowed + atomicWriteFile +
//                  appendAudit fire-and-forget
//   B_no_audit   — production atomic write WITHOUT audit
//   C_raw        — bare `fs.writeFile` (single syscall, no temp, no fsync,
//                  no audit; matches Filesystem-MCP style)
//
// Output:
//   audit/investigations/v0.8-audit-io-raw.csv — per-iteration timings
//
// Run: node scripts/perf/audit_io_investigation.mjs

import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";

// Use the BUILT dist/ — keeps the bench close to the runtime path.
const WINFS = path.resolve(import.meta.dirname, "..", "..");
const distRoot = path.join(WINFS, "dist");

const { checkAllowed } = await import(path.join(distRoot, "core", "allowed_roots.js").replace(/\\/g, "/").replace(/^C:/, "file:///C:"));
const atomicWriteMod = await import(path.join(distRoot, "core", "atomic_write.js").replace(/\\/g, "/").replace(/^C:/, "file:///C:"));
const auditMod = await import(path.join(distRoot, "core", "audit.js").replace(/\\/g, "/").replace(/^C:/, "file:///C:"));
const utf8Mod = await import(path.join(distRoot, "core", "utf8.js").replace(/\\/g, "/").replace(/^C:/, "file:///C:"));

const { atomicWriteFile } = atomicWriteMod;
const { appendAudit, flushAudit } = auditMod;
const { encodeUtf8NoBom } = utf8Mod;

const RAW_CSV = path.join(WINFS, "audit", "investigations", "v0.8-audit-io-raw.csv");

const SIZES = [
  { label: "1KB", bytes: 1024 },
  { label: "10KB", bytes: 10 * 1024 },
  { label: "100KB", bytes: 100 * 1024 },
  { label: "1MB", bytes: 1024 * 1024 },
  { label: "10MB", bytes: 10 * 1024 * 1024 },
];
const WARMUP = 5;
const ITERS = 30;
const HARD_LIMIT_MS = 60_000;

function ns() {
  return performance.now() * 1_000_000;
}

async function setup() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "winfs-bench-"));
  const realRoot = await fs.realpath(tmpRoot);

  // Synthesise a minimal ResolvedConfig the impls expect. We need:
  // - resolvedAllowedRoots (so checkAllowed accepts the path)
  // - resolvedAuditLogPath (so appendAudit has somewhere to write)
  // - auditLogMaxBytes (rotation threshold)
  // - serverMode for audit record shape
  const auditPath = path.join(realRoot, "audit.jsonl");
  const config = {
    allowedRoots: [realRoot],
    allowedUrlHosts: [],
    deniedUrlPatterns: [],
    shellBlocklist: [],
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 60_000,
    shellTimeoutMs: 30_000,
    shellMaxTimeoutMs: 300_000,
    fetchUrlMaxBytes: 5 * 1024 * 1024,
    fetchUrlTimeoutMs: 15_000,
    readMaxBytes: 50 * 1024 * 1024,
    maxDiffBytes: 256 * 1024,
    execMaxOutputBytes: 1 * 1024 * 1024,
    execExtraBlocklist: [],
    execSanitizeEnv: false,
    pythonHome: undefined,
    unrestrictedFilesystem: false,
    unrestrictedFilesystemConfirm: undefined,
    sshExePath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    processMaxConcurrent: 16,
    processBufferCap: 1024 * 1024,
    processSessionTtlMs: 60_000,
    processGcIntervalMs: 10_000,
    auditLogMaxBytes: 100 * 1024 * 1024, // large enough to never rotate during bench
    configPath: "<bench>",
    resolvedAllowedRoots: [realRoot],
    resolvedAuditLogPath: auditPath,
    version: "bench",
    serverMode: "strict",
  };

  return { realRoot, config };
}

async function teardown(realRoot) {
  await flushAudit();
  try {
    await fs.rm(realRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makePayload(bytes) {
  // Use a printable-ASCII pattern so encodeUtf8NoBom doesn't change byte count.
  const block = "the quick brown fox jumps over the lazy dog ";
  const need = Math.ceil(bytes / block.length);
  return block.repeat(need).slice(0, bytes);
}

// ── variants ─────────────────────────────────────────────────────────────

async function variantAFull(absPath, content, config) {
  const t0 = ns();
  // validation
  const check = await checkAllowed(absPath, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) throw new Error(`EPERM_ROOT: ${absPath}`);
  const realPath = check.realPath;
  const t1 = ns();
  // encode
  const buf = encodeUtf8NoBom(content);
  const t2 = ns();
  // atomic write
  await atomicWriteFile(realPath, buf);
  const t4 = ns(); // tmp write + fsync + rename all inside atomicWriteFile
  // audit enqueue (fire-and-forget)
  appendAudit(config, {
    ts: new Date().toISOString(),
    tool: "write",
    args_summary: { path: realPath, content: `<redacted: ${buf.length} bytes>` },
    result_status: "ok",
    duration_ms: 0,
    mode: "strict",
  });
  const t5 = ns();
  const t6 = ns();
  return { t0, t1, t2, t3: t4, t4, t5, t6 };
}

async function variantBNoAudit(absPath, content, config) {
  const t0 = ns();
  const check = await checkAllowed(absPath, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) throw new Error(`EPERM_ROOT: ${absPath}`);
  const realPath = check.realPath;
  const t1 = ns();
  const buf = encodeUtf8NoBom(content);
  const t2 = ns();
  await atomicWriteFile(realPath, buf);
  const t4 = ns();
  // audit STUBBED — no-op
  const t5 = ns();
  const t6 = ns();
  return { t0, t1, t2, t3: t4, t4, t5, t6 };
}

async function variantCRaw(absPath, content, config) {
  const t0 = ns();
  const check = await checkAllowed(absPath, config, { allowMissing: true });
  if ("ok" in check && check.ok === false) throw new Error(`EPERM_ROOT: ${absPath}`);
  const realPath = check.realPath;
  const t1 = ns();
  const buf = encodeUtf8NoBom(content);
  const t2 = ns();
  // Single fs.writeFile — no temp, no fsync, no rename
  await fs.writeFile(realPath, buf);
  const t3 = ns();
  // No rename step → t4 = t3
  const t4 = t3;
  // No audit → t5 = t6 = t4
  const t5 = t4;
  const t6 = t4;
  return { t0, t1, t2, t3, t4, t5, t6 };
}

// Phase decomposition: phase name → (start, end) keys.
const PHASES = [
  ["t0_t1_validation", "t0", "t1"],
  ["t1_t2_encode", "t1", "t2"],
  ["t2_t3_write", "t2", "t3"],
  ["t3_t4_rename", "t3", "t4"],
  ["t4_t5_audit", "t4", "t5"],
  ["t5_t6_return", "t5", "t6"],
  ["t0_t6_total", "t0", "t6"],
];

// ── runner ───────────────────────────────────────────────────────────────

async function timedIter(variantFn, absPath, content, config) {
  const t0 = performance.now();
  let result, error;
  try {
    result = await variantFn(absPath, content, config);
  } catch (e) {
    error = e;
  }
  const elapsedMs = performance.now() - t0;
  return { result, elapsedMs, error };
}

async function runAll() {
  const { realRoot, config } = await setup();
  console.log(`bench setup: tempRoot=${realRoot}`);
  await fs.mkdir(path.join(WINFS, "audit", "investigations"), { recursive: true });

  const csvStream = createWriteStream(RAW_CSV, { flags: "w", encoding: "utf8" });
  csvStream.write("variant,size_label,size_bytes,iteration,phase,duration_ns\n");

  const variants = [
    ["A_full", variantAFull],
    ["B_no_audit", variantBNoAudit],
    ["C_raw", variantCRaw],
  ];

  // Per (variant, size) summary holder.
  const summary = [];

  for (const { label, bytes } of SIZES) {
    const payload = makePayload(bytes);
    for (const [variantName, fn] of variants) {
      console.log(`\n=== ${variantName}  size=${label} (${bytes} bytes) ===`);
      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        const dst = path.join(realRoot, `warmup_${variantName}_${label}_${i}.bin`);
        const { error, elapsedMs } = await timedIter(fn, dst, payload, config);
        if (error || elapsedMs > HARD_LIMIT_MS) {
          console.log(`  warmup ${i}: ABORT ${error?.message ?? `${elapsedMs}ms > limit`}`);
        }
      }
      // Measured
      const samples = []; // each = phase map
      let infCount = 0;
      for (let i = 0; i < ITERS; i++) {
        const dst = path.join(realRoot, `iter_${variantName}_${label}_${i}.bin`);
        const { result, error, elapsedMs } = await timedIter(fn, dst, payload, config);
        if (error || elapsedMs > HARD_LIMIT_MS) {
          infCount++;
          for (const [phase] of PHASES) {
            csvStream.write(`${variantName},${label},${bytes},${i},${phase},INF\n`);
          }
          continue;
        }
        const phaseDurations = {};
        for (const [phase, a, b] of PHASES) {
          const dur = result[b] - result[a];
          phaseDurations[phase] = dur;
          csvStream.write(`${variantName},${label},${bytes},${i},${phase},${dur.toFixed(0)}\n`);
        }
        samples.push(phaseDurations);
      }

      // Per-phase summary (mean, p50, p95, p99)
      const perPhase = {};
      for (const [phase] of PHASES) {
        const vals = samples.map((s) => s[phase]).sort((a, b) => a - b);
        if (vals.length === 0) {
          perPhase[phase] = { mean: NaN, p50: NaN, p95: NaN, p99: NaN, n: 0 };
          continue;
        }
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const p = (q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
        perPhase[phase] = {
          mean,
          p50: p(0.5),
          p95: p(0.95),
          p99: p(0.99),
          n: vals.length,
        };
      }

      console.log(`  iters: ${ITERS - infCount}/${ITERS} (${infCount} INF)`);
      for (const [phase] of PHASES) {
        const s = perPhase[phase];
        if (s.n === 0) continue;
        const fmtMs = (ns) => `${(ns / 1_000_000).toFixed(3)}ms`;
        console.log(`    ${phase.padEnd(20)} mean=${fmtMs(s.mean)} p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} p99=${fmtMs(s.p99)}`);
      }
      summary.push({ variant: variantName, sizeLabel: label, sizeBytes: bytes, perPhase, infCount });
    }
  }

  csvStream.end();
  await new Promise((r) => csvStream.on("finish", r));
  console.log(`\nraw CSV → ${RAW_CSV}`);

  await teardown(realRoot);
  return summary;
}

const summary = await runAll();

// Print a final compact table to stdout that the report-writing step can paste.
console.log("\n\n========== SUMMARY (mean per phase, milliseconds) ==========\n");
const sizeLabels = SIZES.map((s) => s.label);
const variantNames = ["A_full", "B_no_audit", "C_raw"];
console.log("Total wall-clock per write (t0..t6):");
console.log(`size       ${variantNames.map((v) => v.padStart(12)).join("")}`);
for (const label of sizeLabels) {
  const row = variantNames.map((v) => {
    const s = summary.find((x) => x.variant === v && x.sizeLabel === label);
    if (!s) return "N/A".padStart(12);
    const m = s.perPhase.t0_t6_total.mean / 1_000_000;
    return m.toFixed(2).padStart(12);
  });
  console.log(`${label.padEnd(11)}${row.join("")}`);
}

console.log("\nDelta A - B (audit contribution to total) and B - C (atomicity contribution to total):");
console.log(`size       ${"A-B (audit)".padStart(14)}${"B-C (atomic)".padStart(14)}`);
for (const label of sizeLabels) {
  const a = summary.find((x) => x.variant === "A_full" && x.sizeLabel === label);
  const b = summary.find((x) => x.variant === "B_no_audit" && x.sizeLabel === label);
  const c = summary.find((x) => x.variant === "C_raw" && x.sizeLabel === label);
  if (!a || !b || !c) {
    console.log(`${label.padEnd(11)}${"N/A".padStart(14)}${"N/A".padStart(14)}`);
    continue;
  }
  const audit = (a.perPhase.t0_t6_total.mean - b.perPhase.t0_t6_total.mean) / 1_000_000;
  const atomic = (b.perPhase.t0_t6_total.mean - c.perPhase.t0_t6_total.mean) / 1_000_000;
  console.log(`${label.padEnd(11)}${audit.toFixed(2).padStart(14)}${atomic.toFixed(2).padStart(14)}`);
}

console.log("\ndone.");

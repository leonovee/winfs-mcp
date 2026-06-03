#!/usr/bin/env node
// Build the winfs MCPB bundle: stage dist + production node_modules + the
// launcher shim + the safety-baseline config, sync the version from
// package.json into manifest.json, validate, and pack into
// dist-mcpb/winfs-<version>.mcpb.
//
// Reproducible: run `npm run build` first (this script also does it), then
// `node scripts/build-mcpb.mjs`. No network beyond `npm ci --omit=dev` for the
// runtime deps and `npx @anthropic-ai/mcpb` for validate/pack.

import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, "build", "mcpb");
const SERVER = path.join(STAGE, "server");
const OUT_DIR = path.join(ROOT, "dist-mcpb");

function run(cmd, cwd) {
  process.stderr.write(`$ ${cmd}\n`);
  execSync(cmd, { cwd: cwd ?? ROOT, stdio: "inherit" });
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;

  // 1. Compile fresh.
  run("npm run build");

  // 2. Clean + recreate staging.
  await fs.rm(STAGE, { recursive: true, force: true });
  await fs.mkdir(SERVER, { recursive: true });

  // 3. Copy compiled server, the launcher shim, and the safety baseline.
  await fs.cp(path.join(ROOT, "dist"), path.join(SERVER, "dist"), { recursive: true });
  await fs.cp(path.join(ROOT, "mcpb", "launch.mjs"), path.join(SERVER, "launch.mjs"));
  await fs.mkdir(path.join(SERVER, "configs"), { recursive: true });
  await fs.cp(
    path.join(ROOT, "configs", "default.json"),
    path.join(SERVER, "configs", "default.json"),
  );

  // 4. Production-only node_modules, resolved deterministically from the lock.
  await fs.cp(path.join(ROOT, "package.json"), path.join(SERVER, "package.json"));
  await fs.cp(path.join(ROOT, "package-lock.json"), path.join(SERVER, "package-lock.json"));
  run("npm ci --omit=dev --no-audit --no-fund", SERVER);

  // 5. Manifest: sync version from package.json so the two never drift.
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "mcpb", "manifest.json"), "utf8"));
  manifest.version = version;
  await fs.writeFile(
    path.join(STAGE, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  // 6. Validate then pack.
  run(`npx --yes @anthropic-ai/mcpb validate "${path.join(STAGE, "manifest.json")}"`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `winfs-${version}.mcpb`);
  run(`npx --yes @anthropic-ai/mcpb pack "${STAGE}" "${out}"`);

  process.stderr.write(`\n✓ Built ${out}\n`);
}

main().catch((err) => {
  process.stderr.write(`build-mcpb failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

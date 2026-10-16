#!/usr/bin/env node
// migrate-standard-material-pack.mjs --
//   feat-20260523-shader-template-instance-split M6-T01.
//
// One-shot codemod that rewrites every .pack.json asset matching
//   { kind: 'material', payload.shadingModel === 'standard' }
// into the schema-driven payload shape:
//   payload = {
//     materialShader: 'forgeax::default-standard-pbr',
//     paramSchema: <8-entry SSOT from packages/shader/src/default-standard-pbr.schema.json>,
//     values: { ...mapped from legacy fields... }
//   }
//
// Decision anchors:
//   - plan-strategy D-Migration: codemod is the single migration path; manual
//     edits over 5 .pack.json files would be error-prone. Idempotent
//     (architecture principle #6).
//   - plan-strategy D-DefaultStandardPbr-Identifier: the literal
//     'forgeax::default-standard-pbr' (with `::` prefix) routes through
//     ShaderRegistry.findMaterialArtifact at runtime; not a GUID.
//   - requirements AC-10: 1:1 data migration; legacy fields drop without
//     loss because they map directly to the 8-entry paramSchema.
//   - requirements AC-06: pixel parity (epsilon <= 0.05) post-migration is
//     the correctness gate; the codemod must produce values byte-equivalent
//     to what AssetRegistry would have stored under the StandardMaterialAsset
//     path.
//
// Field map (legacy -> values key/type):
//   baseColor                   -> baseColor                  (color, [r,g,b,a])
//   metallic                    -> metallic                   (f32)
//   roughness                   -> roughness                  (f32)
//   baseColorTexture (guid)     -> baseColorTexture           (texture2d, guid)
//   metallicRoughnessTexture    -> metallicRoughnessTexture   (texture2d, guid)
//   normalTexture               -> normalTexture              (texture2d, guid)
//   sampler                     -> sampler                    (sampler, guid)
//   channelMap (object {m,r,o}) -> channelMap (vec4 [m,r,o,a])
//
// channelMap encoding: legacy carried { metallic: 'b', roughness: 'g',
// occlusion: 'r' } where each value is one of 'r' | 'g' | 'b' | 'a'.
// Schema declares channelMap as vec4. We pack the 4 channel selectors as
// numeric indices [r=0, g=1, b=2, a=3] in the order [metallic, roughness,
// occlusion, _padding=0]; this matches default-standard-pbr.schema.json's
// default `[2, 1, 0, 0]` (i.e. metallic='b'=2, roughness='g'=1,
// occlusion='r'=0). Absent legacy channelMap -> we omit the key, letting
// the schema default fill in.
//
// Idempotency:
//   - second run skips entries already lacking shadingModel (the codemod's
//     own output has no shadingModel).
//   - paramSchema is read fresh from the schema JSON each run.
//
// Modes:
//   default            -> in-place rewrite + structured stdout summary.
//   --dry-run          -> print the new payload to stdout; do not write.
//   --files <glob...>  -> override file list (default: scan repo for
//                         **/*.pack.json under apps/, templates/).
//
// Exit codes:
//   0 = success (or dry-run with at least one file inspected)
//   1 = failure (schema missing, JSON parse error, write error)
//   2 = no eligible files found in target paths (sentinel for caller).
//
// Usage:
//   node scripts/migrate-standard-material-pack.mjs            # in-place
//   node scripts/migrate-standard-material-pack.mjs --dry-run  # preview
//
// AI users: this file is a one-shot tool. After M6 lands, it is preserved
// for documentation + idempotency-test reuse but not invoked at CI time.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// --- channel selector encoding ---------------------------------------------

const CHANNEL_INDEX = Object.freeze({ r: 0, g: 1, b: 2, a: 3 });

function encodeChannelMap(channelMap) {
  if (channelMap === undefined || channelMap === null) return undefined;
  const m = CHANNEL_INDEX[channelMap.metallic];
  const r = CHANNEL_INDEX[channelMap.roughness];
  const o = channelMap.occlusion === undefined ? 0 : CHANNEL_INDEX[channelMap.occlusion];
  if (m === undefined || r === undefined || o === undefined) {
    throw new Error(
      `migrate-standard-material-pack: invalid channelMap selectors (got ${JSON.stringify(channelMap)}); each must be one of 'r' | 'g' | 'b' | 'a'.`,
    );
  }
  return [m, r, o, 0];
}

// --- schema loader (paramSchema SSOT) --------------------------------------

function loadDefaultStandardPbrSchema(rootDir) {
  const schemaPath = resolve(rootDir, 'packages/shader/src/default-standard-pbr.schema.json');
  if (!existsSync(schemaPath)) {
    throw new Error(
      `migrate-standard-material-pack: paramSchema SSOT missing at ${schemaPath}; expected to read default-standard-pbr.schema.json.`,
    );
  }
  const raw = readFileSync(schemaPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `migrate-standard-material-pack: paramSchema SSOT JSON parse failed: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!Array.isArray(parsed.paramSchema)) {
    throw new Error(
      `migrate-standard-material-pack: paramSchema SSOT must declare paramSchema[] array (got ${typeof parsed.paramSchema}).`,
    );
  }
  return parsed.paramSchema;
}

// --- payload migration -----------------------------------------------------

/**
 * Build the schema-driven payload from a legacy standard-shading payload.
 * Returns null when the asset is not a standard-shading material (no-op
 * for unlit / sprite / already-migrated assets).
 *
 * Idempotency: assets without `shadingModel` (the codemod's own output)
 * return null and are skipped; the same input maps to the same output.
 */
export function migratePayload(payload, paramSchema) {
  if (payload === undefined || payload === null || typeof payload !== 'object') return null;
  if (payload.shadingModel !== 'standard') return null;

  const values = {};
  if (Array.isArray(payload.baseColor)) {
    // Legacy stored RGBA quartet; preserve verbatim (schema entry type 'color').
    values.baseColor = [...payload.baseColor];
  }
  if (typeof payload.metallic === 'number') {
    values.metallic = payload.metallic;
  }
  if (typeof payload.roughness === 'number') {
    values.roughness = payload.roughness;
  }
  if (typeof payload.baseColorTexture === 'string') {
    values.baseColorTexture = payload.baseColorTexture;
  }
  if (typeof payload.metallicRoughnessTexture === 'string') {
    values.metallicRoughnessTexture = payload.metallicRoughnessTexture;
  }
  if (typeof payload.normalTexture === 'string') {
    values.normalTexture = payload.normalTexture;
  }
  if (typeof payload.sampler === 'string') {
    values.sampler = payload.sampler;
  }
  if (payload.channelMap !== undefined && payload.channelMap !== null) {
    const encoded = encodeChannelMap(payload.channelMap);
    if (encoded !== undefined) {
      values.channelMap = encoded;
    }
  }

  return {
    materialShader: 'forgeax::default-standard-pbr',
    paramSchema: paramSchema.map((entry) => ({ ...entry })),
    values,
  };
}

/**
 * Migrate a parsed pack JSON object (the full file contents). Returns
 * { changed: boolean, pack: <new pack object> }.
 *
 * Idempotency: if no asset entry matches the standard-shading filter,
 * `changed` is false and the returned pack is structurally equal.
 */
export function migratePack(pack, paramSchema) {
  if (
    pack === undefined ||
    pack === null ||
    typeof pack !== 'object' ||
    !Array.isArray(pack.assets)
  ) {
    return { changed: false, pack };
  }
  let changed = false;
  const newAssets = pack.assets.map((asset) => {
    if (asset === null || typeof asset !== 'object') return asset;
    if (asset.kind !== 'material') return asset;
    const newPayload = migratePayload(asset.payload, paramSchema);
    if (newPayload === null) return asset;
    changed = true;
    return { ...asset, payload: newPayload };
  });
  return changed ? { changed, pack: { ...pack, assets: newAssets } } : { changed: false, pack };
}

// --- file-system scanner ---------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.worktrees',
  '.claude',
  'forgeax-engine-assets',
  '.forgeax-harness',
]);

function* walkPackJsonFiles(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        // skip hidden top-level dirs (we already exclude .git/.worktrees above)
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
          // allow .github etc. to be walked; ditto for .forgeax-harness which
          // is already on SKIP_DIRS. Anything else hidden gets walked.
          stack.push(join(dir, entry.name));
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.pack.json')) {
        yield join(dir, entry.name);
      }
    }
  }
}

// --- driver ----------------------------------------------------------------

function parseArgs(argv) {
  const flags = { dryRun: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i += 1;
        flags.files.push(argv[i]);
      }
    } else if (a === '--help' || a === '-h') {
      console.log('usage: migrate-standard-material-pack.mjs [--dry-run] [--files <path>...]');
      process.exit(0);
    }
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const paramSchema = loadDefaultStandardPbrSchema(repoRoot);

  const targets =
    flags.files.length > 0 ? flags.files.map((p) => resolve(p)) : [...walkPackJsonFiles(repoRoot)];

  if (targets.length === 0) {
    console.error('[migrate] no .pack.json files found under repo root.');
    process.exit(2);
  }

  let inspected = 0;
  let changed = 0;
  let skipped = 0;
  const changedPaths = [];

  for (const target of targets) {
    let raw;
    try {
      raw = readFileSync(target, 'utf8');
    } catch (e) {
      console.error(`[migrate] read failed ${target}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    let pack;
    try {
      pack = JSON.parse(raw);
    } catch (e) {
      console.error(`[migrate] parse failed ${target}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    inspected += 1;
    const result = migratePack(pack, paramSchema);
    if (!result.changed) {
      skipped += 1;
      continue;
    }
    changed += 1;
    const rel = relative(repoRoot, target);
    changedPaths.push(rel);
    const out = `${JSON.stringify(result.pack, null, 2)}\n`;
    if (flags.dryRun) {
      console.log(`--- ${rel} (dry-run) ---`);
      console.log(out);
    } else {
      writeFileSync(target, out, 'utf8');
      console.log(`[migrate] wrote ${rel}`);
    }
  }

  console.log(
    `[migrate] inspected=${inspected} changed=${changed} skipped=${skipped} dryRun=${flags.dryRun}`,
  );
  if (changed > 0 && !flags.dryRun) {
    console.log('[migrate] changed files:');
    for (const p of changedPaths) console.log(`  ${p}`);
  }
}

// invoke main when called directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// avoid unused-imports warnings under typecheck
void statSync;

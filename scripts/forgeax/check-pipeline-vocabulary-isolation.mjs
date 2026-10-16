#!/usr/bin/env node
// I-1 engine-neutrality gate: URP pipeline vocabulary (LightMode / Forward /
// ShadowCaster) must never leak into engine-neutral packages' src/ directories.
// Plan-strategy D-6: CI grep gate; requirements AC-11 + constraint C-5.
//
// Context-aware matching — only intercepts tag-value patterns:
//   LightMode: 'Forward'   /   LightMode: "Forward"
//   LightMode: 'ShadowCaster'   /   LightMode: "ShadowCaster"
// (Does NOT intercept English comments containing the word "Forward" unless
// they also match the tag-syntax pattern.)
//
// Allowlist (pipeline-aware locations; these are skipped entirely):
//   packages/runtime/src/{materials.ts,urp-pipeline.ts,__tests__/}
//   apps/   *.md
//
// Banlist (engine-neutral; their src/ must have zero hits):
//   types, ecs, rhi, render-graph, shader, console, pack, image, input,
//   physics*, audio*, font, gltf, import, vite-plugin-*, shader-compiler,
//   naga, wgpu-wasm, rhi-webgpu, rhi-wgpu, math.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOT = process.argv[2] ?? '.';

// --- allowlist -----------------------------------------------------------

const ALLOWLIST_GLOBS = [
  'packages/runtime/src/materials.ts',
  'packages/runtime/src/urp-pipeline.ts',
  'packages/runtime/src/__tests__/',
  // gltf is a bridge package: it consumes glTF and produces MaterialAsset
  // descriptors that the URP pipeline consumes. Like Materials.standard /
  // urp-pipeline.ts it speaks URP vocabulary by design (the produced pass
  // tags are read by the URP recordShadowPass / recordMainPass selectors).
  // Confined to bridge.ts where the descriptor literal lives.
  'packages/gltf/src/bridge.ts',
  'apps/',
];

function isAllowlisted(rel) {
  return ALLOWLIST_GLOBS.some((g) => {
    if (g.endsWith('/')) return rel.startsWith(g);
    return rel === g;
  });
}

// --- banlist packages ----------------------------------------------------

const BANLIST_PACKAGES = [
  'packages/types',
  'packages/ecs',
  'packages/rhi',
  'packages/render-graph',
  'packages/shader',
  'packages/console',
  'packages/pack',
  'packages/image',
  'packages/input',
  'packages/physics',
  'packages/physics-rapier2d',
  'packages/physics-rapier3d',
  'packages/audio',
  'packages/audio-webaudio',
  'packages/font',
  'packages/gltf',
  'packages/import',
  'packages/vite-plugin-pack',
  'packages/vite-plugin-shader',
  'packages/shader-compiler',
  'packages/naga',
  'packages/wgpu-wasm',
  'packages/rhi-webgpu',
  'packages/rhi-wgpu',
  'packages/math',
];

// --- file walker (skips node_modules) ------------------------------------

function* walkFiles(dir, ext) {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'node_modules') continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (name.endsWith(ext)) {
        yield p;
      }
    }
  }
}

// --- scanner -------------------------------------------------------------

/**
 * Scan one file for tag-vocabulary hits. Returns array of {line, hit}.
 */
function scanFile(abs) {
  const content = readFileSync(abs, 'utf8');
  const lines = content.split('\n');
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Tag-position LightMode pattern (context-aware: only tag-value form).
    const lmr = /LightMode\s*:\s*['"](Forward|ShadowCaster)['"]/g;
    let m = lmr.exec(line);
    while (m !== null) {
      results.push({ line: i + 1, hit: m[0].trim() });
      m = lmr.exec(line);
    }
  }

  return results;
}

// --- main ----------------------------------------------------------------

const hits = [];
const checkedDirs = [];

for (const pkgDir of BANLIST_PACKAGES) {
  const srcDir = join(ROOT, pkgDir, 'src');
  if (!existsSync(srcDir)) continue;
  checkedDirs.push(pkgDir);

  // Scan .ts and .md files inside src/ only.
  for (const ext of ['.ts', '.md']) {
    for (const abs of walkFiles(srcDir, ext)) {
      const rel = relative(ROOT, abs);
      if (isAllowlisted(rel)) continue;

      const fileHits = scanFile(abs);
      for (const h of fileHits) {
        hits.push({ file: rel, line: h.line, hit: h.hit });
      }
    }
  }
}

// --- report --------------------------------------------------------------

if (hits.length > 0) {
  process.stderr.write(
    'I-1 FAIL: engine-neutral packages src/ contain URP pipeline vocabulary:\n\n',
  );
  for (const h of hits) {
    process.stderr.write(`  ${h.file}:${h.line}  ${h.hit}\n`);
  }
  process.stderr.write(
    '\nThese symbols (LightMode / Forward / ShadowCaster) belong to the\n' +
      'URP pipeline layer (packages/runtime/) and must not leak into\n' +
      'engine-neutral packages.\n\n' +
      'Allowlist (pipeline-aware locations):\n' +
      '  packages/runtime/src/materials.ts\n' +
      '  packages/runtime/src/urp-pipeline.ts\n' +
      '  packages/runtime/src/__tests__/\n' +
      '  packages/gltf/src/bridge.ts (URP-bridge: produces URP-tagged MaterialAsset)\n' +
      '  apps/\n' +
      '  *.md\n\n' +
      '[hint] If adding a new pipeline-aware package, update the allowlist\n' +
      'in scripts/forgeax/check-pipeline-vocabulary-isolation.mjs.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `I-1 OK: engine-neutral packages src/ pipeline vocabulary clean ` +
    `(checked: ${checkedDirs.join(', ')})\n`,
);
process.exit(0);

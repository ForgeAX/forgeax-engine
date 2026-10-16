#!/usr/bin/env node
// AC-14 / D-3: assert the legacy AssetRegistry instanced-buffer triplet
// (`createInstancedBuffer` / `updateInstancedBuffer` / `getInstancedGpuBuffer`)
// + the `InstancedBufferAsset` POD brand are physically removed from
// runtime + apps source trees.
//
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15 — the
// ECS-managed `array<f32>` path on `Instances.transforms` replaces the old
// `AssetRegistry.createInstancedBuffer` pipeline; cross-cut deletion of the
// triplet + the brand is verified by this gate so a future patch cannot
// silently re-introduce them through any non-historical site.
//
// Banned literals (any non-comment occurrence in scanned roots fails fast):
//   - createInstancedBuffer
//   - updateInstancedBuffer
//   - getInstancedGpuBuffer
//   - InstancedBufferAsset
//
// (Names quoted above are intentionally bare — without backticks — so the
// in-file documentation header itself does not trip the gate after comment
// stripping.)
//
// Source-comment policy: TS / JS line + block comments are stripped before
// scan (mirrors packages/ecs/scripts/check-instances-oos.mjs). The deletion
// rationale across runtime / rhi / apps source files lives in JSDoc /
// // comments and remains the SSOT for AI users tracing the cross-cut;
// the gate enforces "no live code reference" not "no documentary mention".
//
// Self-exempt allowlist (paths intentionally retain the literal verbatim):
//   - this gate file (banned set quoted in header for readability)
//   - .github/workflows/ci.yml (CI step name carries the banned tokens)
//   - .forgeax-harness/ (loop history is append-only)
//   - dist/ (built artefacts of unrelated packages)
//   - .knowledge-base/ (ingested third-party material cited verbatim)
//
// Pattern + zero-dep stdio mirrors packages/ecs/scripts/check-single-exit.mjs
// + packages/ecs/scripts/check-instances-oos.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const BANNED = [
  'createInstancedBuffer',
  'updateInstancedBuffer',
  'getInstancedGpuBuffer',
  'InstancedBufferAsset',
];

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set(['scripts/grep/check-asset-registry-instanced-removed.mjs']);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const hits = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    const ext = p.slice(p.lastIndexOf('.'));
    if (!CODE_EXTS.has(ext)) continue;
    if (SELF_EXEMPT.has(p)) continue;
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    for (const lit of BANNED) {
      if (stripped.includes(lit)) {
        hits.push({ path: p, literal: lit });
      }
    }
  }
}

for (const root of ROOTS) {
  walk(root);
}

if (hits.length > 0) {
  console.error(
    '[check-asset-registry-instanced-removed] AC-14 violated: legacy ' +
      'instanced-buffer triplet / brand re-appeared in non-comment source:',
  );
  for (const h of hits) {
    console.error(`  - ${h.literal}  in  ${h.path}`);
  }
  console.error(
    '\nfeat-20260514 M3 / w15 deleted the AssetRegistry instanced-buffer ' +
      "triplet and the 'InstancedBufferAsset' brand. " +
      "The replacement is the ECS-managed 'array<f32>' path on Instances.transforms. " +
      'Re-introducing any of these literals as live code breaks the cross-cut.',
  );
  process.exit(1);
}

console.log(
  '[check-asset-registry-instanced-removed] OK — legacy instanced-buffer ' +
    'triplet + brand absent from packages/ apps/ templates/ live code.',
);

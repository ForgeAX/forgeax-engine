#!/usr/bin/env node
// AC-10 / w24 (feat-20260515-buffer-array-vocab-collapse M5): assert that
// the legacy `arrayStride: { ... }` option on `defineComponent` cannot
// re-appear at any call-site. The option-bit was deleted at M1 / w5
// (component.ts `DefineComponentOptions.arrayStride` removed) and the
// stride-enforcement responsibility migrated to the RenderSystem extract
// entry (decision §2.3). The single legacy caller (`Instances.transforms`
// in packages/runtime/src/components/instances.ts) was updated at M3 / w16.
//
// Banned pattern (regex; case-sensitive):
//   - `defineComponent(...{...arrayStride:...}...)`
//
// The match shape targets `defineComponent` invocations only — bare
// `arrayStride` identifiers elsewhere (notably `GPUVertexBufferLayout.arrayStride`
// in WebGPU pipeline descriptors at packages/runtime/src/createRenderer.ts)
// are unrelated and intentionally NOT banned.
//
// Files scanned: TS / JS source under packages/ + apps/ + templates/.
// Markdown docs are scanned separately (READMEs retain historical mentions);
// .forgeax-harness/ history is exempt by virtue of not being scanned.
//
// Self-exempt:
//   - this gate file
//   - packages/ecs/src/__tests__/define-component-options.test-d.ts (the
//     test-d AC-05 negative anchor intentionally calls
//     `defineComponent('Bar', { f: 'array<f32>' }, { arrayStride: { f: 16 } })`
//     under a `@ts-expect-error` line to lock the option-bit removal)
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-asset-registry-instanced-removed.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT = new Set([
  'scripts/grep/check-no-array-stride-option.mjs',
  'packages/ecs/src/__tests__/define-component-options.test-d.ts',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.cache', 'test-output']);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

// Match `defineComponent(...)` calls that contain an `arrayStride:` key in
// their options object. The lazy match must not cross `)` (call end) so that
// in merged test files (feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// M2 outputs) a `defineComponent(...)` in one block plus an unrelated
// `GPUVertexBufferLayout { arrayStride: ... }` in another block do not
// false-match. The `[^)]*?` bound keeps the match within a single call.
const RE_DEFINE_COMPONENT_ARRAY_STRIDE = /defineComponent\s*\([^)]*?\{[^)]*?\barrayStride\s*:/m;

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
    const m = stripped.match(RE_DEFINE_COMPONENT_ARRAY_STRIDE);
    if (m) {
      hits.push({ path: p, snippet: m[0].slice(0, 200) });
    }
  }
}

for (const root of ROOTS) {
  walk(root);
}

if (hits.length > 0) {
  console.error(
    '[check-no-array-stride-option] AC-10 violated: deleted ' +
      '`defineComponent(...{ arrayStride: ... })` option re-appeared in ' +
      'non-comment source:',
  );
  for (const h of hits) {
    console.error(`  - ${h.path}`);
    console.error(`      ${h.snippet}`);
  }
  console.error(
    '\nfeat-20260515-buffer-array-vocab-collapse M1 / w5 deleted the ' +
      '`arrayStride` key from `DefineComponentOptions`. Stride enforcement ' +
      'moved to the RenderSystem extract entry (defensive fail-fast against ' +
      '`Instances.transforms.length % 16 !== 0`, routing ' +
      '`instance-transforms-stride-mismatch`). Spawn-site writes a flat ' +
      '`new Float32Array(N * 16)` directly. See AGENTS.md §Breaking changes ' +
      '2026-05-15 row + packages/runtime/README.md §Instances.',
  );
  process.exit(1);
}

console.log(
  '[check-no-array-stride-option] OK — deleted `arrayStride` option ' +
    'absent from `defineComponent` call-sites under packages/ apps/ templates/.',
);

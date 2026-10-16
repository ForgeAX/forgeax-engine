#!/usr/bin/env node
// AC-12 (feat-20260608-create-app-param-surface-trim M3 / TASK-024): assert
// that the literal string `'/shaders/manifest.json'` (single- or double-
// quoted) does not re-appear anywhere under `apps/`. The manifest URL is
// owned by the `@forgeax/engine-vite-plugin-shader` plugin emit path
// (single SSOT in `SHADER_MANIFEST_URL`) and surfaced to demos through the
// `virtual:forgeax/bundler` virtual module's `forgeaxBundlerAdapter()`
// factory. AI users discover the wiring by the one-line `import` of the
// adapter rather than by typing the URL literal.
//
// Banned pattern (case-sensitive, on the post-comment-stripped source):
//   - `'/shaders/manifest.json'`
//   - `"/shaders/manifest.json"`
//
// Files scanned: TS / JS source under `apps/` only. `packages/` is exempt
// because the plugin (`packages/vite-plugin-shader`), the runtime fallback
// (`packages/runtime/src/createRenderer.ts`), and the dev middleware all
// legitimately carry the literal as the single SSOT.
//
// Self-exempt:
//   - this gate file (mentions the literal in comments)
//
// Comment-stripped: a line such as `// fetch '/shaders/manifest.json'`
// inside a `.ts` file is allowed; only code-position occurrences trigger
// the gate. This mirrors `check-no-array-stride-option.mjs`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['apps'];

const SELF_EXEMPT = new Set(['scripts/grep/check-no-shader-manifest-url-literal.mjs']);

// `__test-stubs__` carries vitest-time aliases for build-time virtual modules
// (`virtual:forgeax/bundler` -> `apps/shared/src/__test-stubs__/virtual-bundler-stub.ts`).
// The stub legitimately holds the URL literal that the runtime plugin emits;
// it is consumed only under the vitest alias and never reaches production
// bundles, so it is exempt from the AC-12 surface that targets demo source.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.cache',
  'test-output',
  '__test-stubs__',
]);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

// Two regex variants: single- and double-quoted forms.
const RE_SINGLE = /'\/shaders\/manifest\.json'/;
const RE_DOUBLE = /"\/shaders\/manifest\.json"/;

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
    const matchSingle = stripped.match(RE_SINGLE);
    const matchDouble = stripped.match(RE_DOUBLE);
    if (matchSingle || matchDouble) {
      hits.push({
        path: p,
        snippet: (matchSingle ?? matchDouble)[0],
      });
    }
  }
}

for (const root of ROOTS) {
  walk(root);
}

if (hits.length > 0) {
  console.error(
    '[check-no-shader-manifest-url-literal] AC-12 violated: literal ' +
      "'/shaders/manifest.json' re-appeared in non-comment apps/ source:",
  );
  for (const h of hits) {
    console.error(`  - ${h.path}`);
    console.error(`      ${h.snippet}`);
  }
  console.error(
    '\nfeat-20260608-create-app-param-surface-trim M3 / TASK-024 enforces ' +
      'that the shader manifest URL is plumbed solely through the build-time ' +
      'virtual:forgeax/bundler adapter. Replace the literal call with:\n' +
      "  import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';\n" +
      '  const app = await createApp(canvas, {}, forgeaxBundlerAdapter());\n' +
      'See packages/app/README.md §Third-arg `BundlerOptions` and ' +
      'packages/vite-plugin-shader/README.md §`virtual:forgeax/bundler`.',
  );
  process.exit(1);
}

console.log(
  "[check-no-shader-manifest-url-literal] OK -- literal '/shaders/manifest.json' " +
    'absent from non-comment apps/ source.',
);

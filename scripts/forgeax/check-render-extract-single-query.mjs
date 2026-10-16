#!/usr/bin/env node
// AC-06 RenderSystem extract single-query gate
// (feat-20260517-merge-mesh-renderer-material-renderer M3 / w8;
// plan-strategy section 4 R-A6 / requirements AC-06 main signal).
//
// ts-morph AST traversal of the extract owners, including the environment
// projection (`extract/world-environment.ts`), asserting
// that the implementation contains exactly ONE call expression whose query
// descriptor references the `MeshRenderer` token. Domain extraction helpers
// must preserve the one logical renderable query boundary.
// Auxiliary camera and light queries are intentionally not material-coupled
// and must not affect the count.
//
// Why ts-morph + reverse-grep belt-and-suspenders (research F-B1 +
// plan-strategy R-A6): the file pre-w9 carries 4 archetype query
// expressions (renderableQueryFull / renderableQueryNoMaterial /
// renderableQueryNoTransform / materialQuery) plus a direct
// archetype-graph traversal that reads the MeshRenderer column for the
// instanced full path. A naive `rg 'MeshRenderer'` cannot tell apart
// query construction from token re-use; the AST gate is the precise
// signal. The accompanying reverse-grep gate (5-f32 column reads,
// fallback query identifiers) is the secondary signal that catches
// reverse-coupling regressions if someone reintroduces the fallback
// pattern outside of World query descriptor literals.
//
// Failure modes (exit code 1):
//   - Anything other than one world.query expression across the extract owner
//     modules whose descriptor references `MeshRenderer` (zero means extraction
//     escaped the query boundary; multiple means the alpha split regrew);
//   - Lingering 5-f32 column-read literal (`m.baseColorR[`,
//     `m.baseColorG[`, `m.baseColorB[`, `m.metallic[`, `m.roughness[`)
//     anywhere in the file (reverse-coupling fail-safe);
//   - Lingering fallback identifier literals
//     (`renderableQueryNoMaterial`, `renderableQueryNoTransform`,
//     `renderableQueryFull`) anywhere in the file (regrowth detector).
//
// CLI:
//   node scripts/forgeax/check-render-extract-single-query.mjs
//   node scripts/forgeax/check-render-extract-single-query.mjs --help

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Project, SyntaxKind } from 'ts-morph';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const TARGETS = [
  resolve(REPO_ROOT, 'packages/render/src/render-system-extract.ts'),
  resolve(REPO_ROOT, 'packages/render/src/render-system-extract-tail.ts'),
  resolve(REPO_ROOT, 'packages/render/src/extract/world-environment.ts'),
];

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `${[
      'check-render-extract-single-query: AC-06 main signal',
      '',
      'Usage:',
      '  node scripts/forgeax/check-render-extract-single-query.mjs',
      '',
      'Asserts that the render extract owners contain EXACTLY ONE',
      'world.query call whose descriptor references the MeshRenderer token.',
      'Pairs with',
      'check-render-record-no-material-asset-get.mjs (record-side',
      'reverse-grep) for AC-06 + AC-07 belt-and-suspenders coverage.',
      '',
      'Exit codes:',
      '  0  exactly one MeshRenderer-bearing query in extract',
      '  1  zero or multiple MeshRenderer-bearing queries OR 5-f32 column',
      '     reads OR fallback query identifiers regrew',
    ].join('\n')}\n`,
  );
  process.exit(0);
}

const failures = [];

const project = new Project({ skipAddingFilesFromTsConfig: true });
const sourceFiles = TARGETS.map((target) => project.addSourceFileAtPath(target));

// AST pass: count *.query calls whose first argument is an object literal
// carrying MeshRenderer in any component-bearing descriptor property.
const meshRendererQueryHits = [];
const componentDescriptorProperties = new Set([
  'read',
  'write',
  'optional',
  'with',
  'without',
  'added',
  'changed',
]);
for (const sf of sourceFiles) {
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const expr = node.getExpression().getText();
    const isQueryCtor = /\.query$/.test(expr) || /\.query$/.test(expr.split('(')[0]);
    if (!isQueryCtor) return;
    const args = node.getArguments();
    const first = args[0];
    if (!first) return;
    if (first.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
    const props = first.getProperties();
    for (const p of props) {
      if (p.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const name = p.getName();
      if (!componentDescriptorProperties.has(name)) continue;
      const init = p.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.ArrayLiteralExpression) continue;
      const text = init.getText();
      if (/\bMeshRenderer\b/.test(text)) {
        meshRendererQueryHits.push({
          file: sf.getBaseName(),
          line: node.getStartLineNumber(),
          snippet: node.getText().split('\n')[0].slice(0, 120),
        });
      }
    }
  });
}

if (meshRendererQueryHits.length !== 1) {
  failures.push({
    code: 'AC-06-QUERY-COUNT',
    msg: `extract has ${meshRendererQueryHits.length} *.query calls whose descriptor references MeshRenderer (expected exactly 1).`,
    sites: meshRendererQueryHits.map((h) => `  line ${h.line}: ${h.snippet}`),
  });
}

// Reverse-grep: 5-f32 column read literals (alpha path direct ECS column
// access regrowth detector).
const text = TARGETS.map((target) => readFileSync(target, 'utf8')).join('\n');
const fiveF32Patterns = [
  /m\.baseColorR\[/,
  /m\.baseColorG\[/,
  /m\.baseColorB\[/,
  /m\.metallic\[/,
  /m\.roughness\[/,
];
for (const pat of fiveF32Patterns) {
  const m = text.match(pat);
  if (m) {
    const lineNumber = text.slice(0, m.index ?? 0).split('\n').length;
    failures.push({
      code: 'AC-06-5F32-REGROWTH',
      msg: `extract still reads the legacy MeshRenderer 5-f32 inline column: ${m[0]}`,
      sites: [`  line ${lineNumber}`],
    });
  }
}

// Reverse-grep: fallback / full archetype query identifiers (regrowth detector).
const fallbackIdents = [
  'renderableQueryNoMaterial',
  'renderableQueryNoTransform',
  'renderableQueryFull',
];
for (const ident of fallbackIdents) {
  const re = new RegExp(`\\b${ident}\\b`);
  const m = text.match(re);
  if (m) {
    const lineNumber = text.slice(0, m.index ?? 0).split('\n').length;
    failures.push({
      code: 'AC-06-FALLBACK-REGROWTH',
      msg: `extract still names a deleted fallback / full-archetype query identifier: ${ident}`,
      sites: [`  line ${lineNumber}`],
    });
  }
}

if (failures.length > 0) {
  process.stderr.write('AC-06 extract single-query gate FAIL:\n');
  for (const f of failures) {
    process.stderr.write(`  [${f.code}] ${f.msg}\n`);
    for (const s of f.sites) process.stderr.write(`${s}\n`);
  }
  process.stderr.write(
    '\n[hint] Keep exactly ONE world.query expression with `MeshRenderer` in its descriptor. Delete fallback queries, the legacy non-instanced split, direct graph traversal, and the direct column-read 5-f32 path.\n',
  );
  process.exit(1);
}

process.stdout.write('AC-06 extract single-query gate PASS\n');

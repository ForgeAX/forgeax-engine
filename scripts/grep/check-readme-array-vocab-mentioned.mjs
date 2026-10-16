#!/usr/bin/env node
// AC-14: assert that the new array-vocab keywords + the schema-vocab usage
// of Children / Instances are mentioned in the AI-user-facing README files
// (charter proposition 1: discoverability — one ripgrep pass surfaces the
// vocab; charter proposition 4: text-over-image — README is the SSOT for
// schema-vocab semantics).
//
// feat-20260514-ecs-children-instances-managed-buffer-array M4 / w18+w19 —
// requirements §AC-14 mandates that the migrated vocabulary surface in
// packages/ecs/README.md (schema-vocab quick-ref + EcsErrorCode reverse
// anchors) and packages/runtime/README.md (Children / Instances chapters).
// This gate is the reverse-coupling discoverability check.
//
// Required keywords (each must occur at least once across the two READMEs;
// failure to find any one of them exits 1):
//
//   - 'array<T,N>'           — fixed-length array vocab (FixedArrayView path)
//   - 'array<T>'             — variable-length array vocab (VarArrayView path)
//   - 'Children { entities'  — Children component schema literal
//   - 'Instances { transforms' — Instances component schema literal
//
// Self-exempt: this gate file (the keyword set is quoted in the header for
// readability and would shadow the README scan if not exempted).
//
// Pattern + zero-dep stdio mirrors packages/ecs/scripts/check-single-exit.mjs.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const TARGETS = ['packages/ecs/README.md', 'packages/runtime/README.md'];

const REQUIRED = ['array<T,N>', 'array<T>', 'Children { entities', 'Instances { transforms'];

const corpus = [];
for (const p of TARGETS) {
  try {
    corpus.push({ path: p, text: readFileSync(p, 'utf8') });
  } catch (e) {
    console.error(`[check-readme-array-vocab-mentioned] cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
}

const missing = [];
for (const kw of REQUIRED) {
  const hit = corpus.some((c) => c.text.includes(kw));
  if (!hit) missing.push(kw);
}

if (missing.length > 0) {
  console.error(
    '[check-readme-array-vocab-mentioned] AC-14 violated: required ' +
      'array-vocab keywords absent from AI-user READMEs:',
  );
  for (const kw of missing) {
    console.error(`  - missing: ${kw}`);
  }
  console.error('\nScanned files:');
  for (const c of corpus) {
    console.error(`  - ${c.path}`);
  }
  console.error(
    '\nThe array vocab (array<T,N> + array<T>) is the discoverability ' +
      'surface for FixedArrayView / VarArrayView. Children + Instances ' +
      'schema literals (Children { entities + Instances { transforms) are ' +
      'the canonical component shapes consumed by AI users via ' +
      'world.spawn / world.set / world.get. Add the keywords to the ' +
      'schema-vocab quick-ref / Children / Instances sections.',
  );
  process.exit(1);
}

console.log(
  '[check-readme-array-vocab-mentioned] OK — all 4 required array-vocab ' +
    'keywords present across packages/ecs/README.md + packages/runtime/README.md.',
);

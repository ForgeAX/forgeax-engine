#!/usr/bin/env node
// AC-12: assert that the new 'string' schema vocab keyword + the Name
// component declaration form + the StringView value-shape symbol are
// mentioned in the AI-user-facing README file (charter proposition 1:
// discoverability — one ripgrep pass surfaces the vocab; charter
// proposition 4: text-over-image — README is the SSOT for schema-vocab
// semantics).
//
// feat-20260515-ecs-name-component-and-string-schema M3 / w3-grep-gate-script —
// requirements §AC-12 mandates that the additive vocabulary surface in
// packages/ecs/README.md (schema-vocab quick-ref + Name component section
// + StringView value-shape table). This gate is the reverse-coupling
// discoverability check (mirrors check-readme-array-vocab-mentioned.mjs).
//
// Required keywords (each must occur at least once in the README; failure
// to find any one of them exits 1):
//
//   - 'string'                 — bare-literal schema vocab keyword (with
//                                single quotes — distinguishes the
//                                keyword from incidental prose use of the
//                                word "string")
//   - 'Name { value:'          — Name component schema literal (the
//                                canonical AI-user grep target)
//
// (`StringView` reverse-coupling check removed by feat-20260515-string-
// managed-collapse w18: the class was deleted when 'string' collapsed onto
// the managed-ref dispatch — there is no view-class symbol left to surface.)
//
// Self-exempt: this gate file (the keyword set is quoted in the header for
// readability and would shadow the README scan if not exempted).
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-readme-array-vocab-mentioned.mjs.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const TARGETS = ['packages/ecs/README.md'];

const REQUIRED = ["'string'", 'Name { value:'];

const corpus = [];
for (const p of TARGETS) {
  try {
    corpus.push({ path: p, text: readFileSync(p, 'utf8') });
  } catch (e) {
    console.error(`[check-readme-string-vocab-mentioned] cannot read ${p}: ${e.message}`);
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
    '[check-readme-string-vocab-mentioned] AC-12 violated: required ' +
      "'string'-vocab keywords absent from AI-user README:",
  );
  for (const kw of missing) {
    console.error(`  - missing: ${kw}`);
  }
  console.error('\nScanned files:');
  for (const c of corpus) {
    console.error(`  - ${c.path}`);
  }
  console.error(
    "\nThe 'string' vocab is the discoverability surface for the managed " +
      'JS-string column (collapsed onto managed-ref dispatch by ' +
      "feat-20260515-string-managed-collapse). Name { value: 'string' } is " +
      'the canonical component shape consumed by AI users via world.spawn ' +
      '/ world.set / world.get. Add the keywords to the schema-vocab ' +
      'quick-ref / Name component sections.',
  );
  process.exit(1);
}

console.log(
  "[check-readme-string-vocab-mentioned] OK — all 2 required 'string'-vocab " +
    'keywords present in packages/ecs/README.md.',
);

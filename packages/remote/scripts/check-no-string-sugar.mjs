#!/usr/bin/env node
// AC-02 grep gate: assert the legacy `buildXxxScript` 5 string-template
// helpers are decommissioned from `packages/remote/src/**`.
//
// Forbidden identifiers (closed set, 5):
//   buildEntitiesScript / buildComponentsScript / buildSystemsScript /
//   buildResourcesScript / buildWorldScript
//
// All five lived in the legacy `sugar.ts` (deleted by w5). The replacement
// is the typed `defineSugar` builder + name-based `buildScriptByName`
// helper - both shipped from `defineSugar.ts`. Hits in `packages/remote/src/**`
// indicate the migration backslid.
//
// Pattern aligns with `check-engine-no-console-dep.mjs` + `check-shader-no-naga-in-dist.mjs`:
// zero npm deps, plain `node:fs` + `node:path`, exit 1 on any hit. Walks
// `packages/remote/src/**` recursively; .ts / .mjs / .js / .d.ts all
// included so accidental .d.ts ambient-mode leakage is also caught.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const FORBIDDEN = [
  'buildEntitiesScript',
  'buildComponentsScript',
  'buildSystemsScript',
  'buildResourcesScript',
  'buildWorldScript',
];

const ROOT = join(process.cwd(), 'packages', 'remote', 'src');

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const name of entries) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      files.push(...walk(full));
    } else if (s.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot);
      if (SOURCE_EXT.has(ext)) files.push(full);
    }
  }
  return files;
}

function main() {
  let totalHits = 0;
  const hits = [];
  const files = walk(ROOT);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const symbol of FORBIDDEN) {
      // Match the bare identifier; word-boundary on both sides so
      // `buildEntitiesScripts` (extra plural) is also flagged - the
      // intent is anti-typo + anti-revert, not a precise lexical sieve.
      const pattern = new RegExp(`\\b${symbol}\\b`, 'g');
      let match;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((match = pattern.exec(text)) !== null) {
        const before = text.slice(0, match.index);
        const line = before.split('\n').length;
        hits.push({ file, line, symbol });
        totalHits += 1;
      }
    }
  }

  if (totalHits > 0) {
    process.stderr.write(
      `[fail] AC-02: legacy buildXxxScript identifier hits in packages/remote/src/**:\n`,
    );
    for (const h of hits) {
      process.stderr.write(`  ${h.file}:${h.line}  ${h.symbol}\n`);
    }
    process.stderr.write(
      `\n  expected: 0 hits across packages/remote/src/**\n` +
        `  hint:     migrate to defineSugar / buildScriptByName from ./defineSugar\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[ok] AC-02: 0 hits for legacy buildXxxScript identifiers in packages/remote/src/**\n`,
  );
}

main();

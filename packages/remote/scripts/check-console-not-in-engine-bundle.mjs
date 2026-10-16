#!/usr/bin/env node
// AC-09 reverse direction (AIUser F-3 P3 merge): guards that the literal
// '@forgeax/engine-remote' string never lands in packages/runtime/dist/**
// runtime bundle (*.mjs + *.js, excluding *.d.ts). Forms the bidirectional
// gate together with check-engine-no-console-dep.mjs (forward direction =
// engine package.json deps, reverse direction = engine dist bundle). Both
// scripts share the (b) implementation; this entry exists so CI can run
// the reverse leg standalone post-build for fast PR feedback.
//
// charter proposition 4 explicit opt-in: AI users who never call
// engine.startConsole(opts) must not pay the console payload download.
// Pattern aligns with scripts/check-shader-no-naga-in-dist.mjs - zero
// npm deps, plain node stdio, exit non-zero on hit.
//
// feat-20260513-console-typed-sugar-and-injection M5 / w22 sanity:
// the add-only typed sugar surface (`defineSugar` + `injectSystem`
// identifiers + their sub-entry filenames) does NOT leak into
// packages/runtime/dist/** runtime bundle. Verified post-w17:
//   `grep -E 'defineSugar|injectSystem' packages/runtime/dist/*.mjs` -> 0 hits.
// The literal `@forgeax/engine-remote` package-name guard below already
// catches any accidental static import; the sub-entry symbol grep is a
// belt-and-suspenders check executed manually at the milestone boundary.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const CONSOLE_DEP = '@forgeax/engine-remote';
const ENGINE_DIST = process.argv[2] ?? 'packages/runtime/dist';
const RUNTIME_EXTS = new Set(['.js', '.mjs', '.cjs']);

const hits = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')) continue;
    const ext = p.slice(p.lastIndexOf('.'));
    if (!RUNTIME_EXTS.has(ext)) continue;
    const text = readFileSync(p, 'utf8');
    if (text.includes(CONSOLE_DEP)) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(CONSOLE_DEP)) {
          hits.push(`${p}:${i + 1}`);
        }
      }
    }
  }
}
walk(ENGINE_DIST);

if (hits.length > 0) {
  process.stderr.write(
    `[reason] AC-09 (reverse) FAIL: ${CONSOLE_DEP} appears in engine runtime bundle\n`,
  );
  process.stderr.write(
    '[rerun]  node packages/remote/scripts/check-console-not-in-engine-bundle.mjs\n',
  );
  process.stderr.write(
    `[hint]   convert static import to await import('@forgeax/engine-remote/server') inside Renderer.startConsole(opts) per D-P4 bundle physical isolation; hits:\n`,
  );
  for (const h of hits) process.stderr.write(`  ${h}\n`);
  process.exit(1);
}

process.stdout.write(
  `[ok] AC-09 (reverse): ${ENGINE_DIST}/** runtime bundle clean of ${CONSOLE_DEP}\n`,
);

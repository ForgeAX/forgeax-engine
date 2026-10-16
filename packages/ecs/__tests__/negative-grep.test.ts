// feat-20260618-ecs-module-mechanism M4 / w27 (AC-12):
// Negative-constraint gate. This feature deliberately ships the engine MECHANISM
// only -- it must never grow the "editor-aware" concepts that an earlier scope
// draft floated (constraint A0: the engine does not know "edit"/"editor", does
// not walk directories; A0': world is disposable, so no fine-grained
// undefine*/archetype-reclaim). This test pins the forbidden vocabulary at zero
// in engine source so a future change cannot reintroduce it unnoticed.
//
// Scope: packages/<pkg>/src only (engine source). dist/ is skipped (O-1
// dist-staleness, plan-decisions) and comments are blanked so a JSDoc mention of
// a forbidden term is not a false positive. The baseline is already all-zero
// (plan-strategy R4) -- the gate keeps it there.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const packagesDir = join(repoRoot, 'packages');

const SKIP_DIRS = new Set(['dist', 'node_modules', '.turbo', 'coverage', '.git']);
const SELF = fileURLToPath(import.meta.url);

// Exact identifiers the engine must not contain (A0 / A0').
const FORBIDDEN_SYMBOLS = [
  'runInEdit',
  'SCRIPTS_DIR',
  'undefineComponent',
  'undefineSystem',
] as const;

function listSrcSources(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) listSrcSources(p, out);
    else if (/\.(ts|mjs)$/.test(p) && !p.endsWith('.d.ts') && p !== SELF) out.push(p);
  }
}

// Only scan packages/<pkg>/src trees (engine source, not __tests__ fixtures).
function listEngineSource(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    if (SKIP_DIRS.has(pkg)) continue;
    const srcDir = join(packagesDir, pkg, 'src');
    try {
      if (statSync(srcDir).isDirectory()) listSrcSources(srcDir, out);
    } catch {
      // package without a src/ dir
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

interface Hit {
  readonly symbol: string;
  readonly file: string;
}

function forbiddenSymbols(source: string): readonly (typeof FORBIDDEN_SYMBOLS)[number][] {
  const candidates = FORBIDDEN_SYMBOLS.filter((symbol) => source.includes(symbol));
  if (candidates.length === 0) return [];
  const code = stripComments(source);
  return candidates.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(code));
}

function findForbidden(files: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    for (const symbol of forbiddenSymbols(readFileSync(file, 'utf8'))) {
      hits.push({ symbol, file: relative(repoRoot, file) });
    }
  }
  return hits;
}

describe('negative-grep.test.ts (AC-12)', () => {
  const files = listEngineSource();

  it('scans a non-trivial engine source tree (gate is wired)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('AC-12: forbidden editor/scan/undefine symbols are absent from engine source', () => {
    const hits = findForbidden(files);
    const report = hits.map((h) => `  ${h.symbol} in ${h.file}`).join('\n');
    expect(hits, `forbidden-symbol hits:\n${report}`).toEqual([]);
  });

  it('is falsifiable: the detector flags a synthetic forbidden symbol', () => {
    const found = forbiddenSymbols(`
      export function undefineComponent(name) { return name; }
      const dir = SCRIPTS_DIR;
      if (runInEdit) {}
    `);
    expect([...found].sort()).toEqual(['SCRIPTS_DIR', 'runInEdit', 'undefineComponent']);
  });

  it('comments do not count: a forbidden word in a stripped comment is ignored', () => {
    const found = forbiddenSymbols(`
      // this mentions runInEdit in a comment only
      /* and SCRIPTS_DIR in a block comment */
      const ok = 1;
    `);
    expect(found).toEqual([]);
  });
});

#!/usr/bin/env node
// AC-12: assert that the now-deleted `World.setManagedRefStore` /
// `World.getManagedRefStore` symbol pair (feat-20260515-string-managed-
// collapse w2) is not re-introduced anywhere in source. The setter+getter
// were removed when `managedRefs` became a constructor-owned non-null
// `ManagedRefStore<any>` (charter prop 5: one consistent abstraction —
// World owns the store privately, AI users never wire it manually).
//
// feat-20260515-string-managed-collapse M4 / w16 — requirements §AC-12 +
// plan-strategy §2.5 (decision D-R7): second of two grep-gate freezes
// after the always-on managedRefs one-cut.
//
// Banned literal patterns (substring match on each non-comment-stripped line):
//   - `setManagedRefStore`
//   - `getManagedRefStore`
//
// Files scanned: TS / JS / MJS / CJS source under packages/ apps/ templates/
// scripts/ AND the ECS test directory (the 21 legacy callsites lived there
// before w14 swept them; the gate prevents regression by any future test).
// Excluded: /dist/ /node_modules/ /.venv/ /.git/ + .d.ts files; this gate
// file itself + its colocated test fixture. Comments (// ... and /* ... */)
// are stripped before scanning so historical references in feature-loop
// docstrings don't trigger a false positive.
//
// On hit: emit stderr triple `[reason] / [rerun] / [hint]` and exit 1.
// On no hit: exit 0.
//
// Pattern + zero-dep stdio mirrors packages/ecs/scripts/grep-no-string-view-import.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';

// Exclude only the maintained Dawn producer's private toolchain scratch.
const nativeBuild = resolve(import.meta.dirname, '../../dawn-node/.native-build');

const ROOTS = ['packages', 'apps', 'templates', 'scripts'];

const SELF_EXEMPT_FILES = new Set([
  ['packages', 'ecs', 'scripts', 'grep-no-set-managed-ref-store.mjs'].join(sep),
  ['packages', 'ecs', 'scripts', '__tests__', 'grep-no-set-managed-ref-store.test.mjs'].join(sep),
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  // ROI/SDK evidence preserves prior source snapshots; they are not live code.
  'artifacts',
  '.next',
  '.cache',
  'test-output',
  '.venv',
  '.git',
]);

const CODE_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);

const FIXTURE_DIR_FRAGMENT = `${sep}scripts${sep}__tests__${sep}fixtures${sep}`;

const BANNED = ['setManagedRefStore', 'getManagedRefStore'];

// Strip /* ... */ block comments and `// ...` line comments before scanning.
// Crude but adequate for source files (does not parse strings — but the
// banned literals are unique enough that string literal collisions don't
// materialise in practice).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const hits = [];

function walk(dir, scanFixtures) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (resolve(p) === nativeBuild) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, scanFixtures);
      continue;
    }
    if (!scanFixtures && p.includes(FIXTURE_DIR_FRAGMENT)) continue;
    if (p.endsWith('.d.ts') || p.endsWith('.d.mts')) continue;
    const ext = p.slice(p.lastIndexOf('.'));
    if (!CODE_EXTS.has(ext)) continue;
    if (SELF_EXEMPT_FILES.has(p)) continue;
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    const lines = stripped.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const lit of BANNED) {
        if (line.includes(lit)) {
          hits.push({
            path: p,
            lineNo: i + 1,
            literal: lit,
            snippet: line.trim().slice(0, 200),
          });
        }
      }
    }
  }
}

const args = process.argv.slice(2);
const scanFixtures = args.includes('--scan-fixtures');
const customRoots = args.filter((a) => !a.startsWith('--'));
const roots = customRoots.length > 0 ? customRoots : ROOTS;

for (const root of roots) {
  walk(root, scanFixtures);
}

if (hits.length > 0) {
  for (const h of hits) {
    process.stderr.write(
      `[reason] ${h.literal} reference detected at ${h.path.replaceAll('\\', '/')}:${h.lineNo}\n`,
    );
    process.stderr.write(`         ${h.snippet}\n`);
  }
  process.stderr.write('[rerun] pnpm grep:no-set-managed-ref-store\n');
  process.stderr.write(
    '[hint] World owns ManagedRefStore privately since feat-20260515-string-managed-collapse; ' +
      'remove the call (constructor-owned non-null managedRefs is always-on). ' +
      'See AGENTS.md Breaking changes 2026-05-15 row.\n',
  );
  process.exit(1);
}

process.stdout.write(
  '[grep:no-set-managed-ref-store] OK — no setManagedRefStore / getManagedRefStore references in scanned roots.\n',
);

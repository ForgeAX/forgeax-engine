#!/usr/bin/env node
// AC-12: assert that the now-deleted `StringView` class (feat-20260515-string-
// managed-collapse) is not re-imported anywhere in live source. The legacy
// 5-surface value-shape class was removed when 'string' collapsed onto the
// managed-ref dispatch (charter proposition 5: 'string' materialises the
// payload by-reference as a native JS string, not as a view-class wrapper).
//
// feat-20260515-string-managed-collapse M4 / w15 — requirements §AC-12 +
// plan-strategy §2.5 (decision D-R7): one of two grep-gate freezes after the
// StringView delete + setManagedRefStore delete one-cut.
//
// Banned patterns (regex; case-sensitive):
//   - `import .* StringView ...`           (named import or re-export)
//   - `from <quote>./string-view<quote>`   (relative path import, file deleted)
//   - `from <quote>...string-view<quote>`  (any path ending in /string-view)
//
// Files scanned: TS / JS source under packages/ + apps/ + templates/.
// Excluded: /dist/ /node_modules/ /.venv/ /.git/ + .d.ts files; also the
// docs/string-managed-collapse.md historical spec (markdown — out of scope
// regardless) and this gate file itself + its colocated test fixture.
//
// On hit: emit stderr triple `[reason] / [rerun] / [hint]` and exit 1.
// On no hit: exit 0.
//
// Pattern + zero-dep stdio mirrors scripts/grep/check-no-entity-array-literal.mjs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';

// Exclude only the maintained Dawn producer's private toolchain scratch.
const nativeBuild = resolve(import.meta.dirname, '../../dawn-node/.native-build');

const ROOTS = ['packages', 'apps', 'templates'];

const SELF_EXEMPT_FILES = new Set([
  ['packages', 'ecs', 'scripts', 'grep-no-string-view-import.mjs'].join(sep),
  ['packages', 'ecs', 'scripts', '__tests__', 'grep-no-string-view-import.test.mjs'].join(sep),
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

// Fixture directory: tests seed broken cases inside packages/ecs/scripts/__tests__/fixtures
// — those files MUST be scannable on the fixture path passed via CLI arg, but
// must NOT be hit when the gate runs in default mode (which scans the full
// tree). Skip the colocated fixtures dir at the default-mode walker.
const FIXTURE_DIR_FRAGMENT = `${sep}scripts${sep}__tests__${sep}fixtures${sep}`;

const RE_IMPORT_NAMED = /\bimport\b[^;]*\bStringView\b[^;]*\bfrom\s*['"][^'"]+['"]/m;
const RE_FROM_STRING_VIEW = /\bfrom\s*['"][^'"]*\/string-view['"]/m;

const hits = [];

function walk(dir, scanFixtures) {
  if (!scanFixtures && `${dir}${sep}`.includes(FIXTURE_DIR_FRAGMENT)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (resolve(p) === nativeBuild) continue;
    let st = entry;
    if (entry.isSymbolicLink()) {
      try {
        st = statSync(p);
      } catch {
        continue;
      }
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
    let bytes;
    try {
      bytes = readFileSync(p);
    } catch {
      continue;
    }
    // Both banned patterns require an ASCII token; decode only candidate files.
    if (!bytes.includes('StringView') && !bytes.includes('string-view')) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (RE_IMPORT_NAMED.test(line) || RE_FROM_STRING_VIEW.test(line)) {
        hits.push({ path: p, lineNo: i + 1, snippet: line.trim().slice(0, 200) });
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
    process.stderr.write(`[reason] StringView import detected at ${h.path.replaceAll('\\', '/')}:${h.lineNo}\n`);
    process.stderr.write(`         ${h.snippet}\n`);
  }
  process.stderr.write('[rerun] pnpm grep:no-string-view-import\n');
  process.stderr.write(
    '[hint] StringView class deleted in feat-20260515-string-managed-collapse; ' +
      "use native JS string (world.get(e, C).unwrap().value is `string`). " +
      'See AGENTS.md Breaking changes 2026-05-15 row.\n',
  );
  process.exit(1);
}

process.stdout.write(
  '[grep:no-string-view-import] OK — no StringView import / re-export found in scanned roots.\n',
);

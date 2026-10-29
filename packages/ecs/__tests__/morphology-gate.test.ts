import { Update } from '../src/schedule-token';
// feat-20260618-ecs-module-mechanism M4 / w26 (AC-14):
// Falsifiable morphology gate for the addSystem/defineSystem `fn` signature.
//
// Subitem 0 prepended `world` as the first `fn` parameter. The danger is that
// this is an ARITY-PREPEND, not a rename: an un-migrated callback shaped
// `(queryResults, commands) => ...` still type-checks (TS allows assigning a
// lower-arity function to a higher-arity slot), but at runtime its first param
// silently binds to `world` -> `queryResults.Comp.x` reads the World object ->
// the system corrupts state with no compile error. This is the
// overload-arg-shape trap family (MEMORY: overload-arg-shape-dispatch-hides-p0,
// arity-narrow). typecheck cannot catch it, so this gate audits the actual
// parameter list of every addSystem/defineSystem `fn` callback.
//
// Rule: an `fn` callback declared inside an addSystem({...}) / defineSystem({...})
// object literal must EITHER take zero parameters (nothing can misbind to world)
// OR name its first parameter `world` / `_world`. Any other first-param name is a
// residual 2-param-shape callback and a violation.
//
// Scan maintained source trees, excluding build output and hidden tool scratch.
// Concurrent tests may create and retire generated projects in that scratch.

import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const SCAN_ROOTS = ['packages', 'apps', 'templates'];
const SKIP_DIRS = new Set([
  'dist',
  // Archived SDK/evidence trees are not live Engine source and may preserve
  // historical APIs that the current morphology gate has since removed.
  'artifacts',
  'node_modules',
  'coverage',
  '__fixtures__',
]);

// This gate file itself embeds a synthetic old-shape sample (the falsifiability
// check) inside a template literal that stripComments does not blank -- exclude
// it so the gate never flags its own deliberate counter-example.
const SELF = fileURLToPath(import.meta.url);

function listSources(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    const st = entry.isSymbolicLink() ? statSync(p) : entry;
    if (st.isDirectory()) listSources(p, out);
    else if (/\.(ts|mjs)$/.test(p) && !p.endsWith('.d.ts') && p !== SELF) out.push(p);
  }
}

// Blank out comment spans so callbacks shown in JSDoc examples never count as
// real call sites (preserves newlines/offsets so brace matching stays correct).
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

function matchBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Callback {
  readonly file: string;
  readonly params: string;
  readonly first: string;
}

const FN_PARAM = /\bfn\s*(?::\s*(?:async\s*)?)?\(([^)]*)\)\s*(?:=>|\{)/;
const CALL_SITE = /\b(?:addSystem|defineSystem)\s*\(\s*(?:\w+\s*,\s*)?\{/g;

function collectCallbacks(): { all: Callback[]; violations: Callback[] } {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) listSources(join(repoRoot, r), files);

  const all: Callback[] = [];
  const violations: Callback[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('addSystem') && !source.includes('defineSystem')) continue;
    const src = stripComments(source);
    let m: RegExpExecArray | null;
    CALL_SITE.lastIndex = 0;
    while ((m = CALL_SITE.exec(src)) !== null) {
      const openIdx = src.indexOf('{', m.index);
      const end = matchBrace(src, openIdx);
      if (end < 0) continue;
      const literal = src.slice(openIdx, end + 1);
      const fnMatch = FN_PARAM.exec(literal);
      if (fnMatch === null) continue; // fn is a token reference, not an inline callback
      const params = (fnMatch[1] ?? '').trim();
      const first =
        params
          .split(',')[0]
          ?.trim()
          .replace(/:.*$/, '')
          .replace(/^\.\.\./, '')
          .replace(/^async\s+/, '')
          .trim() ?? '';
      const rel = relative(repoRoot, file);
      const cb: Callback = { file: rel, params, first };
      all.push(cb);
      if (params !== '' && first !== 'world' && first !== '_world') {
        violations.push(cb);
      }
    }
  }
  return { all, violations };
}

describe('morphology-gate.test.ts (AC-14)', () => {
  it('reads maintained sources after concurrent hidden fixtures are retired', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-morphology-'));
    try {
      const source = join(root, 'runtime', 'src', 'systems.ts');
      const scratch = join(root, '.wechat-vfx-fixture-test');
      const generated = join(scratch, '.forgeax', 'generated', 'execution-bootstrap.ts');
      mkdirSync(dirname(source), { recursive: true });
      mkdirSync(dirname(generated), { recursive: true });
      writeFileSync(source, 'world.addSystem(Update, { fn: (world) => {} });');
      writeFileSync(generated, 'world.addSystem(Update, { fn: (oldShape) => {} });');
      const files: string[] = [];
      listSources(root, files);
      // Another test retires its fixture between discovery and source reads.
      rmSync(scratch, { recursive: true });
      expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual([
        'world.addSystem(Update, { fn: (world) => {} });',
      ]);
      expect(files).toEqual([source]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds migrated callbacks and rejects residual 2-param shapes (AC-14)', () => {
    const { all, violations } = collectCallbacks();
    // Sanity: the engine + demos define many inline systems. If this drops to
    // ~0 the scanner stopped matching call sites and the gate would be vacuous.
    expect(all.length).toBeGreaterThan(50);
    const report = violations
      .map((v) => `  ${v.file}: fn(${v.params}) -- first param "${v.first}" misbinds to world`)
      .join('\n');
    expect(violations, `residual world-first-param violations:\n${report}`).toEqual([]);
  }, 30_000);

  it('is falsifiable: the detector flags a synthetic old-shape callback', () => {
    // Mirror the production detector against an in-memory bad sample so a future
    // refactor that neuters the parser fails here instead of silently passing.
    const sample = stripComments(`
      world.addSystem(Update, {
        name: 'bad',
        queries: [],
        fn: (queryResults, commands) => { void queryResults; void commands; },
      });
    `);
    CALL_SITE.lastIndex = 0;
    const m = CALL_SITE.exec(sample);
    expect(m).not.toBeNull();
    const openIdx = sample.indexOf('{', (m as RegExpExecArray).index);
    const end = matchBrace(sample, openIdx);
    const literal = sample.slice(openIdx, end + 1);
    const fnMatch = FN_PARAM.exec(literal);
    expect(fnMatch).not.toBeNull();
    const first = (fnMatch as RegExpExecArray)[1]?.split(',')[0]?.trim();
    expect(first).toBe('queryResults');
    expect(first === 'world' || first === '_world').toBe(false);
  });
});

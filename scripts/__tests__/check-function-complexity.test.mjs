import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_PATH,
  COMPLEXITY_THRESHOLD,
  compareWithBaseline,
  measureSource,
  nextBaseline,
} from '../check-function-complexity.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gatePath = resolve(repoRoot, 'scripts', 'check-function-complexity.mjs');

function branchyFunction(name, branches) {
  const body = Array.from({ length: branches }, (_, i) => `  if (x === ${i}) return ${i};`).join(
    '\n',
  );
  return `export function ${name}(x: number): number {\n${body}\n  return -1;\n}\n`;
}

function withGitRepo(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-function-complexity-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    for (const [path, contents] of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: root }).status, 0);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runGate(root, ...args) {
  return spawnSync(process.execPath, [gatePath, '--root', root, ...args], { encoding: 'utf8' });
}

function baselineJson(functions) {
  return `${JSON.stringify({ threshold: COMPLEXITY_THRESHOLD, functions }, null, 2)}\n`;
}

describe('measureSource', () => {
  it('counts McCabe decision points including logical and nullish operators', () => {
    const [record] = measureSource(
      'a.ts',
      `function f(a, b) {
        if (a && b) {}
        for (const x of a) {}
        while (b) {}
        const y = a ? 1 : b ?? 2;
        switch (a) { case 1: break; case 2: break; default: break; }
        try {} catch {}
        return a || b;
      }`,
    );
    // 1 + if + && + for + while + ?: + ?? + 2 cases + catch + ||
    assert.equal(record.complexity, 11);
    assert.equal(record.id, 'a.ts::f');
  });

  it('measures nested functions separately and names them by lexical scope', () => {
    const records = measureSource(
      'b.ts',
      `class Owner {
        method(a) {
          const inner = () => (a ? 1 : 2);
          return a && inner();
        }
      }
      const handlers = { onEvent(x) { if (x) return 1; return 0; } };`,
    );
    const byId = Object.fromEntries(records.map((r) => [r.id, r.complexity]));
    assert.deepEqual(byId, {
      'b.ts::Owner.method': 2,
      'b.ts::Owner.method.inner': 2,
      'b.ts::onEvent': 2,
    });
  });

  it('disambiguates same-named anonymous functions by ordinal, independent of line numbers', () => {
    const records = measureSource('c.ts', '\n\n[1].map(() => 1);\n[2].map(() => 2);');
    assert.deepEqual(
      records.map((r) => r.id),
      ['c.ts::<anonymous>', 'c.ts::<anonymous>#2'],
    );
  });
});

describe('baseline ratchet', () => {
  const scan = {
    fileCount: 1,
    functionCount: 3,
    risks: [
      { id: 'x::kept', line: 1, complexity: 30 },
      { id: 'x::grown', line: 2, complexity: 41 },
      { id: 'x::added', line: 3, complexity: 25 },
    ],
  };
  const baseline = new Map([
    ['x::kept', 35],
    ['x::grown', 40],
    ['x::removed', 50],
  ]);

  it('reports new, grown and stale entries', () => {
    const result = compareWithBaseline(scan, baseline);
    assert.deepEqual(
      result.added.map((r) => r.id),
      ['x::added'],
    );
    assert.deepEqual(
      result.grown.map((r) => r.id),
      ['x::grown'],
    );
    assert.deepEqual(result.stale.map((r) => r.id).sort(), ['x::kept', 'x::removed']);
  });

  it('only tightens unless increases are accepted explicitly', () => {
    assert.deepEqual(Object.fromEntries(nextBaseline(scan, baseline, { acceptIncrease: false })), {
      'x::kept': 30,
      'x::grown': 40,
    });
    assert.deepEqual(Object.fromEntries(nextBaseline(scan, baseline, { acceptIncrease: true })), {
      'x::kept': 30,
      'x::grown': 41,
      'x::added': 25,
    });
  });
});

describe('check-function-complexity CLI', () => {
  it('fails a new risk function and passes once it is under the threshold', () => {
    withGitRepo(
      [
        ['src/risky.ts', branchyFunction('risky', COMPLEXITY_THRESHOLD)],
        [BASELINE_PATH, baselineJson({})],
      ],
      (root) => {
        const failed = runGate(root);
        assert.equal(failed.status, 1);
        assert.match(
          failed.stderr,
          /FAIL new id=src\/risky\.ts::risky line=1 complexity=21 max=20/,
        );

        writeFileSync(
          join(root, 'src/risky.ts'),
          branchyFunction('risky', COMPLEXITY_THRESHOLD - 1),
        );
        const passed = runGate(root);
        assert.equal(passed.status, 0, passed.stderr);
        assert.match(passed.stdout, /PASS files=1 functions=1 risks=0 max=20/);
      },
    );
  });

  it('ignores generated, vendored and package output sources', () => {
    const risky = branchyFunction('risky', COMPLEXITY_THRESHOLD + 5);
    withGitRepo(
      [
        ['packages/a/pkg/glue.js', risky],
        ['packages/a/src/generated/validators.ts', risky],
        ['third_party/lib/index.ts', risky],
        ['types/index.d.ts', risky],
        [BASELINE_PATH, baselineJson({})],
      ],
      (root) => {
        const result = runGate(root);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /files=0/);
      },
    );
  });

  it('--write locks in a reduction but refuses growth without --accept-increase', () => {
    withGitRepo(
      [
        ['src/risky.ts', branchyFunction('risky', COMPLEXITY_THRESHOLD + 2)],
        [BASELINE_PATH, baselineJson({ 'src/risky.ts::risky': 30 })],
      ],
      (root) => {
        assert.equal(runGate(root).status, 1);
        assert.equal(runGate(root, '--write').status, 0);
        const written = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'));
        assert.deepEqual(written.functions, { 'src/risky.ts::risky': 23 });

        writeFileSync(
          join(root, 'src/risky.ts'),
          branchyFunction('risky', COMPLEXITY_THRESHOLD + 4),
        );
        assert.equal(runGate(root, '--write').status, 1);
        assert.equal(runGate(root, '--write', '--accept-increase').status, 0);
        assert.equal(runGate(root).status, 0);
      },
    );
  });
});

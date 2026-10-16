// check-test-perf-budget.test.mjs — TDD RED fixture for check-test-perf-budget.mjs.
// Runs the budget guard script as a child process, feeding it synthetic vitest
// JSON reporter ndjson on stdin, and asserting exit code + stdout shape.
// Intended for `node --test scripts/ci/__tests__/check-test-perf-budget.test.mjs`
// (independent of the vitest project tree).
//
// Usage: node --test scripts/ci/__tests__/check-test-perf-budget.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Guard script lives at scripts/ci/check-test-perf-budget.mjs relative to repo root.
// Resolve via realpath so __tests__/ dir itself doesn't break resolution.
const guardPath = realpathSync(join(__dirname, '..', 'check-test-perf-budget.mjs'));

/**
 * Run the guard script with synthetic ndjson stdin and return { exitCode, stdout, stderr }.
 * If execFileSync throws (non-zero exit), catch and return the partial output.
 */
function runGuard(ndjsonLines, extraEnv = {}) {
  const input = `${ndjsonLines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  try {
    const stdout = execFileSync(process.execPath, [guardPath], {
      input,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString()?.trim() ?? '',
      stderr: err.stderr?.toString()?.trim() ?? '',
    };
  }
}

/**
 * Build a synthetic vitest JSON reporter testResult object.
 * name: relative file path (e.g. 'packages/runtime/src/__tests__/foo.test.ts')
 * duration: total file duration in ms
 * assertionResults: array of per-it() results with individual duration in ms
 */
function makeFile(name, duration, assertionResults) {
  return { name, startTime: 1000, endTime: 1000 + duration, duration, assertionResults };
}

function makeIt(duration = 10) {
  return {
    ancestorTitles: [],
    fullName: 'test case',
    status: 'passed',
    title: 'case',
    duration,
    failureMessages: [],
  };
}

// Write a temp file with the given content (for skip-comment scanning tests).
function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-budget-test-'));
  const fp = join(dir, 'test-file.test.ts');
  writeFileSync(fp, content, 'utf-8');
  return { dir, fp };
}

// ============================================================================
// Tests
// ============================================================================

test('ms/it < 200: pass', async () => {
  const results = runGuard([
    {
      testResults: [makeFile('packages/foo/src/__tests__/fast.test.ts', 150, [makeIt(150)])],
    },
  ]);
  assert.strictEqual(results.exitCode, 0, 'should pass for fast file');
});

test('ms/it > 200 and it >= 3: pass (large file exemption)', async () => {
  const results = runGuard([
    {
      testResults: [
        makeFile('packages/foo/src/__tests__/big.test.ts', 900, [
          makeIt(300),
          makeIt(300),
          makeIt(300),
        ]),
      ],
    },
  ]);
  assert.strictEqual(results.exitCode, 0, 'large file with >= 3 tests should pass');
});

test('ms/it > 200 and it < 3: report with hint containing "merge into"', async () => {
  const results = runGuard([
    {
      testResults: [makeFile('packages/foo/src/__tests__/slow-tiny.test.ts', 500, [makeIt(500)])],
    },
  ]);
  assert.strictEqual(results.exitCode, 0, 'slow tiny file should remain advisory');
  const parsed = JSON.parse(results.stdout);
  assert.strictEqual(parsed.code, 'ci-test-consolidation-candidate');
  assert.ok(
    parsed.hint && (parsed.hint.includes('merge into') || parsed.hint.includes('merged')),
    'hint should mention "merge into"',
  );
  assert.ok(parsed.actual, 'should include actual');
  assert.ok(parsed.expected, 'should include expected');
});

test('it = 0 (no tests): pass', async () => {
  const results = runGuard([
    {
      testResults: [makeFile('packages/foo/src/__tests__/empty.test.ts', 0, [])],
    },
  ]);
  assert.strictEqual(results.exitCode, 0, 'file with 0 tests should pass');
});

test('corrupted JSON line: parse error', async () => {
  const input = 'this is not valid JSON\n';
  let errored = false;
  try {
    execFileSync(process.execPath, [guardPath], {
      input,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    errored = true;
    const stderr = err.stderr?.toString() ?? '';
    assert.ok(
      stderr.includes('parse') ||
        stderr.includes('JSON') ||
        stderr.includes('invalid') ||
        stderr.includes('error') ||
        stderr.includes('corrupt'),
      'should mention parse/json/invalid/error for corrupted input',
    );
  }
  // After w18 GREEN landed, the guard is implemented and must exit non-zero
  // on corrupted JSON input (round-2 fix-up of round-1 reviewer minor: the
  // prior `errored || true` assertion was vacuous and false-passed).
  assert.equal(errored, true, 'guard should fail on corrupted JSON');
});

test('empty input fails closed instead of passing as zero work', () => {
  const results = runGuard([]);
  assert.equal(results.exitCode, 2);
  assert.match(results.stderr, /report shape invalid/i);
});

test('missing report testResults fails closed', () => {
  const results = runGuard([{}]);
  assert.equal(results.exitCode, 2);
  assert.match(results.stderr, /testResults/);
});

test('partial test-file fields fail closed', () => {
  for (const testResult of [
    { name: 'missing-duration.test.ts', assertionResults: [makeIt()] },
    { name: 'missing-assertions.test.ts', duration: 10 },
    { duration: 10, assertionResults: [makeIt()] },
    { name: 'missing-status.test.ts', duration: 10, assertionResults: [{}] },
  ]) {
    const results = runGuard([{ testResults: [testResult] }]);
    assert.equal(results.exitCode, 2);
    assert.match(results.stderr, /report shape invalid/i);
  }
});

test('derives omitted file duration from valid Vitest timestamps', () => {
  const results = runGuard([
    {
      testResults: [
        {
          name: 'packages/foo/src/__tests__/slow-tiny.test.ts',
          startTime: 1000,
          endTime: 1500,
          assertionResults: [makeIt(500)],
        },
      ],
    },
  ]);
  assert.equal(results.exitCode, 0, 'derived duration should still report a candidate');
  assert.match(results.stdout, /slow-tiny/);
});

test('invalid explicit duration does not fall back to timestamps', () => {
  const results = runGuard([
    {
      testResults: [
        {
          name: 'packages/foo/src/__tests__/invalid-duration.test.ts',
          startTime: 1000,
          endTime: 1010,
          duration: null,
          assertionResults: [makeIt()],
        },
      ],
    },
  ]);
  assert.equal(results.exitCode, 2);
  assert.match(results.stderr, /report shape invalid/i);
});

test('a partial ndjson report fails closed instead of being skipped', () => {
  const results = runGuard([
    { testResults: [makeFile('packages/foo/src/__tests__/valid.test.ts', 10, [makeIt()])] },
    { testResults: null },
  ]);
  assert.equal(results.exitCode, 2);
  assert.match(results.stderr, /testResults/);
});

test('@perf-budget-skip comment in file: pass', async () => {
  // Create a temp file with the skip comment, then a synthetic slow tiny result.
  const { dir, fp } = tmpFile('// @perf-budget-skip\n// other stuff\n');
  try {
    const results = runGuard(
      [
        {
          testResults: [makeFile(fp, 500, [makeIt(500)])],
        },
      ],
      // Pass a hint about the repo root so the guard can resolve the relative path.
      // The guard resolves relative name against cwd; we use the real tmp path
      // as the name directly so it sees the @perf-budget-skip comment.
    );
    assert.strictEqual(results.exitCode, 0, 'skip-comment file should pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ms/it exactly 200: boundary pass', async () => {
  const results = runGuard([
    {
      testResults: [makeFile('packages/foo/src/__tests__/boundary.test.ts', 200, [makeIt(200)])],
    },
  ]);
  assert.strictEqual(results.exitCode, 0, 'ms/it = 200 should pass (not > 200)');
});

test('two files, one slow-tiny, one fast: report slow-tiny', async () => {
  const results = runGuard([
    {
      testResults: [
        makeFile('packages/foo/src/__tests__/fast.test.ts', 100, [makeIt(50), makeIt(50)]),
        makeFile('packages/bar/src/__tests__/slow-tiny.test.ts', 600, [makeIt(600)]),
      ],
    },
  ]);
  assert.strictEqual(results.exitCode, 0, 'should report candidates without rejecting the run');
  const parsed = JSON.parse(results.stdout);
  assert.strictEqual(parsed.code, 'ci-test-consolidation-candidate');
  assert.ok(parsed.actual.includes('slow-tiny'), 'actual should name the violating file');
});

// A variable-speed coverage run must not turn a layout suggestion into a
// correctness failure or hide candidates after the first slow file.
test('reports every candidate under shared-runner timing variation', () => {
  for (const duration of [201, 230, 2000]) {
    const result = runGuard([
      {
        testResults: [
          makeFile('first.test.ts', duration, [makeIt(duration)]),
          makeFile('second.test.ts', duration, [makeIt(duration)]),
        ],
      },
    ]);
    assert.equal(result.exitCode, 0);
    const candidates = result.stdout.split('\n').map((line) => JSON.parse(line));
    assert.equal(candidates.length, 2);
    assert.ok(candidates[1].actual.includes('second.test.ts'));
  }
});

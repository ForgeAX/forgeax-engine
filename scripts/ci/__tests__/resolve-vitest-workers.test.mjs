import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/ci/resolve-vitest-workers.mjs');

function run(value) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, FORGEAX_VITEST_MAX_WORKERS: value },
    encoding: 'utf8',
  });
}

test('accepts a bounded worker override for natural-main A/B validation', () => {
  const result = run('5');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '5\n');
  assert.match(result.stderr, /maxWorkers=5/);
});

test('rejects an unsafe worker override', () => {
  const result = run('7');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be an integer from 1 to 6/);
});

test('the real Bun canary entry forwards its admitted worker budget and rejects unsafe admission', {
  skip: process.platform === 'win32',
}, () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const start = workflow.indexOf(
    '      - name: Vitest portability canary (via bun run test:portability)',
  );
  assert.ok(start >= 0);
  const end = workflow.indexOf('\n      - name:', start + 1);
  const step = workflow.slice(start, end);
  const runLine = /^ {8}run: (.*)$/m.exec(step);
  assert.ok(runLine);
  const command =
    runLine[1] === '|'
      ? step
          .slice(runLine.index + runLine[0].length)
          .split('\n')
          .filter((line) => line.startsWith('          '))
          .map((line) => line.slice(10))
          .join('\n')
      : runLine[1];
  const fixture = mkdtempSync(resolve(tmpdir(), 'bun-canary-budget-'));
  const receipt = resolve(fixture, 'receipt.json');
  const bun = resolve(fixture, 'bun');
  try {
    writeFileSync(
      bun,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.BUN_CANARY_RECEIPT, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(bun, 0o755);
    const execute = (budget) =>
      spawnSync('bash', ['-eo', 'pipefail', '-c', command], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: fixture + delimiter + process.env.PATH,
          BUN_CANARY_RECEIPT: receipt,
          FORGEAX_VITEST_MAX_WORKERS: budget,
        },
      });
    for (const budget of ['2', '3']) {
      const result = execute(budget);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), [
        'run',
        'test:portability',
        `--maxWorkers=${budget}`,
      ]);
      rmSync(receipt);
    }
    const rejected = execute('7');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must be an integer from 1 to 6/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

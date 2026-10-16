import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';
import { dispatch } from '../run-vitest-unit.mjs';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
test('basic test and test:unit select the same complete bounded project roster', () => {
  const outputs = ['test', 'test:unit'].map((script) => {
    const command = pnpmCommand();
    const result = spawnSync(command[0], [...command.slice(1), script, '--', '--dry-run'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const groups = result.stdout.match(/^group-\d+: .*$/gm);
    assert.ok(groups?.length > 0, result.stdout);
    return groups;
  });
  assert.deepEqual(outputs[0], outputs[1]);
});
const splitRunnerPath = join(repoRoot, 'scripts', 'ci', 'run-split-vitest-coverage.mjs');
const pnpm = pnpmCommand();

function fakeRuntime(result = { status: 0, signal: null }) {
  const calls = [];
  const exits = [];
  const signals = [];
  return {
    calls,
    exits,
    signals,
    options: {
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return result;
      },
      setExitCode(code) {
        exits.push(code);
      },
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
    },
  };
}

test('coverage dispatch removes the coverage marker and uses the bounded runner', () => {
  const runtime = fakeRuntime();

  dispatch(['--', '--coverage', '--dry-run', '--group-size=2'], runtime.options);

  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].command, process.execPath);
  assert.deepEqual(runtime.calls[0].args, [splitRunnerPath, '--dry-run', '--group-size=2']);
  assert.deepEqual(runtime.exits, [0]);
});

test('non-coverage dispatch uses the bounded runner and forwards arguments', () => {
  const runtime = fakeRuntime();

  dispatch(['--run', 'scripts/ci/__tests__/example.test.mjs'], runtime.options);

  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.calls[0].args, [
    splitRunnerPath,
    '--non-coverage',
    '--run',
    'scripts/ci/__tests__/example.test.mjs',
  ]);
  assert.deepEqual(runtime.exits, [0]);
});

test('non-zero child status is returned unchanged for both dispatch branches', () => {
  for (const argv of [['--coverage', '--not-a-split-runner-option'], ['--not-a-vitest-option']]) {
    const runtime = fakeRuntime({ status: 17, signal: null });

    dispatch(argv, runtime.options);

    assert.deepEqual(runtime.exits, [17]);
    assert.deepEqual(runtime.signals, []);
  }
});

test('child signals are re-raised instead of converted to a successful exit', () => {
  const runtime = fakeRuntime({ status: null, signal: 'SIGTERM' });

  dispatch([], runtime.options);

  assert.deepEqual(runtime.exits, []);
  assert.deepEqual(runtime.signals, [{ pid: process.pid, signal: 'SIGTERM' }]);
});

test('literal coverage routing reaches the split runner and preserves its defaults', () => {
  const result = spawnSync(
    pnpm[0],
    [...pnpm.slice(1), 'test:unit', '--', '--coverage', '--dry-run'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^group-01: /m);
  assert.doesNotMatch(result.stderr, /unknown argument: --coverage/);
});

test('split coverage rejects multiplicative group and Vitest worker concurrency', () => {
  const result = spawnSync(
    process.execPath,
    [splitRunnerPath, '--dry-run', '--group-concurrency=2', '--max-workers=2'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /concurrent groups require --max-workers=1/);
});

test('literal non-coverage routing uses the discovered bounded roster', () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const splitSource = readFileSync(splitRunnerPath, 'utf8');
  const result = spawnSync(
    pnpm[0],
    [...pnpm.slice(1), 'test:unit', '--', '--dry-run', '--group-size=2'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    },
  );

  assert.equal(packageJson.scripts['test:unit'], 'node scripts/ci/run-vitest-unit.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^group-01: /m);
  assert.match(splitSource, /export function allProjectNames/);
  assert.match(splitSource, /options\.coverage/);
});

test('literal typecheck routing uses two-project bounded groups without coverage', () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const result = spawnSync(
    process.execPath,
    [
      splitRunnerPath,
      '--non-coverage',
      '--typecheck',
      '--group-size=2',
      '--max-workers=1',
      '--testTimeout=90000',
      '--hookTimeout=90000',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
    },
  );

  assert.equal(
    packageJson.scripts['test:type'],
    'node scripts/ci/run-split-vitest-coverage.mjs --non-coverage --typecheck --group-size=2 --max-workers=1 --testTimeout=90000 --hookTimeout=90000',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^group-01: /m);
  const groups = result.stdout.match(/^group-\d+: .*$/gm) ?? [];
  assert.ok(groups.length > 0);
  assert.ok(groups.every((group) => group.split(': ')[1].split(', ').length <= 2));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /--coverage(?:=|\s|$)/);
});

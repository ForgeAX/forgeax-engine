import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const action = readFileSync(
  resolve(root, '.github/actions/prepare-xdg-runtime/action.yml'),
  'utf8',
);

const workflowJobs = new Map([
  [
    '.github/workflows/ci.yml',
    [
      'primary-pnpm',
      'coverage-pnpm-shard',
      'directional-csm-browser',
      'vitest-browser-shard',
      'shared-inputs-browser',
      'smoke-fleet',
      'bevy-smoke-fleet',
      'vitest-dawn',
      'webkit-fallback',
      'metrics-validate-browser',
      'metrics-validate-runtime',
    ],
  ],
  ['.github/workflows/nightly.yml', ['smoke-browser-dawn']],
  ['.github/workflows/gpu-pass-timing-real-gpu.yml', ['gpu-pass-timing-benchmark']],
  ['.github/workflows/native-ray-query.yml', ['native-ray-query-contract', 'native-node-gi']],
  ['.github/workflows/sdk-pr-preflight.yml', ['build-sdk']],
  ['.github/workflows/sdk-release-candidate.yml', ['consumers', 'collision']],
]);

function jobBlock(workflow, job) {
  const start = workflow.search(new RegExp(`^  ${job}:\\s*$`, 'm'));
  assert.notEqual(start, -1, `missing jobs.${job}`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test('shared XDG runtime action creates a private Linux directory and exports it', () => {
  assert.match(action, /using: composite/);
  assert.match(action, /if: runner\.os == 'Linux'/);
  assert.match(action, /mktemp -d/);
  assert.match(action, /chmod 700/);
  assert.match(action, /test -w/);
  assert.match(action, /XDG_RUNTIME_DIR=%s\\n.*GITHUB_ENV/);
});

test('job runtime setup routes real Node staging away from an unusable system temp root', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'forgeax-job-runtime-test-'));
  try {
    const runnerTemp = join(fixture, 'runner-temp');
    mkdirSync(runnerTemp);
    const environmentFile = join(fixture, 'environment');
    const script = action
      .split('run: |\n')[1]
      .split('\n')
      .map((line) => line.slice(8))
      .join('\n');
    const inheritedTemp = join(fixture, 'unavailable-system-temp');
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: environmentFile,
        TMPDIR: inheritedTemp,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const exported = Object.fromEntries(
      readFileSync(environmentFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    assert.equal(exported.TMPDIR, runnerTemp);
    const staged = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import {mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; console.log(mkdtempSync(join(tmpdir(), 'forgeax-ci-inputs-')));",
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: inheritedTemp, ...exported },
      },
    );
    assert.equal(staged.status, 0, staged.stderr);
    assert.ok(staged.stdout.trim().startsWith(`${runnerTemp}/forgeax-ci-inputs-`));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('every verified CI input consumer prepares job runtime before staging', () => {
  for (const relativePath of workflowJobs.keys()) {
    const workflow = readFileSync(resolve(root, relativePath), 'utf8');
    for (const match of workflow.matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gm)) {
      const block = jobBlock(workflow, match[1]);
      const stage = block.indexOf('uses: ./.github/actions/prepare-ci-inputs');
      if (stage === -1) continue;
      const prepare = block.indexOf('uses: ./.github/actions/prepare-xdg-runtime');
      assert.ok(
        prepare !== -1 && prepare < stage,
        `${relativePath} jobs.${match[1]} prepares TMPDIR before inputs`,
      );
    }
  }
});

test('every CI GPU or headed-browser producer prepares XDG before its carrier', () => {
  for (const [relativePath, jobs] of workflowJobs) {
    const workflow = readFileSync(resolve(root, relativePath), 'utf8');
    for (const job of jobs) {
      const block = jobBlock(workflow, job);
      const prepare = block.indexOf('uses: ./.github/actions/prepare-xdg-runtime');
      assert.notEqual(prepare, -1, `${relativePath} jobs.${job} must prepare XDG_RUNTIME_DIR`);
      const checkout = block.indexOf('actions/checkout@');
      assert.ok(checkout < prepare, `${relativePath} jobs.${job} prepares XDG after checkout`);
      const firstCarrier = block.search(
        /(xvfb-run|vitest run --project=dawn|run-direct-light-dawn|smoke:browser|smoke:desktop|smoke:templates)/,
      );
      assert.ok(
        firstCarrier === -1 || prepare < firstCarrier,
        `${relativePath} jobs.${job} prepares XDG before its carrier`,
      );
    }
  }
});

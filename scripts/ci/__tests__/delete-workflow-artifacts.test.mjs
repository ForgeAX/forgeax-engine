import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const sourcePath = resolve('scripts/ci/delete-workflow-artifacts.mjs');

function runFixture({
  listFails = false,
  preserveName,
  artifacts,
  workflow = '.github/workflows/sdk-release-candidate.yml',
  runAttempt = 1,
  sourceFails = false,
  sourceStatus = 'completed',
  sourceConclusion = 'success',
  job = '',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-delete-workflow-artifacts-'));
  const binDir = join(root, 'bin');
  const logPath = join(root, 'gh.log');
  const fakeGh = join(binDir, 'gh');
  mkdirSync(binDir);
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--paginate')) {
  if (process.env.GH_TEST_LIST_FAIL === '1') process.exit(1);
  process.stdout.write(process.env.GH_TEST_ARTIFACTS ?? '101\\tfirst\\n102\\tsecond\\n');
  process.exit(0);
}
if (!args.includes('--method')) {
  if (process.env.GH_TEST_SOURCE_FAIL === '1') process.exit(1);
  process.stdout.write(JSON.stringify({path:process.env.GH_TEST_WORKFLOW,run_attempt:Number(process.env.GH_TEST_ATTEMPT),status:process.env.GH_TEST_SOURCE_STATUS,conclusion:JSON.parse(process.env.GH_TEST_SOURCE_CONCLUSION)}));
  process.exit(0);
}
if (args.includes('--method') && args.includes('DELETE')) {
  require('node:fs').appendFileSync(process.env.GH_TEST_LOG, args.at(-1) + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  );
  chmodSync(fakeGh, 0o755);
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [sourcePath, ...(preserveName ? ['--preserve-name', preserveName] : [])],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_RUN_ID: '123',
          GH_TOKEN: 'fixture-token',
          GH_TEST_LIST_FAIL: listFails ? '1' : '0',
          GH_TEST_SOURCE_FAIL: sourceFails ? '1' : '0',
          GH_TEST_WORKFLOW: workflow,
          GH_TEST_ATTEMPT: String(runAttempt),
          GH_TEST_SOURCE_STATUS: sourceStatus,
          GH_TEST_SOURCE_CONCLUSION: JSON.stringify(sourceConclusion),
          GITHUB_JOB: job,
          GH_TEST_LOG: logPath,
          ...(artifacts === undefined ? {} : { GH_TEST_ARTIFACTS: artifacts }),
        },
      },
    );
  } finally {
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    rmSync(root, { recursive: true, force: true });
    result = { ...result, log };
  }
  return result;
}

test('deletes every artifact returned by the workflow-run listing', () => {
  const fixture = runFixture();
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /transient artifacts deleted: 2; preserved: 0; failed deletions: 0/);
  assert.deepEqual(fixture.log.trim().split('\n').sort(), [
    'repos/owner/repo/actions/artifacts/101',
    'repos/owner/repo/actions/artifacts/102',
  ]);
});

test('preserves an explicitly named artifact while deleting the rest', () => {
  const fixture = runFixture({ preserveName: 'first' });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /transient artifacts deleted: 1; preserved: 1; failed deletions: 0/);
  assert.deepEqual(fixture.log.trim().split('\n'), ['repos/owner/repo/actions/artifacts/102']);
});

test('does not fail the workflow when the listing API is unavailable', () => {
  const fixture = runFixture({ listFails: true });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /could not list transient artifacts/);
});

test('preserves original failed captures after a later successful attempt', () => {
  const fixture = runFixture({
    artifacts:
      '101\tcore-build-a1\n102\tfailure-view-integration-evidence-3-a1\n103\tview-integration-evidence-3-a2\n104\tfailure-preview-rhi-window-1\n',
  });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.match(fixture.stdout, /transient artifacts deleted: 2; preserved: 2; failed deletions: 0/);
  assert.deepEqual(fixture.log.trim().split('\n').sort(), [
    'repos/owner/repo/actions/artifacts/101',
    'repos/owner/repo/actions/artifacts/103',
  ]);
});

test('successful CI retains original repair evidence through its bounded producer expiry', () => {
  const names = [
    'core-build-a1',
    'shared-app-inputs-a1',
    ...[0, 1, 2, 3].map((index) => `coverage-shard-${index}`),
    'metrics-report',
    'chromium-fallback-color-lighting-status',
    'metrics-validate-browser-evidence-a1',
    'metrics-validate-browser-evidence-a2',
    'app-dist-0-a1',
    'coverage-shard-4',
    'metrics-validate-browser-evidence-a3',
  ];
  const fixture = runFixture({
    workflow: '.github/workflows/ci.yml@refs/heads/main',
    runAttempt: 2,
    artifacts: names.map((name, index) => `${index + 101}\t${name}`).join('\n'),
  });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.deepEqual(
    fixture.log.trim().split('\n').sort(),
    [111, 112, 113].map((id) => `repos/owner/repo/actions/artifacts/${id}`),
  );
});

test('an unavailable source identity leaves producer expiry authoritative', () => {
  const fixture = runFixture({ sourceFails: true });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.equal(fixture.log, '');
  assert.match(fixture.stdout, /source.*unavailable/);
});

test('keeps LOD, compatibility and coverage failure captures after a successful retry', () => {
  const fixture = runFixture({
    artifacts:
      '101\tlod-performance-failure-a1\n102\tcompatibility-failure-webkit-1\n103\tcoverage-diagnostics-shard-2\n104\tapp-dist-0\n',
  });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.deepEqual(fixture.log.trim().split('\n'), ['repos/owner/repo/actions/artifacts/104']);
});

test('the gated producer cleanup can delete app transport before its own run completes', () => {
  const fixture = runFixture({
    workflow: '.github/workflows/ci.yml',
    sourceStatus: 'in_progress',
    sourceConclusion: null,
    job: 'cleanup-transient-artifacts',
    artifacts: '101\tcoverage-shard-0\n102\tapp-dist-0\n',
  });
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.deepEqual(fixture.log.trim().split('\n'), ['repos/owner/repo/actions/artifacts/102']);
});

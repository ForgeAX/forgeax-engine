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

function runFixture({ listFails = false, preserveName, artifacts } = {}) {
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

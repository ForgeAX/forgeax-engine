import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertChannelAdvance,
  assertReleaseSource,
  assertSuccessfulCandidateRun,
  developmentVersion,
  releasePolicy,
} from '../release-policy.mjs';

test('retained failed or active Candidate artifacts never authorize Promotion', () => {
  const run = {
    id: 123,
    path: '.github/workflows/sdk-release-candidate.yml',
    status: 'completed',
    conclusion: 'success',
  };
  assert.doesNotThrow(() => assertSuccessfulCandidateRun(run, '123'));
  for (const change of [
    { id: 124 },
    { path: '.github/workflows/ci.yml' },
    { status: 'in_progress' },
    { status: 'queued' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { conclusion: null },
  ])
    assert.throws(
      () => assertSuccessfulCandidateRun({ ...run, ...change }, '123'),
      /release-candidate-run-not-successful/,
    );
  assert.throws(
    () => assertSuccessfulCandidateRun(undefined, '123'),
    /release-candidate-run-not-successful/,
  );
});

test('stable and development identities select disjoint branch and tag policies', () => {
  assert.deepEqual(releasePolicy('0.4.1'), { channel: 'stable', branch: 'stable', tag: 'latest' });
  assert.deepEqual(releasePolicy('0.5.0-dev.123.abcdef123456'), {
    channel: 'next',
    branch: 'main',
    tag: 'next',
  });
  for (const invalid of [
    '01.2.3',
    '1.2.3-dev.01.abcdef123456',
    '1.2.3-beta',
    'latest',
    '1.2.3+dev',
  ])
    assert.throws(() => releasePolicy(invalid), /release-version-invalid/);
});

test('source membership and development SHA are checked before release', () => {
  const source = `abcdef123456${'a'.repeat(28)}`;
  assert.throws(
    () => assertReleaseSource('1.2.3', source, 'b'.repeat(40), () => false),
    /release-source-not-on-stable/,
  );
  assert.throws(
    () => assertReleaseSource('1.2.3-dev.8.abcdef654321', source, source, () => true),
    /release-development-source-mismatch/,
  );
  assert.equal(
    assertReleaseSource('1.2.3-dev.8.abcdef123456', source, source, () => true).tag,
    'next',
  );
});

test('channel retries are idempotent and older versions cannot move a channel backwards', () => {
  assertChannelAdvance('1.2.4', '1.2.3');
  assertChannelAdvance('1.2.4', '1.2.4');
  assert.throws(() => assertChannelAdvance('1.2.3', '1.2.4'), /release-channel-regression/);
  assert.throws(
    () => assertChannelAdvance('1.3.0-dev.8.abcdef123456', '1.3.0-dev.9.abcdef654321'),
    /release-channel-regression/,
  );
  assertChannelAdvance('1.3.0-dev.10.abcdef123456', '1.3.0-dev.9.abcdef654321');
});

test('automatic development identity derives from the stable line and completed source run', () => {
  const source = `abcdef123456${'a'.repeat(28)}`;
  assert.equal(developmentVersion('0.3.11', '123', source), '0.4.0-dev.123.abcdef123456');
  assert.throws(
    () => developmentVersion('0.4.0-dev.1.abcdef123456', '123', source),
    /baseline-invalid/,
  );
  assert.throws(() => developmentVersion('0.3.11', '01', source), /version-invalid/);
});

test('release CLI proves older source ancestry from a shallow checkout without admitting outsiders', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-release-ancestry-'));
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const script = fileURLToPath(new URL('../release-policy.mjs', import.meta.url));
  try {
    const source = join(root, 'source');
    git(root, 'init', '--initial-branch=main', source);
    git(source, 'config', 'user.name', 'Release fixture');
    git(source, 'config', 'user.email', 'release-fixture@example.invalid');
    git(source, 'commit', '--allow-empty', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    git(source, 'commit', '--allow-empty', '-m', 'qualified source');
    const qualified = git(source, 'rev-parse', 'HEAD');
    git(source, 'commit', '--allow-empty', '-m', 'later source');
    git(source, 'branch', 'stable');
    git(source, 'checkout', '-b', 'outsider', base);
    git(source, 'commit', '--allow-empty', '-m', 'outside release history');
    const outsider = git(source, 'rev-parse', 'HEAD');
    const origin = join(root, 'origin.git');
    git(root, 'clone', '--bare', source, origin);
    for (const branch of ['main', 'stable']) {
      const client = join(root, branch);
      git(root, 'clone', '--depth=1', '--branch', branch, pathToFileURL(origin).href, client);
      assert.equal(git(client, 'rev-parse', '--is-shallow-repository'), 'true');
      const version = (sha) => (branch === 'main' ? `0.5.0-dev.1.${sha.slice(0, 12)}` : '0.4.1');
      const run = (sha) =>
        execFileSync(process.execPath, [script, version(sha), sha], {
          cwd: client,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      assert.match(
        run(qualified),
        new RegExp(`source_sha=${qualified}\\nsource_branch=${branch}\\n`),
      );
      assert.throws(
        () => run(outsider),
        (error) => error.stderr.includes(`release-source-not-on-${branch}`),
      );
      assert.match(run(qualified), new RegExp(`source_sha=${qualified}\\n`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

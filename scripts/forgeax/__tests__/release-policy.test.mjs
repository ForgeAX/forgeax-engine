import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertChannelAdvance,
  assertRcAboveStable,
  assertReleaseSource,
  assertSuccessfulCandidateRun,
  developmentVersion,
  releasePolicy,
  stableVersionOf,
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

test('stable, rc and development identities select disjoint branch, tag and mirror policies', () => {
  assert.deepEqual(releasePolicy('0.4.1'), {
    channel: 'stable',
    branch: 'stable',
    tag: 'latest',
    mirror: 'stable',
  });
  assert.deepEqual(releasePolicy('0.4.2-rc.3'), {
    channel: 'rc',
    branch: 'rc',
    tag: 'rc',
    mirror: null,
  });
  assert.deepEqual(releasePolicy('0.5.0-dev.123.abcdef123456'), {
    channel: 'next',
    branch: 'main',
    tag: 'next',
    mirror: 'main',
  });
  for (const invalid of [
    '01.2.3',
    '1.2.3-dev.01.abcdef123456',
    '1.2.3-rc.01',
    '1.2.3-rc',
    '1.2.3-rc.1.abcdef123456',
    '1.2.3-beta',
    'latest',
    '1.2.3+dev',
  ])
    assert.throws(() => releasePolicy(invalid), /release-version-invalid/);
});

test('source membership and development SHA are checked before release', () => {
  const source = `abcdef123456${'a'.repeat(28)}`;
  assert.throws(
    () => assertReleaseSource('1.2.3', source, { stable: 'b'.repeat(40) }, () => false),
    /release-source-not-on-stable/,
  );
  assert.throws(
    () => assertReleaseSource('1.2.3-dev.8.abcdef654321', source, { main: source }, () => true),
    /release-development-source-mismatch/,
  );
  assert.equal(
    assertReleaseSource('1.2.3-dev.8.abcdef123456', source, { main: source }, () => true),
    'main',
  );
});

test('an rc source must contain the current stable so promotion fast-forwards', () => {
  const source = 'a'.repeat(40);
  const stable = 'b'.repeat(40);
  const contains = (sha, head) => sha === head || (sha === stable && head === source);
  assert.equal(assertReleaseSource('1.2.4-rc.1', source, { rc: source, stable }, contains), 'rc');
  assert.throws(
    () =>
      assertReleaseSource(
        '1.2.4-rc.1',
        source,
        { rc: source, stable },
        (sha, head) => sha === head,
      ),
    /release-rc-missing-stable/,
  );
  assert.throws(
    () => assertReleaseSource('1.2.4-rc.1', source, { rc: source }, contains),
    /release-rc-missing-stable/,
  );
});

test('a stable version is prepared only from the exact rc tip that contains stable', () => {
  const tip = 'a'.repeat(40);
  const older = 'c'.repeat(40);
  const stable = 'b'.repeat(40);
  // stable <- older <- tip on rc; stable has not moved yet.
  const history = { [tip]: [tip, older, stable], [older]: [older, stable], [stable]: [stable] };
  const contains = (sha, head) => history[head]?.includes(sha) ?? false;
  assert.equal(assertReleaseSource('1.2.4', tip, { rc: tip, stable }, contains), 'rc');
  assert.throws(
    () => assertReleaseSource('1.2.4', older, { rc: tip, stable }, contains),
    /release-source-not-on-stable/,
  );
  assert.throws(
    () => assertReleaseSource('1.2.4', tip, { rc: tip, stable }, (sha, head) => sha === head),
    /release-source-not-on-stable/,
  );
  // After Promotion fast-forwards stable, the same source is ordinary stable history.
  assert.equal(assertReleaseSource('1.2.4', tip, { rc: tip, stable: tip }, contains), 'stable');
  assert.equal(stableVersionOf('1.2.4-rc.3'), '1.2.4');
  assert.throws(() => stableVersionOf('1.2.4'), /release-version-not-rc/);
});

test('an rc line stays above the published stable; a hotfix taking its number moves it up', () => {
  assertRcAboveStable('1.2.4-rc.1', '1.2.3');
  assertRcAboveStable('1.2.4-rc.1', undefined);
  assertRcAboveStable('1.2.4', '1.2.4');
  assert.throws(() => assertRcAboveStable('1.2.4-rc.3', '1.2.4'), /release-rc-not-above-stable/);
  assertRcAboveStable('1.2.5-rc.3', '1.2.4');
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
  assertChannelAdvance('1.2.4-rc.2', '1.2.4-rc.1');
  assertChannelAdvance('1.2.5-rc.3', '1.2.4-rc.2');
  assert.throws(() => assertChannelAdvance('1.2.4-rc.1', '1.2.4-rc.2'), /regression/);
  assert.throws(() => assertChannelAdvance('1.2.4-rc.3', '1.2.4'), /regression/);
  // A public mirror branch moves from its previous stable manifest to development.
  assertChannelAdvance('1.3.0-dev.1.abcdef123456', '1.2.3');
});

test('development identity continues the next sequence on the minor after stable', () => {
  const source = `abcdef123456${'a'.repeat(28)}`;
  assert.equal(
    developmentVersion('0.3.11', '0.4.0-dev.15099.140c393b90db', source),
    '0.4.0-dev.15100.abcdef123456',
  );
  // A new stable minor restarts the sequence; an absent next starts it.
  assert.equal(
    developmentVersion('0.4.0', '0.4.0-dev.15099.140c393b90db', source),
    '0.5.0-dev.1.abcdef123456',
  );
  assert.equal(developmentVersion('0.3.11', undefined, source), '0.4.0-dev.1.abcdef123456');
  assert.throws(
    () => developmentVersion('0.4.0-dev.1.abcdef123456', undefined, source),
    /baseline-invalid/,
  );
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
    git(source, 'checkout', '-b', 'rc');
    git(source, 'commit', '--allow-empty', '-m', 'weekly rc cut');
    const cut = git(source, 'rev-parse', 'HEAD');
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
    const client = join(root, 'rc');
    git(root, 'clone', '--depth=1', '--branch', 'rc', pathToFileURL(origin).href, client);
    const runRc = (sha) =>
      execFileSync(process.execPath, [script, '0.4.2-rc.1', sha], {
        cwd: client,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    assert.match(runRc(cut), new RegExp(`source_sha=${cut}\\nsource_branch=rc\\nchannel=rc\\n`));
    assert.throws(
      () => runRc(qualified),
      (error) => error.stderr.includes('release-rc-missing-stable'),
    );
    const runStable = (sha) =>
      execFileSync(process.execPath, [script, '0.4.2', sha], {
        cwd: client,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    assert.match(
      runStable(cut),
      new RegExp(`source_sha=${cut}\\nsource_branch=rc\\nchannel=stable\\n`),
    );
    assert.match(
      runStable(qualified),
      new RegExp(`source_sha=${qualified}\\nsource_branch=stable\\n`),
    );
    assert.throws(
      () => runStable(outsider),
      (error) => error.stderr.includes('release-source-not-on-stable'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

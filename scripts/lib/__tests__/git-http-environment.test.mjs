import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gitHttpEnvironment } from '../git-http-environment.mjs';

test('a checkout without persisted credentials forwards its explicit GitHub token only to GitHub', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-git-auth-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    const input = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GH_TOKEN: 'fixture-secret',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'fixture.keep',
      GIT_CONFIG_VALUE_0: 'retained',
    };
    const before = { ...input };
    const result = gitHttpEnvironment(root, 'https://github.com', input);
    assert.equal(result.GIT_CONFIG_COUNT, '3');
    assert.equal(result.GIT_CONFIG_VALUE_0, 'retained');
    assert.equal(result.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
    assert.equal(result.GIT_CONFIG_VALUE_1, '');
    assert.equal(
      result.GIT_CONFIG_VALUE_2,
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:fixture-secret').toString('base64')}`,
    );
    assert.deepEqual(gitHttpEnvironment(root, 'https://example.invalid', input), input);
    assert.deepEqual(gitHttpEnvironment(root, 'http://github.com', input), input);
    assert.deepEqual(input, before);
    execFileSync('git', [
      '-C',
      root,
      'config',
      'http.https://github.com/.extraheader',
      'Authorization: fixture-header',
    ]);
    assert.equal(
      gitHttpEnvironment(root, 'https://github.com', input).GIT_CONFIG_VALUE_2,
      'Authorization: fixture-header',
    );
    const githubToken = { ...input, GH_TOKEN: undefined, GITHUB_TOKEN: 'fixture-fallback' };
    execFileSync('git', [
      '-C',
      root,
      'config',
      '--unset-all',
      'http.https://github.com/.extraheader',
    ]);
    assert.equal(
      gitHttpEnvironment(root, 'https://github.com', githubToken).GIT_CONFIG_VALUE_2,
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:fixture-fallback').toString('base64')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

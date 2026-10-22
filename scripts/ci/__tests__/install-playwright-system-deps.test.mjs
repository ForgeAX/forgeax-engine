import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const installer = resolve('scripts/ci/install-playwright-system-deps-with-retry.sh');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-package-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  const script = (path, body) =>
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  script(join(bin, 'id'), 'echo 1000');
  script(join(bin, 'sudo'), 'test "$1" = -n\nshift\nexec "$@"');
  script(
    join(bin, 'dpkg'),
    'echo "dpkg $*" >> "$FIXTURE_LOG"\ntest "$FIXTURE_REPAIR_EXIT" = 0 || exit "$FIXTURE_REPAIR_EXIT"\nrm -f "$FIXTURE_PENDING"',
  );
  script(
    join(bin, 'fixture-install'),
    'echo install >> "$FIXTURE_LOG"\ntest ! -e "$FIXTURE_PENDING"',
  );
  script(join(bin, 'sleep'), ':');
  script(
    join(root, 'scripts/ci/with-apt-ubuntu-sources.sh'),
    'echo sources >> "$FIXTURE_LOG"\nexec "$@"',
  );
  const log = join(root, 'calls.log');
  const pending = join(root, 'pending');
  return {
    interrupt: () => writeFileSync(pending, 'unconfigured package\n'),
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
    run: (overrides = {}) =>
      spawnSync('bash', [installer, 'fixture-install'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_WORKSPACE: root,
          RUNNER_OS: 'Linux',
          FIXTURE_REPAIR_EXIT: '0',
          FIXTURE_LOG: log,
          FIXTURE_PENDING: pending,
          ...overrides,
        },
        encoding: 'utf8',
      }),
  };
}

test('completes interrupted package configuration before the real install command', (t) => {
  const f = fixture(t);
  f.interrupt();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['dpkg --force-confold --configure -a', 'sources', 'install']);
});

test('a failed package recovery blocks installation with its original exit code', (t) => {
  const f = fixture(t);
  f.interrupt();
  const result = f.run({ FIXTURE_REPAIR_EXIT: '42' });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(f.calls(), ['dpkg --force-confold --configure -a']);
});

test('non-Linux consumers do not run package recovery', (t) => {
  const f = fixture(t);
  const result = f.run({ RUNNER_OS: 'macOS', FIXTURE_REPAIR_EXIT: '42' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['sources', 'install']);
});

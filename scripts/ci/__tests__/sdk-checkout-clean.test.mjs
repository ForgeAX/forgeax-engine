import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const producers = [
  ['sdk-pr-preflight.yml', 'build-sdk'],
  ['sdk-release-candidate.yml', 'build-sdk'],
  ['sdk-release-candidate.yml', 'reproducibility'],
];
const cleanupCommand = (name, producer) => {
  const source = readFileSync(resolve('.github/workflows', name), 'utf8');
  const start = source.indexOf(`\n  ${producer}:\n`);
  assert.ok(start >= 0, `${name}: missing ${producer} source builder`);
  const rest = source.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  const job = end < 0 ? rest : rest.slice(0, end + 1);
  const checkout = job.indexOf('uses: actions/checkout@v5');
  const cleanup = job.indexOf(
    '- name: Clean retired submodule checkouts before source preparation',
  );
  const nextSetup = job.indexOf('uses: actions/setup-node@v5');
  assert.ok(
    checkout >= 0 && cleanup > checkout && nextSetup > cleanup,
    `${name}/${producer}: cleanup must follow checkout and precede every source producer`,
  );
  const step = job.slice(cleanup, job.indexOf('\n      - ', cleanup + 1));
  assert.match(step, /if: runner.environment == 'self-hosted'/);
  const command = step.match(/run: (.+)/)?.[1];
  assert.ok(command);
  return command === '|'
    ? step
        .split('run: |\n')[1]
        .split('\n')
        .map((line) => line.slice(10))
        .join('\n')
        .trim()
    : command;
};

// actions/checkout cleans before changing revision. A gitlink tracked by the
// old revision survives that clean and becomes an untracked checkout after
// switching to source that retired it. Exercise the actual post-checkout command.
test('SDK source preparation clears retained submodule changes and preserves their pinned source', () => {
  for (const [workflow, producer] of producers) {
    const clean = cleanupCommand(workflow, producer);
    const temporary = mkdtempSync(join(tmpdir(), 'forgeax-sdk-retired-gitlink-'));
    try {
      const vendor = join(temporary, 'vendor');
      const root = join(temporary, 'engine');
      git(temporary, 'init', '--initial-branch=main', vendor);
      git(vendor, 'config', 'user.name', 'SDK fixture');
      git(vendor, 'config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(vendor, '.gitattributes'), 'native.txt text eol=lf\n');
      writeFileSync(join(vendor, 'native.txt'), 'pinned native source\n');
      git(vendor, 'add', '.');
      git(vendor, 'commit', '-m', 'native source');
      const native = git(vendor, 'rev-parse', 'HEAD');
      git(temporary, 'init', '--initial-branch=main', root);
      git(root, 'config', 'user.name', 'SDK fixture');
      git(root, 'config', 'user.email', 'fixture@example.invalid');
      git(root, 'config', 'submodule.recurse', 'false');
      for (const path of ['third_party/current', 'third_party/retired'])
        git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', vendor, path);
      git(root, 'commit', '-am', 'both submodules');
      const previous = git(root, 'rev-parse', 'HEAD');
      git(root, 'rm', '--cached', 'third_party/retired');
      git(root, 'config', '-f', '.gitmodules', '--remove-section', 'submodule.third_party/retired');
      git(root, 'add', '.gitmodules');
      git(root, 'commit', '-am', 'retire old source');
      const current = git(root, 'rev-parse', 'HEAD');
      git(root, 'checkout', previous);
      git(root, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
      git(root, 'clean', '-ffdx');
      git(root, 'checkout', current);
      assert.match(git(root, 'status', '--porcelain'), /\?\? third_party\/retired\//);
      writeFileSync(join(root, 'third_party/current/native.txt'), 'stale tracked source\n');
      writeFileSync(join(root, 'third_party/current/old-output.txt'), 'stale untracked output\n');
      execFileSync('bash', ['-e', '-c', clean], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(git(root, 'status', '--porcelain'), '');
      assert.equal(git(join(root, 'third_party/current'), 'rev-parse', 'HEAD'), native);
      assert.equal(
        readFileSync(join(root, 'third_party/current/native.txt'), 'utf8'),
        'pinned native source\n',
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});

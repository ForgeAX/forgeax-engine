import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('Candidate absorbs standalone workspace sources before every recursive checkout', () => {
  const workflow = readFileSync(resolve('.github/workflows/sdk-release-candidate.yml'), 'utf8');
  const commands = [
    ...workflow.matchAll(
      / {8}run: \|\n((?: {10}.*\n|\n)+) {6}- uses: actions\/checkout@v5\n {8}with:\n {10}ref: \$\{\{ needs.resolve-source.outputs.source_sha \}\}\n(?: {10}.*\n)*? {10}submodules: recursive/g,
    ),
  ].map((match) =>
    match[1]
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n'),
  );
  assert.equal(commands.length, 4);
  for (const command of commands) {
    const temporary = mkdtempSync(join(tmpdir(), 'forgeax-sdk-standalone-'));
    try {
      const root = join(temporary, 'engine');
      const env = {
        ...process.env,
        GITHUB_WORKSPACE: root,
        RUNNER_TEMP: temporary,
        GIT_CONFIG_GLOBAL: join(temporary, 'global.gitconfig'),
      };
      git(temporary, 'init', '--initial-branch=main', root);
      git(root, 'config', 'user.name', 'SDK fixture');
      git(root, 'config', 'user.email', 'fixture@example.invalid');
      const pins = new Map();
      for (const path of ['tools/view', 'packages/modeling']) {
        const source = join(root, path);
        mkdirSync(source, { recursive: true });
        git(root, 'init', '--initial-branch=main', source);
        git(source, 'config', 'user.name', 'SDK fixture');
        git(source, 'config', 'user.email', 'fixture@example.invalid');
        writeFileSync(join(source, 'source.txt'), path);
        git(source, 'add', 'source.txt');
        git(source, 'commit', '-m', 'source');
        pins.set(path, git(source, 'rev-parse', 'HEAD'));
        git(root, 'config', '-f', '.gitmodules', `submodule.${path}.path`, path);
        git(root, 'config', '-f', '.gitmodules', `submodule.${path}.url`, source);
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${pins.get(path)},${path}`);
        const stale = join(root, '.git/modules', path);
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, 'stale.txt'), 'previous absorbed checkout');
      }
      git(root, 'add', '.gitmodules');
      git(root, 'commit', '-m', 'workspace sources');
      execFileSync('bash', ['-e', '-c', command], { cwd: root, env, stdio: 'pipe' });
      for (const [path, pin] of pins) {
        assert.ok(
          statSync(join(root, path, '.git')).isFile(),
          `${path}: standalone Git directory remains`,
        );
        assert.equal(git(join(root, path), 'rev-parse', 'HEAD'), pin);
        assert.ok(!existsSync(join(root, '.git/modules', path, 'stale.txt')));
      }
      assert.equal(git(root, 'status', '--porcelain'), '');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});
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

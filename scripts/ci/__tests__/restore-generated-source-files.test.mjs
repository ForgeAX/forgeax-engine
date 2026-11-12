import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const restoreScript = resolve(repoRoot, 'scripts/ci/restore-generated-source-files.mjs');
const generatedPath = 'apps/hello/taa/evidence/visual-cases.json';
const unexpectedPath = 'apps/hello/taa/src/main.ts';

const runGit = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-restore-generated-source-'));
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'ci@example.invalid']);
  runGit(root, ['config', 'user.name', 'ForgeAX CI']);

  for (const [path, content] of [
    [generatedPath, 'stable-visual-cases\n'],
    [unexpectedPath, 'stable-source\n'],
  ]) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  runGit(root, ['add', '--all']);
  runGit(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
};

const runRestore = (root) =>
  spawnSync(process.execPath, [restoreScript], {
    cwd: root,
    encoding: 'utf8',
  });

test('restores TAA generated evidence and refuses mixed tracked changes before either restore', () => {
  const root = createFixture();
  try {
    writeFileSync(join(root, generatedPath), 'generated-change\n');
    const restored = runRestore(root);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /apps\/hello\/taa\/evidence\/visual-cases\.json/);
    assert.equal(readFileSync(join(root, generatedPath), 'utf8'), 'stable-visual-cases\n');
    assert.equal(runGit(root, ['status', '--porcelain']), '');

    writeFileSync(join(root, generatedPath), 'generated-change-again\n');
    writeFileSync(join(root, unexpectedPath), 'unexpected-change\n');
    const refused = runRestore(root);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /unexpected tracked changes exist/);
    assert.match(refused.stderr, /apps\/hello\/taa\/src\/main\.ts/);
    assert.equal(readFileSync(join(root, generatedPath), 'utf8'), 'generated-change-again\n');
    assert.equal(readFileSync(join(root, unexpectedPath), 'utf8'), 'unexpected-change\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

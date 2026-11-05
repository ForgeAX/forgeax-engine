import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { rootDocsPolicyViolations } from '../check-root-docs.mjs';

test('rejects staged root docs through the CLI on the current platform', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-root-docs-cli-'));
  const ownedRoot = realpathSync(root);
  assert.ok(ownedRoot.startsWith(realpathSync(tmpdir()) + sep));
  t.after(() => {
    assert.equal(realpathSync(root), ownedRoot);
    rmSync(ownedRoot, { recursive: true, force: true });
  });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'forbidden.md'), '# Forbidden root document\n');
  assert.equal(spawnSync('git', ['add', '--', 'docs/forbidden.md'], { cwd: root }).status, 0);
  const gate = fileURLToPath(new URL('../check-root-docs.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [gate], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /root docs are forbidden/);
});

test('allows a clean final tree', () => {
  assert.deepEqual(rootDocsPolicyViolations(['packages/runtime/README.md']), []);
});

test('rejects every tracked root docs path', () => {
  assert.deepEqual(rootDocsPolicyViolations(['docs/design.md', 'docs/reports/status.md']), [
    { filename: 'docs/design.md', status: 'present' },
    { filename: 'docs/reports/status.md', status: 'present' },
  ]);
});

test('allows deletions while the retired directory is drained', () => {
  assert.deepEqual(
    rootDocsPolicyViolations([
      { filename: 'docs/design.md', status: 'removed' },
      { filename: 'packages/runtime/README.md', status: 'modified' },
    ]),
    [],
  );
});

test('rejects additions, edits, and renames involving root docs', () => {
  assert.deepEqual(
    rootDocsPolicyViolations([
      { filename: 'docs/new.md', status: 'added' },
      { filename: 'docs/old.md', status: 'modified' },
      {
        filename: 'packages/runtime/README.md',
        previous_filename: 'docs/old.md',
        status: 'renamed',
      },
    ]),
    [
      { filename: 'docs/new.md', previousFilename: undefined, status: 'added' },
      { filename: 'docs/old.md', previousFilename: undefined, status: 'modified' },
      {
        filename: 'packages/runtime/README.md',
        previousFilename: 'docs/old.md',
        status: 'renamed',
      },
    ],
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { rootDocsPolicyViolations } from '../check-root-docs.mjs';

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

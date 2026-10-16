import assert from 'node:assert/strict';
import test from 'node:test';

import { rootForgeaxLoopPolicyViolations } from '../check-root-forgeax-loop.mjs';

test('allows a clean final tree', () => {
  assert.deepEqual(rootForgeaxLoopPolicyViolations(['packages/runtime/README.md']), []);
});

test('rejects tracked root forgeax-loop paths', () => {
  assert.deepEqual(
    rootForgeaxLoopPolicyViolations([
      'forgeax-loop/bug-20260820-csm-door-shadow-clipping/loop-state.json',
      'packages/runtime/README.md',
    ]),
    [
      {
        filename: 'forgeax-loop/bug-20260820-csm-door-shadow-clipping/loop-state.json',
        status: 'present',
      },
    ],
  );
});

test('allows deletion of the retired root forgeax-loop path', () => {
  assert.deepEqual(
    rootForgeaxLoopPolicyViolations([
      {
        filename: 'forgeax-loop/bug-20260820-csm-door-shadow-clipping/loop-state.json',
        status: 'removed',
      },
    ]),
    [],
  );
});

test('rejects additions, edits, and renames involving root forgeax-loop', () => {
  assert.deepEqual(
    rootForgeaxLoopPolicyViolations([
      { filename: 'forgeax-loop/new.json', status: 'added' },
      { filename: 'forgeax-loop/old.json', status: 'modified' },
      {
        filename: 'packages/runtime/README.md',
        previous_filename: 'forgeax-loop/old.json',
        status: 'renamed',
      },
    ]),
    [
      { filename: 'forgeax-loop/new.json', previousFilename: undefined, status: 'added' },
      { filename: 'forgeax-loop/old.json', previousFilename: undefined, status: 'modified' },
      {
        filename: 'packages/runtime/README.md',
        previousFilename: 'forgeax-loop/old.json',
        status: 'renamed',
      },
    ],
  );
});

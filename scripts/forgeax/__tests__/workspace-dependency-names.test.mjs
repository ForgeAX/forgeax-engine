import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceDependencyNames } from '../../build-task-cache.mjs';

test('optional peer dependencies do not create build-order cycles', () => {
  const knownNames = new Set(['@forgeax/engine-physics-rapier3d', '@forgeax/engine-required-peer']);
  const dependencies = workspaceDependencyNames(
    {
      dependencies: {},
      peerDependencies: {
        '@forgeax/engine-physics-rapier3d': 'workspace:*',
        '@forgeax/engine-required-peer': 'workspace:*',
      },
      peerDependenciesMeta: {
        '@forgeax/engine-physics-rapier3d': { optional: true },
      },
    },
    knownNames,
  );

  assert.deepEqual([...dependencies], ['@forgeax/engine-required-peer']);
});

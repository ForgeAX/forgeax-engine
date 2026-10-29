import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, test } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { meshDrawSnapshot, rotateMeshDraws } from '../mesh-draw';
import { MeshFrame } from '../mesh-frame';

function source(entityKey: number): RenderableSnapshot {
  const material = new MaterialResource(defaultMaterialSnapshot());
  return {
    worldId: 0,
    entityKey,
    assetHandle: 1,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    material,
    materials: [material],
    materialOverrides: [],
    materialBindingSources: ['engine-default'],
  };
}

test('draw projections stay shared across consecutive reads and never stay resident per row', () => {
  const meshes = new MeshFrame().with(0, 1, createBoxGeometry(2, 2, 2).unwrap());
  const row = source(1);
  const first = meshDrawSnapshot(row, meshes);
  expect(first).not.toBe(row);
  expect(meshDrawSnapshot(row, meshes)).toBe(first);
  rotateMeshDraws();
  // A read in the next generation keeps the shared projection.
  expect(meshDrawSnapshot(row, meshes)).toBe(first);
  rotateMeshDraws();
  rotateMeshDraws();
  // Two generations without a read drop it: a cold complete read is not retained.
  const later = meshDrawSnapshot(row, meshes);
  expect(later).not.toBe(first);
  expect(later).toEqual(first);
});

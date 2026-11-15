import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, test } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { meshDrawSnapshot, rotateMeshDraws } from '../mesh-draw';
import { MeshFrame } from '../mesh-frame';

function source(entityKey: number): RenderableSnapshot {
  const material = new MaterialResource(defaultMaterialSnapshot());
  return {
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
  const meshes = new MeshFrame().with(1, createBoxGeometry(2, 2, 2).unwrap());
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

test('mesh binding projection rebases the appended WaterMesh material range after slot changes', () => {
  const ordinary = new MaterialResource(defaultMaterialSnapshot(1));
  const removedOrdinary = new MaterialResource(defaultMaterialSnapshot(2));
  const waterNear = new MaterialResource(defaultMaterialSnapshot(3));
  const waterFar = new MaterialResource(defaultMaterialSnapshot(4));
  const geometry = createBoxGeometry(2, 2, 2).unwrap();
  const meshes = new MeshFrame().with(1, geometry, [ordinary]);
  const row: RenderableSnapshot = {
    ...source(1),
    material: ordinary,
    materials: [ordinary, removedOrdinary, waterNear, waterFar],
    materialBindingSources: ['renderer-override', 'mesh-default', 'mesh-default', 'mesh-default'],
    waterMeshSource: {
      guid: 'scene-entity:1',
      generation: 1,
      worldIdentity: 'world',
      zoneGuid: 'zone',
      zoneGeneration: 1,
      targetFormat: 'rgba16float',
      materialStartIndex: 2,
      views: [
        {
          viewIdentity: 'view',
          draws: [{ materialIndex: 2 } as never, { materialIndex: 3 } as never],
        },
      ],
    },
  };
  const originalMaterials = row.materials;
  const originalWaterSource = row.waterMeshSource;

  const projected = meshDrawSnapshot(row, meshes);
  const draws = projected.waterMeshSource?.views[0]?.draws;

  expect(projected.materials).toEqual([ordinary, waterNear, waterFar]);
  expect(projected.waterMeshSource?.materialStartIndex).toBe(1);
  expect(draws?.map((draw) => draw.materialIndex)).toEqual([1, 2]);
  expect(projected.materials[draws?.[0]?.materialIndex ?? -1]).toBe(waterNear);
  expect(projected.materials[draws?.[1]?.materialIndex ?? -1]).toBe(waterFar);
  expect(row.materials).toBe(originalMaterials);
  expect(row.waterMeshSource).toBe(originalWaterSource);
  expect(row.waterMeshSource?.materialStartIndex).toBe(2);
  expect(row.waterMeshSource?.views[0]?.draws.map((draw) => draw.materialIndex)).toEqual([2, 3]);
});

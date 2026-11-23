import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, test } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { meshDrawSnapshot, SceneMeshDrawShapes } from '../mesh-draw';
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

test('borrows current entity fields and shares admitted mesh facts across one frame', () => {
  const meshes = new MeshFrame().with(1, createBoxGeometry(2, 2, 2).unwrap());
  const row = { ...source(1) };
  const first = meshDrawSnapshot(row, meshes);
  row.entityKey = 2;
  const later = meshDrawSnapshot(row, meshes);
  expect(later.entityKey).toBe(2);
  expect(first.entityKey).toBe(1);
  expect(later.localAabb).toBe(first.localAabb);
  expect(later.materials).toBe(first.materials);
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

  const shapes = new SceneMeshDrawShapes();
  const { entityKey: _entity, transform: _transform, ...content } = row;
  const displayed = shapes.resolve(content, meshes);
  expect(displayed.materials).toEqual([ordinary, waterNear, waterFar]);
  expect(displayed.waterMeshSource?.materialStartIndex).toBe(1);
  expect(shapes.resolve(content, new MeshFrame())).toBe(content);

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

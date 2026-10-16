import { pickTriangle } from '@forgeax/engine/picking';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { propagateTransforms, Transform } from '@forgeax/engine/scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { makePickScene, VIEWPORT, worldFingerprint } from './_shared/pick-scene';

const CENTER = VIEWPORT / 2;

export default defineFeature({
  title: 'Exact triangle picking',
  catalog: 'Exact triangle picking',
  kind: 'headless',
  summary:
    'pickTriangle intersects world-space CPU triangles, returning the nearest hit with triangle index and barycentrics, or an explicit unavailable status.',
  expect:
    'Center hits the near box front face at z=1.5 with barycentrics summing to 1; assetGuidOf is echoed; a skinned mesh yields unavailable/skinned-pose-unavailable.',
  run(checks) {
    const scene = makePickScene();
    const before = worldFingerprint(scene.world);
    const result = pickTriangle(scene.world, scene.camera, CENTER, CENTER, VIEWPORT, VIEWPORT, {
      assetGuidOf: (asset) => (asset === scene.mesh ? 'lab-box-guid' : undefined),
    });
    if (result.status !== 'hit') {
      checks.ok('center hits a triangle', false, result.status);
      return;
    }
    const { hit } = result;
    checks.ok('hit entity is the near (occluding) box', hit.entity === scene.near);
    checks.ok(
      'hit point on front face z=1.5',
      Math.abs((hit.point[2] ?? 0) - 1.5) < 1e-4,
      JSON.stringify([hit.point[0], hit.point[1], hit.point[2]]),
    );
    checks.ok(
      'barycentrics sum to 1',
      Math.abs(hit.barycentric[0] + hit.barycentric[1] + hit.barycentric[2] - 1) < 1e-4,
    );
    checks.ok(
      'triangle index is reported',
      Number.isInteger(hit.triangleIndex),
      String(hit.triangleIndex),
    );
    checks.ok(
      'assetGuidOf resolves the GUID',
      hit.assetGuid === 'lab-box-guid',
      String(hit.assetGuid),
    );
    const miss = pickTriangle(scene.world, scene.camera, 5, 5, VIEWPORT, VIEWPORT);
    checks.ok('empty corner is a triangle-precision miss', miss.status === 'miss');
    checks.ok('World unchanged', worldFingerprint(scene.world) === before);

    const skinnedScene = makePickScene();
    const skinned: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
      attributes: {
        position: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
        skinIndex: new Uint16Array(12),
        skinWeight: new Float32Array(12),
      },
      aabb: new Float32Array([-1, -1, 0, 1, 1, 0]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'Default' }],
    };
    const world = skinnedScene.world;
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        {
          component: MeshFilter,
          data: { assetHandle: world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', skinned) },
        },
        {
          component: MeshRenderer,
          data: {
            materials: [
              world.allocSharedRef<'MaterialAsset', MaterialAsset>(
                'MaterialAsset',
                Materials.unlit([1, 1, 1, 1]),
              ),
            ],
          },
        },
      )
      .unwrap();
    propagateTransforms(world);
    const unavailable = pickTriangle(
      world,
      skinnedScene.camera,
      CENTER,
      CENTER,
      VIEWPORT,
      VIEWPORT,
    );
    checks.ok(
      'skinned mesh in front yields unavailable',
      unavailable.status === 'unavailable' && unavailable.reason === 'skinned-pose-unavailable',
      unavailable.status === 'unavailable' ? unavailable.reason : unavailable.status,
    );
  },
});

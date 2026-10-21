import { createHash } from 'node:crypto';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import {
  buildMeshDistanceField,
  createBoxGeometry,
  encodeMeshDistanceField,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
} from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { withClipping } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { projectCollisionScene } from '../assembly/scene-sdf-projection';
import { MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import { projectRayScene } from '../raytracing/scene-projection';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

async function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const red = assets.create(Materials.standard({ baseColor: [1, 0, 0, 1] })).unwrap();
  const green = assets.create(Materials.standard({ baseColor: [0, 1, 0, 1] })).unwrap();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  assert(geometry.attributes.position instanceof Float32Array);
  assert(geometry.indices);
  const field = (
    await buildMeshDistanceField(geometry.attributes.position, geometry.indices, { resolution: 8 })
  ).unwrap();
  const bytes = (await encodeMeshDistanceField(field)).unwrap();
  const mesh = assets
    .create({
      ...geometry,
      materialSlots: [{ slotName: 'surface', defaultMaterial: red }],
      distanceField: {
        ...field,
        sectionSidedness: [0],
        artifact: {
          integrity: {
            algorithm: 'sha256',
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
          assetCodec: MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
        },
      },
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore();
  const lease = createRenderReadLease(world);
  const draw = () => {
    world.update(0).unwrap();
    scene.extractComposition(
      [world],
      { cameraOwner: 0, resourceOwner: 0 },
      assets,
      (request) =>
        extractFrames([world], 0, assets, undefined, caches, {
          cull: 'none',
          renderables: request,
        }),
      [lease],
    );
    const retained = scene.compositionRetainedScene();
    assert(retained);
    return retained;
  };
  const collision = (frame: ReturnType<typeof draw>) =>
    projectCollisionScene(
      frame.slots,
      frame.worlds,
      0,
      {
        origin: [-2, -2, -2],
        dimensions: [5, 5, 5],
        spacing: 1,
        maxDistance: 2,
        maxInstances: 16,
        maxFieldBytes: 1024 * 1024,
      },
      frame,
    );
  return {
    assets,
    mesh,
    red,
    green,
    draw,
    collision,
    dispose() {
      scene.dispose();
      lease.dispose();
      assets.dispose();
    },
  };
}

it('projects current Mesh defaults and fixed material values without replacing retained slots', async () => {
  const f = await fixture();
  try {
    const before = f.draw();
    const project = (frame: typeof before) => projectRayScene(frame.slots, frame.worlds, 16, frame);
    expect(project(before).materials[0]?.handle).toBe(f.red);
    f.assets
      .update(f.mesh, { materialSlots: [{ slotName: 'surface', defaultMaterial: f.green }] })
      .unwrap();
    const rebound = f.draw();
    expect(rebound.slots.at(0)).toBe(before.slots.at(0));
    expect(project(rebound).materials[0]?.handle).toBe(f.green);
    expect(project(before).materials[0]?.handle).toBe(f.red);
    f.assets.update(f.green, { values: { baseColor: [0, 0, 1, 1] } }).unwrap();
    const repainted = f.draw();
    expect(repainted.slots.at(0)).toBe(rebound.slots.at(0));
    expect(project(repainted).materials[0]?.snapshot.baseColor).toEqual(
      new Float32Array([0, 0, 1]),
    );
    expect(project(rebound).materials[0]?.snapshot.baseColor).toEqual(new Float32Array([0, 1, 0]));
  } finally {
    f.dispose();
  }
});

it.each([
  'clipping',
  'displacement',
] as const)('rejects current %s defaults and preserves the fixed collision admission', async (kind) => {
  const f = await fixture();
  try {
    const texture = f.assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array(4).fill(255),
      })
      .unwrap();
    const changed = f.assets
      .create(
        kind === 'clipping'
          ? withClipping(Materials.standard({ baseColor: [1, 1, 1, 1] }), {
              planes: [[1, 0, 0, 0]],
            })
          : Materials.standard({
              baseColor: [1, 1, 1, 1],
              displacementTexture: texture,
              displacementScale: 1,
            }),
      )
      .unwrap();
    const before = f.draw();
    expect(f.collision(before).instances).toHaveLength(1);
    f.assets
      .update(f.mesh, { materialSlots: [{ slotName: 'surface', defaultMaterial: changed }] })
      .unwrap();
    const rebound = f.draw();
    expect(rebound.slots.at(0)).toBe(before.slots.at(0));
    const unsupported = expect.objectContaining({
      code: 'scene-sdf-unavailable',
      detail: expect.objectContaining({ reason: 'unsupported-geometry' }),
    });
    expect(() => f.collision(rebound)).toThrow(unsupported);
    expect(f.collision(before).instances).toHaveLength(1);
    f.assets
      .update(changed, {
        values: kind === 'clipping' ? { clippingControl: [0, 0, 0, 0] } : { displacementScale: 0 },
      })
      .unwrap();
    expect(f.collision(f.draw()).instances).toHaveLength(1);
    expect(() => f.collision(rebound)).toThrow(unsupported);
  } finally {
    f.dispose();
  }
});

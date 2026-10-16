import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Materials } from '../materials';
import { prepareExtractContext } from '../render-system-extract';
import { extractFrame } from '../render-system-extract-tail';

it.each([
  false,
  true,
])('expands CPU and GPU bounds before culling, and refreshes material changes (instances=%s)', (instanced) => {
  const world = new World();
  registerPropagateTransforms(world);
  const assets = new AssetRegistry(
    new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('No shader compilation during extract');
        },
      },
      manifestUrl: undefined,
    }),
  );
  const extract = () => extractFrame(world, prepareExtractContext(world, { assets }));
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      {
        component: Camera,
        data: { projection: 1, left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 10 },
      },
    )
    .unwrap();
  const geometry = createPlaneGeometry(1, 1).unwrap();
  const mesh = world.allocSharedRef('MeshAsset', geometry);
  const flat = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 1, 1, 1] }),
  );
  const displaced = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1, 1, 1, 1],
      displacementTexture: {
        texture: world.allocSharedRef('TextureAsset', {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data: new Uint8Array([255, 0, 0, 255]),
        }),
      },
      displacementScale: -2,
      displacementBias: 1,
    }),
  );
  const transforms = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, 0, 0, 1]);
  const entity = world
    .spawn(
      { component: Transform, data: { pos: [instanced ? 10 : 0, 0, -5.5], scale: [2, 1, 1] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [flat] } },
      ...(instanced ? [{ component: Instances, data: { transforms } }] : []),
    )
    .unwrap();
  if (instanced) {
    transforms[12] = -5;
    world.set(entity, Instances, { transforms }).unwrap();
  }
  world.update(0).unwrap();
  expect(extract().renderables).toHaveLength(0);
  world.set(entity, MeshRenderer, { materials: [displaced] }).unwrap();
  world.update(0).unwrap();
  const result = extract().renderables;
  expect(result).toHaveLength(1);
  expect(Array.from(result[0]?.localAabb ?? [])).toEqual([-1.5, -1.5, -1, 1.5, 1.5, 1]);
  expect(Array.from(geometry.aabb ?? [])).toEqual([-0.5, -0.5, 0, 0.5, 0.5, 0]);
  world.set(entity, MeshRenderer, { materials: [flat] }).unwrap();
  world.update(0).unwrap();
  expect(extract().renderables).toHaveLength(0);
});

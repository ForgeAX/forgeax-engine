import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { extractSource } from '../render-system-extract-tail';

function matrices(count: number, x: number): Float32Array {
  const out = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    out[i * 16] = out[i * 16 + 5] = out[i * 16 + 10] = out[i * 16 + 15] = 1;
    out[i * 16 + 12] = x;
  }
  return out;
}

function scene(count: number, x: number) {
  const worldAssets = new AssetRegistry();
  const world = new World({ assets: worldAssets });
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: worldAssets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: matrices(count, x) } },
    )
    .unwrap();
  world.update(0).unwrap();
  return { world, entity, assets: worldAssets };
}

describe('World-owned instance authoring', () => {
  it.each([1500, 10000, 20000])('extracts %s matrices without creating a Renderer', (count) => {
    const { world, assets } = scene(count, 0);
    const snapshot = extractSource(world, assets).renderables.at(0)?.instances;
    expect(snapshot?.instanceCount).toBe(count);
    expect(snapshot?.transforms).toEqual(matrices(count, 0));
  });

  it('keeps worlds isolated and lets independent consumers observe skipped updates', () => {
    const a = scene(2, 0);
    const b = scene(2, 1);
    const before = extractSource(a.world, a.assets).renderables.at(0)?.instances;
    expect(extractSource(b.world, b.assets).renderables.at(0)?.instances?.transforms[12]).toBe(1);
    a.world.set(a.entity, Instances, { transforms: matrices(2, 0.5) }).unwrap();
    extractSource(a.world, a.assets);
    a.world.set(a.entity, Instances, { transforms: matrices(2, -0.5) }).unwrap();
    const late = extractSource(a.world, a.assets).renderables.at(0)?.instances;
    expect(late?.transforms[12]).toBe(-0.5);
    expect(before?.transforms[12]).toBe(0);
    expect(extractSource(b.world, b.assets).renderables.at(0)?.instances?.transforms[12]).toBe(1);
  });
});

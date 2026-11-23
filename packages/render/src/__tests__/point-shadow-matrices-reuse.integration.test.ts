import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { Camera, PointLight, PointLightShadow } from '../components';
import { EnvironmentFrameGate } from '../extract/environment-frame-gate';
import { Materials } from '../materials';
import { extractSource } from '../render-system-extract-tail';
import { SceneComposition } from '../scene/scene-composition';

it('reuses packed point shadow matrices until position, near or far change', () => {
  const world = new World();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: PointLight, data: {} },
      { component: PointLightShadow, data: {} },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const assets = new AssetRegistry({} as never);
  const environmentGate = new EnvironmentFrameGate();
  environmentGate.assetsChanged = false;
  const pull = () =>
    extractSource(world, assets, undefined, { environmentGate }).lights.pointShadow?.[0]
      ?.shadowMatrices;
  const a = pull();
  const b = pull();
  expect(a).toBeDefined();
  expect(b).toBe(a);
  world.set(entity, Transform, { pos: [3, 1, 2] }).unwrap();
  propagateTransforms(world).unwrap();
  const c = pull();
  expect(c).not.toBe(a);
  expect(Array.from(c ?? [])).not.toEqual(Array.from(a ?? []));
  expect(pull()).toBe(c);
});

it('shares local light preparation across distinct cameras and unrelated asset revisions', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const first = world
    .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
    .unwrap();
  const second = world
    .spawn({ component: Transform, data: { pos: [1, 0, 0] } }, { component: Camera, data: {} })
    .unwrap();
  const light = world
    .spawn({ component: Transform, data: {} }, { component: PointLight, data: {} })
    .unwrap();
  const composition = new SceneComposition();
  const pull = (cameraEntityKey: number) =>
    extractSource(world, assets, undefined, {
      cameraEntityKey,
      renderables: 'none',
      environmentGate: composition.localLightingGate(world, assets),
      environmentLightingOnly: true,
    });
  try {
    propagateTransforms(world).unwrap();
    const a = pull(first);
    const b = pull(second);
    expect(a.cameras[0]?.entityKey).toBe(first);
    expect(b.cameras[0]?.entityKey).toBe(second);
    expect(b.lights).toBe(a.lights);
    world.set(second, Transform, { pos: [5, 0, 0] }).unwrap();
    propagateTransforms(world).unwrap();
    const changed = pull(second);
    expect(changed.cameras[0]?.position[0]).toBe(5);
    expect(changed.lights).toBe(a.lights);
    const unrelated = assets
      .create(Materials.standard({ baseColor: [1, 1, 1, 1], roughness: 0.5 }))
      .unwrap();
    assets.update(unrelated, { values: { roughness: 0.75 } }).unwrap();
    expect(pull(second).lights).toBe(a.lights);
    world.set(light, PointLight, { intensity: 4 }).unwrap();
    expect(pull(second).lights).not.toBe(a.lights);
  } finally {
    composition.invalidate();
    assets.dispose();
  }
});

import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { ANTIALIAS_TAA, Camera } from '../../components/camera';
import { CameraView } from '../../components/camera-view';
import { DynamicResolution } from '../../components/dynamic-resolution';
import { LensEffects } from '../../components/lens-effects';
import { LensFlare } from '../../components/lens-flare';
import { collectCameraSnapshots } from '../cameras';

it('detaches optional camera snapshots across component migration and later field writes', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const plain = world
    .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
    .unwrap();
  const selected = world
    .spawn(
      { component: Transform, data: { pos: [2, 3, 4] } },
      { component: Camera, data: { antialias: ANTIALIAS_TAA } },
      { component: CameraView, data: {} },
      { component: DynamicResolution, data: {} },
      { component: LensEffects, data: { vignetteIntensity: 0.5 } },
      { component: LensFlare, data: {} },
    )
    .unwrap();
  world.update().unwrap();
  const held = collectCameraSnapshots(world);
  const before = held.find((row) => row.entityKey === Number(selected));
  expect(held.find((row) => row.entityKey === Number(plain))).not.toHaveProperty('lensEffects');
  expect(before?.lensEffects?.vignetteColor).toEqual([0, 0, 0]);
  expect(before?.lensFlare?.tint).toEqual([1, 1, 1]);
  const encoded = JSON.stringify(held);
  world.set(selected, LensEffects, { vignetteColor: [1, 0, 0] }).unwrap();
  world.set(selected, Transform, { pos: [8, 9, 10] }).unwrap();
  world.removeComponent(selected, LensFlare).unwrap();
  world.addComponent(plain, { component: LensEffects, data: { grainIntensity: 0.2 } }).unwrap();
  world.update().unwrap();
  const current = collectCameraSnapshots(world);
  const after = current.find((row) => row.entityKey === Number(selected));
  expect(after?.lensEffects?.vignetteColor).toEqual([1, 0, 0]);
  expect(after).not.toHaveProperty('lensFlare');
  expect(
    current.find((row) => row.entityKey === Number(plain))?.lensEffects?.grainIntensity,
  ).toBeCloseTo(0.2);
  expect(JSON.stringify(held)).toBe(encoded);
});

it('preserves effect rejection order and retries after the current invalid field is repaired', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: {} },
      { component: LensEffects, data: { vignetteIntensity: -1 } },
      { component: LensFlare, data: { intensity: -1 } },
    )
    .unwrap();
  world.update().unwrap();
  expect(() => collectCameraSnapshots(world)).toThrow(
    expect.objectContaining({
      code: 'lens-effects-invalid-parameter',
    }),
  );
  world.set(entity, LensEffects, { vignetteIntensity: 0.5 }).unwrap();
  expect(() => collectCameraSnapshots(world)).toThrow(
    expect.objectContaining({
      code: 'lens-flare-invalid-parameter',
    }),
  );
  world.set(entity, LensFlare, { intensity: 1 }).unwrap();
  expect(collectCameraSnapshots(world)).toHaveLength(1);
});

it('keeps cached batch columns current across dense rows, optional tables and growth', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const entities = Array.from({ length: 64 }, (_, index) =>
    world
      .spawn(
        { component: Transform, data: { pos: [index, 2, 4] } },
        { component: Camera, data: {} },
        { component: CameraView, data: { order: index } },
        { component: LensEffects, data: { grainIntensity: (index % 10) / 10 } },
        ...(index % 2 === 0 ? [{ component: LensFlare, data: { threshold: index + 1 } }] : []),
      )
      .unwrap(),
  );
  world.update().unwrap();
  const held = collectCameraSnapshots(world),
    encoded = JSON.stringify(held);
  for (const [index, entity] of entities.entries()) {
    const row = held.find((row) => row.entityKey === Number(entity));
    expect(row?.view?.order).toBe(index);
    if (index % 10 !== 0) expect(row?.lensEffects?.grainIntensity).toBeCloseTo((index % 10) / 10);
    if (index % 2 === 0) expect(row?.lensFlare?.threshold).toBe(index + 1);
    else expect(row).not.toHaveProperty('lensFlare');
  }
  const first = entities[0];
  if (first === undefined) throw new Error('missing dense camera');
  world.removeComponent(first, LensFlare).unwrap();
  world.set(first, CameraView, { order: 500 }).unwrap();
  for (let index = 0; index < 300; index++)
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: {} },
        { component: CameraView, data: { order: index + 1000 } },
        { component: LensEffects, data: { grainIntensity: 0.5 } },
      )
      .unwrap();
  world.update().unwrap();
  const next = collectCameraSnapshots(world);
  expect(next).toHaveLength(364);
  expect(next.find((row) => row.entityKey === Number(first))?.view?.order).toBe(500);
  expect(next.find((row) => row.entityKey === Number(first))).not.toHaveProperty('lensFlare');
  expect(JSON.stringify(held)).toBe(encoded);
});

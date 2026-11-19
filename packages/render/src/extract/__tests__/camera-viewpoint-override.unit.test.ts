import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import {
  AmbientOcclusion,
  Camera,
  CameraView,
  LensEffects,
  PlanarReflection,
} from '../../components';
import { selectCameraRoles } from '../../render-system-extract';
import { setActiveCamera } from '../../systems/active-camera';
import { collectCameraSnapshots } from '../cameras';
import { EnvironmentFrameGate } from '../environment-frame-gate';

function fixture() {
  const world = new World();
  registerPropagateTransforms(world);
  const source = world
    .spawn(
      { component: Transform, data: { pos: [1, 2, 3] } },
      { component: Camera, data: { fov: 1 } },
      { component: CameraView, data: { viewport: [0, 0, 0.5, 1], resolutionScale: 0.5 } },
      { component: LensEffects, data: { grainIntensity: 0.2 } },
      { component: AmbientOcclusion, data: { radius: 0.7 } },
      { component: PlanarReflection, data: {} },
    )
    .unwrap();
  const other = world
    .spawn(
      { component: Transform, data: { pos: [9, 2, 3] } },
      { component: Camera, data: {} },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
      { component: LensEffects, data: { grainIntensity: 0.6 } },
    )
    .unwrap();
  const viewpoint = world
    .spawn(
      { component: Transform, data: { pos: [8, 6, 8] } },
      { component: Camera, data: { fov: 0.7, near: 0.2, far: 500 } },
    )
    .unwrap();
  world.update(0).unwrap();
  return { world, source, other, viewpoint };
}

it('replaces one declared view through its viewpoint without changing source entities', () => {
  const f = fixture();
  const before = f.world.get(f.source, CameraView).unwrap();
  setActiveCamera(f.world, f.viewpoint, f.source);
  const roles = selectCameraRoles(f.world);
  expect(roles.display.map((camera) => camera.entityKey).sort()).toEqual(
    [f.viewpoint, f.other].sort(),
  );
  const selected = roles.display.find((camera) => camera.entityKey === f.viewpoint);
  expect(selected?.position).toEqual(new Float32Array([8, 6, 8]));
  expect(selected?.fov).toBeCloseTo(0.7);
  expect(selected?.near).toBeCloseTo(0.2);
  expect(selected?.view?.resolutionScale).toBe(0.5);
  expect(selected?.view?.viewport).toEqual(new Float32Array([0, 0, 0.5, 1]));
  expect(selected?.lensEffects?.grainIntensity).toBeCloseTo(0.2);
  expect(selected?.ambientOcclusion?.radius).toBeCloseTo(0.7);
  expect(
    roles.auxiliary.some((camera) => camera.entityKey === f.viewpoint && camera.planarReflection),
  ).toBe(true);
  expect(f.world.get(f.source, CameraView).unwrap()).toEqual(before);
  expect(f.world.get(f.source, Transform).unwrap().pos).toEqual(new Float32Array([1, 2, 3]));
  expect(f.world.hasComponent(f.viewpoint, CameraView)).toBe(false);
});

it('rekeys cached camera effects when only the selected view source changes', () => {
  const f = fixture();
  const reader = new EnvironmentFrameGate();
  reader.assetsChanged = false;
  setActiveCamera(f.world, f.viewpoint, f.source);
  const first = collectCameraSnapshots(f.world, reader);
  const encoded = JSON.stringify(first);
  expect(collectCameraSnapshots(f.world, reader)).toBe(first);
  setActiveCamera(f.world, f.viewpoint, f.other);
  const second = collectCameraSnapshots(f.world, reader);
  expect(
    second.find((camera) => camera.entityKey === f.viewpoint)?.lensEffects?.grainIntensity,
  ).toBeCloseTo(0.6);
  expect(second.find((camera) => camera.entityKey === f.viewpoint)?.view?.viewport).toEqual(
    new Float32Array([0.5, 0, 0.5, 1]),
  );
  f.world.set(f.other, CameraView, { resolutionScale: 0.25 }).unwrap();
  const third = collectCameraSnapshots(f.world, reader);
  expect(third.find((camera) => camera.entityKey === f.viewpoint)?.view?.resolutionScale).toBe(
    0.25,
  );
  expect(JSON.stringify(first)).toBe(encoded);
});

it('restores the original view roster when the viewpoint selection is released', () => {
  const f = fixture();
  setActiveCamera(f.world, f.viewpoint, f.source);
  expect(
    selectCameraRoles(f.world).display.some((camera) => camera.entityKey === f.viewpoint),
  ).toBe(true);
  setActiveCamera(f.world, f.source);
  expect(
    selectCameraRoles(f.world)
      .display.map((camera) => camera.entityKey)
      .sort(),
  ).toEqual([f.source, f.other].sort());
  setActiveCamera(f.world, f.viewpoint, 999999);
  expect(
    selectCameraRoles(f.world)
      .display.map((camera) => camera.entityKey)
      .sort(),
  ).toEqual([f.source, f.other].sort());
});

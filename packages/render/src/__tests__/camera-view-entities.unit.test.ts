import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('adds and removes a CameraView without rebuilding the other views', async () => {
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  registerPropagateTransforms(world);
  const spawnCamera = (order: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE },
        },
        { component: CameraView, data: { order, viewport: new Float32Array([0, 0, 0.5, 0.5]) } },
      )
      .unwrap();
  const input = {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  };
  const draw = async (frames: number) => {
    for (let frame = 0; frame < frames; frame++) {
      expect(world.update().ok).toBe(true);
      const result = renderer.draw(input);
      if (!result.ok) throw result.error;
      if (result.value === undefined) throw new Error('expected submitted receipt');
      expect((await result.value.completed).ok).toBe(true);
    }
  };
  const rendered = () =>
    (renderer.inspect().views ?? []).map((view) => [view.entityKey, view.renderedFrames]);

  const first = spawnCamera(0);
  const second = spawnCamera(1);
  await draw(3);
  expect(rendered()).toEqual([
    [Number(first), 3],
    [Number(second), 3],
  ]);

  // A new camera seeds only its own view; retained views keep their history.
  const third = spawnCamera(2);
  await draw(1);
  expect(rendered()).toEqual([
    [Number(first), 4],
    [Number(second), 4],
    [Number(third), 1],
  ]);

  // Removing a camera retires only its view.
  world.despawn(second).unwrap();
  await draw(2);
  expect(rendered()).toEqual([
    [Number(first), 6],
    [Number(third), 3],
  ]);

  // Disabling keeps the declaration but retires its recording state; re-enabling seeds anew.
  world.set(first, CameraView, { enabled: false }).unwrap();
  await draw(1);
  expect(rendered()).toEqual([[Number(third), 4]]);
  world.set(first, CameraView, { enabled: true }).unwrap();
  await draw(1);
  expect(rendered()).toEqual([
    [Number(first), 1],
    [Number(third), 5],
  ]);
  await renderer.dispose();
});

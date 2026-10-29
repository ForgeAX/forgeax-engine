import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, Camera, perspective } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { setActiveCamera } from '../systems/active-camera';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it.each([
  undefined,
  0,
  720,
])('keeps Host budget %s outside source World and follows camera selection and resize', async (maxRenderShortSide) => {
  const canvas = { width: 3203, height: 1440, getContext: () => null };
  const renderer = await createRenderer(
    canvas,
    { rhi, ...(maxRenderShortSide === undefined ? {} : { maxRenderShortSide }) },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const attached = attachment.value;
  registerPropagateTransforms(world);
  const cameras = [0, 1].map((x) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 4] } },
        {
          component: Camera,
          data: { ...perspective({ fov: Math.PI / 3, aspect: 1 }), antialias: ANTIALIAS_NONE },
        },
      )
      .unwrap(),
  );
  const first = cameras[0],
    second = cameras[1];
  if (first === undefined || second === undefined) throw Error('expected cameras');
  const draw = async (entity?: number) => {
    world.update().unwrap();
    const result = renderer.draw({
      leases: [attached],
      camera: { lease: attached, ...(entity === undefined ? {} : { entityKey: entity }) },
      environment: { lease: attached },
    });
    if (!result.ok) throw result.error;
    const receipt = result.value;
    if (receipt === undefined) throw Error('expected receipt');
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
    for (const camera of cameras) expect(world.hasComponent(camera, CameraView)).toBe(false);
  };
  try {
    setActiveCamera(world, Number(second));
    await draw();
    if (maxRenderShortSide === 720) {
      expect(renderer.inspect().views).toMatchObject([
        { entityKey: Number(second), width: 1602, height: 720 },
      ]);
      await draw(Number(first));
      expect(renderer.inspect().views).toMatchObject([
        { entityKey: Number(first), width: 1602, height: 720 },
      ]);
      canvas.width = 1440;
      canvas.height = 3203;
      await draw();
      expect(renderer.inspect().views).toMatchObject([
        { entityKey: Number(second), width: 720, height: 1602 },
      ]);
      canvas.width = 800;
      canvas.height = 600;
      await draw();
      expect(renderer.inspect().views ?? []).toHaveLength(0);
    } else expect(renderer.inspect().views ?? []).toHaveLength(0);
    expect([canvas.width, canvas.height]).toEqual(
      maxRenderShortSide === 720 ? [800, 600] : [3203, 1440],
    );
  } finally {
    expect((await renderer.dispose()).ok).toBe(true);
  }
});

it('projects the fixed short-side budget through extraction and Render World without resizing the canvas', async () => {
  const canvas = { width: 3203, height: 1440, getContext: () => null };
  const renderer = await createRenderer(
    canvas,
    { rhi },
    {
      shaderManifestUrl: renderLifecycleManifestUrl(),
    },
  );
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const attached = attachment.value;
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: { ...perspective({ fov: Math.PI / 3, aspect: 1 }), antialias: ANTIALIAS_NONE },
      },
      { component: CameraView, data: { maxRenderShortSide: 720 } },
    )
    .unwrap();
  const draw = async () => {
    world.update().unwrap();
    const result = renderer.draw({
      leases: [attached],
      camera: { lease: attached },
      environment: { lease: attached },
    });
    if (!result.ok) throw result.error;
    const receipt = result.value;
    if (receipt === undefined) throw Error('expected submitted receipt');
    const completed = await receipt.completed;
    if (!completed.ok) throw completed.error;
  };
  try {
    await draw();
    expect(renderer.inspect().views?.[0]).toMatchObject({ width: 1602, height: 720 });
    world.set(camera, CameraView, { maxRenderShortSide: 480 }).unwrap();
    await draw();
    expect(renderer.inspect().views?.[0]).toMatchObject({ width: 1068, height: 480 });
    expect([canvas.width, canvas.height]).toEqual([3203, 1440]);
  } finally {
    expect((await renderer.dispose()).ok).toBe(true);
  }
});

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

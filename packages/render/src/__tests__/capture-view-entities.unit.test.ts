import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('records an auxiliary RenderTarget camera as its own capture view beside the display', async () => {
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
  const camera = { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE };
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 6] } }, { component: Camera, data: camera })
    .unwrap();
  const target = renderer.createRenderTarget({
    shape: '2d',
    width: 16,
    height: 16,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: true,
  });
  if (!target.ok) throw target.error;
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
  const auxiliary = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: { ...camera, target: world.allocSharedRef('RenderTarget', target.value) },
      },
    )
    .unwrap();
  await draw(3);
  // A capture view is a view entity, not a composed CameraView.
  expect(renderer.inspect().views ?? []).toEqual([]);

  // A composed display view records beside the same capture view.
  const composed = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8] } },
      { component: Camera, data: camera },
      { component: CameraView, data: { viewport: new Float32Array([0, 0, 1, 1]) } },
    )
    .unwrap();
  await draw(2);
  expect((renderer.inspect().views ?? []).map((view) => view.entityKey)).toEqual([
    Number(composed),
  ]);

  // Removing the auxiliary camera retires its capture view; the display keeps drawing.
  world.despawn(auxiliary).unwrap();
  world.despawn(composed).unwrap();
  await draw(2);
  expect(renderer.inspect().views ?? []).toEqual([]);
  expect(renderer.destroyRenderTarget(target.value).ok).toBe(true);
  await renderer.dispose();
});

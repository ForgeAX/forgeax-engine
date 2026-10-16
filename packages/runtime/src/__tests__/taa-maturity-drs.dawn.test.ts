import { Camera, CameraView, DynamicResolution } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { json, scene } from './taa-maturity.fixture';

it('keeps asynchronous GPU budgets isolated across independently culled views and a cut', {
  timeout: 240_000,
  retry: 0,
}, async () => {
  const carrier = await scene(256, 128, { timing: true });
  const { world, camera, renderer } = carrier;
  world.set(camera, Camera, { antialias: 3 }).unwrap();
  world
    .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1], order: 0 } })
    .unwrap();
  world
    .addComponent(camera, {
      component: DynamicResolution,
      data: { targetGpuMs: 0.0001, minScale: 0.5, maxScale: 1 },
    })
    .unwrap();
  const second = world
    .spawn(
      { component: Transform, data: { pos: [20, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -2,
          right: 2,
          top: 1.5,
          bottom: -1.5,
          near: 0.1,
          far: 20,
          antialias: 3,
          bloom: 0,
          tonemap: 7,
        },
      },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
      { component: DynamicResolution, data: { targetGpuMs: 10000, minScale: 0.5, maxScale: 1 } },
    )
    .unwrap();
  const snapshots = [];
  try {
    for (let f = 0; f < 180; f++) {
      await carrier.draw();
      await new Promise((resolve) => setTimeout(resolve, 0));
      snapshots.push({ frame: f, views: renderer.inspect().views });
    }
    const views = renderer.inspect().views;
    expect(views).toHaveLength(2);
    expect(views?.map((v) => v.dynamicResolution?.extent?.scale)).toEqual([0.5, 1]);
    expect(views?.[1]?.frustum.culled).toBe(views?.[1]?.frustum.total);
    // A public camera cut affects history only for that view. Authored budgets
    // remain data in World; the renderer never writes its selected scale there.
    world.set(camera, Camera, { historyVersion: 10000 }).unwrap();
    await carrier.draw();
    const after = renderer.inspect().views;
    expect(after?.[0]?.temporal.frameIndex).toBeLessThan(views?.[0]?.temporal.frameIndex ?? 0);
    expect(after?.[1]?.temporal.frameIndex).toBeGreaterThan(views?.[1]?.temporal.frameIndex ?? 0);
    expect(world.get(camera, DynamicResolution).unwrap().targetGpuMs).toBe(Math.fround(0.0001));
    expect(world.get(second, DynamicResolution).unwrap().targetGpuMs).toBe(10000);
    expect(after?.map((v) => v.dynamicResolution?.extent?.scale)).toEqual([0.5, 1]);
    json('drs-multi-view.json', {
      snapshots,
      after,
      input:
        'heavy view contains the thin-line roster; second view is empty, independently culled and GPU-timed',
    });
  } finally {
    await carrier.dispose();
  }
});

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  CameraView,
  type FrameReceipt,
  PlanarReflection,
  perspective,
  type Renderer,
  type RenderTarget,
} from '@forgeax/engine-render';
import { buildFrameModel, decodeTape, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

/** Real public target pixels distinguish two reflections and a held resized view. */
export async function verifyPlanarMultiCamera(input: {
  world: World;
  renderer: Renderer;
  recorder: RecorderAttachment;
  camera: EntityHandle;
  target: RenderTarget;
  marker: EntityHandle;
  draw: () => Promise<FrameReceipt>;
  save: (name: string, bytes: Uint8Array) => void;
}) {
  const { world, renderer, recorder, camera, target, marker, draw, save } = input;
  const descriptor = {
    shape: '2d' as const,
    width: 128,
    height: 128,
    format: 'rgba8unorm' as const,
    sampleCount: 1 as const,
    mipLevels: 1 as const,
    sampled: true,
    readback: true,
  };
  const secondTarget = renderValue(renderer.createRenderTarget(descriptor));
  world
    .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 0.5, 1] } })
    .unwrap();
  world
    .addComponent(camera, {
      component: PlanarReflection,
      data: { target: world.allocSharedRef('RenderTarget', target) },
    })
    .unwrap();
  const second = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [12, 2, 5],
          quat: quat.fromLookAt(quat.create(), [12, 2, 5], [12, 0, -1], [0, 1, 0]),
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: (55 * Math.PI) / 180, aspect: 1, near: 0.1, far: 40 }),
          clearColor: [0, 0, 0, 1],
        },
      },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
      {
        component: PlanarReflection,
        data: { target: world.allocSharedRef('RenderTarget', secondTarget) },
      },
    )
    .unwrap();
  world.set(marker, Transform, { pos: [12, 4, -2] }).unwrap();
  const read = async () => {
    const tickets = [target, secondTarget].map((output) =>
      renderValue(renderer.requestTargetReadback(output, { mipLevel: 0 })),
    );
    const observed = renderValue(
      await renderer.observe(await draw(), {
        include: ['target-readbacks'],
        targetReadbacks: tickets,
      }),
    ).targetReadbacks;
    if (observed === undefined || observed.length !== 2)
      throw new Error('Both reflection readbacks are required');
    const [left, right] = observed;
    if (left === undefined || right === undefined)
      throw new Error('Both reflection images are required');
    return { left, right };
  };
  const colors = (bytes: Uint8Array) => {
    let red = 0,
      green = 0;
    for (let offset = 0; offset < bytes.length; offset += 4) {
      if ((bytes[offset] ?? 0) > 128 && (bytes[offset + 1] ?? 0) < 10) red++;
      if ((bytes[offset + 1] ?? 0) > 128 && (bytes[offset] ?? 0) < 10) green++;
    }
    return { red, green };
  };
  for (let frame = 0; frame < testQuality.staticFrames; frame++) await draw();
  const baseline = await read();
  expect(colors(baseline.left.bytes).red).toBeGreaterThan(10);
  expect(colors(baseline.right.bytes).red).toBe(0);
  expect(colors(baseline.right.bytes).green).toBeGreaterThan(10);
  save('multi-left.rgba', baseline.left.bytes);
  save('multi-right.rgba', baseline.right.bytes);
  const capturing = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  await draw();
  (await recorder.frameBoundary()).unwrap();
  const captured = (await capturing).unwrap();
  const model = buildFrameModel(decodeTape(captured.bytes).unwrap());
  const consumers = model.works.filter((work) =>
    work.pipeline.shaders.some(
      (shader) => shader.stage === 'fragment' && shader.source?.includes('PlanarReflectionUniform'),
    ),
  );
  const reflectionViews = consumers.map(
    (work) =>
      work.bindings.find((entry) => entry.groupIndex === 1 && entry.binding === 15)?.resourceId,
  );
  // Each display records the nearest-layer and water-color consumers.
  expect(consumers).toHaveLength(4);
  expect(reflectionViews.every((view) => typeof view === 'string')).toBe(true);
  expect(new Set(reflectionViews).size).toBe(2);
  expect(
    renderer
      .inspect()
      .perFramePassNames.filter((name) => name.startsWith('planar-reflection-face')),
  ).toHaveLength(2);
  save('multi.rhitape', compactTape(captured).bytes);
  save('multi.json', new TextEncoder().encode(JSON.stringify(model, null, 2)));
  world.set(second, CameraView, { updateInterval: 1000 }).unwrap();
  await draw();
  const held = await read();
  renderValue(renderer.resizeRenderTarget(secondTarget, { ...descriptor, width: 64, height: 32 }));
  world.set(marker, Transform, { pos: [12, -4, -2] }).unwrap();
  const resizedWhileHeld = await read();
  expect(resizedWhileHeld.right.bytes).toEqual(held.right.bytes);
  save('multi-held.rgba', resizedWhileHeld.right.bytes);
  world.set(second, CameraView, { updateInterval: 1 }).unwrap();
  await draw();
  const resumed = await read();
  expect([resumed.right.bytesPerRow, resumed.right.byteLength]).toEqual([256, 256 * 32]);
  expect(colors(resumed.right.bytes).green).toBe(0);
  expect(colors(resumed.left.bytes).red).toBeGreaterThan(10);
  save('multi-resumed.rgba', resumed.right.bytes);
}

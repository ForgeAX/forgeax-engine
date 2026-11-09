import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';

it('recovers real WebGL context loss and assets through a replacement Renderer generation', {
  timeout: 120_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const created = await constructRuntimeRendererHost(canvas, { rhi: wgpu.rhi });
  if (!created.ok) throw created.error;
  const { renderer, assets } = created.value;
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = assets.create(Materials.unlit([0.8, 0.1, 0.2, 1])).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 20, tonemap: 0 } },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const request = { leases: [lease], camera: { lease }, environment: { lease } };
  const sample = async () => {
    const receipt = await drawReadyFrame(renderer, request, ['final-display']);
    const result = await renderer.observe(receipt, { include: ['final-display'] });
    if (!result.ok) throw result.error;
    const image = result.value.observations?.find((value) => value.domain === 'final-display');
    if (!image) throw new Error('Missing completed display');
    return [...image.bytes];
  };
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    world.update(1 / 60).unwrap();
    for (let frame = 0; frame < 60; frame++) await drawReadyFrame(renderer, request);
    const before = await sample();
    expect(before.some((value, index) => index % 4 !== 3 && value > 40)).toBe(true);
    const gl = canvas.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Actual WebGL context-loss extension required');
    // Keep work in flight to cover completion rejection racing the DOM event.
    const inFlight = renderer.draw(request);
    if (!inFlight.ok) throw inFlight.error;
    const completed = inFlight.value.completed;
    const contextLost = new Promise<void>((resolve) => {
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
    });
    extension.loseContext();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    await completed;
    await contextLost;
    expect(renderer.state()).toBe('device-lost');
    const restored = new Promise<void>((resolve) => {
      canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true });
    });
    extension.restoreContext();
    await restored;
    const first = renderer.recover();
    const second = renderer.recover();
    const results = await Promise.all([first, second]);
    for (const result of results) if (!result.ok) throw result.error;
    expect(renderer.state()).toBe('alive');
    for (let frame = 0; frame < 60; frame++) await drawReadyFrame(renderer, request);
    expect(await sample()).toEqual(before);
  } finally {
    await renderer.dispose();
    canvas.remove();
  }
});

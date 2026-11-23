import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { gpuShadowViewRequests } from '../record/frame-gpu-driven';
import { staticShadowAdmission } from '../record/static-shadow-budget';
import { ShadowDepthLayers } from '../shadow-depth-layers';
import type { ViewLights } from '../world/render-lights';

it('charges full atlas spans, the compatibility array minimum and overlapping generations', () => {
  const lights = {
    directionalCsmConfig: { staticShadowCache: true },
    cascades: { cascadeCount: 1 },
    pointShadow: [{ staticShadowCache: true, shadowAtlasLayer: 1, mapSize: 256 }],
    spot: [{ staticShadowCache: true, shadowAtlasTile: 0, lightViewProj: new Float32Array(16) }],
  } as unknown as ViewLights;
  const layer = 4 * 256 * 256;
  // Two directional layers, twelve point faces through cube slot 1, and two spot layers.
  expect(staticShadowAdmission(lights, 256, 256, 32 * layer)).toEqual({
    directional: true,
    pointMask: 2,
    spotMask: 1,
  });
  expect(staticShadowAdmission(lights, 256, 256, 32 * layer - 1)).toEqual({
    directional: true,
    pointMask: 2,
    spotMask: 0,
  });
  expect(staticShadowAdmission(lights, 256, 256, 8 * layer)).toEqual({
    directional: true,
    pointMask: 0,
    spotMask: 1,
  });
  expect(staticShadowAdmission(lights, 256, 256, 0)).toEqual({
    directional: false,
    pointMask: 0,
    spotMask: 0,
  });
});

it('shares reservations across cameras and draws the same full-resolution view while depth retires', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const owners = Array.from({ length: 3 }, () => new ShadowDepthLayers(device));
  const [first, second, third] = owners as [
    ShadowDepthLayers,
    ShadowDepthLayers,
    ShadowDepthLayers,
  ];
  const label = 'directional-shadow-static';
  const size = 32;
  const bytes = size * size * 4 * 2;
  const matrix = Float32Array.from({ length: 16 }, (_, i) => Number(i % 5 === 0));
  const lights = {
    directionalCsmConfig: { staticShadowCache: true },
    cascades: { cascadeCount: 1 },
    pointShadow: [],
    spot: [],
    shadowViews: [{ identity: { kind: 'directional', index: 0 }, matrix }],
  } as unknown as ViewLights;
  const requests = (owner: ShadowDepthLayers) =>
    gpuShadowViewRequests(lights, new Map(), size, 0, 1, size, bytes * 2, owner);
  const release = device.queue.holdCompletions?.();
  try {
    expect(requests(first)[0]?.staticLayer).toBeUndefined();
    expect(requests(second)[0]?.staticLayer).toBeUndefined();
    const combined = requests(third);
    expect(combined).toHaveLength(1);
    expect(combined[0]).toMatchObject({ staticLayer: false, targetSize: size, matrix });
    // Both promises occupy the device before either graph resolves its imports.
    const texture = first.texture(label, size, 2);
    second.texture(label, size, 2);
    expect(requests(first)[0]?.staticLayer).toBeUndefined();
    expect(first.texture(label, size, 2)).toBe(texture);
    first.dispose();
    expect(requests(third)[0]?.staticLayer).toBe(false);
    release?.();
    await device.queue.onSubmittedWorkDone();
    expect(requests(third)[0]?.staticLayer).toBeUndefined();
    third.texture(label, size, 2);
  } finally {
    release?.();
    for (const owner of owners) owner.dispose();
    await device.queue.onSubmittedWorkDone();
  }
});

it('returns unallocated promises on cancellation and failed creation without disturbing later requests', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const first = new ShadowDepthLayers(device);
  const other = new ShadowDepthLayers(device);
  const label = 'spot-shadow-static';
  const bytes = 8 * 8 * 2 * 4;
  try {
    const memory = first.beginStaticPlan(bytes);
    expect(first.admitStatic(label, 8, 2)).toBe(true);
    const stale = memory.revision;
    first.beginStaticPlan(bytes);
    expect(first.admitStatic(label, 8, 2)).toBe(true);
    memory.cancel(stale);
    other.beginStaticPlan(bytes);
    expect(other.admitStatic(label, 8, 2)).toBe(false);
    const failure = new Error('injected texture creation failure');
    vi.spyOn(device, 'createTexture').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => first.texture(label, 8, 2)).toThrow(failure);
    expect(other.admitStatic(label, 8, 2)).toBe(true);
    other._abort();
    expect(first.admitStatic(label, 8, 2)).toBe(true);
    first._commit();
    expect(other.admitStatic(label, 8, 2)).toBe(true);
  } finally {
    first.dispose();
    other.dispose();
    vi.restoreAllMocks();
  }
});

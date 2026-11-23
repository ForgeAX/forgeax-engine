import type { RenderPipeline, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createViewportHitCapture } from '../assembly/viewport-hit-proxy';
import { createViewportHitRequests } from '../assembly/viewport-hit-requests';
import { createBarrelDistortionMapping } from '../barrel-distortion';
import { makeZeroCameraFallbackSnapshot, type RenderFrameState } from '../record/frame-snapshot';

it('compares and returns display frame IDs even when physical submission IDs lag', async () => {
  const device = { caps: { backendKind: 'webgpu' } } as RhiDevice;
  const requests = createViewportHitRequests({
    device: () => device,
    generation: () => 2,
    shader: async () => ({}) as ShaderModule,
    trackMeshes() {},
  });
  const frame = {
    frameId: 2,
    deviceGeneration: 2,
    presentation: 'ready' as const,
    completed: Promise.resolve(ok(undefined)),
  };
  const state = {} as RenderFrameState;
  const camera = {
    projection: 'perspective' as const,
    far: 100,
    viewMatrix: [],
    projectionMatrix: [],
  };
  const mapping = { ...createBarrelDistortionMapping(32, 32, { strength: 0 }).unwrap(), camera };
  const result = requests.request({
    x: 10,
    y: 10,
    width: 32,
    height: 32,
    afterFrameId: 93,
    deviceGeneration: 2,
    worldIdentity: 'split-render-world',
  });
  for (let index = 0; index < 4; index++) await Promise.resolve();
  const capture = () =>
    requests.capture({
      state,
      capture: createViewportHitCapture(makeZeroCameraFallbackSnapshot()),
      mapping,
      width: 32,
      height: 32,
      gpuDriven: false,
      unsupportedView: false,
    });
  capture();
  requests.submit(frame, state, undefined, 21, 93);
  expect(requests.collecting).toBe(true);
  capture();
  requests.submit(frame, state, undefined, 22, 94);
  await expect(result).resolves.toEqual({
    kind: 'miss',
    entity: null,
    frameId: 94,
    publicationRevision: 22,
  });
});

it.each([
  false,
  true,
])('warms only a completed opted-in display frame (enabled=%s)', async (warmup) => {
  const device = {
    caps: { backendKind: 'webgpu' },
    createRenderPipelineAsync: vi.fn(),
  } as unknown as RhiDevice;
  const shader = vi.fn(async () => ({}) as ShaderModule);
  const requests = createViewportHitRequests({
    warmup,
    device: () => device,
    generation: () => 2,
    shader,
    trackMeshes() {},
  });
  const state = {} as RenderFrameState;
  const completion = Promise.withResolvers<ReturnType<typeof ok<undefined>>>();
  const receipt = {
    frameId: 9,
    deviceGeneration: 2,
    presentation: 'ready' as const,
    completed: completion.promise,
  };
  expect(requests.collecting).toBe(warmup);
  expect(requests.collectingDraws).toBe(false);
  const capture = createViewportHitCapture(makeZeroCameraFallbackSnapshot(), true);
  const pipeline = {} as RenderPipeline;
  capture.recordPipeline({ pipeline, state: undefined });
  capture.recordPipeline({ pipeline, state: {} });
  expect(capture.recipes).toHaveLength(1);
  requests.capture({
    state,
    capture,
    mapping: undefined,
    width: 32,
    height: 32,
    gpuDriven: false,
    unsupportedView: false,
  });
  requests.submit({ ...receipt, presentation: 'pending' }, state);
  expect(requests.collecting).toBe(warmup);
  requests.capture({
    state,
    capture,
    mapping: undefined,
    width: 32,
    height: 32,
    gpuDriven: false,
    unsupportedView: false,
  });
  requests.submit(receipt, state);
  expect(requests.collecting).toBe(false);
  expect(shader).not.toHaveBeenCalled();
  completion.resolve(ok(undefined));
  await Promise.resolve();
  expect(shader).toHaveBeenCalledTimes(warmup ? 1 : 0);
  requests.invalidate();
});

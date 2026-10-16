import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { type FrameRecording, submitFrameRecordings } from '../assembly/frame-recording';
import {
  createRenderFeatureHost,
  type RenderFeatureFrameResult,
  runRenderFeatureFrame,
} from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import type { RenderSystemInternals } from '../record/render-context';

it.each([
  'submit',
  'abort',
  'source',
  'published-source',
] as const)('drains %s callback failures, closes both GPU sessions and fences accepted retirement', async (failure) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const events: string[] = [];
  let throwing = false;
  let resourceName = 'original';
  const callback = (identity: string, kind: string) => {
    events.push(`${identity}:${kind}`);
    if (throwing && identity === 'a' && kind === failure) throw new Error(`injected ${kind}`);
  };
  const features: RenderFeature<undefined>[] = ['a', 'b'].map((identity) => ({
    identity,
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [{ kind: 'buffer', name: resourceName, size: 16, usage: ['storage'] }],
            passes: [],
          },
        ],
      }),
    onFrameSubmitted: () => callback(identity, 'submit'),
    onFrameAborted: () => callback(identity, 'abort'),
    onSourceFrameSubmitted: () => callback(identity, 'source'),
  }));
  const host = createRenderFeatureHost(features).unwrap();
  const internals = {
    device,
    canvas: { width: 1, height: 1 },
    errorRegistry: { fire() {} },
  } as unknown as RenderSystemInternals;
  const fences: (() => void)[] = [];
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
    () => new Promise<undefined>((resolve) => fences.push(() => resolve(undefined))),
  );
  const created = vi.spyOn(device, 'createBuffer');
  const destroyed = vi.spyOn(device, 'destroyBuffer');
  let frameNumber = 0;
  function* frame(abort = false): FrameRecording {
    const encoder = device.createCommandEncoder().unwrap();
    let prepared: RenderFeatureFrameResult | undefined;
    yield {
      kind: 'features',
      host,
      encoder,
      internals,
      input: {
        identity: 'view',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: ++frameNumber,
        caps: device.caps,
        gpuWork,
        ...(failure === 'published-source'
          ? {
              publishedFeatures: features.map((feature) => ({
                identity: feature.identity,
                data: undefined,
              })),
              onFeatureSourceSubmitted: (identity: string) =>
                callback(identity, 'published-source'),
            }
          : {}),
      },
      accept: (result) => {
        expect(result.errors).toEqual([]);
        prepared = result;
      },
    };
    const result = yield {
      encoder,
      device,
      reportError() {},
      ...(abort ? { isCurrent: () => false } : {}),
    };
    if (result.ok) prepared?.onSubmitted();
    else prepared?.onAborted();
    return result.ok;
  }
  try {
    expect(submitFrameRecordings([frame()])).toBe(true);
    const originals = created.mock.results.map((result) => result.value.unwrap());
    fences.shift()?.();
    await Promise.resolve();
    events.length = 0;
    resourceName = 'replacement';
    throwing = true;
    expect(() => submitFrameRecordings([frame(failure === 'abort')])).toThrow(
      'Feature frame finalization failed',
    );
    throwing = false;
    // A producer exception must never leave a sibling's GPU transaction open.
    expect(submitFrameRecordings([frame()])).toBe(true);
    const terminal = failure === 'abort' ? 'abort' : 'submit';
    expect(events.filter((event) => event === `b:${terminal}`)).toHaveLength(
      failure === 'abort' ? 1 : 2,
    );
    const source = failure === 'published-source' ? 'published-source' : 'source';
    for (const identity of ['a', 'b'])
      expect(events.filter((event) => event === `${identity}:${source}`)).toHaveLength(
        failure === 'abort' ? 1 : 2,
      );
    // Unsubmitted cleanup cannot collect either feature's accepted old buffer.
    host.retirePreparedGraphics().unwrap();
    expect(destroyed.mock.calls.some(([buffer]) => originals.includes(buffer))).toBe(false);
    for (const resolve of fences.splice(0)) resolve();
    await Promise.resolve();
    expect(
      originals.every((original) => destroyed.mock.calls.some(([buffer]) => buffer === original)),
    ).toBe(true);
  } finally {
    for (const resolve of fences.splice(0)) resolve();
    await Promise.resolve();
    gpuWork.dispose().unwrap();
    host.dispose();
  }
});

it('never repeats accepted source acknowledgements after terminal callback failures', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const events: string[] = [];
  const feature: RenderFeature<undefined> = {
    identity: 'once',
    extract: () => ok(undefined),
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onFrameSubmitted: () => {
      events.push('submitted');
      throw new Error('submitted callback');
    },
    onSourceFrameSubmitted: () => {
      events.push('ack');
      throw new Error('ack callback');
    },
    onFrameAborted: () => events.push('aborted'),
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const batch = runRenderFeatureFrame(host, [
    {
      identity: 'view',
      render: true,
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: device.caps,
    },
  ]);
  batch.frame.onSubmitted();
  expect(() => batch.onSubmitted()).toThrow('Feature frame finalization failed');
  batch.onSubmitted();
  batch.onAborted();
  expect(events).toEqual(['submitted', 'ack']);
  host.dispose();
});

it.each([
  'extract',
  'plan',
  'invalid-plan',
  'prepare',
] as const)('contains an abort callback throw after %s failure without stranding a prepared sibling', async (failure) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let broken = true;
  const aborted: string[] = [];
  const features: RenderFeature<undefined>[] = ['a', 'b'].map((identity) => ({
    identity,
    extract: () => {
      if (identity === 'b' && broken && failure === 'extract') throw new Error('extract failure');
      return ok(undefined);
    },
    plan: () => {
      if (identity === 'b' && broken && failure === 'plan') throw new Error('plan failure');
      return ok({
        work: [
          {
            scope: 'frame',
            resources: Array.from(
              { length: identity === 'b' && broken && failure === 'invalid-plan' ? 2 : 1 },
              () => ({
                kind: 'buffer' as const,
                name: 'state',
                size: 16,
                usage: ['storage' as const],
              }),
            ),
            passes: [],
          },
        ],
      });
    },
    onFrameAborted: () => {
      aborted.push(identity);
      if (identity === 'b' && broken) throw new Error('abort failure');
    },
  }));
  const host = createRenderFeatureHost(features).unwrap();
  const frame = () =>
    runRenderFeatureFrame(host, [
      {
        identity: 'view',
        render: true,
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: device.caps,
        gpuWork,
        createPreparedGraphicsResolver: (input) => {
          if (input.featureIdentity === 'b' && broken && failure === 'prepare')
            throw new Error('prepare failure');
          return createPreparedGraphicsResolver({
            device,
            featureIdentity: input.featureIdentity,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: () => {
              throw new Error('No graphics program required');
            },
            resolveBindings: () => ok(undefined),
          });
        },
      },
    ]);
  try {
    const first = frame();
    expect(first.frame.errors.length).toBeGreaterThan(0);
    expect(first.frame.plans.map((plan) => plan.featureIdentity)).toEqual(['a']);
    first.frame.onSubmitted();
    first.onSubmitted();
    expect(aborted).toEqual(failure === 'extract' ? [] : ['b']);
    broken = false;
    const next = frame();
    expect(next.frame.errors).toEqual([]);
    expect(next.frame.plans.map((plan) => plan.featureIdentity)).toEqual(['a', 'b']);
    next.frame.onSubmitted();
    next.onSubmitted();
  } finally {
    gpuWork.dispose().unwrap();
    host.dispose();
  }
});

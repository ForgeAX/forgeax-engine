import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameBatch,
  runRenderFeatureFrame,
} from '../features/host';
import { createMotionBlurFeature } from '../features/motion-blur/motion-blur-feature';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { resolveStandardRenderFeatureTargets } from '../features/targets';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';

function submit(batch: RenderFeatureFrameBatch) {
  expect(batch.frame.errors).toEqual([]);
  batch.frame.onSubmitted();
  for (const view of batch.views.values()) view.onSubmitted();
  batch.onSubmitted();
}
async function fixture(feature: RenderFeature<unknown>) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const host = createRenderFeatureHost([feature]).unwrap();
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const common = {
    worlds: [],
    owner: 0,
    frameNumber: 1,
    generation: 0,
    caps: device.caps,
    gpuWork: gpu,
  } as const;
  return { device, gpu, host, destroy, common };
}

describe('Feature resource frame transaction', () => {
  it('keeps shared vertex dependencies alive across a held frame and resolves the resumed raster input', async () => {
    let render = true;
    const feature: RenderFeature<undefined> = {
      identity: 'shared-vertex-proof',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: render
            ? [
                {
                  scope: 'frame',
                  resources: [{ kind: 'buffer', name: 'shared', size: 32, usage: ['vertex'] }],
                  passes: [],
                },
                {
                  scope: { view: 'a' },
                  resources: [
                    {
                      kind: 'vertex-data',
                      name: 'vertices',
                      layout: 'position-size-color-instance',
                      buffer: 'shared',
                    },
                  ],
                  passes: [],
                },
              ]
            : [{ scope: 'frame', resources: [], passes: [] }],
        }),
    };
    const f = await fixture(feature);
    const frame = () => runRenderFeatureFrame(f.host, [{ ...f.common, identity: 'a', render }]);
    submit(frame());
    render = false;
    const held = frame();
    submit(held);
    for (const batch of held.preparedResourceBatches) batch.release().unwrap();
    expect(f.destroy).not.toHaveBeenCalled();
    render = true;
    submit(frame());
    const transaction = f.host.beginPreparedFrame(feature.identity, 0);
    if (transaction === undefined) throw new Error('Missing graphics transaction');
    transaction.retainResources(() => true);
    const item = transaction.committedItems().find((row) => row.kind === 'vertex-data');
    if (item?.kind !== 'vertex-data') throw new Error('Missing retained vertices');
    const resolver = createPreparedGraphicsResolver({
      device: f.device,
      featureIdentity: feature.identity,
      generation: 0,
      capabilityAvailable: true,
      lookup: (reference) => transaction.lookup(reference),
      resolvePipeline: () => {
        throw new Error('No pipeline is needed for vertex resolution');
      },
      resolveBindings: () => ok(undefined),
      resolveGpuBuffer: (reference) => f.gpu.resolveBuffer(feature.identity, reference),
    });
    const resolved = resolver.resolve(item.reference);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.kind).toBe('vertex-data');
    resolver.release().unwrap();
    transaction.abort();
    f.gpu.dispose().unwrap();
    f.host.dispose();
  });

  it('aborts resource replacement without destroying the last submitted buffer', async () => {
    let name = 'old';
    const feature: RenderFeature<undefined> = {
      identity: 'replacement-proof',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: 'frame',
              resources: [{ kind: 'buffer', name, size: 32, usage: ['storage'] }],
              passes: [],
            },
          ],
        }),
    };
    const f = await fixture(feature);
    const create = vi.spyOn(f.device, 'createBuffer');
    const frame = () =>
      runRenderFeatureFrame(f.host, [{ ...f.common, identity: 'a', render: true }]);
    const first = frame();
    submit(first);
    const previous = create.mock.results[0]?.value;
    if (previous?.ok !== true) throw new Error('Missing submitted buffer');
    name = 'replacement';
    const failed = frame();
    failed.onAborted();
    for (const batch of failed.preparedResourceBatches) batch.release().unwrap();
    expect(f.destroy.mock.calls.some(([buffer]) => buffer === previous.value)).toBe(false);
    name = 'old';
    submit(frame());
    expect(create).toHaveBeenCalledTimes(2);
    name = 'replacement';
    const retry = frame();
    submit(retry);
    expect(f.destroy.mock.calls.some(([buffer]) => buffer === previous.value)).toBe(false);
    for (const batch of retry.preparedResourceBatches) batch.release().unwrap();
    expect(f.destroy.mock.calls.some(([buffer]) => buffer === previous.value)).toBe(true);
    f.gpu.dispose().unwrap();
    f.host.dispose();
  });

  it('resizes the production Motion Blur view without resetting another view and can retry an aborted resize', async () => {
    const f = await fixture(createMotionBlurFeature());
    const targets = resolveStandardRenderFeatureTargets({
      tonemap: 'aces',
      antialias: 'taa',
      colorAttachmentFormat: 'rgba8unorm',
      storageBuffer: true,
      multisample: true,
      cloudHistory: false,
    });
    const frame = (width: number) =>
      runRenderFeatureFrame(
        f.host,
        ['a', 'b'].map((identity) => ({
          ...f.common,
          identity,
          render: true,
          targets,
          caps: {
            ...f.device.caps,
            compute: true,
            storageBuffer: true,
            storageTexture: true,
            rgba16floatRenderable: true,
          },
          frameSize: { width: identity === 'a' ? width : 64, height: 64 },
          motionBlur: { params: { shutterAngle: 180 }, frameDeltaSeconds: 1 / 60 },
        })),
      );
    const buffers = (batch: RenderFeatureFrameBatch, view: string) =>
      batch.views
        .get(view)
        ?.plans.flatMap(
          (plan) =>
            getRenderFeaturePlanExecutionProjection(plan)?.passes.flatMap(
              (pass) => pass.resolvedGpuCompute?.buffers.map((row) => row.buffer) ?? [],
            ) ?? [],
        );
    const first = frame(64);
    submit(first);
    const other = buffers(first, 'b');
    const failed = frame(128);
    expect(failed.frame.errors).toEqual([]);
    failed.onAborted();
    for (const batch of failed.preparedResourceBatches) batch.release().unwrap();
    const retried = frame(128);
    submit(retried);
    expect(buffers(retried, 'b')).toEqual(other);
    expect(buffers(retried, 'a')).not.toEqual(buffers(first, 'a'));
    const stable = frame(128);
    submit(stable);
    expect(buffers(stable, 'a')).toEqual(buffers(retried, 'a'));
    for (const batch of retried.preparedResourceBatches) batch.release().unwrap();
    f.gpu.dispose().unwrap();
    f.host.dispose();
  });
});

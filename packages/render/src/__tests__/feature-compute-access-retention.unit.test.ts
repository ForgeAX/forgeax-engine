import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderFeatureHost, getRenderFeaturePlanExecutionProjection } from '../features/host';
import type { RenderFeatureWorkPlan } from '../features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const program = ownRenderFeatureProgramData({
  wgsl: 'synthetic',
  entryPoints: ['simulate'],
  bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
});
function plan(buffer: string, count: number): RenderFeatureWorkPlan {
  return {
    resources: [
      { kind: 'compute-program', name: 'program', program },
      { kind: 'buffer', name: buffer, size: 16, usage: ['storage'] },
      ownRenderFeatureProgramData({
        kind: 'compute-bindings' as const,
        name: `binding-${buffer}`,
        program: 'program',
        entries: [{ binding: 0, resource: buffer }],
      }),
    ],
    passes: [
      {
        kind: 'compute',
        name: 'simulate',
        program: 'program',
        bindings: `binding-${buffer}`,
        dispatches: [{ kind: 'direct', entryPoint: 'simulate', workgroups: [count] }],
      },
    ],
  };
}

it('reuses compute accesses for unchanged items and releases them with their bindings', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let current = plan('a', 1);
  const host = createRenderFeatureHost([
    {
      identity: 'compute',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ ...current, scope: { view: 'main' } }] }),
    },
  ]).unwrap();
  let frameNumber = 0;
  const run = () => {
    frameNumber += 1;
    const frame = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber,
      caps: device.caps,
      gpuWork: gpu,
      generation: 0,
    });
    expect(frame.errors).toEqual([]);
    const planned = frame.plans[0];
    const execution = planned && getRenderFeaturePlanExecutionProjection(planned);
    const resolved = execution?.passes[0]?.resolvedGpuCompute;
    frame.onSubmitted();
    // The queue fence passed: retired references may be released.
    for (const lease of frame.preparedResourceBatches) lease.release().unwrap();
    if (resolved === undefined) throw new Error('Missing resolved compute pass');
    return resolved;
  };
  try {
    const released = (() => {
      const first = run();
      current = plan('a', 3);
      const second = run();
      // Counts are frame data; the derived buffer accesses are reused.
      expect(second.buffers).toBe(first.buffers);
      expect(second.dispatches[0]).not.toBe(first.dispatches[0]);
      return new WeakRef(first.buffers);
    })();
    current = plan('b', 1);
    for (let frame = 0; frame < 4; frame++) run();
    for (let attempt = 0; attempt < 10 && released.deref() !== undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gc();
    }
    expect(released.deref()).toBeUndefined();
  } finally {
    gpu.dispose().unwrap();
    host.dispose();
  }
});

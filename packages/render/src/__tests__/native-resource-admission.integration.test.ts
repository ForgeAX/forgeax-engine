import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameBatch,
} from '../features/host';
import { createPreparedResourceMaps } from '../features/native-resource-admission';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureNativeResourceAdmission,
  type RenderFeatureNativeResourceDomain,
} from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';

it('observes later inherited writes while isolated resource copies keep their accepted values', () => {
  const parent = createPreparedResourceMaps();
  const fallback = createPreparedResourceMaps();
  const inherited = createPreparedResourceMaps(parent, fallback);
  const first = { name: 'state', generation: 0 } as RenderFeatureGpuBufferRef;
  const next = { name: 'state', generation: 1 } as RenderFeatureGpuBufferRef;
  expect(inherited.buffers.get('state')).toBeUndefined();
  fallback.buffers.set('state', first);
  expect(inherited.buffers.get('state')).toBe(first);
  parent.buffers.set('state', next);
  expect(inherited.buffers.get('state')).toBe(next);
  const isolated = createPreparedResourceMaps(parent, fallback, false);
  parent.buffers.delete('state');
  expect(inherited.buffers.get('state')).toBe(first);
  expect(isolated.buffers.get('state')).toBe(next);
  inherited.buffers.set('state', next);
  fallback.buffers.delete('state');
  expect(inherited.buffers.get('state')).toBe(next);
  expect(parent.buffers.get('state')).toBeUndefined();
});

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  let unavailable = false;
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: () =>
        unavailable ? err({ code: 'rhi-not-available' } as never) : ok(module),
    }),
  });
  const program = ownRenderFeatureProgramData({
    wgsl: 'synthetic',
    entryPoints: ['main'],
    bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
  });
  let domain: RenderFeatureNativeResourceDomain | undefined,
    viewDomain: RenderFeatureNativeResourceDomain | undefined,
    saved: RenderFeatureNativeResourceAdmission | undefined;
  let size = 64,
    value = 1,
    root = true,
    fail = false,
    discard = false,
    wait = false,
    cold = 0,
    viewCold = 0,
    submitted = 0,
    aborted = 0;
  const feature: RenderFeature<null> = {
    identity: 'forgeax.vfx-render.gpu-particles',
    extract: () => ok(null),
    plan: (_source, context) => {
      const builder = context.createNativePlan?.();
      if (builder?.resourceAdmission === undefined) throw new Error('Missing admission');
      const api = builder.resourceAdmission;
      const frame = builder.scope('frame'),
        view = builder.scope({ view: 'main' });
      api.program('frame', 'program', program, wait);
      if (root) {
        if (domain === undefined || !api.retain('frame', domain)) {
          cold++;
          domain = api.admit('frame', [
            { kind: 'buffer', name: 'state', size, usage: ['storage', 'copy-src'] },
            {
              kind: 'compute-bindings',
              name: 'bindings',
              program: 'program',
              entries: [{ binding: 0, resource: 'state' }],
            },
          ]);
        }
        api.upload('frame', 'state', 0, new Uint32Array([value]));
        frame.passes.push({
          kind: 'compute',
          name: 'tick',
          program: 'program',
          bindings: 'bindings',
          dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [value] }],
        });
      }
      if (viewDomain === undefined || !api.retain({ view: 'main' }, viewDomain)) {
        viewCold++;
        viewDomain = api.admit({ view: 'main' }, [
          {
            kind: 'compute-bindings',
            name: 'view-bindings',
            program: 'program',
            entries: [{ binding: 0, resource: 'state' }],
          },
        ]);
      }
      api.upload({ view: 'main' }, 'state', 4, new Uint32Array([value + 1]));
      view.passes.push({
        kind: 'compute',
        name: 'project',
        program: 'program',
        bindings: 'view-bindings',
        dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [value] }],
      });
      saved = api;
      if (fail) throw new Error('Abort after admission');
      return ok(discard ? { work: [] } : builder.finish([frame, view]));
    },
    onFrameSubmitted: () => {
      submitted++;
    },
    onFrameAborted: () => {
      aborted++;
    },
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const frame = (number: number, generation = 0) =>
    host.runFrame([
      {
        identity: 'main',
        render: true,
        worlds: [],
        owner: 1,
        frameNumber: number,
        generation,
        caps: device.caps,
        gpuWork,
      },
    ]);
  return {
    device,
    host,
    gpuWork,
    frame,
    state: () => ({ cold, viewCold, submitted, aborted, domain, saved }),
    setValue: (next: number) => {
      value = next;
    },
    onlyView: () => {
      root = false;
    },
    replace: () => {
      size = 128;
      domain = undefined;
      viewDomain = undefined;
    },
    restore: (token: RenderFeatureNativeResourceDomain) => {
      size = 64;
      domain = token;
      viewDomain = undefined;
    },
    fail: () => {
      fail = true;
    },
    discard: () => {
      discard = true;
    },
    preparing: () => {
      wait = true;
    },
    unavailable: () => {
      unavailable = true;
      wait = true;
    },
    dispose: () => {
      host.dispose().unwrap();
      gpuWork.dispose().unwrap();
    },
  };
}

function submit(batch: RenderFeatureFrameBatch) {
  expect(batch.frame.errors).toEqual([]);
  batch.frame.onSubmitted();
  for (const view of batch.views.values()) view.onSubmitted();
  batch.onSubmitted();
}

it('prepares once, keeps current upload/dispatch values, and retains inherited names after the root owner retires', async () => {
  const f = await fixture();
  const create = vi.spyOn(f.device, 'createBuffer');
  const write = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    const first = f.frame(1);
    submit(first);
    f.setValue(2);
    const second = f.frame(2);
    submit(second);
    expect(f.state().cold).toBe(1);
    expect(f.state().viewCold).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.map((call) => Array.from(call[2] as Uint8Array))).toEqual([
      [1, 0, 0, 0],
      [2, 0, 0, 0],
      [2, 0, 0, 0],
      [3, 0, 0, 0],
    ]);
    const current = second.frame.plans[0];
    if (current === undefined) throw new Error('Missing frame');
    expect(current.plan.resources).toHaveLength(0);
    expect(
      getRenderFeaturePlanExecutionProjection(current)?.passes[0]?.gpuCompute?.dispatches[0]
        ?.workgroups,
    ).toEqual([2]);
    f.onlyView();
    const inherited = f.frame(3);
    submit(inherited);
    expect(f.state().viewCold).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect([...inherited.views.values()][0]?.plans[0]?.plan.resources).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it('does not advance source ACK on abort and restores canonical ownership after a same-count replacement', async () => {
  const f = await fixture();
  try {
    const first = f.frame(1);
    submit(first);
    const token = f.state().domain;
    if (token === undefined) throw new Error('Missing domain');
    f.replace();
    const replacement = f.frame(2);
    expect(replacement.frame.errors).toEqual([]);
    replacement.onAborted();
    expect(f.state().submitted).toBe(1);
    expect(f.state().aborted).toBe(1);
    f.restore(token);
    const restored = f.frame(3);
    submit(restored);
    expect(f.state().cold).toBe(2);
    const next = f.frame(4, 1);
    expect(next.frame.errors).toEqual([]);
    expect(f.state().cold).toBe(3);
    next.onAborted();
  } finally {
    f.dispose();
  }
});

it('closes admission callbacks after both a finished plan and a failed unfinished plan', async () => {
  const f = await fixture();
  try {
    const first = f.frame(1);
    submit(first);
    expect(() => f.state().saved?.upload('frame', 'state', 0, new Uint32Array([4]))).toThrow(
      'closed',
    );
    f.fail();
    const failed = f.frame(2);
    expect(failed.frame.errors.length).toBeGreaterThan(0);
    expect(() => f.state().saved?.upload('frame', 'state', 0, new Uint32Array([4]))).toThrow(
      'outside its plan stage',
    );
    expect(f.state().submitted).toBe(1);
  } finally {
    f.dispose();
  }
});

it('rejects side-effecting admission discarded into raw work', async () => {
  const f = await fixture();
  try {
    f.discard();
    const batch = f.frame(1);
    expect(batch.frame.errors.length).toBeGreaterThan(0);
    expect(f.state().submitted).toBe(0);
    expect(f.state().aborted).toBe(1);
  } finally {
    f.dispose();
  }
});

it('keeps explicit preparation pending when admission fails before a plan can be returned', async () => {
  const f = await fixture();
  try {
    f.unavailable();
    const batch = f.frame(1);
    expect(batch.frame.errors.length).toBeGreaterThan(0);
    expect(batch.frame.preparationPending).toBe(true);
    expect(batch.frame.preparationPendingReason).toMatchObject({
      code: 'feature-preparation',
      featureIdentity: 'forgeax.vfx-render.gpu-particles',
      preparationStage: 'native-admission',
      operation: 'prepare-gpu-program',
      resource: '["frame","program"]',
      reason: 'rhi-not-available:[object Object]',
    });
    expect(f.state().submitted).toBe(0);
  } finally {
    f.dispose();
  }
});

it('captures an actual unresolved compute admission and clears it after completion and generation replacement', async () => {
  const f = await fixture();
  let settle: (() => void) | undefined;
  const create = vi.fn((descriptor: Parameters<typeof f.device.createComputePipeline>[0]) => {
    const result = f.device.createComputePipeline(descriptor);
    return new Promise<typeof result>((resolve) => {
      settle = () => resolve(result);
    });
  });
  Object.defineProperty(f.device, 'createComputePipelineAsync', {
    configurable: true,
    value: create,
  });
  try {
    f.preparing();
    const pending = f.frame(1);
    expect(pending.frame.preparationPendingReason).toEqual({
      code: 'feature-preparation',
      featureIdentity: 'forgeax.vfx-render.gpu-particles',
      preparationStage: 'native-admission',
      operation: 'prepare-gpu-program',
      resource: '["frame","program"]',
      reason: 'rhi-not-available:pipeline-pending',
    });
    expect(create).toHaveBeenCalledOnce();
    pending.onAborted();
    if (settle === undefined) throw Error('Missing actual async compute request');
    settle();
    await Promise.resolve();
    const ready = f.frame(2);
    expect(ready.frame.preparationPendingReason).toBeUndefined();
    submit(ready);
    f.host.recover({ frameNumber: 3, caps: f.device.caps }).unwrap();
    const recovered = f.frame(3, 1);
    expect(recovered.frame.preparationPendingReason?.preparationStage).toBe('native-admission');
    expect(create).toHaveBeenCalledTimes(2);
    recovered.onAborted();
    expect(pending.frame.preparationPendingReason?.reason).toBe(
      'rhi-not-available:pipeline-pending',
    );
  } finally {
    Reflect.deleteProperty(f.device, 'createComputePipelineAsync');
    f.dispose();
  }
});

it('does not call a later source-plan exception native compilation merely because admission requested readiness', async () => {
  const f = await fixture();
  try {
    f.preparing();
    f.fail();
    const failed = f.frame(1);
    expect(failed.frame.preparationPendingReason).toEqual({
      code: 'feature-preparation',
      featureIdentity: 'forgeax.vfx-render.gpu-particles',
      preparationStage: 'source-plan',
    });
    failed.onAborted();
  } finally {
    f.dispose();
  }
});

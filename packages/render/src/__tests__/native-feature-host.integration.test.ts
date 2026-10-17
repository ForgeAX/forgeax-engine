function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fixture value');
  return value;
}

import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  hasNativeRenderFeatureExecutionSignature,
  type RenderFeatureFrameInput,
  runRenderFeatureFrame,
} from '../features/host';
import type { RenderFeatureNativePlanToken } from '../features/prepared-gpu-work';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(module) }),
  });
  const program = ownRenderFeatureProgramData({
    wgsl: 'synthetic',
    entryPoints: ['main'],
    bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
  });
  let submitted = 0,
    aborted = 0,
    sourceFeedback = 0;
  let size = 16,
    groups = 1;
  let reverseWork = false;
  const feature: RenderFeature<null> = {
    identity: 'native-feature',
    extract: () => ok(null),
    plan: (_frame, context) => {
      const writer = context.createNativePlan?.();
      if (writer === undefined) throw new Error('Missing current Host writer');
      const frame = writer.scope('frame'),
        view = writer.scope({ view: 'main' });
      frame.resources.push(
        { kind: 'compute-program', name: 'program', program },
        {
          kind: 'buffer',
          name: 'state',
          size,
          usage: ['storage', 'copy-src'],
          data: new Uint32Array([groups]),
        },
        { kind: 'buffer', name: 'copy', size: 16, usage: ['storage'] },
        {
          kind: 'compute-bindings',
          name: 'bindings',
          program: 'program',
          entries: [{ binding: 0, resource: 'state' }],
        },
      );
      frame.passes.push({
        kind: 'compute',
        name: 'tick',
        program: 'program',
        bindings: 'bindings',
        dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [groups] }],
      });
      view.passes.push({
        kind: 'copy',
        name: 'view-copy',
        copies: [{ source: 'state', destination: 'copy', size: 16 }],
      });
      return ok(
        writer.finish(reverseWork ? [view, frame] : [frame, view], {
          exact: context.frame.frameNumber,
        }),
      );
    },
    onFrameSubmitted: () => {
      submitted++;
    },
    onFrameAborted: () => {
      aborted++;
    },
    onSourceFrameSubmitted: () => {
      sourceFeedback++;
    },
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const input = (frameNumber: number, generation = 0): RenderFeatureFrameInput => ({
    identity: 'main',
    render: true,
    worlds: [],
    owner: 1,
    frameNumber,
    generation,
    caps: device.caps,
    gpuWork,
  });
  return {
    host,
    gpuWork,
    input,
    setSize: (value: number) => {
      size = value;
    },
    setGroups: (value: number) => {
      groups = value;
    },
    setReverseWork: () => {
      reverseWork = true;
    },
    counts: () => ({ submitted, aborted, sourceFeedback }),
  };
}
describe('native primary work through the actual Feature Host', () => {
  it('keeps real work facts, current counts and scopes while sharing native topology', async () => {
    const f = await fixture();
    try {
      const first = runRenderFeatureFrame(f.host, [f.input(1)]);
      expect(first.frame.errors).toEqual([]);
      expect(required(first.frame.plans[0]).plan.resources).toHaveLength(4);
      expect(first.views.get('main') ?? first.views.get('view:main')).toBeDefined();
      const view = required([...first.views.values()][0]);
      expect(required(view.plans[0]).plan.passes).toHaveLength(1);
      expect(hasNativeRenderFeatureExecutionSignature(required(first.frame.plans[0]))).toBe(true);
      const signature = required(first.frame.plans[0]).signature;
      first.frame.onSubmitted();
      view.onSubmitted();
      first.onSubmitted();
      expect(f.counts()).toEqual({ submitted: 1, aborted: 0, sourceFeedback: 1 });
      f.setGroups(2);
      const next = runRenderFeatureFrame(f.host, [f.input(2)]);
      expect(next.frame.errors).toEqual([]);
      expect(required(next.frame.plans[0]).signature).toBe(signature);
      const current = required(
        getRenderFeaturePlanExecutionProjection(required(next.frame.plans[0])),
      );
      expect(
        required(required(required(current.passes[0]).gpuCompute).dispatches[0]).workgroups,
      ).toEqual([2]);
      expect(
        required(
          required(
            required(
              required(getRenderFeaturePlanExecutionProjection(required(first.frame.plans[0])))
                .passes[0],
            ).gpuCompute,
          ).dispatches[0],
        ).workgroups,
      ).toEqual([1]);
      next.frame.onSubmitted();
      required([...next.views.values()][0]).onSubmitted();
      next.onSubmitted();
    } finally {
      f.host.dispose().unwrap();
      f.gpuWork.dispose();
    }
  });
  it('keeps abort separate from ACK and rejects same-count replacement and device reuse', async () => {
    const f = await fixture();
    try {
      const first = runRenderFeatureFrame(f.host, [f.input(1)]);
      first.frame.onSubmitted();
      required([...first.views.values()][0]).onSubmitted();
      first.onSubmitted();
      const before = required(first.frame.plans[0]).signature;
      f.setSize(32);
      const failed = runRenderFeatureFrame(f.host, [f.input(2)]);
      expect(failed.frame.errors).toEqual([]);
      expect(required(failed.frame.plans[0]).signature).not.toBe(before);
      failed.onAborted();
      expect(f.counts()).toEqual({ submitted: 1, aborted: 1, sourceFeedback: 1 });
      f.setSize(16);
      const recovery = runRenderFeatureFrame(f.host, [f.input(3, 1)]);
      expect(recovery.frame.errors).toEqual([]);
      expect(required(recovery.frame.plans[0]).generation).toBe(1);
      expect(required(recovery.frame.plans[0]).signature).not.toBe(before);
      recovery.onAborted();
    } finally {
      f.host.dispose().unwrap();
      f.gpuWork.dispose();
    }
  });
  it('prepares shared dependencies before an explicitly earlier view row', async () => {
    const f = await fixture();
    f.setReverseWork();
    try {
      const batch = runRenderFeatureFrame(f.host, [f.input(1)]);
      expect(batch.frame.errors).toEqual([]);
      expect(batch.frame.plans).toHaveLength(1);
      expect(required([...batch.views.values()][0]).plans).toHaveLength(1);
      batch.onAborted();
    } finally {
      f.host.dispose().unwrap();
      f.gpuWork.dispose();
    }
  });
  it('rejects a stale issued wrapper through ordinary abort and readiness cleanup', () => {
    let saved: import('../features/plan').RenderFeaturePlan | undefined;
    let aborted = 0;
    const feature: RenderFeature<null> = {
      identity: 'stale',
      extract: () => ok(null),
      requiresPreparation: () => true,
      plan: (_frame, context) => {
        if (saved !== undefined) return ok(saved);
        const builder = required(context.createNativePlan)();
        saved = builder.finish([builder.scope('frame')]);
        return ok(saved);
      },
      onFrameAborted: () => {
        aborted++;
      },
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const input = (frameNumber: number): RenderFeatureFrameInput => ({
      identity: 'main',
      render: true,
      worlds: [],
      owner: 1,
      frameNumber,
      generation: 0,
      caps: {} as never,
    });
    try {
      const first = runRenderFeatureFrame(host, [input(1)]);
      first.frame.onSubmitted();
      first.onSubmitted();
      const next = runRenderFeatureFrame(host, [input(2)]);
      expect(next.frame.errors).toHaveLength(1);
      expect(next.frame.preparationPending).toBe(true);
      expect(next.frame.plans).toHaveLength(0);
      expect(aborted).toBe(1);
      next.onAborted();
      saved = undefined;
      const fresh = runRenderFeatureFrame(host, [input(3)]);
      expect(fresh.frame.errors).toEqual([]);
      expect(fresh.frame.plans).toHaveLength(1);
      expect(required(required(host.inspection?.()).signatures[0]).nativeCalls).toBe(2);
      fresh.onAborted();
    } finally {
      host.dispose().unwrap();
    }
  });
  it('does not read an unrelated raw native accessor', () => {
    let reads = 0;
    const feature: RenderFeature<null> = {
      identity: 'raw',
      extract: () => ok(null),
      plan: () =>
        ok({
          work: [],
          get native(): RenderFeatureNativePlanToken {
            reads++;
            throw new Error('unrelated author field');
          },
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      const batch = runRenderFeatureFrame(host, [
        {
          identity: 'main',
          render: true,
          worlds: [],
          owner: 1,
          frameNumber: 1,
          generation: 0,
          caps: {} as never,
        },
      ]);
      expect(batch.frame.errors).toEqual([]);
      expect(reads).toBe(0);
      batch.onAborted();
    } finally {
      host.dispose().unwrap();
    }
  });
});

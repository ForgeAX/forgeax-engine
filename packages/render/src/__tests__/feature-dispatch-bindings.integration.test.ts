import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import { resolveFeatureWorkResources } from '../features/frame-plan';
import { createRenderFeatureHost, getRenderFeaturePlanExecutionProjection } from '../features/host';
import {
  deriveRenderFeaturePassAccess,
  type RenderFeatureWorkPlan,
  validateRenderFeaturePlan,
} from '../features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const program = ownRenderFeatureProgramData({
  wgsl: 'synthetic',
  entryPoints: ['simulate'],
  bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
});
const binding = (name: string) =>
  ownRenderFeatureProgramData({
    kind: 'compute-bindings' as const,
    name: `binding-${name}`,
    program: 'program',
    entries: [{ binding: 0, resource: name }],
  });
function plan(a = 1, b = 2): RenderFeatureWorkPlan {
  return {
    resources: [
      { kind: 'compute-program', name: 'program', program },
      ...['a', 'b'].map((name) => ({
        kind: 'buffer' as const,
        name,
        size: 16,
        usage: ['storage'] as const,
      })),
      binding('a'),
      binding('b'),
    ],
    passes: [
      {
        kind: 'compute',
        name: 'batched',
        program: 'program',
        bindings: 'binding-a',
        dispatches: [
          { kind: 'direct', entryPoint: 'simulate', workgroups: [a] },
          { kind: 'direct', entryPoint: 'simulate', bindings: 'binding-b', workgroups: [b] },
        ],
      },
    ],
  };
}

it('validates and derives every override, including zero-count and shared-view dependencies', () => {
  const source = plan();
  expect(validateRenderFeaturePlan('batch', source).ok).toBe(true);
  const pass = source.passes[0];
  if (pass?.kind !== 'compute') throw new Error('Missing compute pass');
  expect(deriveRenderFeaturePassAccess(source, pass)).toEqual([
    { resource: 'a', usage: 'storage-read-write' },
    { resource: 'b', usage: 'storage-read-write' },
  ]);
  for (const override of ['missing', 'a']) {
    expect(
      validateRenderFeaturePlan('invalid', {
        ...source,
        passes: [
          {
            ...pass,
            dispatches: [
              { kind: 'direct', entryPoint: 'simulate', bindings: override, workgroups: [0] },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  }
  const wrong = {
    ...source,
    resources: source.resources.map((resource) =>
      resource.name === 'binding-b' ? { ...binding('b'), program: 'other' } : resource,
    ),
  };
  expect(validateRenderFeaturePlan('invalid', wrong).ok).toBe(false);
  const scoped = resolveFeatureWorkResources([
    { scope: 'frame', resources: source.resources, passes: [] },
    { scope: { view: 'main' }, resources: [], passes: source.passes },
  ]);
  expect(scoped[1]?.closure.resources.map((resource) => resource.name)).toEqual(
    source.resources.map((resource) => resource.name),
  );
});

it('uses each actual binding and current count through one retained compute graph', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let current = plan();
  const host = createRenderFeatureHost([
    {
      identity: 'batch',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ ...current, scope: { view: 'main' } }] }),
    },
  ]).unwrap();
  let graph: ReturnType<RenderGraphBuilder<RenderFeatureExecutionFrame>['compile']> | undefined;
  let signature: string | undefined;
  const recorded: { count: number; binding: unknown }[] = [];
  try {
    for (const [index, counts] of [
      [1, 2],
      [0, 3],
      [2, 0],
    ].entries()) {
      current = plan(counts[0], counts[1]);
      const frame = runSingleViewFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: index + 1,
        caps: device.caps,
        gpuWork: gpu,
        generation: 0,
      });
      expect(frame.errors).toEqual([]);
      const planned = frame.plans[0];
      if (planned === undefined) throw new Error('Missing planned batch');
      if (signature !== undefined) expect(planned.signature).toBe(signature);
      signature = planned.signature;
      const execution = getRenderFeaturePlanExecutionProjection(planned);
      if (execution === undefined) throw new Error('Missing compute execution');
      if (graph === undefined) {
        const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
        new RenderFeatureComputeGraphProjection(builder).addPasses(execution.passes).unwrap();
        graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
      }
      const encoder = device.createCommandEncoder().unwrap();
      const begin = encoder.beginComputePass.bind(encoder);
      vi.spyOn(encoder, 'beginComputePass').mockImplementation((descriptor) => {
        const pass = begin(descriptor);
        let activeBinding: unknown;
        const set = pass.setBindGroup.bind(pass);
        vi.spyOn(pass, 'setBindGroup').mockImplementation((index, binding, ...rest) => {
          activeBinding = binding;
          set(index, binding, ...rest);
        });
        vi.spyOn(pass, 'dispatchWorkgroups').mockImplementation((count) => {
          recorded.push({ count, binding: activeBinding });
        });
        return pass;
      });
      graph
        .unwrap()
        .execute({ encoder, featureExecutions: [execution] })
        .unwrap();
      frame.onSubmitted();
    }
    expect(recorded.map((row) => row.count)).toEqual([1, 2, 3, 2]);
    expect(recorded[0]?.binding).not.toBe(recorded[1]?.binding);
    expect(recorded[2]?.binding).toBe(recorded[1]?.binding);
    expect(recorded[3]?.binding).toBe(recorded[0]?.binding);
  } finally {
    await graph?.unwrap().retire();
    gpu.dispose().unwrap();
    host.dispose();
  }
});

import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import { createRenderFeatureHost, getRenderFeaturePlanExecutionProjection } from '../features/host';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  freezeRenderFeaturePlan,
  type RenderFeatureWorkPlan,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
} from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

function plan(a = true, b = false): RenderFeatureWorkPlan {
  return {
    resources: ['a', 'b', 'c'].map((name) => ({
      kind: 'buffer' as const,
      name,
      size: 16,
      usage: ['copy-src'] as const,
    })),
    passes: [
      {
        kind: 'copy',
        name: 'reset',
        enabled: a || b,
        copies: [
          { source: 'a', destination: 'b', size: 16, enabled: a },
          { source: 'a', destination: 'c', size: 16, enabled: b },
        ],
      },
    ],
  };
}

it('keeps copy enablement as frame data while still validating every disabled command', () => {
  const initial = plan();
  const snapshot = cloneRenderFeaturePlanSignatureSnapshot(initial);
  const signature = renderFeaturePlanSignature(initial);
  for (const flags of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]) {
    const current = plan(flags[0], flags[1]);
    expect(freezeRenderFeaturePlan('copy', current).ok).toBe(true);
    expect(renderFeaturePlanSignature(current)).toBe(signature);
    expect(cloneRenderFeaturePlanSignatureSnapshot(current, snapshot)).toBe(snapshot);
    expect(renderFeaturePlanSignatureSnapshotEquals(current, snapshot)).toBe(true);
  }
  const invalid: RenderFeatureWorkPlan = {
    ...initial,
    passes: [
      {
        kind: 'copy',
        name: 'invalid',
        enabled: false,
        copies: [{ source: 'a', destination: 'a', size: 16, enabled: false }],
      },
    ],
  };
  expect(freezeRenderFeaturePlan('copy', invalid).ok).toBe(false);
});

it('records exactly the live ordered copies through one retained real host/graph projection', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'unused' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let current = plan();
  const host = createRenderFeatureHost([
    {
      identity: 'copy',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ ...current, scope: { view: 'main' } }] }),
    },
  ]).unwrap();
  let graph: ReturnType<RenderGraphBuilder<RenderFeatureExecutionFrame>['compile']> | undefined;
  let signature: string | undefined;
  try {
    for (const [index, flags] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ].entries()) {
      current = plan(flags[0], flags[1]);
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
      if (planned === undefined) throw new Error('Missing copy plan');
      if (signature !== undefined) expect(planned.signature).toBe(signature);
      signature = planned.signature;
      const execution = getRenderFeaturePlanExecutionProjection(planned);
      if (execution === undefined) throw new Error('Missing copy execution');
      if (graph === undefined) {
        const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
        new RenderFeatureComputeGraphProjection(builder).addPasses(execution.passes).unwrap();
        graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
      }
      const encoder = device.createCommandEncoder().unwrap();
      const observed: unknown[][] = [];
      vi.spyOn(encoder, 'copyBufferToBuffer').mockImplementation((...args: unknown[]) => {
        observed.push(args);
      });
      graph
        .unwrap()
        .execute({ encoder, featureExecutions: [execution] })
        .unwrap();
      const copies = execution.passes.flatMap((pass) => pass.resolvedGpuCopies ?? []);
      expect(copies).toHaveLength(2);
      expect(observed).toEqual(
        copies
          .filter((copy) => copy.enabled !== false)
          .map((copy) => [
            copy.source.buffer,
            copy.sourceOffset,
            copy.destination.buffer,
            copy.destinationOffset,
            copy.size,
          ]),
      );
      frame.onSubmitted();
    }
  } finally {
    await graph?.unwrap().retire();
    gpu.dispose().unwrap();
    host.dispose();
  }
});

it.each([
  false,
  true,
])('projects ordered upload slices with one destination (read/write alias=%s)', async (alias) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: () => {
        throw new Error('Copies do not compile shaders');
      },
    }),
  });
  const current: RenderFeatureWorkPlan = {
    ...plan(),
    passes: [
      {
        kind: 'copy',
        name: 'field-uploads',
        copies: alias
          ? [
              { source: 'a', destination: 'b', size: 8 },
              { source: 'b', destination: 'c', size: 8 },
            ]
          : [
              { source: 'a', destination: 'c', size: 8 },
              { source: 'b', destination: 'c', size: 4, destinationOffset: 8 },
              { source: 'b', destination: 'c', size: 4, sourceOffset: 4, destinationOffset: 12 },
            ],
      },
    ],
  };
  const host = createRenderFeatureHost([
    {
      identity: 'field-uploads',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ ...current, scope: { view: 'main' } }] }),
    },
  ]).unwrap();
  try {
    const frame = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: device.caps,
      gpuWork: gpu,
      generation: 0,
    });
    expect(frame.errors).toEqual([]);
    const planned = frame.plans[0];
    if (planned === undefined) throw new Error('Missing upload plan');
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    if (execution === undefined) throw new Error('Missing upload execution');
    const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
    const projected = new RenderFeatureComputeGraphProjection(builder).addPasses(execution.passes);
    projected.unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
    if (alias) {
      expect(compiled).toMatchObject({ ok: false, error: { code: 'access-conflict' } });
      return;
    }
    const graph = compiled.unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      const copy = vi.spyOn(encoder, 'copyBufferToBuffer');
      graph.execute({ encoder, featureExecutions: [execution] }).unwrap();
      expect(copy.mock.calls).toEqual(
        execution.passes
          .flatMap((pass) => pass.resolvedGpuCopies ?? [])
          .map((entry) => [
            entry.source.buffer,
            entry.sourceOffset,
            entry.destination.buffer,
            entry.destinationOffset,
            entry.size,
          ]),
      );
      expect(copy).toHaveBeenCalledTimes(3);
      frame.onSubmitted();
    } finally {
      await graph.retire();
    }
  } finally {
    gpu.dispose().unwrap();
    host.dispose();
  }
});

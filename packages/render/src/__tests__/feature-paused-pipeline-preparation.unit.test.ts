import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import { createRenderFeatureHost, getRenderFeaturePlanExecutionProjection } from '../features/host';
import type { RenderFeatureWork } from '../features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import { projectRenderFeaturePlans } from '../features/render-graph-contribution';
import { createRenderFeatureTarget } from '../features/targets';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import { abortFeatureFrame, prepareFeatureFrame, submitFeatureFrame } from './feature-frame-driver';

const waterMergeProgram = ownRenderFeatureProgramData({
  wgsl: 'synthetic',
  entryPoints: ['merge'],
  bindings: [
    {
      entries: [
        {
          binding: 0,
          visibility: 4,
          texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
        },
        {
          binding: 1,
          visibility: 4,
          storageTexture: {
            access: 'write-only' as const,
            format: 'rgba16float' as const,
            viewDimension: '2d' as const,
          },
        },
      ],
    },
  ],
});

function waterInfoWork(
  view: string,
  hasWater: boolean,
  preparePipelines = true,
): RenderFeatureWork {
  return {
    scope: { view },
    resources: [
      {
        kind: 'graph-texture',
        name: 'water-info-water-raster-0',
        allocationKey: 'water-info-water-raster-0',
        descriptor: {
          format: 'rgba16float',
          size: { width: 1, height: 1, depthOrArrayLayers: 1 },
          sampleCount: 1,
          dimension: '2d',
        },
      },
      {
        kind: 'graph-texture',
        name: 'water-info-merged-0',
        allocationKey: 'water-info-merged-0',
        descriptor: {
          format: 'rgba16float',
          size: { width: 1, height: 1, depthOrArrayLayers: 1 },
          sampleCount: 1,
          dimension: '2d',
        },
      },
      {
        kind: 'graphics-program',
        name: 'water-info-raster-program',
        program: {
          shader: 'water-info-raster',
          vertexLayout: 'none',
          colorFormats: ['rgba16float'],
          preparePipelines,
        },
      },
      {
        kind: 'prepared-gpu-resource',
        name: 'water-info-water-raster-view',
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: 'water-info-water-raster-0',
      },
      {
        kind: 'prepared-gpu-resource',
        name: 'water-info-merged-view',
        resource: { kind: 'texture-view', value: undefined },
        logicalTarget: 'water-info-merged-0',
      },
      { kind: 'compute-program', name: 'water-info-merge-program', program: waterMergeProgram },
      {
        kind: 'compute-bindings',
        name: 'water-info-merge-bindings',
        program: 'water-info-merge-program',
        entries: [
          { binding: 0, resource: 'water-info-water-raster-view' },
          { binding: 1, resource: 'water-info-merged-view' },
        ],
      },
    ],
    passes: [
      {
        kind: 'raster',
        name: 'water-info-water-raster',
        colorAttachments: [
          { target: 'water-info-water-raster-0', loadOp: 'clear', storeOp: 'store' },
        ],
        draws: hasWater
          ? [
              {
                program: 'water-info-raster-program',
                bindings: [],
                vertexData: [],
                vertexLayout: 'none',
                draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
              },
            ]
          : [],
      },
      {
        kind: 'compute',
        name: 'water-info-merge',
        program: 'water-info-merge-program',
        bindings: 'water-info-merge-bindings',
        dispatches: [{ kind: 'direct', entryPoint: 'merge', workgroups: [1, 1, 1] }],
      },
    ],
  };
}

it.each([false, true])('holds pending graphics until ready (atomic: %s)', async (atomic) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = rhi
    .createShaderModuleImmediate(device, {
      code: '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fs_main() -> @location(0) vec4f {return vec4f();}',
    })
    .unwrap();
  const create = vi.spyOn(device, 'createRenderPipeline');
  const feature: RenderFeature<undefined> = {
    identity: 'paused-prepare',
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: { view: 'main' },
            ...(atomic ? { submission: 'atomic' as const } : {}),
            resources: [
              {
                kind: 'graphics-program',
                name: 'pipeline',
                program: {
                  shader: 'paused',
                  vertexLayout: 'none',
                  colorFormats: ['rgba8unorm'],
                  preparePipelines: true,
                },
              },
              { kind: 'graphics-bindings', name: 'bindings', program: 'pipeline', values: {} },
            ],
            passes: [
              {
                kind: 'raster',
                name: 'initialize',
                colorAttachments: [{ target: 'swapchain', loadOp: 'clear', storeOp: 'store' }],
                draws: [],
              },
              {
                kind: 'raster',
                name: 'prepare',
                enabled: atomic,
                colorAttachments: [{ target: 'swapchain', loadOp: 'load', storeOp: 'store' }],
                draws: [
                  {
                    program: 'pipeline',
                    bindings: ['bindings'],
                    vertexData: [],
                    vertexLayout: 'none',
                    draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const target = createRenderFeatureTarget({
    name: 'swapchain',
    kind: 'scene-color',
    format: 'rgba8unorm',
    sampleCount: 1,
  });
  let pending = true;
  const frame = () =>
    prepareFeatureFrame(host, [
      {
        world: new World(),
        identity: 'main',
        render: true,
        frameNumber: 1,
        generation: 0,
        caps: device.caps,
        targets: [target],
        createPreparedGraphicsResolver(input) {
          return createPreparedGraphicsResolver({
            device,
            featureIdentity: input.featureIdentity,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: (descriptor) => {
              expect(descriptor.preparePipelines).toBe(true);
              if (pending)
                return err(
                  new RhiError({
                    code: 'rhi-not-available',
                    expected: 'actual completion',
                    hint: 'retry',
                  }),
                );
              return device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
                fragment: {
                  module: shader,
                  entryPoint: 'fs_main',
                  targets: [{ format: 'rgba8unorm' }],
                },
              });
            },
            resolveBindings: () => ok(undefined),
          });
        },
      },
    ]);
  try {
    const first = frame();
    expect(first.frame.preparationPending).toBe(true);
    expect(first.frame.preparationPendingReason).toMatchObject({
      code: 'feature-preparation',
      featureIdentity: 'paused-prepare',
      preparationStage: 'graphics-pipeline',
      pass: 'prepare',
      shader: 'paused',
      operation: 'resolve',
      reason: 'pipeline-pending',
    });
    const originalReason = structuredClone(first.frame.preparationPendingReason);
    expect(first.frame.errors).toEqual([]);
    // The view remains unpublished even though its clear pass has no pipeline dependency.
    expect(first.views.get('main')?.plans).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    abortFeatureFrame(host);
    pending = false;
    const ready = frame();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.preparationPendingReason).toBeUndefined();
    expect(first.frame.preparationPendingReason).toEqual(originalReason);
    expect(ready.frame.errors).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
    const view = ready.views.get('main');
    if (view === undefined) throw new Error('missing view');
    const projected = view.plans.flatMap(
      (plan) => getRenderFeaturePlanExecutionProjection(plan)?.passes ?? [],
    );
    expect(projected.map(({ name, enabled }) => [name, enabled !== false])).toEqual([
      ['initialize', true],
      ['prepare', atomic],
    ]);
    abortFeatureFrame(host);
  } finally {
    host.dispose();
  }
});

it.each([
  true,
  false,
])('keeps required view closures atomic across pending pipelines and retries (preparePipelines=%s)', async (preparePipelines) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let pendingView = 'right';
  let hasWater = true;
  let frameNumber = 0;
  const submitted = vi.fn();
  const aborted = vi.fn();
  const unrelatedSubmitted = vi.fn();
  const unrelatedAborted = vi.fn();
  const required: RenderFeature<undefined> = {
    identity: 'water-info-producer',
    extract: () => ok(undefined),
    requiresPreparation: () => true,
    plan: (_source, context) =>
      ok({
        work: context.views.map((view) => waterInfoWork(view.identity, hasWater, preparePipelines)),
      }),
    onFrameSubmitted: submitted,
    onFrameAborted: aborted,
  };
  const unrelated: RenderFeature<undefined> = {
    identity: 'unrelated-feature',
    extract: () => ok(undefined),
    plan: (_source, context) =>
      ok({
        work: context.views.map((view) => ({
          scope: { view: view.identity },
          resources: [],
          passes: [],
        })),
      }),
    onFrameSubmitted: unrelatedSubmitted,
    onFrameAborted: unrelatedAborted,
  };
  const host = createRenderFeatureHost([required, unrelated]).unwrap();
  const frame = () => {
    frameNumber += 1;
    return prepareFeatureFrame(
      host,
      ['left', 'right'].map((identity) => ({
        world: new World(),
        identity,
        render: true,
        frameNumber,
        generation: 0,
        caps: device.caps,
        gpuWork: gpu,
        createPreparedGraphicsResolver(input) {
          return createPreparedGraphicsResolver({
            device,
            featureIdentity: input.featureIdentity,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: () =>
              identity === pendingView
                ? err(
                    new RhiError({
                      code: 'rhi-not-available',
                      expected: 'actual completion',
                      hint: 'retry',
                    }),
                  )
                : device.createRenderPipeline({
                    layout: 'auto',
                    vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
                    fragment: {
                      module: shader,
                      entryPoint: 'fs_main',
                      targets: [{ format: 'rgba16float' }],
                    },
                  }),
            resolveBindings: () => ok(undefined),
          });
        },
      })),
    );
  };
  try {
    const pending = frame();
    expect(pending.frame.preparationPending).toBe(true);
    expect(pending.frame.preparationPendingReason).toMatchObject({
      featureIdentity: 'water-info-producer',
      preparationStage: 'graphics-pipeline',
      pass: 'water-info-water-raster',
      reason: 'pipeline-pending',
    });
    expect(pending.frame.errors).toEqual([]);
    expect(pending.views.get('left')?.plans.map((plan) => plan.featureIdentity)).toEqual([
      'unrelated-feature',
    ]);
    expect(pending.views.get('right')?.plans.map((plan) => plan.featureIdentity)).toEqual([
      'unrelated-feature',
    ]);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
    submitFeatureFrame(host);
    for (const lease of pending.preparedResourceBatches) lease.release().unwrap();
    expect(unrelatedSubmitted).not.toHaveBeenCalled();
    expect(unrelatedAborted).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();

    pendingView = '';
    const ready = frame();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.errors).toEqual([]);
    for (const identity of ['left', 'right']) {
      const plans = ready.views.get(identity)?.plans ?? [];
      const waterPlan = plans.find((plan) => plan.featureIdentity === 'water-info-producer');
      expect(waterPlan).toBeDefined();
      const execution =
        waterPlan === undefined ? undefined : getRenderFeaturePlanExecutionProjection(waterPlan);
      const passes = execution?.passes;
      expect(passes?.map((pass) => pass.name)).toContain('water-info-water-raster');
      expect(passes?.map((pass) => pass.name)).toContain('water-info-merge');

      if (execution === undefined) throw new Error('Missing WaterInfo execution projection');
      const missingWriter = {
        ...execution,
        passes: execution.passes.filter((pass) => pass.name !== 'water-info-water-raster'),
      };
      const incompleteBuilder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
      projectRenderFeaturePlans(incompleteBuilder, [missingWriter], {
        resolveTarget: () => undefined,
      }).unwrap();
      const incomplete = incompleteBuilder.compile({
        device,
        surfaceSize: { width: 1, height: 1 },
      });
      expect(incomplete.ok).toBe(false);
      if (!incomplete.ok) expect(incomplete.error.code).toBe('uninitialized-read');

      const completeBuilder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
      projectRenderFeaturePlans(completeBuilder, [execution], {
        resolveTarget: () => undefined,
      }).unwrap();
      const complete = completeBuilder.compile({
        device,
        surfaceSize: { width: 1, height: 1 },
      });
      expect(complete.ok).toBe(true);
      if (complete.ok) {
        try {
          expect(complete.value.inspect().passes.map((pass) => pass.name)).toEqual([
            'water-info-water-raster',
            'water-info-merge',
          ]);
        } finally {
          await complete.value.retire();
        }
      }
    }
    submitFeatureFrame(host);
    for (const lease of ready.preparedResourceBatches) lease.release().unwrap();
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(unrelatedSubmitted).toHaveBeenCalledTimes(1);

    hasWater = false;
    pendingView = 'right';
    const emptyRaster = frame();
    expect(emptyRaster.frame.preparationPending).not.toBe(true);
    expect(emptyRaster.frame.errors).toEqual([]);
    for (const identity of ['left', 'right']) {
      const plans = emptyRaster.views.get(identity)?.plans ?? [];
      const waterPlan = plans.find((plan) => plan.featureIdentity === 'water-info-producer');
      const raster = waterPlan
        ? getRenderFeaturePlanExecutionProjection(waterPlan)?.passes.find(
            (pass) => pass.name === 'water-info-water-raster',
          )
        : undefined;
      expect(raster?.graphics?.draws).toEqual([]);
      expect(raster?.graphics?.attachments.colors[0]?.loadOp).toBe('clear');
      expect(
        waterPlan === undefined
          ? undefined
          : getRenderFeaturePlanExecutionProjection(waterPlan)?.passes.map((pass) => pass.name),
      ).toContain('water-info-merge');
    }
    submitFeatureFrame(host);
    for (const lease of emptyRaster.preparedResourceBatches) lease.release().unwrap();
    expect(submitted).toHaveBeenCalledTimes(2);
  } finally {
    gpu.dispose().unwrap();
    host.dispose();
  }
});

it.each([
  'pending',
  'failed',
  'consumer-throws',
] as const)('settles a %s producer once after same-frame consumer preparation', async (outcome) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const candidates = new Map<string, { frame: number; device: number }>();
  const aborted = vi.fn(() => candidates.clear());
  const submitted = vi.fn();
  const observed: ({ frame: number; device: number } | undefined)[] = [];
  let producerReady = false;
  let frameNumber = 9;
  const work = (shader: string): RenderFeatureWork => ({
    scope: { view: 'main' },
    resources: [
      {
        kind: 'graphics-program',
        name: 'pipeline',
        program: {
          shader,
          vertexLayout: 'none',
          colorFormats: ['rgba16float'],
          preparePipelines: true,
        },
      },
    ],
    passes: [
      {
        kind: 'raster',
        name: shader,
        colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program: 'pipeline',
            bindings: [],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  });
  const host = createRenderFeatureHost([
    {
      identity: 'producer',
      extract: (context) => {
        candidates.set('main', { frame: context.frameNumber, device: 2 });
        return ok(undefined);
      },
      plan: () => ok({ work: [work('producer')] }),
      onFrameAborted: aborted,
      onFrameSubmitted: submitted,
    },
    {
      identity: 'consumer',
      extract: () => {
        if (outcome === 'consumer-throws' && !producerReady) {
          observed.push(candidates.get('main'));
          throw new Error('consumer preparation failed');
        }
        return ok(undefined);
      },
      plan: () => ok({ work: [work('consumer')] }),
    },
  ]).unwrap();
  const frame = () =>
    prepareFeatureFrame(host, [
      {
        world: new World(),
        identity: 'main',
        render: true,
        frameNumber,
        deviceGeneration: 2,
        generation: 0,
        caps: device.caps,
        targets: [
          createRenderFeatureTarget({ kind: 'scene-color', format: 'rgba16float', sampleCount: 1 }),
        ],
        createPreparedGraphicsResolver(input) {
          return createPreparedGraphicsResolver({
            device,
            featureIdentity: input.featureIdentity,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: () => {
              if (input.featureIdentity === 'producer' && !producerReady)
                return err(
                  new RhiError({
                    code: outcome === 'failed' ? 'rhi-descriptor-invalid' : 'rhi-not-available',
                    expected: 'this requested producer pipeline completes',
                    hint: 'retry after its owning preparation changes',
                  }),
                );
              if (input.featureIdentity === 'consumer') {
                const candidate = candidates.get('main');
                observed.push(candidate);
                if (
                  candidate === undefined ||
                  candidate.frame !== input.frameGeneration ||
                  candidate.device !== input.deviceGeneration
                )
                  return err(new Error('same-frame producer publication is unavailable'));
              }
              return device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
                fragment: {
                  module: shader,
                  entryPoint: 'fs_main',
                  targets: [{ format: 'rgba16float' }],
                },
              });
            },
            resolveBindings: () => ok(undefined),
          });
        },
      },
    ]);
  try {
    const first = frame();
    expect(observed).toEqual(outcome === 'failed' ? [undefined] : [{ frame: 9, device: 2 }]);
    expect(first.frame.preparationPending).toBe(true);
    expect(first.frame.errors).toHaveLength(
      outcome === 'pending' ? 0 : outcome === 'failed' ? 2 : 1,
    );
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(candidates.size).toBe(0);
    expect(submitted).not.toHaveBeenCalled();
    abortFeatureFrame(host);
    expect(aborted).toHaveBeenCalledTimes(1);

    frameNumber++;
    producerReady = true;
    const ready = frame();
    expect(ready.frame.errors).toEqual([]);
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(observed.at(-1)).toEqual({ frame: 10, device: 2 });
    submitFeatureFrame(host);
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});

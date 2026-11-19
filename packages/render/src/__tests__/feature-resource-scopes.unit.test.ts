import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import { NativeFeatureWorkRouting } from '../features/frame-plan';
import {
  createRenderFeatureGraphTextureTargets,
  prepareRenderFeatureGraphTextureTargets,
} from '../features/graph-texture-targets';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameBatch,
  type RenderFeatureHost,
} from '../features/host';
import { sameRenderFeatureNativeExecutionTopology } from '../features/native-execution-topology';
import type { RenderFeatureWork } from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import {
  createRenderFeatureGraphTextureTarget,
  createRenderFeatureTarget,
  isRenderFeatureGraphTextureTarget,
} from '../features/targets';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import { abortFeatureFrame, prepareFeatureFrame, submitFeatureFrame } from './feature-frame-driver';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

function complete(host: RenderFeatureHost, batch: RenderFeatureFrameBatch) {
  expect(batch.frame.errors).toEqual([]);
  submitFeatureFrame(host);
  for (const resources of batch.preparedResourceBatches) resources.release().unwrap();
}

async function fixture(work: () => readonly RenderFeatureWork[]) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule() {
        throw new Error('Copy work does not request a shader');
      },
    }),
  });
  const feature: RenderFeature<undefined> = {
    identity: 'resource-scopes',
    extract: () => ok(undefined),
    plan: () => ok({ work: work() }),
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const common = {
    world: new World(),
    frameNumber: 1,
    generation: 0,
    caps: device.caps,
    gpuWork: gpu,
  } as const;
  return {
    device,
    gpu,
    host,
    common,
    dispose() {
      gpu.dispose().unwrap();
      host.dispose();
    },
  };
}

function sharedViews(shared: number, views: number): RenderFeatureWork[] {
  return [
    {
      scope: 'frame',
      resources: Array.from({ length: shared }, (_, index) => ({
        kind: 'buffer' as const,
        name: `shared-${index}`,
        size: 16,
        usage: ['copy-src' as const],
      })),
      passes: [],
    },
    ...Array.from({ length: views }, (_, index) => ({
      scope: { view: `view-${index}` },
      resources: [
        { kind: 'buffer' as const, name: 'output', size: 16, usage: ['storage' as const] },
      ],
      passes: [
        {
          kind: 'copy' as const,
          name: 'copy',
          copies: [{ source: 'shared-0', destination: 'output', size: 16 }],
        },
      ],
    })),
  ];
}

describe('prepared feature resource scopes', () => {
  it('projects a retained material texture without a producer pass', async () => {
    const f = await fixture(() => [
      {
        scope: { view: 'main' },
        resources: [
          {
            kind: 'graph-texture',
            name: 'held-foam',
            allocationKey: 'held-foam',
            materialSource: true,
            descriptor: {
              format: 'rgba16float',
              size: { width: 8, height: 8, depthOrArrayLayers: 1 },
              dimension: '2d',
              lifetime: 'persistent',
              sampleCount: 1,
              usage: 5,
            },
          },
        ],
        passes: [],
      },
    ]);
    try {
      const batch = prepareFeatureFrame(f.host, [{ ...f.common, identity: 'main', render: true }]);
      expect(batch.frame.errors).toEqual([]);
      const plan = batch.views.get('main')?.plans[0];
      if (!plan) throw new Error('Missing held material source plan');
      const execution = getRenderFeaturePlanExecutionProjection(plan);
      if (!execution) throw new Error('Missing held material source projection');
      const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
      const state = createRenderFeatureGraphTextureTargets();
      prepareRenderFeatureGraphTextureTargets(builder, state, [execution]).unwrap();
      expect([...state.targets.keys()].map((target) => target.name)).toContain('held-foam');
      const target = execution.materialTextureTargets?.[0];
      if (!isRenderFeatureGraphTextureTarget(target))
        throw new Error('Missing retained material target');
      expect(
        sameRenderFeatureNativeExecutionTopology(execution, {
          ...execution,
          materialTextureTargets: [createRenderFeatureGraphTextureTarget({ ...target })],
        }),
      ).toBe(true);
      expect(
        sameRenderFeatureNativeExecutionTopology(execution, {
          ...execution,
          materialTextureTargets: [
            createRenderFeatureGraphTextureTarget({ ...target, allocationKey: 'replacement-foam' }),
          ],
        }),
      ).toBe(false);
      expect(
        sameRenderFeatureNativeExecutionTopology(execution, {
          ...execution,
          materialTextureTargets: [],
        }),
      ).toBe(false);
    } finally {
      abortFeatureFrame(f.host);
      f.dispose();
    }
  });

  it('does not probe all eight resource kinds for every shared key in every view', async () => {
    const f = await fixture(() => sharedViews(32, 8));
    const original = Map.prototype.get;
    let normalizedReads = 0;
    const counter = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
    ) {
      if (typeof key === 'string' && (key.startsWith('["frame",') || key.startsWith('["view:')))
        normalizedReads++;
      return original.call(this, key);
    });
    let batch: RenderFeatureFrameBatch | undefined;
    try {
      batch = prepareFeatureFrame(
        f.host,
        Array.from({ length: 8 }, (_, index) => ({
          ...f.common,
          identity: `view-${index}`,
          render: true,
        })),
      );
    } finally {
      counter.mockRestore();
    }
    try {
      if (batch === undefined) throw new Error('Missing feature batch');
      complete(f.host, batch);
      expect(
        batch.frame.plans.map((plan) => getRenderFeaturePlanExecutionProjection(plan)?.scope),
      ).toEqual(['frame']);
      expect(
        [...batch.views.values()].map((view) =>
          view.plans.map((plan) => getRenderFeaturePlanExecutionProjection(plan)?.scope),
        ),
      ).toEqual(Array.from({ length: 8 }, (_, index) => [`view:view-${index}`]));
      expect(normalizedReads).toBeLessThan(1000);
      const copies = [...batch.views.values()].flatMap((view) =>
        view.plans.flatMap(
          (plan) =>
            getRenderFeaturePlanExecutionProjection(plan)?.passes.flatMap(
              (pass) => pass.resolvedGpuCopies ?? [],
            ) ?? [],
        ),
      );
      expect(copies).toHaveLength(8);
      expect(new Set(copies.map((copy) => copy.source.buffer)).size).toBe(1);
      expect(new Set(copies.map((copy) => copy.destination.buffer)).size).toBe(8);
    } finally {
      abortFeatureFrame(f.host);
      f.dispose();
    }
  });

  it('preserves broad shared names when a resolver callback changes a view pass after admission', async () => {
    const work = sharedViews(3, 1);
    const f = await fixture(() => work);
    const allocations = vi.spyOn(f.device, 'createBuffer');
    const callbackOrder: string[] = [];
    const batch = prepareFeatureFrame(f.host, [
      {
        ...f.common,
        identity: 'view-0',
        render: true,
        createPreparedGraphicsResolver(input) {
          callbackOrder.push(input.featureIdentity);
          const pass = work[1]?.passes[0];
          if (pass?.kind !== 'copy') throw new Error('Missing mutable copy pass');
          (pass.copies[0] as { source: string }).source = 'shared-2';
          return createPreparedGraphicsResolver({
            device: f.device,
            featureIdentity: input.featureIdentity,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: () => {
              throw new Error('No graphics pipeline is requested');
            },
            resolveBindings: () => ok(undefined),
          });
        },
      },
    ]);
    try {
      complete(f.host, batch);
      expect(callbackOrder).toEqual(['resource-scopes', 'resource-scopes']);
      const plan = batch.views.get('view-0')?.plans[0];
      if (plan === undefined) throw new Error('Missing view plan');
      expect(plan.plan.resources.map((resource) => resource.name)).toEqual(['shared-0', 'output']);
      const copy = getRenderFeaturePlanExecutionProjection(plan)?.passes[0]?.resolvedGpuCopies?.[0];
      const replacement = allocations.mock.results[2]?.value;
      if (replacement?.ok !== true) throw new Error('Missing third shared buffer');
      expect(copy?.source.buffer).toBe(replacement.value);
    } finally {
      allocations.mockRestore();
      abortFeatureFrame(f.host);
      f.dispose();
    }
  });

  it('aborts every prepared resource after a projection callback fails and retries without stale scopes', async () => {
    const f = await fixture(() => sharedViews(3, 2));
    const allocations = vi.spyOn(f.device, 'createBuffer');
    const destroyed = vi.spyOn(f.device, 'destroyBuffer');
    let callbacks = 0;
    const failure = new Error('Resolver creation failed');
    const failed = prepareFeatureFrame(
      f.host,
      ['view-0', 'view-1'].map((identity) => ({
        ...f.common,
        identity,
        render: true,
        createPreparedGraphicsResolver(input) {
          if (++callbacks === 2) throw failure;
          return createPreparedGraphicsResolver({
            device: f.device,
            featureIdentity: input.featureIdentity,
            generation: input.generation,
            capabilityAvailable: true,
            lookup: input.lookup,
            resolvePipeline: () => {
              throw new Error('No graphics pipeline is requested');
            },
            resolveBindings: () => ok(undefined),
          });
        },
      })),
    );
    try {
      expect(callbacks).toBe(2);
      expect(failed.frame.errors).toHaveLength(1);
      expect(failed.frame.plans).toEqual([]);
      expect([...failed.views.values()].flatMap((view) => view.plans)).toEqual([]);
      expect(allocations).toHaveBeenCalledTimes(5);
      expect(destroyed).toHaveBeenCalledTimes(5);
      abortFeatureFrame(f.host);
      const retried = prepareFeatureFrame(
        f.host,
        ['view-0', 'view-1'].map((identity) => ({
          ...f.common,
          identity,
          render: true,
        })),
      );
      complete(f.host, retried);
      expect(allocations).toHaveBeenCalledTimes(10);
      expect(destroyed).toHaveBeenCalledTimes(5);
      for (const view of retried.views.values()) {
        const plan = view.plans[0];
        if (plan === undefined) throw new Error('Missing retried view plan');
        const copy =
          getRenderFeaturePlanExecutionProjection(plan)?.passes[0]?.resolvedGpuCopies?.[0];
        const shared = allocations.mock.results[5]?.value;
        if (shared?.ok !== true) throw new Error('Missing retried shared buffer');
        expect(copy?.source.buffer).toBe(shared.value);
      }
    } finally {
      abortFeatureFrame(f.host);
      allocations.mockRestore();
      destroyed.mockRestore();
      f.dispose();
    }
  });

  it('routes raster sampled targets through shared resource ownership into the graph', async () => {
    const colorTarget = createRenderFeatureTarget({
      name: 'color',
      kind: 'scene-color',
      format: 'rgba8unorm',
      sampleCount: 1,
    });
    const desc = {
      format: 'rgba8unorm' as const,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      sampleCount: 1,
      dimension: '2d' as const,
    };
    const work = (): RenderFeatureWork[] => [
      {
        scope: 'frame',
        resources: [
          { kind: 'graph-texture', name: 'shared', allocationKey: 'shared', descriptor: desc },
        ],
        passes: [
          {
            kind: 'raster',
            name: 'frame-write',
            colorAttachments: [{ target: 'shared', loadOp: 'clear', storeOp: 'store' }],
            draws: [],
          },
        ],
      },
      ...(['view-0', 'view-1'] as const).map((view) => ({
        scope: { view },
        resources: [
          {
            kind: 'graph-texture' as const,
            name: `${view}-local`,
            allocationKey: 'local',
            descriptor: desc,
          },
        ],
        passes: [
          {
            kind: 'raster' as const,
            name: `${view}-read`,
            colorAttachments: [
              { target: 'color', loadOp: 'clear' as const, storeOp: 'store' as const },
            ],
            sampledTargets: ['shared'],
            draws: [],
          },
          {
            kind: 'raster' as const,
            name: `${view}-write-local`,
            colorAttachments: [
              { target: `${view}-local`, loadOp: 'clear' as const, storeOp: 'store' as const },
            ],
            draws: [],
          },
        ],
      })),
    ];
    const f = await fixture(work);
    try {
      const batch = prepareFeatureFrame(
        f.host,
        (['view-0', 'view-1'] as const).map((identity) => ({
          ...f.common,
          identity,
          render: true,
          targets: [colorTarget],
        })),
      );
      expect(batch.frame.errors).toEqual([]);
      const framePlan = batch.frame.plans[0];
      const leftPlan = batch.views.get('view-0')?.plans[0];
      const rightPlan = batch.views.get('view-1')?.plans[0];
      if (framePlan === undefined || leftPlan === undefined || rightPlan === undefined)
        throw new Error('Missing routed feature plans');
      const frame = getRenderFeaturePlanExecutionProjection(framePlan);
      const left = getRenderFeaturePlanExecutionProjection(leftPlan);
      const right = getRenderFeaturePlanExecutionProjection(rightPlan);
      if (frame === undefined || left === undefined || right === undefined)
        throw new Error('Missing feature execution projection');

      const frameHandle = frame.passes[0]?.graphics?.attachments.colors[0]?.resource;
      const leftHandle = left.passes.find((pass) => pass.name === 'view-0-read')?.graphics
        ?.sampledTargets?.[0];
      const rightHandle = right.passes.find((pass) => pass.name === 'view-1-read')?.graphics
        ?.sampledTargets?.[0];
      const leftLocalHandle = left.passes.find((pass) => pass.name === 'view-0-write-local')
        ?.graphics?.attachments.colors[0]?.resource;
      const rightLocalHandle = right.passes.find((pass) => pass.name === 'view-1-write-local')
        ?.graphics?.attachments.colors[0]?.resource;
      if (
        !isRenderFeatureGraphTextureTarget(frameHandle) ||
        !isRenderFeatureGraphTextureTarget(leftHandle) ||
        !isRenderFeatureGraphTextureTarget(rightHandle) ||
        !isRenderFeatureGraphTextureTarget(leftLocalHandle) ||
        !isRenderFeatureGraphTextureTarget(rightLocalHandle)
      )
        throw new Error('Expected host graph texture target handles');

      const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
      const state = createRenderFeatureGraphTextureTargets();
      prepareRenderFeatureGraphTextureTargets(builder, state, [frame, left, right]).unwrap();
      const frameTarget = requiredFixtureValue(state.targets.get(frameHandle));
      const leftTarget = requiredFixtureValue(state.targets.get(leftHandle));
      const rightTarget = requiredFixtureValue(state.targets.get(rightHandle));
      const leftLocal = requiredFixtureValue(state.targets.get(leftLocalHandle));
      const rightLocal = requiredFixtureValue(state.targets.get(rightLocalHandle));
      expect(leftTarget.texture).toBe(frameTarget.texture);
      expect(rightTarget.texture).toBe(frameTarget.texture);
      expect(leftTarget.view).toBe(frameTarget.view);
      expect(rightTarget.view).toBe(frameTarget.view);
      expect(leftLocal.texture).not.toBe(rightLocal.texture);

      builder
        .addRasterPass('frame-write', {
          accesses: [{ resource: frameTarget.view, usage: 'color-attachment' }],
          colorAttachments: [{ view: frameTarget.view, loadOp: 'clear', storeOp: 'store' }],
          encodeDirect: () => {},
        })
        .unwrap();
      for (const [name, resolved] of [
        ['view-0-read', leftTarget],
        ['view-1-read', rightTarget],
      ] as const)
        builder
          .addRasterPass(name, {
            accesses: [{ resource: resolved.view, usage: 'sampled-read' }],
            colorAttachments: [],
            encodeDirect: () => {},
          })
          .unwrap();
      for (const [name, resolved] of [
        ['view-0-write-local', leftLocal],
        ['view-1-write-local', rightLocal],
      ] as const)
        builder
          .addRasterPass(name, {
            accesses: [{ resource: resolved.view, usage: 'color-attachment' }],
            colorAttachments: [{ view: resolved.view, loadOp: 'clear', storeOp: 'store' }],
            encodeDirect: () => {},
          })
          .unwrap();
      const graph = builder
        .compile({ device: f.device, surfaceSize: { width: 1, height: 1 } })
        .unwrap();
      try {
        const names = graph.inspect().passes.map((pass) => pass.name);
        for (const name of [
          'frame-write',
          'view-0-read',
          'view-1-read',
          'view-0-write-local',
          'view-1-write-local',
        ])
          expect(names).toContain(name);
      } finally {
        await graph.retire();
      }

      const directTarget = createRenderFeatureGraphTextureTarget({
        kind: 'graph-texture',
        name: 'direct',
        format: 'rgba8unorm',
        sampleCount: 1,
        allocationKey: 'direct',
        descriptor: desc,
      });
      const externalLeft = createRenderFeatureGraphTextureTarget({
        kind: 'graph-texture',
        name: 'external-left',
        format: 'rgba8unorm',
        sampleCount: 1,
        allocationKey: 'external',
        descriptor: desc,
      });
      const externalRight = createRenderFeatureGraphTextureTarget({
        kind: 'graph-texture',
        name: 'external-right',
        format: 'rgba8unorm',
        sampleCount: 1,
        allocationKey: 'external',
        descriptor: desc,
      });
      const directPass = (name: string, target: typeof directTarget) => ({
        featureIdentity: 'direct-adapter',
        order: 0,
        name,
        graphics: { attachments: { colors: [] }, sampledTargets: [target], draws: [] },
      });
      const externalBuilder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
      const externalState = createRenderFeatureGraphTextureTargets();
      prepareRenderFeatureGraphTextureTargets(externalBuilder, externalState, [
        {
          featureIdentity: 'direct-adapter',
          order: 0,
          scope: 'view:left',
          passes: [directPass('external-left', externalLeft)],
        },
        {
          featureIdentity: 'direct-adapter',
          order: 0,
          scope: 'view:right',
          passes: [directPass('external-right', externalRight)],
        },
        {
          featureIdentity: 'direct-adapter',
          order: 0,
          passes: [directPass('direct-no-scope', directTarget)],
        },
      ]).unwrap();
      expect(externalState.targets.get(externalLeft)?.texture).not.toBe(
        externalState.targets.get(externalRight)?.texture,
      );
      expect(externalState.targets.has(directTarget)).toBe(true);
      complete(f.host, batch);

      const nativeRows = new NativeFeatureWorkRouting().resolve(work());
      const nativeView = nativeRows.find(
        (row) => row.work.scope !== 'frame' && row.work.scope.view === 'view-0',
      );
      expect(nativeView?.resourceScopes.get('shared')).toBe('frame');
    } finally {
      abortFeatureFrame(f.host);
      f.dispose();
    }
  });

  it('resolves native prepared texture bindings against shared graph targets', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule() {
          throw new Error('Native texture target preparation does not request a shader');
        },
      }),
    });
    const descriptor = {
      format: 'rgba8unorm' as const,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      sampleCount: 1,
      dimension: '2d' as const,
    };
    const colorTarget = createRenderFeatureTarget({
      name: 'color',
      kind: 'scene-color',
      format: 'rgba8unorm',
      sampleCount: 1,
    });
    const feature: RenderFeature<undefined> = {
      identity: 'native-target-roster',
      extract: () => ok(undefined),
      plan: (_source, context) => {
        const native = context.createNativePlan?.();
        if (native === undefined) throw new Error('Missing native plan builder');
        const frame = native.scope('frame');
        const view = native.scope({ view: 'main' });
        frame.resources.push({
          kind: 'graph-texture',
          name: 'shared',
          allocationKey: 'shared',
          descriptor,
        });
        frame.passes.push({
          kind: 'raster',
          name: 'frame-write',
          colorAttachments: [{ target: 'shared', loadOp: 'clear', storeOp: 'store' }],
          draws: [],
        });
        view.resources.push({
          kind: 'prepared-gpu-resource',
          name: 'shared-view',
          resource: { kind: 'texture-view', value: undefined },
          logicalTarget: 'shared',
        });
        view.passes.push({
          kind: 'raster',
          name: 'view-read',
          colorAttachments: [{ target: 'color', loadOp: 'clear', storeOp: 'store' }],
          sampledTargets: ['shared'],
          draws: [],
        });
        return ok(native.finish([frame, view]));
      },
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      const batch = prepareFeatureFrame(host, [
        {
          world: new World(),
          identity: 'main',
          render: true,
          frameNumber: 1,
          generation: 0,
          caps: device.caps,
          targets: [colorTarget],
          gpuWork: gpu,
        },
      ]);
      expect(batch.frame.errors).toEqual([]);
      const planned = batch.views.get('main')?.plans[0];
      if (planned === undefined) throw new Error('Missing native view projection');
      const execution = getRenderFeaturePlanExecutionProjection(planned);
      if (execution === undefined) throw new Error('Missing native execution projection');
      expect(execution.passes.map((pass) => pass.name)).toContain('view-read');
      expect(
        execution.passes.find((pass) => pass.name === 'view-read')?.graphics?.sampledTargets,
      ).toMatchObject([{ kind: 'graph-texture', name: 'shared' }]);
      expect(planned.plan.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'prepared-gpu-resource',
            name: 'shared-view',
            logicalTarget: 'shared',
          }),
        ]),
      );
      complete(host, batch);
    } finally {
      abortFeatureFrame(host);
      host.dispose();
      gpu.dispose().unwrap();
    }
  });
});

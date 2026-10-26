import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameBatch,
} from '../features/host';
import type { RenderFeatureWork } from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';

function complete(batch: RenderFeatureFrameBatch) {
  expect(batch.frame.errors).toEqual([]);
  batch.frame.onSubmitted();
  for (const view of batch.views.values()) view.onSubmitted();
  batch.onSubmitted();
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
    worlds: [],
    owner: 0,
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
      batch = f.host.runFrame(
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
      complete(batch);
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
      batch?.onAborted();
      f.dispose();
    }
  });

  it('preserves broad shared names when a resolver callback changes a view pass after admission', async () => {
    const work = sharedViews(3, 1);
    const f = await fixture(() => work);
    const allocations = vi.spyOn(f.device, 'createBuffer');
    const callbackOrder: string[] = [];
    const batch = f.host.runFrame([
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
      complete(batch);
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
      batch.onAborted();
      f.dispose();
    }
  });

  it('aborts every prepared resource after a projection callback fails and retries without stale scopes', async () => {
    const f = await fixture(() => sharedViews(3, 2));
    const allocations = vi.spyOn(f.device, 'createBuffer');
    const destroyed = vi.spyOn(f.device, 'destroyBuffer');
    let callbacks = 0;
    const failure = new Error('Resolver creation failed');
    const failed = f.host.runFrame(
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
      failed.onAborted();
      const retried = f.host.runFrame(
        ['view-0', 'view-1'].map((identity) => ({
          ...f.common,
          identity,
          render: true,
        })),
      );
      complete(retried);
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
      failed.onAborted();
      allocations.mockRestore();
      destroyed.mockRestore();
      f.dispose();
    }
  });
});

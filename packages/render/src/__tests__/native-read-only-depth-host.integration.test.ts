import type { RenderPipeline } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectRendererFeatureInspection } from '../assembly/renderer-feature-inspection';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameInput,
  runRenderFeatureFrame,
} from '../features/host';
import { createRenderFeatureTarget } from '../features/targets';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}
async function fixture(permission = true, diagnostic: boolean | 'absent' = true) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  let writes = false,
    stencil = false,
    reads = 0;
  const pending = new Set<string>();
  const state = {
    get depthWriteEnabled() {
      reads++;
      return writes;
    },
  };
  const feature: RenderFeature<null> = {
    identity: 'depth-batch',
    extract: () => ok(null),
    plan: (_source, context) => {
      const builder = required(context.createNativePlan)();
      const work = builder.scope({ view: 'main' });
      for (const [index, name] of ['sampled', 'ordinary'].entries()) {
        work.resources.push({
          kind: 'graphics-program',
          name,
          program: {
            shader: name,
            vertexLayout: 'none',
            colorFormats: ['rgba8unorm'],
            depthFormat: 'depth24plus-stencil8',
            sampleCount: 1,
            renderState: stencil
              ? { depthWriteEnabled: false, stencil: { passOp: 'replace' } }
              : state,
          },
        });
        work.resources.push({
          kind: 'graphics-bindings',
          name: `${name}.binding`,
          program: name,
          values: {},
        });
        work.passes.push({
          kind: 'raster',
          name,
          colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
          ...(index === 0 ? { sampledTargets: ['depth'], sceneDepth: 'read-only' } : {}),
          draws: [
            {
              program: name,
              bindings: [`${name}.binding`],
              vertexLayout: 'none',
              vertexData: [],
              draw: { kind: 'draw', vertexCount: 3, instanceCount: index + 1 },
            },
          ],
        });
      }
      return ok(
        builder.finish(
          [work],
          undefined,
          permission ? { batchReadOnlyDepthRaster: true } : undefined,
        ),
      );
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
    ...(diagnostic === 'absent' ? {} : { featureReadOnlyDepthBatchDiagnostic: diagnostic }),
    targets: [
      createRenderFeatureTarget({
        name: 'color',
        kind: 'scene-color',
        format: 'rgba8unorm',
        sampleCount: 1,
      }),
      createRenderFeatureTarget({
        name: 'depth',
        kind: 'scene-depth',
        format: 'depth24plus-stencil8',
        sampleCount: 1,
      }),
    ],
    createPreparedGraphicsResolver: ({ lookup, generation }) =>
      createPreparedGraphicsResolver({
        device,
        generation,
        capabilityAvailable: true,
        lookup,
        resolvePipeline: (descriptor) =>
          pending.has(descriptor.shader)
            ? err(
                new RhiError({
                  code: 'rhi-not-available',
                  expected: 'pending pipeline',
                  hint: 'retry',
                }),
              )
            : ok({} as RenderPipeline),
        resolveBindings: () => ok(undefined),
      }),
  });
  const run = (frameNumber: number, generation = 0) => {
    const batch = runRenderFeatureFrame(host, [input(frameNumber, generation)]);
    expect(batch.frame.errors).toEqual([]);
    const view = required([...batch.views.values()][0]);
    expect(view.errors).toEqual([]);
    const planned = required(view.plans[0]);
    const execution = required(getRenderFeaturePlanExecutionProjection(planned));
    return {
      batch,
      view,
      planned,
      execution,
      submit() {
        batch.frame.onSubmitted();
        view.onSubmitted();
        batch.onSubmitted();
      },
    };
  };
  return {
    host,
    pending,
    run,
    reads: () => reads,
    setDiagnostic: (value: boolean | 'absent') => {
      diagnostic = value;
    },
    setWrites: (value: boolean) => {
      writes = value;
    },
    setStencil: (value: boolean) => {
      stencil = value;
    },
  };
}

describe('Host current read-only depth pipeline authority', () => {
  it.each([
    false,
    'absent',
  ] as const)('keeps ordinary pass grouping with diagnostic %s', async (diagnostic) => {
    const f = await fixture(true, diagnostic);
    try {
      const result = f.run(1);
      expect(result.execution.passes).toHaveLength(2);
      expect(f.host.inspection?.().featureReadOnlyDepthBatchDiagnostic).toBeUndefined();
      result.batch.onAborted();
    } finally {
      f.host.dispose().unwrap();
    }
  });
  it('publishes only current enabled preparation counts, including a genuine zero-hit frame', async () => {
    const f = await fixture();
    try {
      const first = f.run(1);
      const snapshot = f.host.inspection?.().featureReadOnlyDepthBatchDiagnostic;
      expect(snapshot).toEqual({
        frameNumber: 1,
        generation: 0,
        stage: 'prepared',
        scopes: 1,
        beforePasses: 2,
        afterPasses: 1,
        removedRasterPasses: 1,
        admittedPasses: 1,
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(
        projectRendererFeatureInspection(f.host).featureHost?.featureReadOnlyDepthBatchDiagnostic,
      ).toEqual(snapshot);
      first.batch.onAborted();
      f.setDiagnostic(false);
      const off = f.run(2);
      expect(f.host.inspection?.().featureReadOnlyDepthBatchDiagnostic).toBeUndefined();
      off.submit();
      f.setDiagnostic(true);
      f.pending.add('sampled');
      const pending = f.run(3);
      expect(f.host.inspection?.().featureReadOnlyDepthBatchDiagnostic).toMatchObject({
        frameNumber: 3,
        beforePasses: 2,
        afterPasses: 2,
        removedRasterPasses: 0,
        admittedPasses: 1,
      });
      expect(snapshot?.frameNumber).toBe(1);
      pending.batch.onAborted();
      f.host.advancePreparedGeneration();
      expect(f.host.inspection?.().featureReadOnlyDepthBatchDiagnostic).toBeUndefined();
    } finally {
      f.host.dispose().unwrap();
    }
  });
  it('batches only with producer permission and preserves current dynamic pipeline state', async () => {
    for (const permission of [false, true]) {
      const f = await fixture(permission);
      try {
        const first = f.run(1);
        expect(first.execution.passes).toHaveLength(permission ? 1 : 2);
        expect(first.planned.plan.passes).toHaveLength(permission ? 1 : 2);
        first.submit();
        f.setWrites(true);
        const writer = f.run(2);
        expect(writer.execution.passes).toHaveLength(2);
        writer.submit();
        f.setWrites(false);
        const next = f.run(3, 1);
        expect(next.execution.passes).toHaveLength(permission ? 1 : 2);
        expect(first.planned.generation).toBe(0);
        expect(next.planned.generation).toBe(1);
        next.batch.onAborted();
      } finally {
        f.host.dispose().unwrap();
      }
    }
  });
  it('does not add authored getter observations while consulting prepared state', async () => {
    const counts = [];
    for (const permission of [false, true]) {
      const f = await fixture(permission);
      try {
        const result = f.run(1);
        counts.push(f.reads());
        result.batch.onAborted();
      } finally {
        f.host.dispose().unwrap();
      }
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
  });
  it('keeps a pending pipeline separate so another ready draw is still admitted', async () => {
    const f = await fixture();
    try {
      f.pending.add('sampled');
      const first = f.run(1);
      expect(first.planned.plan.passes).toHaveLength(2);
      expect(first.execution.passes).toHaveLength(1);
      expect(first.execution.passes[0]?.name).toBe('ordinary');
      first.submit();
      f.pending.clear();
      const next = f.run(2);
      expect(next.execution.passes).toHaveLength(1);
      expect(next.execution.passes[0]?.graphics?.draws).toHaveLength(2);
      next.batch.onAborted();
    } finally {
      f.host.dispose().unwrap();
    }
  });
  it('preserves stencil operation barriers even when depth writes are disabled', async () => {
    const f = await fixture();
    try {
      f.setStencil(true);
      const result = f.run(1);
      expect(result.execution.passes).toHaveLength(2);
      result.batch.onAborted();
    } finally {
      f.host.dispose().unwrap();
    }
  });
});

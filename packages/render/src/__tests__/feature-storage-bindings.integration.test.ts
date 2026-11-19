import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RenderPipeline } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { featureResourceKey } from '../features/frame-plan';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeatureFrameInput,
} from '../features/host';
import type { RenderFeatureWork } from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import {
  createRenderFeatureProjectionState,
  projectRenderFeaturePlans,
} from '../features/render-graph-contribution';
import { createRenderFeatureTarget } from '../features/targets';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import { abortFeatureFrame, prepareFeatureFrame } from './feature-frame-driver';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing storage binding fixture');
  return value;
}

it.each([
  'raw',
  'native',
] as const)('shares compute-produced storage with graphics and isolates same-name view buffers through %s Host preparation', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const feature: RenderFeature<null> = {
    identity: 'storage-bindings',
    extract: () => ok(null),
    plan: (_source, context) => {
      const works: RenderFeatureWork[] = [
        {
          scope: 'frame',
          resources: [
            { kind: 'buffer', name: 'shared', size: 16, usage: ['storage'] },
            {
              kind: 'compute-program',
              name: 'compute',
              program: {
                wgsl: 'synthetic',
                entryPoints: ['main'],
                bindings: [
                  { entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }] },
                ],
              },
            },
            {
              kind: 'compute-bindings',
              name: 'producer',
              program: 'compute',
              entries: [{ binding: 0, resource: 'shared' }],
            },
          ],
          passes: [
            {
              kind: 'compute',
              name: 'produce-shared',
              program: 'compute',
              bindings: 'producer',
              dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
            },
          ],
        },
        ...['main', 'secondary'].map(
          (view): RenderFeatureWork => ({
            scope: { view },
            resources: [
              { kind: 'buffer', name: 'params', size: 16, usage: ['storage'] },
              {
                kind: 'compute-bindings',
                name: 'local-producer',
                program: 'compute',
                entries: [{ binding: 0, resource: 'params' }],
              },
              {
                kind: 'graphics-program',
                name: 'graphics',
                program: {
                  shader: 'synthetic',
                  vertexLayout: 'none',
                  colorFormats: ['rgba8unorm'],
                },
              },
              {
                kind: 'graphics-bindings',
                name: 'consumer',
                program: 'graphics',
                values: {
                  bufferBindings: [
                    { binding: 0, resource: 'shared', access: 'read' },
                    { binding: 1, resource: 'params', access: 'read' },
                  ],
                },
              },
            ],
            passes: [
              {
                kind: 'compute',
                name: `produce-local-${view}`,
                program: 'compute',
                bindings: 'local-producer',
                dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
              },
              {
                kind: 'raster',
                name: `consume-${view}`,
                colorAttachments: [{ target: 'color', loadOp: 'clear', storeOp: 'store' }],
                draws: [
                  {
                    program: 'graphics',
                    bindings: ['consumer'],
                    vertexLayout: 'none',
                    vertexData: [],
                    draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                  },
                ],
              },
            ],
          }),
        ),
      ];
      if (mode === 'raw') return ok({ work: works });
      const builder = required(context.createNativePlan)();
      return ok(
        builder.finish(
          works.map((work) => {
            const scope = builder.scope(work.scope);
            scope.resources.push(...work.resources);
            scope.passes.push(...work.passes);
            return scope;
          }),
        ),
      );
    },
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  try {
    const batch = prepareFeatureFrame(
      host,
      ['main', 'secondary'].map(
        (identity): RenderFeatureFrameInput => ({
          identity,
          render: true,
          world: host.world,
          frameNumber: 1,
          generation: 0,
          caps: device.caps,
          gpuWork: gpu,
          targets: [
            createRenderFeatureTarget({
              name: 'color',
              kind: 'scene-color',
              format: 'rgba8unorm',
              sampleCount: 1,
            }),
          ],
          createPreparedGraphicsResolver: (input) =>
            createPreparedGraphicsResolver({
              device,
              featureIdentity: input.featureIdentity,
              generation: input.generation,
              capabilityAvailable: true,
              lookup: input.lookup,
              resolvePipeline: () => ok({} as RenderPipeline),
              resolveBindings: () => ok(undefined),
            }),
        }),
      ),
    );
    expect(batch.frame.errors).toEqual([]);
    const shared = required(
      getRenderFeaturePlanExecutionProjection(required(batch.frame.plans[0])),
    );
    const executions = [...batch.views.values()].map((view) => {
      expect(view.errors).toEqual([]);
      return required(getRenderFeaturePlanExecutionProjection(required(view.plans[0])));
    });
    const graph = new RenderGraphBuilder();
    const texture = graph
      .createTexture('color', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
      .unwrap();
    const view = graph.view(texture).unwrap();
    const state = createRenderFeatureProjectionState();
    expect(
      projectRenderFeaturePlans(graph, [shared, ...executions], {
        state,
        resolveTarget: () => ({ texture, view }),
      }),
    ).toMatchObject({ ok: true });
    const sharedBuffer = required(shared.passes[0]?.resolvedGpuCompute?.buffers[0]).buffer;
    const locals = executions.map((execution, index) => {
      const snapshot = required(execution.passes[1]?.resolvedGraphics);
      const local = required(execution.passes[0]?.resolvedGpuCompute?.buffers[0]).buffer;
      expect(snapshot.resolveGpuResource?.('shared')?.buffer).toBe(sharedBuffer);
      expect(snapshot.resolveGpuResource?.('params')?.buffer).toBe(local);
      expect(
        snapshot.resolveGpuResource?.(
          featureResourceKey({ view: index === 0 ? 'secondary' : 'main' }, 'params'),
        ),
      ).toBeUndefined();
      return local;
    });
    expect(locals[0]).not.toBe(locals[1]);
    expect(state.buffers.handles.size).toBe(3);
    for (const buffer of [sharedBuffer, ...locals])
      expect(state.buffers.handles.has(buffer)).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    await compiled.retire();
  } finally {
    abortFeatureFrame(host);
    host.dispose().unwrap();
    gpu.dispose().unwrap();
  }
});

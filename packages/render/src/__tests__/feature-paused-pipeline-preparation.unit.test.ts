import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  runRenderFeatureFrame,
} from '../features/host';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';

it('keeps explicit disabled graphics pending until the actual pipeline resolves, then records zero work', async () => {
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
                name: 'prepare',
                enabled: false,
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
  let pending = true;
  const frame = () =>
    runRenderFeatureFrame(host, [
      {
        worlds: [],
        owner: 0,
        identity: 'main',
        render: true,
        frameNumber: 1,
        generation: 0,
        caps: device.caps,
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
    expect(first.frame.errors).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    first.onAborted();
    pending = false;
    const ready = frame();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.errors).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
    const view = ready.views.get('main');
    if (view === undefined) throw new Error('missing view');
    const projected = view.plans.flatMap(
      (plan) => getRenderFeaturePlanExecutionProjection(plan)?.passes ?? [],
    );
    expect(projected).toHaveLength(1);
    expect(projected.every((pass) => pass.enabled === false)).toBe(true);
    ready.onAborted();
  } finally {
    host.dispose();
  }
});
